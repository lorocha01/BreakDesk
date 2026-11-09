#!/usr/bin/env bash
# Instala o servidor público do Nexo numa VPS (Ubuntu 22.04/24.04 ou Debian 12):
#   - rendezvous: IDs, autenticação, sinalização e histórico (servidor Nexo + PostgreSQL)
#   - relay: TURN (coturn) para quando os computadores não conseguem conexão direta
#   - HTTPS automático (Caddy + Let's Encrypt)
#
# Uso (na VPS, dentro da pasta do projeto):
#   sudo infra/instalar-servidor.sh                       # sem domínio: usa <ip>.sslip.io
#   sudo infra/instalar-servidor.sh remoto.empresa.com.br   # com domínio próprio
#
# Com domínio próprio, crie antes um registro DNS "A" apontando o domínio para o IP da VPS.
# Rodar de novo é seguro: mantém as senhas já geradas (.env) e atualiza os contêineres.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" = 0 ] || { echo "Rode com sudo: sudo $0 $*"; exit 1; }

echo "==> Verificando Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 não encontrado."; exit 1; }

echo "==> Descobrindo o IP público"
PUBLIC_IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me || true)"
[ -n "$PUBLIC_IP" ] || { echo "Não consegui descobrir o IP público desta VPS."; exit 1; }
PRIVATE_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')"

EXISTING_DOMAIN="$( [ -f .env ] && sed -n 's/^NEXO_DOMAIN=//p' .env || true )"
DOMAIN="${1:-${EXISTING_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}}"

if [ ! -f .env ]; then
  echo "==> Gerando senhas (.env)"
  cat > .env <<ENV
NEXO_DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
TURN_SECRET=$(openssl rand -hex 32)
TURN_EXTERNAL_IP=
CORS_ORIGINS=tauri://localhost,http://tauri.localhost,https://tauri.localhost
LOG_LEVEL=info
ENV
  chmod 600 .env
else
  sed -i "s|^NEXO_DOMAIN=.*|NEXO_DOMAIN=$DOMAIN|" .env
fi

# VPS atrás de NAT 1:1 (AWS, GCP, Azure, Oracle): o TURN precisa anunciar o IP público.
if [ -n "$PRIVATE_IP" ] && [ "$PRIVATE_IP" != "$PUBLIC_IP" ]; then
  sed -i "s|^TURN_EXTERNAL_IP=.*|TURN_EXTERNAL_IP=$PUBLIC_IP/$PRIVATE_IP|" .env
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Liberando portas no firewall (ufw)"
  ufw allow 80/tcp && ufw allow 443/tcp
  ufw allow 3478/tcp && ufw allow 3478/udp && ufw allow 5349/tcp
  ufw allow 49160:49200/udp
fi

echo "==> Subindo os serviços (a primeira vez leva alguns minutos)"
docker compose up -d --build

echo "==> Aguardando o HTTPS de https://$DOMAIN"
ok=""
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [ -z "$ok" ]; then
  echo
  echo "O servidor subiu, mas https://$DOMAIN ainda não respondeu."
  echo "Confira: o domínio aponta para $PUBLIC_IP? As portas 80 e 443 estão abertas no painel da VPS?"
  echo "Logs: docker compose -f $(pwd)/docker-compose.yml logs caddy server"
  exit 1
fi

# O TURN sobre TLS (5349) usa o certificado emitido pelo Caddy: reinicia agora que ele existe.
docker compose restart coturn >/dev/null

cat <<MSG

============================================================
 Servidor público do Nexo pronto!

   Endereço:  https://$DOMAIN

 Portas que precisam estar abertas no painel da VPS (firewall do provedor):
   TCP 80, 443, 3478, 5349   e   UDP 3478, 49160-49200

 Para gerar o instalador do app já configurado com este servidor:
   NEXO_SERVER=https://$DOMAIN installer/windows/build.sh

 Ou, nos apps já instalados: Configurações -> Geral -> Servidor:
   https://$DOMAIN   -> Aplicar
============================================================
MSG
