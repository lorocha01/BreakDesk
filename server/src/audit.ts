import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db.js';

export interface AuditEntry {
  event: string;
  actorDevice?: string | null;
  actorUser?: string | null;
  subjectDevice?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export class Audit {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
  ) {}

  async write(e: AuditEntry): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit_log (event, actor_device, actor_user, subject_device, session_id, ip, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [e.event, e.actorDevice ?? null, e.actorUser ?? null, e.subjectDevice ?? null, e.sessionId ?? null, e.ip ?? null, e.detail ?? {}],
      );
    } catch (err) {
      this.log.error({ err, event: e.event }, 'falha ao gravar auditoria');
    }
  }
}
