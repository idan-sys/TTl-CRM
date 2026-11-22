const TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
const STS_TOKEN_URL = 'https://sts.googleapis.com/v1/token';
const IAM_CREDENTIALS_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const OTP_LIFETIME_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_SENDS_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;
const MAX_REQUEST_BYTES = 12 * 1024;
const VALID_ROLES = new Set(['Admin', 'Staff_All', 'Staff_Egg', 'Staff_Sur']);

let cachedAccessToken = '';
let cachedAccessTokenExpiresAt = 0;
let cachedAccessTokenConfig = '';
let cachedPrivateKeyPem = '';
let cachedPrivateKeyPromise = null;

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function withCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-methods', 'POST, OPTIONS');
  headers.set('access-control-allow-headers', 'Content-Type');
  headers.set('access-control-max-age', '600');
  headers.append('vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function firestoreString(fields, name) {
  const value = fields && fields[name];
  return value && typeof value.stringValue === 'string' ? value.stringValue : '';
}

function firestoreBoolean(fields, name) {
  const value = fields && fields[name];
  return value && typeof value.booleanValue === 'boolean' ? value.booleanValue : undefined;
}

function profileIsActive(profile) {
  return Boolean(profile && VALID_ROLES.has(profile.role) && profile.isActive !== false);
}

function workerIsConfigured(env) {
  return Boolean(
    env.APP_ORIGIN &&
    env.FIREBASE_PROJECT_ID &&
    env.FIREBASE_API_KEY &&
    env.FIREBASE_SERVICE_ACCOUNT_EMAIL &&
    env.WIF_ISSUER &&
    env.WIF_AUDIENCE &&
    env.WIF_PROVIDER_RESOURCE &&
    env.WIF_SIGNING_KEY_ID &&
    env.WIF_SIGNING_PRIVATE_KEY &&
    env.GOOGLE_APPS_SCRIPT_URL &&
    env.GOOGLE_APPS_SCRIPT_SHARED_SECRET &&
    typeof env.OTP_HASH_SECRET === 'string' &&
    env.OTP_HASH_SECRET.length >= 32
  );
}

function base64UrlEncode(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function privateKeyBytes(pemValue) {
  const pem = String(pemValue || '').replace(/\\n/g, '\n');
  const base64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  if (!base64) throw new Error('Workload identity signing key is not configured.');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function getSigningKey(pemValue) {
  if (cachedPrivateKeyPem === pemValue && cachedPrivateKeyPromise) return cachedPrivateKeyPromise;
  cachedPrivateKeyPem = pemValue;
  cachedPrivateKeyPromise = crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes(pemValue),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  try {
    return await cachedPrivateKeyPromise;
  } catch (error) {
    if (cachedPrivateKeyPem === pemValue) {
      cachedPrivateKeyPem = '';
      cachedPrivateKeyPromise = null;
    }
    throw error;
  }
}

async function signJwt(payload, privateKeyPem, keyId) {
  const header = base64UrlEncode(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT',
    ...(keyId ? { kid: keyId } : {})
  }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const key = await getSigningKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getGoogleAccessToken(env) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cacheConfig = `${env.WIF_ISSUER}:${env.WIF_AUDIENCE}:${env.WIF_PROVIDER_RESOURCE}:${env.WIF_SIGNING_KEY_ID}`;
  if (cachedAccessToken &&
      cachedAccessTokenConfig === cacheConfig &&
      cachedAccessTokenExpiresAt > nowSeconds + 60) {
    return cachedAccessToken;
  }

  const subjectToken = await signJwt({
    iss: env.WIF_ISSUER,
    sub: 'ttl-crm-email-mfa',
    aud: env.WIF_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + 300
  }, env.WIF_SIGNING_PRIVATE_KEY, env.WIF_SIGNING_KEY_ID);

  const response = await fetch(STS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: env.WIF_PROVIDER_RESOURCE,
      scope: OAUTH_SCOPE,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
    })
  });
  if (!response.ok) throw new Error('Google Workload Identity Federation exchange failed.');

  const tokenData = await response.json();
  if (!tokenData.access_token || !Number.isFinite(Number(tokenData.expires_in))) {
    throw new Error('Google returned an invalid federated access token.');
  }
  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenExpiresAt = nowSeconds + Number(tokenData.expires_in);
  cachedAccessTokenConfig = cacheConfig;
  return cachedAccessToken;
}

async function publicSigningJwk(env) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes(env.WIF_SIGNING_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const { d, p, q, dp, dq, qi, ...publicJwk } = jwk;
  return {
    ...publicJwk,
    kid: env.WIF_SIGNING_KEY_ID,
    use: 'sig',
    alg: 'RS256'
  };
}

function oidcDiscovery(env) {
  const issuer = String(env.WIF_ISSUER || '').replace(/\/+$/, '');
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256']
  };
}

export async function getUserProfile(env, uid, idToken) {
  const documentUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const response = await fetch(documentUrl, {
    headers: { authorization: `Bearer ${idToken}` }
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const result = await response.json();
    const status = result && result.error && typeof result.error.status === 'string'
      ? result.error.status
      : 'unknown';
    throw new Error(`Firestore user profile lookup failed (${response.status}, ${status}).`);
  }

  const document = await response.json();
  const fields = document.fields || {};
  return {
    role: firestoreString(fields, 'role'),
    email: firestoreString(fields, 'email'),
    fullName: firestoreString(fields, 'full_name'),
    isActive: firestoreBoolean(fields, 'is_active')
  };
}

async function lookupFirebaseUser(env, idToken) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY || '')}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken })
  });

  if (response.status === 400 || response.status === 401) return null;
  if (!response.ok) throw new Error('Firebase identity lookup failed.');
  const result = await response.json();
  const user = result.users && result.users[0];
  if (!user || !user.localId || !user.email || user.disabled === true) return null;
  return { uid: user.localId, email: normalizeEmail(user.email) };
}

async function getActiveProfile(env, uid, email, idToken) {
  const profile = await getUserProfile(env, uid, idToken);
  if (!profileIsActive(profile)) return null;
  if (profile.email && normalizeEmail(profile.email) !== normalizeEmail(email)) return null;
  return profile;
}

async function getAdminRequestContext(env, idToken) {
  const identity = await lookupFirebaseUser(env, idToken);
  if (!identity) return null;
  const profile = await getActiveProfile(env, identity.uid, identity.email, idToken);
  if (!profile || profile.role !== 'Admin') return null;
  return { identity, profile };
}

function isCompanyEmail(email) {
  return /^[^@\s]+@talthelife\.com$/i.test(email);
}

function firestoreField(value) {
  if (typeof value === 'boolean') return { booleanValue: value };
  return { stringValue: value };
}

async function writeUserProfile(env, uid, idToken, profile) {
  const documentUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/users?documentId=${encodeURIComponent(uid)}`;
  const response = await fetch(documentUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      fields: {
        full_name: firestoreField(profile.fullName),
        email: firestoreField(profile.email),
        role: firestoreField(profile.role),
        is_active: firestoreField(true),
        can_view_agreements: firestoreField(false)
      }
    })
  });
  if (!response.ok) throw new Error(`Firestore user profile creation failed (${response.status}).`);
}

async function lookupManagedAuthUser(env, accessToken, email) {
  const endpoint = `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/accounts:lookup`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ email: [email] })
  });
  if (!response.ok) throw new Error(`Firebase Auth user lookup failed (${response.status}).`);
  const result = await response.json();
  return (result.users || []).find(user => normalizeEmail(user.email) === email) || null;
}

async function createManagedAuthUser(env, accessToken, email, fullName) {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const endpoint = `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/accounts`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password: base64UrlEncode(randomBytes),
      displayName: fullName,
      emailVerified: false,
      disabled: false
    })
  });
  if (!response.ok) {
    const result = await response.json();
    const message = result && result.error && typeof result.error.message === 'string'
      ? result.error.message
      : 'unknown';
    throw new Error(`Firebase Auth user creation failed (${response.status}, ${message}).`);
  }
  const result = await response.json();
  if (typeof result.localId !== 'string' || !result.localId) {
    throw new Error('Firebase Auth returned an invalid user ID.');
  }
  return result.localId;
}

async function sendPasswordSetupEmail(env, email) {
  const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestType: 'PASSWORD_RESET',
      email,
      continueUrl: env.APP_ORIGIN
    })
  });
  if (!response.ok) throw new Error(`Firebase password setup email failed (${response.status}).`);
}

async function createUserForAdmin(request, env) {
  const body = await readJsonBody(request);
  if (!body ||
      typeof body.idToken !== 'string' ||
      body.idToken.length > 8192 ||
      typeof body.name !== 'string' ||
      typeof body.email !== 'string' ||
      typeof body.role !== 'string') {
    return jsonResponse({ error: 'יש למלא שם, דוא״ל ותפקיד תקינים.' }, 400);
  }

  const name = body.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
  const email = normalizeEmail(body.email);
  if (!name || !isCompanyEmail(email) || !VALID_ROLES.has(body.role)) {
    return jsonResponse({ error: 'יש להזין שם, כתובת talthelife.com ותפקיד תקינים.' }, 400);
  }

  const adminContext = await getAdminRequestContext(env, body.idToken);
  if (!adminContext) return jsonResponse({ error: 'נדרשת הרשאת מנהל פעילה.' }, 403);

  try {
    const accessToken = await getGoogleAccessToken(env);
    const existingAuthUser = await lookupManagedAuthUser(env, accessToken, email);
    if (existingAuthUser && existingAuthUser.disabled === true) {
      return jsonResponse({ error: 'חשבון Firebase קיים אך מושבת. יש להפעיל אותו לפני שליחת הזמנה.' }, 409);
    }
    const uid = existingAuthUser
      ? existingAuthUser.localId
      : await createManagedAuthUser(env, accessToken, email, name);

    if (!uid) throw new Error('Firebase Auth user lookup returned an invalid user ID.');
    const existingProfile = await getUserProfile(env, uid, body.idToken);
    if (existingProfile) {
      return jsonResponse({ error: 'כבר קיים פרופיל CRM עבור כתובת הדוא״ל הזו.' }, 409);
    }

    await writeUserProfile(env, uid, body.idToken, {
      fullName: name,
      email,
      role: body.role
    });

    let invitationSent = true;
    try {
      await sendPasswordSetupEmail(env, email);
    } catch (error) {
      invitationSent = false;
      console.error('Password setup email failed:', error.message);
    }
    return jsonResponse({ uid, invitationSent }, 201);
  } catch (error) {
    console.error('Admin user provisioning failed:', error.message);
    return jsonResponse({
      error: 'יצירת המשתמש לא הושלמה. בדוק הרשאות שירות ונסה שוב.'
    }, 502);
  }
}

async function sendInviteForAdmin(request, env) {
  const body = await readJsonBody(request);
  if (!body ||
      typeof body.idToken !== 'string' ||
      body.idToken.length > 8192 ||
      typeof body.uid !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(body.uid)) {
    return jsonResponse({ error: 'בקשת שליחת הקישור אינה תקינה.' }, 400);
  }

  const adminContext = await getAdminRequestContext(env, body.idToken);
  if (!adminContext) return jsonResponse({ error: 'נדרשת הרשאת מנהל פעילה.' }, 403);

  try {
    const profile = await getUserProfile(env, body.uid, body.idToken);
    if (!profileIsActive(profile) || !isCompanyEmail(profile.email)) {
      return jsonResponse({ error: 'לא נמצא משתמש פעיל לשליחת קישור.' }, 404);
    }
    await sendPasswordSetupEmail(env, profile.email);
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    console.error('Admin password setup resend failed:', error.message);
    return jsonResponse({ error: 'שליחת הקישור נכשלה. נסה שוב מאוחר יותר.' }, 502);
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashOtp(challengeId, code, hashSecret) {
  if (!hashSecret || String(hashSecret).length < 32) {
    throw new Error('OTP hash secret must contain at least 32 characters.');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hashSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${challengeId}:${code}`)
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function generateOtp() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= limit);
  return String(random[0] % 1000000).padStart(6, '0');
}

function maskEmail(email) {
  const [localPart, domain] = normalizeEmail(email).split('@');
  if (!localPart || !domain) return '';
  const visible = localPart.length > 2 ? localPart.slice(0, 2) : localPart.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(2, localPart.length - visible.length))}@${domain}`;
}

async function sendOtpEmail(env, email, code, profile) {
  const response = await fetch(env.GOOGLE_APPS_SCRIPT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      secret: env.GOOGLE_APPS_SCRIPT_SHARED_SECRET,
      email,
      name: profile.fullName,
      role: profile.role,
      code
    })
  });
  if (!response.ok) throw new Error(`Google Apps Script mail request failed with status ${response.status}.`);
  const result = await response.json();
  if (!result || result.ok !== true) throw new Error('Google Apps Script did not confirm email delivery.');
}

function otpStoreForEmail(env, emailHash) {
  const id = env.OTP_STORE.idFromName(emailHash);
  return env.OTP_STORE.get(id);
}

async function callOtpStore(env, emailHash, path, body) {
  const durableObject = otpStoreForEmail(env, emailHash);
  return durableObject.fetch(`https://otp-store${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function startChallenge(request, env) {
  const body = await readJsonBody(request);
  if (!body || typeof body.idToken !== 'string' || body.idToken.length > 8192) {
    return jsonResponse({ error: 'בקשת האימות אינה תקינה.' }, 400);
  }

  const identity = await lookupFirebaseUser(env, body.idToken);
  if (!identity) return jsonResponse({ error: 'לא ניתן לאמת את פרטי הכניסה או את הרשאת המשתמש.' }, 401);

  const profile = await getActiveProfile(env, identity.uid, identity.email, body.idToken);
  if (!profile) return jsonResponse({ error: 'לא ניתן לאמת את פרטי הכניסה או את הרשאת המשתמש.' }, 403);

  const emailHash = await sha256Hex(identity.email);
  const challengeId = `${emailHash}.${crypto.randomUUID()}`;
  const code = generateOtp();
  const codeHash = await hashOtp(challengeId, code, env.OTP_HASH_SECRET);
  const issueResponse = await callOtpStore(env, emailHash, '/issue', {
    challengeId,
    uid: identity.uid,
    codeHash
  });
  if (!issueResponse.ok) {
    const issueBody = await issueResponse.json();
    return jsonResponse({ error: issueBody.error || 'לא ניתן לשלוח קוד נוסף כרגע. נסה שוב בעוד דקה.' }, issueResponse.status);
  }

  try {
    await sendOtpEmail(env, identity.email, code, profile);
  } catch (error) {
    await callOtpStore(env, emailHash, '/revoke', { challengeId });
    console.error('OTP email delivery failed:', error.message);
    return jsonResponse({ error: 'שליחת קוד האימות נכשלה. נסה שוב מאוחר יותר או פנה למנהל.' }, 502);
  }

  return jsonResponse({ challengeId, emailHint: maskEmail(identity.email) }, 200);
}

export async function createFirebaseCustomToken(env, uid) {
  const serviceAccountEmail = String(env.FIREBASE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: TOKEN_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    uid,
    claims: { email_mfa_verified: true }
  };
  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(
    `${IAM_CREDENTIALS_URL}${encodeURIComponent(serviceAccountEmail)}:signJwt`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ payload: JSON.stringify(payload) })
    }
  );
  if (!response.ok) throw new Error('Google IAM remote JWT signing failed.');
  const result = await response.json();
  if (typeof result.signedJwt !== 'string' || !result.signedJwt) {
    throw new Error('Google IAM returned an invalid signed JWT.');
  }
  return result.signedJwt;
}

async function verifyChallenge(request, env) {
  const body = await readJsonBody(request);
  if (!body ||
      typeof body.challengeId !== 'string' ||
      typeof body.code !== 'string' ||
      typeof body.idToken !== 'string' ||
      !/^[0-9]{6}$/.test(body.code) ||
      body.idToken.length > 8192) {
    return jsonResponse({ error: 'יש להזין קוד אימות בן שש ספרות.' }, 400);
  }

  const match = /^([a-f0-9]{64})\.[0-9a-f-]{36}$/.exec(body.challengeId);
  if (!match) return jsonResponse({ error: 'קוד האימות אינו תקף או שפג תוקפו.' }, 400);

  const emailHash = match[1];
  const codeHash = await hashOtp(body.challengeId, body.code, env.OTP_HASH_SECRET);
  const verifyResponse = await callOtpStore(env, emailHash, '/verify', {
    challengeId: body.challengeId,
    codeHash
  });
  if (!verifyResponse.ok) {
    const verifyBody = await verifyResponse.json();
    return jsonResponse({ error: verifyBody.error || 'קוד האימות שגוי או שפג תוקפו.' }, verifyResponse.status);
  }

  const verified = await verifyResponse.json();
  const identity = await lookupFirebaseUser(env, body.idToken);
  if (!identity || identity.uid !== verified.uid) {
    return jsonResponse({ error: 'לא ניתן לאמת את פרטי הכניסה. התחל את התהליך מחדש.' }, 401);
  }

  const profile = await getActiveProfile(env, identity.uid, identity.email, body.idToken);
  if (!profile) return jsonResponse({ error: 'החשבון אינו פעיל או שאין לו הרשאה למערכת.' }, 403);

  const customToken = await createFirebaseCustomToken(env, identity.uid);
  return jsonResponse({ customToken }, 200);
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  chunks.forEach(chunk => {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return null;
  }
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export class OtpStore {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
    const body = await readJsonBody(request);
    if (!body) return jsonResponse({ error: 'Invalid request.' }, 400);

    const path = new URL(request.url).pathname;
    if (path === '/issue') return this.issue(body);
    if (path === '/verify') return this.verify(body);
    if (path === '/revoke') return this.revoke(body);
    return jsonResponse({ error: 'Not found.' }, 404);
  }

  async issue(body) {
    if (typeof body.challengeId !== 'string' ||
        typeof body.uid !== 'string' ||
        !/^[a-f0-9]{64}\.[0-9a-f-]{36}$/.test(body.challengeId) ||
        !/^[a-f0-9]{64}$/.test(body.codeHash)) {
      return jsonResponse({ error: 'Invalid challenge.' }, 400);
    }

    const now = Date.now();
    const result = await this.ctx.storage.transaction(async transaction => {
      const recentSends = (await transaction.get('recentSends') || [])
        .filter(time => Number.isSafeInteger(time) && time > now - 60 * 60 * 1000);
      const lastSentAt = recentSends.length ? recentSends[recentSends.length - 1] : 0;
      if (recentSends.length >= OTP_MAX_SENDS_PER_HOUR) {
        return { status: 429, error: 'נשלחו יותר מדי קודים. נסה שוב בעוד שעה.' };
      }
      if (now - lastSentAt < OTP_RESEND_COOLDOWN_MS) {
        return { status: 429, error: 'יש להמתין דקה לפני שליחת קוד נוסף.' };
      }

      recentSends.push(now);
      await transaction.put('recentSends', recentSends);
      await transaction.put('challenge', {
        challengeId: body.challengeId,
        uid: body.uid,
        codeHash: body.codeHash,
        expiresAt: now + OTP_LIFETIME_MS,
        attempts: 0
      });
      return { status: 201 };
    });

    if (result.status !== 201) return jsonResponse({ error: result.error }, result.status);
    return jsonResponse({ ok: true }, 201);
  }

  async verify(body) {
    if (typeof body.challengeId !== 'string' || !/^[a-f0-9]{64}\.[0-9a-f-]{36}$/.test(body.challengeId) ||
        typeof body.codeHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.codeHash)) {
      return jsonResponse({ error: 'קוד האימות אינו תקף או שפג תוקפו.' }, 400);
    }

    const now = Date.now();
    const result = await this.ctx.storage.transaction(async transaction => {
      const challenge = await transaction.get('challenge');
      if (!challenge || challenge.challengeId !== body.challengeId) {
        return { status: 410, error: 'קוד האימות אינו תקף או שפג תוקפו.' };
      }
      if (challenge.expiresAt <= now) {
        await transaction.delete('challenge');
        return { status: 410, error: 'קוד האימות פג תוקפו. בקש קוד חדש.' };
      }
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        await transaction.delete('challenge');
        return { status: 429, error: 'נחסמו ניסיונות האימות. בקש קוד חדש.' };
      }

      challenge.attempts++;
      if (!constantTimeEqual(challenge.codeHash, body.codeHash)) {
        if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
          await transaction.delete('challenge');
          return { status: 429, error: 'נחסמו ניסיונות האימות. בקש קוד חדש.' };
        }
        await transaction.put('challenge', challenge);
        return { status: 401, error: 'קוד האימות שגוי.' };
      }

      await transaction.delete('challenge');
      return { status: 200, uid: challenge.uid };
    });

    if (result.status !== 200) return jsonResponse({ error: result.error }, result.status);
    return jsonResponse({ uid: result.uid }, 200);
  }

  async revoke(body) {
    if (typeof body.challengeId !== 'string') return jsonResponse({ error: 'Invalid challenge.' }, 400);
    await this.ctx.storage.transaction(async transaction => {
      const challenge = await transaction.get('challenge');
      if (challenge && challenge.challengeId === body.challengeId) {
        await transaction.delete('challenge');
      }
    });
    return jsonResponse({ ok: true }, 200);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const appOrigin = String(env.APP_ORIGIN || '').trim();
    if (origin && origin !== appOrigin) {
      return jsonResponse({ error: 'Origin not allowed.' }, 403);
    }

    const corsOrigin = origin === appOrigin ? origin : '';
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), corsOrigin);
    }

    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/.well-known/openid-configuration') {
      if (!env.WIF_ISSUER) return jsonResponse({ error: 'OIDC issuer is not configured.' }, 503);
      return jsonResponse(oidcDiscovery(env), 200);
    }
    if (request.method === 'GET' && path === '/.well-known/jwks.json') {
      if (!env.WIF_SIGNING_PRIVATE_KEY || !env.WIF_SIGNING_KEY_ID) {
        return jsonResponse({ error: 'OIDC signing key is not configured.' }, 503);
      }
      try {
        return jsonResponse({ keys: [await publicSigningJwk(env)] }, 200);
      } catch (error) {
        console.error('OIDC public-key generation failed:', error.message);
        return jsonResponse({ error: 'OIDC signing key is invalid.' }, 503);
      }
    }
    if (request.method === 'GET' && path === '/health') {
      const ready = workerIsConfigured(env);
      return withCors(jsonResponse({ ok: ready, service: 'crm-auth' }, ready ? 200 : 503), corsOrigin);
    }
    if (request.method !== 'POST') {
      return withCors(jsonResponse({ error: 'Method not allowed.' }, 405), corsOrigin);
    }
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return withCors(jsonResponse({ error: 'Content-Type must be application/json.' }, 415), corsOrigin);
    }
    if (!workerIsConfigured(env)) {
      return withCors(jsonResponse({ error: 'שירות האימות עדיין לא הוגדר.' }, 503), corsOrigin);
    }

    let response;
    try {
      if (path === '/auth/start') {
        response = await startChallenge(request, env);
      } else if (path === '/auth/verify') {
        response = await verifyChallenge(request, env);
      } else if (path === '/admin/users/create') {
        response = await createUserForAdmin(request, env);
      } else if (path === '/admin/users/invite') {
        response = await sendInviteForAdmin(request, env);
      } else {
        response = jsonResponse({ error: 'Not found.' }, 404);
      }
    } catch (error) {
      console.error('MFA request failed:', error.message);
      response = jsonResponse({ error: 'שירות האימות אינו זמין כרגע. נסה שוב מאוחר יותר.' }, 500);
    }
    return withCors(response, corsOrigin);
  }
};
