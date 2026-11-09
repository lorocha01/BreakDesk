#!/usr/bin/env bash
# Gera o instalador Windows (Nexo-Setup-<versão>.exe) a partir do Linux.
# Requisitos: rustup target x86_64-pc-windows-gnu, mingw-w64, nsis (makensis), node 22, curl, unzip.
#   installer/windows/build.sh            # compila tudo e gera o instalador em release/
#   SKIP_APP_BUILD=1 installer/windows/build.sh   # reaproveita o Nexo.exe já compilado
#   NEXO_SERVER=https://remoto.empresa.com.br installer/windows/build.sh
#                                   # app já sai usando o servidor público (rendezvous) da internet
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/installer/windows"
STAGE="$HERE/staging"
VERSION="$(node -p "require('$ROOT/desktop/package.json').version")"
NODE_VER="v22.11.0"
MINGW_RT="/usr/lib/gcc/x86_64-w64-mingw32/$(ls /usr/lib/gcc/x86_64-w64-mingw32 | grep -- '-win32$' | sort -V | tail -1)"

rm -rf "$STAGE" && mkdir -p "$STAGE/app" "$STAGE/server"

echo "[1/4] Aplicativo"
if [ -z "${SKIP_APP_BUILD:-}" ]; then
  (cd "$ROOT/desktop" && VITE_NEXO_SERVER="${NEXO_SERVER:-}" npm run -s build)
  echo "    servidor padrão do app: ${NEXO_SERVER:-rede local (descoberta automática)}"
  (cd "$ROOT" && CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
    cargo build --release --target x86_64-pc-windows-gnu -p nexo-desktop --features tauri/custom-protocol)
fi
REL="$ROOT/target/x86_64-pc-windows-gnu/release"
cp "$REL/nexo.exe" "$STAGE/app/Nexo.exe"
cp "$REL/WebView2Loader.dll" "$STAGE/app/"
cp "$MINGW_RT/libstdc++-6.dll" "$MINGW_RT/libgcc_s_seh-1.dll" "$STAGE/app/"
cp "$ROOT/desktop/src-tauri/icons/icon.ico" "$STAGE/nexo.ico"

echo "[2/4] Servidor (Node portátil + banco embutido)"
(cd "$ROOT/server" && npm run -s build)
cp -r "$ROOT/server/dist" "$ROOT/server/migrations" "$ROOT/server/package.json" "$ROOT/server/package-lock.json" "$STAGE/server/"
cp "$ROOT/server/scripts/windows/iniciar.mjs" "$ROOT/server/scripts/windows/Iniciar servidor Nexo.bat" "$STAGE/server/"
(cd "$STAGE/server" && npm ci --omit=dev --os=win32 --cpu=x64 --silent && rm -f package-lock.json)
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/nexo-installer"; mkdir -p "$CACHE"
[ -f "$CACHE/node-$NODE_VER.exe" ] || {
  curl -sSfLo "$CACHE/node.zip" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip"
  unzip -qjo "$CACHE/node.zip" "node-$NODE_VER-win-x64/node.exe" -d "$CACHE" && mv "$CACHE/node.exe" "$CACHE/node-$NODE_VER.exe"
  rm -f "$CACHE/node.zip"
}
mkdir -p "$STAGE/server/node" && cp "$CACHE/node-$NODE_VER.exe" "$STAGE/server/node/node.exe"

echo "[3/4] WebView2 (instalado só se faltar)"
[ -f "$CACHE/MicrosoftEdgeWebview2Setup.exe" ] || \
  curl -sSfLo "$CACHE/MicrosoftEdgeWebview2Setup.exe" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
cp "$CACHE/MicrosoftEdgeWebview2Setup.exe" "$STAGE/"

echo "[4/4] makensis"
(cd "$HERE" && makensis -V2 -DVERSION="$VERSION" nexo.nsi)
mkdir -p "$ROOT/release"
mv "$HERE/Nexo-Setup-$VERSION.exe" "$ROOT/release/"
rm -rf "$STAGE"
ls -la "$ROOT/release/Nexo-Setup-$VERSION.exe"
