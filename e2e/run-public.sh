#!/usr/bin/env bash
# E2E contra um servidor PÚBLICO já no ar (rendezvous + TURN via HTTPS/WSS), com o app
# desktop Tauri como host e a UI web no Chromium como viewer. Cenários P2P e relay.
#   PUBLIC_SERVER=https://remoto.exemplo.com e2e/run-public.sh
#   (para testar uma pilha local com certificado interno: IGNORE_HTTPS=1 e confie a CA no sistema)
# Variável opcional HOST_ID_CMD: comando que imprime o ID do host recém-registrado.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${PUBLIC_SERVER:?defina PUBLIC_SERVER=https://...}"
WORK="${E2E_WORK:-$(mktemp -d /tmp/nexo-e2e-pub.XXXX)}"; export E2E_WORK="$WORK"
DISP=":95"; APP_PORT=4183; PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
mkdir -p "$WORK"/{received,out,host-share/pasta}
head -c 250000 /dev/urandom > "$WORK/host-share/pasta/dados.bin"

( cd "$ROOT/desktop" && VITE_NEXO_SERVER="$PUBLIC_SERVER" npm run -s build >/dev/null )
( cd "$ROOT" && cargo build -q -p nexo-desktop --features tauri/custom-protocol )

Xvfb $DISP -screen 0 1600x900x24 -nolisten tcp >/dev/null 2>&1 & PIDS+=($!)
sleep 1
DISPLAY=$DISP xterm -geometry 200x60+0+0 -fa Monospace -fs 14 -e bash --norc --noprofile -c "cd '$WORK'; PS1='host\$ ' exec bash --norc -i" >/dev/null 2>&1 & PIDS+=($!)

APPHOME="$WORK/apphome"; CFG="$APPHOME/.config/br.com.nexo.remote"; mkdir -p "$CFG"
NAME="Host-Publico-$RANDOM"
HASH="$(cd "$ROOT/server" && node -e "import('@node-rs/argon2').then(a=>a.hash(process.argv[1],{algorithm:2}).then(console.log))" "senha-e2e-123")"
cat > "$CFG/settings.json" <<JSON
{"serverUrl":"http://localhost:8080","deviceName":"$NAME","unattended":{"enabled":true,"allowedDeviceIds":[]},
 "receiveDir":"$WORK/received","defaultPermissions":{"input":true,"files":true,"chat":true}}
JSON
printf '{"unattendedHash":"%s"}' "$HASH" > "$CFG/secrets.json"
# serverUrl antigo (rede local) de propósito: o app deve migrar sozinho para o servidor público.
HOME="$APPHOME" XDG_CONFIG_HOME="$APPHOME/.config" DISPLAY=$DISP WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  dbus-run-session -- "$ROOT/target/debug/nexo" --minimized > "$WORK/out/desktop.log" 2>&1 & PIDS+=($!)

HOST_ID=""
for _ in $(seq 1 120); do
  if [ -n "${HOST_ID_CMD:-}" ]; then HOST_ID="$(NAME="$NAME" bash -c "$HOST_ID_CMD" 2>/dev/null || true)"; fi
  [ -n "$HOST_ID" ] && break; sleep 0.5
done
[ -n "$HOST_ID" ] || { echo "host não registrou no servidor público"; cat "$CFG/nexo.log" 2>/dev/null; exit 1; }
echo "[e2e] host $NAME = $HOST_ID ; servidor configurado: $(grep -o '"serverUrl": *"[^"]*"' "$CFG/settings.json")"
sleep 3

( cd "$ROOT/desktop" && npx vite preview --port $APP_PORT --strictPort >/dev/null 2>&1 ) & PIDS+=($!)
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$APP_PORT" >/dev/null 2>&1 && break; sleep 0.2; done
DISPLAY=$DISP HOST_ID="$HOST_ID" SERVER="$PUBLIC_SERVER" APP="http://127.0.0.1:$APP_PORT" node "$ROOT/e2e/real-host.e2e.cjs"
