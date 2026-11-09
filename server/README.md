# Nexo — Servidor

API REST + sinalização WebSocket do Nexo (Node 22, TypeScript, Fastify 5, PostgreSQL).
Contrato: [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) (seções 1–3).

## Desenvolvimento

```bash
npm ci
scripts/dev.sh            # Postgres descartável (porta 5434) + migrações + servidor em :8080 (tsx watch)
scripts/dev.sh --detach   # em segundo plano (PID em /tmp/nexo-server.pid, log em /tmp/nexo-server.log)
```

Scripts npm: `dev`, `build`, `start`, `migrate` (dev) / `migrate:prod` (após build), `test`, `typecheck`.
Variáveis: veja `.env.example`.

## Testes

```bash
npm test
```
Os testes usam um PostgreSQL **real**: se `DATABASE_URL` não estiver definida, o
`test/global-setup.ts` sobe um cluster descartável com `scripts/test-db.sh` (porta 5433)
e aplica as migrações. Cobrem: identidade/desafio Ed25519, contas e bloqueio de login,
credenciais TURN, fluxo completo de sinalização, recusa/cancelamento/expiração,
limites, substituição de socket, carência de reconexão e histórico/auditoria.

## Estrutura

```
src/
  app.ts          montagem do Fastify (CORS, cabeçalhos, erros, rotas, hub)
  config.ts       configuração por variáveis de ambiente
  signaling.ts    hub WebSocket: presença, máquina de estados de sessão, relay
  routes/devices.ts  registro, desafio/token, ICE, histórico, auditoria
  routes/account.ts  contas de usuário (Argon2id), vínculo de dispositivos
  crypto.ts       Ed25519, fingerprint, IDs
  tokens.ts       JWT (HS256) de dispositivo/usuário
  turn.ts         credenciais efêmeras do coturn
  audit.ts        gravação de auditoria
  migrate.ts      executor de migrações SQL
migrations/       SQL versionado
```
