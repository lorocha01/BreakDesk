import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Audit } from './audit.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createDb, type Db } from './db.js';
import { HttpError } from './errors.js';
import { accountRoutes } from './routes/account.js';
import { deviceRoutes } from './routes/devices.js';
import { SignalingHub } from './signaling.js';
import { Tokens } from './tokens.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function buildApp(cfg: Config, db: Db = createDb(cfg.databaseUrl), ownsDb = true): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
      ...(cfg.env === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    bodyLimit: cfg.maxMessageBytes,
    trustProxy: cfg.trustProxy,
  });

  const tokens = new Tokens(cfg.jwtSecret);
  const audit = new Audit(db, app.log);
  const hub = new SignalingHub(cfg, db, tokens, audit, app.log);
  const ctx: AppContext = { cfg, db, tokens, audit, hub };

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });

  // Cabeçalhos de segurança (equivalente ao helmet para uma API JSON).
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-site');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cache-control', 'no-store');
    if (cfg.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: first ? `${first.path.join('.') || 'corpo'}: ${first.message}` : 'Requisição inválida.',
      });
    }
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: e.code ?? 'BAD_REQUEST', message: e.message ?? 'Requisição inválida.' });
    }
    req.log.error({ err }, 'erro não tratado');
    return reply.code(500).send({ error: 'INTERNAL', message: 'Erro interno.' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: 'Rota não encontrada.' }));

  app.get('/healthz', async () => ({ ok: true }));
  await app.register(
    async (api) => {
      await deviceRoutes(api, ctx);
      await accountRoutes(api, ctx);
    },
    { prefix: '/api/v1' },
  );

  hub.attach(app.server);
  await hub.recoverOnStartup();
  app.addHook('onClose', async () => {
    await hub.close();
    if (ownsDb) await db.end();
  });
  return { app, ctx };
}
