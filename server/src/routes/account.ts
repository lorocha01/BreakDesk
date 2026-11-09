import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireAuth } from '../context.js';
import { HttpError } from '../errors.js';
import { SlidingWindowLimiter } from '../ratelimit.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // OWASP (argon2id)

const Email = z.string().trim().toLowerCase().max(254).pipe(z.email('E-mail inválido.'));
const RegisterBody = z.object({
  email: Email,
  password: z.string().min(10, 'A senha deve ter ao menos 10 caracteres.').max(256),
  displayName: z.string().trim().min(1).max(80),
});
const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) });

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: Date;
  password_hash: string;
}
const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at });

export async function accountRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { db, cfg, audit, tokens, hub } = ctx;
  const failures = new SlidingWindowLimiter(cfg.loginMaxFailures, cfg.loginWindowMs);
  const registerLimiter = new SlidingWindowLimiter(cfg.registerPerHour, 3600_000);
  // Hash fictício para equalizar o tempo quando o e-mail não existe.
  const dummyHash = await hash('nexo-dummy-password-for-timing', ARGON);
  app.addHook('onClose', async () => {
    failures.close();
    registerLimiter.close();
  });

  app.post('/auth/register', async (req, reply) => {
    const body = RegisterBody.parse(req.body);
    if (!registerLimiter.take(`user:${req.ip}`)) throw new HttpError(429, 'RATE_LIMITED', 'Muitos cadastros a partir deste endereço.');
    const passwordHash = await hash(body.password, ARGON);
    const r = await db.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING id, email, display_name, created_at, password_hash`,
      [body.email, passwordHash, body.displayName],
    );
    const u = r.rows[0];
    if (!u) throw new HttpError(409, 'EMAIL_TAKEN', 'E-mail já cadastrado.');
    await audit.write({ event: 'user_register', actorUser: u.id, ip: req.ip });
    const { token } = await tokens.issue('user', u.id);
    reply.code(201);
    return { user: publicUser(u), token };
  });

  app.post('/auth/login', async (req) => {
    const body = LoginBody.parse(req.body);
    const key = `${body.email}|${req.ip}`;
    if (failures.blocked(key)) {
      await audit.write({ event: 'user_login_blocked', ip: req.ip, detail: { email: body.email } });
      throw new HttpError(429, 'LOCKED', 'Muitas tentativas. Tente novamente mais tarde.', {
        'retry-after': String(failures.retryAfterSec(key)),
      });
    }
    const r = await db.query<UserRow>(
      'SELECT id, email, display_name, created_at, password_hash FROM users WHERE lower(email)=$1',
      [body.email],
    );
    const u = r.rows[0];
    const ok = await verify(u?.password_hash ?? dummyHash, body.password).catch(() => false);
    if (!u || !ok) {
      failures.hit(key);
      await audit.write({ event: 'user_login_failed', actorUser: u?.id ?? null, ip: req.ip, detail: { email: body.email } });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.');
    }
    failures.reset(key);
    await audit.write({ event: 'user_login', actorUser: u.id, ip: req.ip });
    const { token } = await tokens.issue('user', u.id);
    return { user: publicUser(u), token };
  });

  app.get('/me', async (req) => {
    const userId = await requireAuth(ctx, req, 'user');
    const r = await db.query<UserRow>('SELECT id, email, display_name, created_at, password_hash FROM users WHERE id=$1', [userId]);
    if (!r.rows[0]) throw new HttpError(401, 'UNAUTHORIZED', 'Usuário não existe mais.');
    return { user: publicUser(r.rows[0]) };
  });

  app.post('/account/devices/link', async (req) => {
    const deviceId = await requireAuth(ctx, req, 'device');
    const { userToken } = z.object({ userToken: z.string().min(10).max(2048) }).parse(req.body);
    const userId = await tokens.verify(userToken, 'user');
    if (!userId) throw new HttpError(401, 'UNAUTHORIZED', 'Token de usuário inválido.');
    await db.query('UPDATE devices SET user_id=$2 WHERE id=$1', [deviceId, userId]);
    await audit.write({ event: 'device_linked', actorDevice: deviceId, actorUser: userId, ip: req.ip });
    return { ok: true };
  });

  app.get('/account/devices', async (req) => {
    const userId = await requireAuth(ctx, req, 'user');
    const r = await db.query<{ id: string; name: string; os: string; fingerprint: string; last_seen_at: Date | null }>(
      'SELECT id, name, os, fingerprint, last_seen_at FROM devices WHERE user_id=$1 ORDER BY last_seen_at DESC NULLS LAST',
      [userId],
    );
    return {
      devices: r.rows.map((d) => ({
        deviceId: d.id,
        name: d.name,
        os: d.os,
        fingerprint: d.fingerprint,
        online: hub.isOnline(d.id),
        lastSeenAt: d.last_seen_at,
      })),
    };
  });

  app.delete('/account/devices/:id', async (req) => {
    const userId = await requireAuth(ctx, req, 'user');
    const { id } = z.object({ id: z.string().regex(/^[1-9][0-9]{8}$/) }).parse(req.params);
    const r = await db.query('UPDATE devices SET user_id=NULL WHERE id=$1 AND user_id=$2', [id, userId]);
    if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Dispositivo não vinculado a esta conta.');
    await audit.write({ event: 'device_unlinked', actorUser: userId, subjectDevice: id, ip: req.ip });
    return { ok: true };
  });
}
