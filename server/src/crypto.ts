import { createHash, createHmac, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Decodifica base64 padrão estritamente (rejeita caracteres inválidos). */
export function decodeB64(s: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  return Buffer.from(s, 'base64');
}

export function parsePublicKey(b64: string): Buffer | null {
  const raw = decodeB64(b64);
  return raw && raw.length === 32 ? raw : null;
}

/** SHA-256(pub) → hex maiúsculo → 32 primeiros caracteres → grupos de 4 com ':' */
export function fingerprint(pub: Buffer): string {
  const hex = createHash('sha256').update(pub).digest('hex').toUpperCase().slice(0, 32);
  return hex.match(/.{4}/g)!.join(':');
}

export function verifyEd25519(pub: Buffer, message: string, signatureB64: string): boolean {
  const sig = decodeB64(signatureB64);
  if (!sig || sig.length !== 64 || pub.length !== 32) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** ID numérico de 9 dígitos, primeiro dígito ≠ 0. */
export function newDeviceId(): string {
  return String(randomInt(100_000_000, 1_000_000_000));
}

export function randomB64(bytes = 32): string {
  return randomBytes(bytes).toString('base64');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function hmacSha1B64(secret: string, data: string): string {
  return createHmac('sha1', secret).update(data).digest('base64');
}
