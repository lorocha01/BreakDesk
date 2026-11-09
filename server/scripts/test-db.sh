#!/usr/bin/env bash
# Sobe (ou derruba) um cluster PostgreSQL descartável para testes/desenvolvimento local.
#   scripts/test-db.sh start   -> imprime DATABASE_URL na última linha
#   scripts/test-db.sh stop
# Variáveis: PGPORT (5433), PGDATA_DIR (/tmp/nexo-pg-$PGPORT), PG_BIN (/usr/lib/postgresql/16/bin)
set -euo pipefail
PGPORT="${PGPORT:-5433}"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="${PGDATA_DIR:-/tmp/nexo-pg-$PGPORT}"
DB="${PGDATABASE_NAME:-nexo}"

as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

case "${1:-start}" in
  start)
    if [ ! -f "$DATA/PG_VERSION" ]; then
      mkdir -p "$DATA"
      [ "$(id -u)" = "0" ] && chown postgres:postgres "$DATA"
      as_pg "$PG_BIN/initdb" -D "$DATA" -U nexo --auth=trust -E UTF8 >/dev/null
    fi
    if ! as_pg "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      as_pg "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w \
        -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off" start >/dev/null
    fi
    if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U nexo -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
      "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U nexo "$DB"
    fi
    echo "postgres://nexo@127.0.0.1:$PGPORT/$DB"
    ;;
  stop)
    as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true
    ;;
  destroy)
    as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 || true
    rm -rf "$DATA"
    ;;
  *) echo "uso: $0 start|stop|destroy" >&2; exit 1 ;;
esac
