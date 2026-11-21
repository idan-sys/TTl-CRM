import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import test from 'node:test';
import worker, {
  createFirebaseCustomToken,
  getUserProfile,
  OtpStore,
  hashOtp
} from '../src/index.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    return this.values.delete(key);
  }

  async transaction(callback) {
    const snapshot = new Map(this.values);
    const transaction = {
      get: async key => snapshot.get(key),
      put: async (key, value) => snapshot.set(key, structuredClone(value)),
      delete: async key => snapshot.delete(key)
    };
    const result = await callback(transaction);
    this.values = snapshot;
    return result;
  }
}

function createStore() {
  const storage = new MemoryStorage();
  return { store: new OtpStore({ storage }), storage };
}

function post(path, body) {
  return new Request(`https://otp-store${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const challengeId = `${'a'.repeat(64)}.12345678-1234-1234-1234-123456789abc`;
const hashSecret = 'test-secret-with-at-least-32-characters';
const wifKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const wifEnv = {
  WIF_ISSUER: 'https://auth.example.workers.dev',
  WIF_SIGNING_KEY_ID: 'test-key-1',
  WIF_SIGNING_PRIVATE_KEY: wifKeyPair.privateKey
};

test('OIDC discovery advertises the Worker issuer and public JWKS endpoint', async () => {
  const response = await worker.fetch(
    new Request('https://auth.example.workers.dev/.well-known/openid-configuration'),
    wifEnv
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    issuer: 'https://auth.example.workers.dev',
    jwks_uri: 'https://auth.example.workers.dev/.well-known/jwks.json',
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256']
  });
});

test('OIDC JWKS publishes only the public portion of the signing key', async () => {
  const response = await worker.fetch(
    new Request('https://auth.example.workers.dev/.well-known/jwks.json'),
    wifEnv
  );
  assert.equal(response.status, 200);
  const { keys } = await response.json();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kid, 'test-key-1');
  assert.equal(keys[0].alg, 'RS256');
  assert.equal(keys[0].n, createPublicKey(wifKeyPair.privateKey).export({ format: 'jwk' }).n);
  for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
    assert.equal(privateField in keys[0], false);
  }
});

test('health remains unavailable until required workload identity settings are present', async () => {
  const response = await worker.fetch(
    new Request('https://auth.example.workers.dev/health'),
    wifEnv
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, service: 'crm-auth' });
});

test('Firebase custom tokens are signed remotely through keyless Google IAM credentials', async () => {
  const env = {
    ...wifEnv,
    WIF_AUDIENCE: 'https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/provider',
    WIF_PROVIDER_RESOURCE: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/provider',
    FIREBASE_SERVICE_ACCOUNT_EMAIL: 'ttl-crm-mfa-signer@example.iam.gserviceaccount.com'
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://sts.googleapis.com/v1/token') {
      const request = new URLSearchParams(init.body);
      assert.equal(request.get('audience'), env.WIF_PROVIDER_RESOURCE);
      assert.equal(request.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:jwt');

      const subjectToken = request.get('subject_token');
      const [encodedHeader, encodedPayload, encodedSignature] = subjectToken.split('.');
      const signedData = Buffer.from(`${encodedHeader}.${encodedPayload}`);
      assert.equal(
        verifySignature(
          'RSA-SHA256',
          signedData,
          wifKeyPair.publicKey,
          Buffer.from(encodedSignature, 'base64url')
        ),
        true
      );
      assert.equal(JSON.parse(Buffer.from(encodedHeader, 'base64url')).kid, env.WIF_SIGNING_KEY_ID);
      const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url'));
      assert.equal(claims.iss, env.WIF_ISSUER);
      assert.equal(claims.sub, 'ttl-crm-email-mfa');
      assert.equal(claims.aud, env.WIF_AUDIENCE);
      return Response.json({ access_token: 'federated-access-token', expires_in: 300 });
    }

    assert.match(url, /iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/.+:signJwt$/);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer federated-access-token');
    const request = JSON.parse(init.body);
    const payload = JSON.parse(request.payload);
    assert.equal(payload.uid, 'firebase-user-1');
    assert.deepEqual(payload.claims, { email_mfa_verified: true });
    return Response.json({ signedJwt: 'firebase-custom-token' });
  };

  try {
    assert.equal(await createFirebaseCustomToken(env, 'firebase-user-1'), 'firebase-custom-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Firebase profile lookup uses the user token for only that user document', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      'https://firestore.googleapis.com/v1/projects/tal-the-life-crm2/databases/(default)/documents/users/user-1'
    );
    assert.equal(init.method, undefined);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer firebase-id-token');
    return Response.json({
      fields: {
        role: { stringValue: 'Staff_Egg' },
        email: { stringValue: 'staff@example.com' },
        full_name: { stringValue: 'CRM Staff' },
        is_active: { booleanValue: true }
      }
    });
  };

  try {
    assert.deepEqual(
      await getUserProfile({ FIREBASE_PROJECT_ID: 'tal-the-life-crm2' }, 'user-1', 'firebase-id-token'),
      {
        role: 'Staff_Egg',
        email: 'staff@example.com',
        fullName: 'CRM Staff',
        isActive: true
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Firebase profile lookup reports the Google API status for failed responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: { code: 429, status: 'RESOURCE_EXHAUSTED' }
  }, { status: 429 });

  try {
    await assert.rejects(
      getUserProfile({ FIREBASE_PROJECT_ID: 'tal-the-life-crm2' }, 'user-1', 'firebase-id-token'),
      /Firestore user profile lookup failed \(429, RESOURCE_EXHAUSTED\)\./
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a valid code is single-use and the stored challenge contains only its hash', async () => {
  const { store, storage } = createStore();
  const code = '042731';
  const codeHash = await hashOtp(challengeId, code, hashSecret);

  const issueResponse = await store.fetch(post('/issue', { challengeId, uid: 'user-1', codeHash }));
  assert.equal(issueResponse.status, 201);
  const storedChallenge = storage.values.get('challenge');
  assert.equal(storedChallenge.code, undefined);
  assert.equal(storedChallenge.codeHash, codeHash);

  const verifyResponse = await store.fetch(post('/verify', {
    challengeId,
    codeHash: await hashOtp(challengeId, code, hashSecret)
  }));
  assert.equal(verifyResponse.status, 200);
  assert.deepEqual(await verifyResponse.json(), { uid: 'user-1' });

  const reuseResponse = await store.fetch(post('/verify', {
    challengeId,
    codeHash: await hashOtp(challengeId, code, hashSecret)
  }));
  assert.equal(reuseResponse.status, 410);
});

test('invalid codes consume attempts and lock the challenge after five failures', async () => {
  const { store } = createStore();
  const codeHash = await hashOtp(challengeId, '042731', hashSecret);
  await store.fetch(post('/issue', { challengeId, uid: 'user-1', codeHash }));

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await store.fetch(post('/verify', {
      challengeId,
      codeHash: await hashOtp(challengeId, '000000', hashSecret)
    }));
    assert.equal(response.status, 401);
  }

  const lockedResponse = await store.fetch(post('/verify', {
    challengeId,
    codeHash: await hashOtp(challengeId, '000000', hashSecret)
  }));
  assert.equal(lockedResponse.status, 429);
});

test('resending is rate-limited per email hash', async () => {
  const { store } = createStore();
  const codeHash = await hashOtp(challengeId, '042731', hashSecret);
  const firstResponse = await store.fetch(post('/issue', { challengeId, uid: 'user-1', codeHash }));
  assert.equal(firstResponse.status, 201);

  const nextChallenge = `${'a'.repeat(64)}.22345678-1234-1234-1234-123456789abc`;
  const resendResponse = await store.fetch(post('/issue', {
    challengeId: nextChallenge,
    uid: 'user-1',
    codeHash: await hashOtp(nextChallenge, '142731', hashSecret)
  }));
  assert.equal(resendResponse.status, 429);
});

test('expired challenges cannot be verified', async () => {
  const { store, storage } = createStore();
  storage.values.set('challenge', {
    challengeId,
    uid: 'user-1',
    codeHash: await hashOtp(challengeId, '042731', hashSecret),
    expiresAt: Date.now() - 1,
    attempts: 0
  });

  const response = await store.fetch(post('/verify', {
    challengeId,
    codeHash: await hashOtp(challengeId, '042731', hashSecret)
  }));
  assert.equal(response.status, 410);
  assert.equal(storage.values.has('challenge'), false);
});

test('OTP HMAC hashes cannot be reused with a different secret', async () => {
  const firstHash = await hashOtp(challengeId, '042731', hashSecret);
  const secondHash = await hashOtp(challengeId, '042731', `${hashSecret}-rotated`);
  assert.notEqual(firstHash, secondHash);
  assert.equal(firstHash.length, 64);
});
