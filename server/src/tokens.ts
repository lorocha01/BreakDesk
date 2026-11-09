import { SignJWT, jwtVerify } from 'jose';

export type TokenType = 'device' | 'user';

export const DEVICE_TOKEN_TTL_SEC = 12 * 3600;
export const USER_TOKEN_TTL_SEC = 7 * 24 * 3600;

export class Tokens {
  private key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(typ: TokenType, sub: string): Promise<{ token: string; expiresAt: string }> {
    const ttl = typ === 'device' ? DEVICE_TOKEN_TTL_SEC : USER_TOKEN_TTL_SEC;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const token = await new SignJWT({ typ })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(exp)
      .setIssuer('nexo')
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Retorna o `sub` se o token for válido e do tipo esperado; senão null. */
  async verify(token: string, typ: TokenType): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'], issuer: 'nexo' });
      if (payload.typ !== typ || typeof payload.sub !== 'string') return null;
      return payload.sub;
    } catch {
      return null;
    }
  }
}
