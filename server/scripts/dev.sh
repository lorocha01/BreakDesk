#!/usr/bin/env bash
# Sobe Postgres descartável + migrações + servidor Nexo para desenvolvimento/E2E local.
#   scripts/dev.sh            -> servidor em primeiro plano (tsx watch)
#   scripts/dev.sh --built    -> usa dist/ (npm run build antes)
#   scripts/dev.sh --detach   -> roda em segundo plano; PID em /tmp/nexo-server.pid, log em /tmp/nexo-server.log
# Variáveis úteis: PORT (8080), PGPORT (5434), CORS_ORIGINS, TURN_URLS, TURN_SECRET, STUN_URLS
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPORT="${PGPORT:-5434}"
export DATABASE_URL="$(scripts/test-db.sh start | tail -1)"
export PORT="${PORT:-8080}"
export NODE_ENV="${NODE_ENV:-development}"
export CORS_ORIGINS="${CORS_ORIGINS:-*}"
export MIGRATE_ON_START=true
[ -d node_modules ] || npm ci
echo "DATABASE_URL=$DATABASE_URL"
echo "Servidor em http://localhost:$PORT  (WS: ws://localhost:$PORT/ws)"
case "${1:-}" in
  --built)  [ -f dist/index.js ] || npm run build; exec node dist/index.js ;;
  --detach)
    [ -f dist/index.js ] || npm run build
    LOG_LEVEL="${LOG_LEVEL:-info}" nohup node dist/index.js > /tmp/nexo-server.log 2>&1 &
    echo $! > /tmp/nexo-server.pid
    for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && { echo "pronto (PID $(cat /tmp/nexo-server.pid))"; exit 0; }; sleep 0.2; done
    echo "servidor não respondeu; veja /tmp/nexo-server.log" >&2; exit 1 ;;
  *) exec npx tsx watch src/index.ts ;;
esac
