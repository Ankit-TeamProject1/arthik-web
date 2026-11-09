// Same envelope as the Android app's BackupCrypto:
// PBKDF2WithHmacSHA256 -> AES-256-GCM, data = ciphertext || 16-byte tag.
const ENC = 'arthik-backup-encrypted';
const ITER = 210000;
const b64 = {
  enc: (u8) => { let s = ''; u8.forEach(b => s += String.fromCharCode(b)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

export function isEncrypted(text) {
  try { return JSON.parse(text).format === ENC; } catch { return false; }
}

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(plainText, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITER);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, new TextEncoder().encode(plainText)));
  return JSON.stringify({
    format: ENC, version: 1, kdf: 'PBKDF2WithHmacSHA256', iterations: ITER, cipher: 'AES-256-GCM',
    salt: b64.enc(salt), iv: b64.enc(iv), data: b64.enc(sealed),
  }, null, 2);
}

/** Returns {ok:true,text} | {ok:false, reason:'wrong'|'malformed'} */
export async function decrypt(envelopeText, password) {
  let env;
  try { env = JSON.parse(envelopeText); } catch { return { ok: false, reason: 'malformed' }; }
  if (env.format !== ENC) return { ok: false, reason: 'malformed' };
  try {
    const key = await deriveKey(password, b64.dec(env.salt), env.iterations || ITER);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(env.iv), tagLength: 128 }, key, b64.dec(env.data));
    return { ok: true, text: new TextDecoder().decode(plain) };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'OperationError' ? 'wrong' : 'malformed' };
  }
}
