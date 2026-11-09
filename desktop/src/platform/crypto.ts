import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { b64ToBytes, bytesToB64, utf8 } from '../lib/b64';

// Pure-JS SHA-512 so Ed25519 works even where crypto.subtle is unavailable (non-secure origins).
ed.hashes.sha512 = sha512;

/** Spec §0: SHA-256(pub) → hex upper → first 32 chars → groups of 4 joined by ':'. */
export function fingerprintOf(publicKeyB64: string): string {
  const hex = Array.from(sha256(b64ToBytes(publicKeyB64)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .slice(0, 32);
  return hex.match(/.{4}/g)!.join(':');
}

export async function verifyEd25519(publicKeyB64: string, message: string, sigB64: string): Promise<boolean> {
  try {
    return ed.verify(b64ToBytes(sigB64), utf8(message), b64ToBytes(publicKeyB64));
  } catch {
    return false;
  }
}

export async function signEd25519(secret: Uint8Array, message: string): Promise<string> {
  return bytesToB64(ed.sign(utf8(message), secret));
}

export async function newKeypair(): Promise<{ secret: Uint8Array; publicKey: Uint8Array }> {
  const secret = ed.utils.randomSecretKey();
  const publicKey = ed.getPublicKey(secret);
  return { secret, publicKey };
}

export async function publicFromSecret(secret: Uint8Array): Promise<Uint8Array> {
  return ed.getPublicKey(secret);
}
