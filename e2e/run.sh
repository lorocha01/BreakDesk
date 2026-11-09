#!/usr/bin/env bash
# E2E real (Linux): servidor + PostgreSQL + coturn + nexo-hostd (Rust, capturando um Xvfb)
# + interface web real no Chromium (Playwright). Testa P2P e relay TURN forçado.
#   e2e/run.sh            # host = agente headless nexo-hostd
#   HOST_KIND=desktop e2e/run.sh   # host = app desktop Tauri real (UI + orquestração TS + núcleo Rust)
# Requisitos: Xvfb, xterm, xdotool, turnserver (coturn), postgresql 16, node 22, cargo.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${E2E_WORK:-$(mktemp -d /tmp/nexo-e2e.XXXX)}"
export E2E_WORK="$WORK"
DISP=":97"
SERVER_PORT=8092
APP_PORT=4183
TURN_SECRET="e2e-turn-secret-$(date +%s)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  [ -f /tmp/nexo-server.pid ] && kill "$(cat /tmp/nexo-server.pid)" 2>/dev/null || true
}
trap cleanup EXIT

echo "[e2e] workdir $WORK"
mkdir -p "$WORK"/{host,received,out}

# 1) Binários
HOST_KIND="${HOST_KIND:-hostd}"
( cd "$ROOT" && cargo build -q -p nexo-core --bin nexo-hostd --features hostd )
( cd "$ROOT/server" && [ -d node_modules ] || npm ci --silent; npm run -s build )
( cd "$ROOT/desktop" && [ -d node_modules ] || npm ci --silent; VITE_NEXO_SERVER="http://127.0.0.1:$SERVER_PORT" npm run -s build )
if [ "$HOST_KIND" = desktop ]; then
  ( cd "$ROOT" && cargo build -q -p nexo-desktop --features tauri/custom-protocol )
fi

# 2) coturn local (loopback liberado só para teste)
turnserver -n --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --listening-port=3479 \
  --use-auth-secret --static-auth-secret="$TURN_SECRET" --realm=nexo.e2e \
  --no-tls --no-dtls --no-cli --allow-loopback-peers --min-port=49300 --max-port=49400 \
  --log-file="$WORK/out/turn.log" --simple-log >/dev/null 2>&1 &
PIDS+=($!)

# 3) Servidor + Postgres
( cd "$ROOT/server" && PORT=$SERVER_PORT PGPORT=5495 TURN_SECRET="$TURN_SECRET" \
  TURN_URLS="turn:127.0.0.1:3479?transport=udp" STUN_URLS="stun:127.0.0.1:3479" \
  scripts/dev.sh --detach )

# 4) Tela virtual com um terminal em tela cheia (foco segue o ponteiro, sem WM)
Xvfb $DISP -screen 0 1600x900x24 -nolisten tcp >/dev/null 2>&1 &
PIDS+=($!)
sleep 1
DISPLAY=$DISP xterm -geometry 200x60+0+0 -fa Monospace -fs 14 -bg '#0b1020' -fg '#e2e8f0' \
  -e bash --norc --noprofile -c "cd '$WORK'; PS1='host\$ ' exec bash --norc -i" >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

# 5) Arquivo para download no host
mkdir -p "$WORK/host-share/pasta"
head -c 250000 /dev/urandom > "$WORK/host-share/pasta/dados.bin"
echo "relatorio do host" > "$WORK/host-share/pasta/leia-me.txt"

# 6) Host: agente headless (padrão) ou app desktop real
if [ "$HOST_KIND" = desktop ]; then
  APPHOME="$WORK/apphome"; CFG="$APPHOME/.config/br.com.nexo.remote"; mkdir -p "$CFG"
  HASH="$(cd "$ROOT/server" && node -e "import('@node-rs/argon2').then(a=>a.hash(process.argv[1],{algorithm:2}).then(console.log))" "senha-e2e-123")"
  cat > "$CFG/settings.json" <<JSON
{"serverUrl":"http://127.0.0.1:$SERVER_PORT","deviceName":"Desktop-E2E","unattended":{"enabled":true,"allowedDeviceIds":[]},
 "receiveDir":"$WORK/received","defaultPermissions":{"input":true,"files":true,"chat":true},"fps":30,"quality":"auto"}
JSON
  printf '{"unattendedHash":"%s"}' "$HASH" > "$CFG/secrets.json"
  HOME="$APPHOME" XDG_CONFIG_HOME="$APPHOME/.config" DISPLAY=$DISP WEBKIT_DISABLE_COMPOSITING_MODE=1 dbus-run-session -- "$ROOT/target/debug/nexo" --minimized > "$WORK/out/desktop.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 150); do
    HOST_ID="$(psql -At -h 127.0.0.1 -p 5495 -U nexo nexo -c "select id from devices where name='Desktop-E2E' order by created_at desc limit 1" 2>/dev/null || true)"
    [ -n "$HOST_ID" ] && break; sleep 0.2
  done
  [ -n "$HOST_ID" ] || { echo "app desktop não registrou"; tail -30 "$WORK/out/desktop.log"; exit 1; }
  sleep 3 # tempo para o WebSocket do app ficar online
else
  DISPLAY=$DISP NEXO_PASSWORD="senha-e2e-123" "$ROOT/target/debug/nexo-hostd" \
    --server "http://127.0.0.1:$SERVER_PORT" --data-dir "$WORK/host" --name "Host-E2E" \
    --receive-dir "$WORK/received" --fps 20 > "$WORK/out/hostd.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 100); do grep -q '^NEXO_ID=' "$WORK/out/hostd.log" && break; sleep 0.2; done
  HOST_ID="$(grep '^NEXO_ID=' "$WORK/out/hostd.log" | head -1 | cut -d= -f2)"
  [ -n "$HOST_ID" ] || { echo "hostd sem ID"; cat "$WORK/out/hostd.log"; exit 1; }
fi
echo "[e2e] host id $HOST_ID"

# 7) UI web servida
( cd "$ROOT/desktop" && npx vite preview --port $APP_PORT --strictPort >/dev/null 2>&1 ) &
PIDS+=($!)
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$APP_PORT" >/dev/null 2>&1 && break; sleep 0.2; done

# 8) Playwright
DISPLAY=$DISP HOST_ID="$HOST_ID" SERVER="http://127.0.0.1:$SERVER_PORT" APP="http://127.0.0.1:$APP_PORT" \
  node "$ROOT/e2e/real-host.e2e.cjs"
