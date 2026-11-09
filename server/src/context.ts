import type { FastifyRequest } from 'fastify';
import type { Audit } from './audit.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import type { SignalingHub } from './signaling.js';
import type { Tokens, TokenType } from './tokens.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  tokens: Tokens;
  audit: Audit;
  hub: SignalingHub;
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

export async function requireAuth(ctx: AppContext, req: FastifyRequest, typ: TokenType): Promise<string> {
  const t = bearer(req);
  const sub = t ? await ctx.tokens.verify(t, typ) : null;
  if (!sub) throw new HttpError(401, 'UNAUTHORIZED', typ === 'device' ? 'Token de dispositivo inválido.' : 'Token de usuário inválido.');
  return sub;
}
