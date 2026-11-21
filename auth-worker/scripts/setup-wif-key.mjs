import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'ttl-crm-wif-'));
const secretFile = path.join(temporaryDirectory, 'secret.json');

try {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  writeFileSync(secretFile, JSON.stringify({ WIF_SIGNING_PRIVATE_KEY: privateKey }), {
    encoding: 'utf8',
    mode: 0o600
  });

  const wranglerCli = path.join(workerDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const result = spawnSync(process.execPath, [wranglerCli, 'secret', 'bulk', secretFile], {
    cwd: workerDirectory,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler secret upload failed with exit code ${result.status}.`);
  }
  console.log('Workload Identity signing key uploaded. The temporary file was removed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
