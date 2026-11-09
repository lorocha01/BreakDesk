# Nexo — Infraestrutura

Componentes (todos em `docker-compose.yml`):

| Serviço | Função | Exposição |
|---|---|---|
| `caddy` | TLS automático (Let's Encrypt) e proxy reverso de `/api`, `/ws`, `/healthz` | 80/tcp, 443/tcp |
| `server` | API REST, autenticação de dispositivos/usuários, sinalização WebSocket, sessões, auditoria | interno (8080) |
| `postgres` | Usuários, dispositivos, sessões, auditoria | rede interna (sem porta pública) |
| `coturn` | STUN/TURN para NAT traversal e relay quando P2P não é possível | 3478/udp+tcp, 5349/tcp, 49160-49200/udp |

## Implantação em uma VPS

Requisitos: Linux com Docker + Compose v2, um domínio (ex.: `nexo.suaempresa.com.br`)
com registro **A/AAAA** apontando para o IP público da VPS.

1. Libere no firewall (e no *security group* do provedor):

   | Porta | Protocolo | Uso |
   |---|---|---|
   | 80 | TCP | Desafio HTTP do Let's Encrypt / redirecionamento |
   | 443 | TCP | API + WebSocket (HTTPS/WSS) |
   | 3478 | UDP **e** TCP | STUN/TURN |
   | 5349 | TCP | TURN sobre TLS (redes que só liberam TLS) |
   | 49160–49200 | UDP | Portas de relay do TURN |

   Exemplo com `ufw`:
   ```bash
   ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 3478 && ufw allow 5349/tcp && ufw allow 49160:49200/udp
   ```

2. Configure as variáveis:
   ```bash
   cd infra
   cp .env.example .env
   # preencha NEXO_DOMAIN, ACME_EMAIL e gere os segredos:
   openssl rand -hex 24      # POSTGRES_PASSWORD
   openssl rand -base64 48   # JWT_SECRET
   openssl rand -hex 32      # TURN_SECRET
   ```
   Em provedores com NAT 1:1 (AWS, GCP, Azure), defina `TURN_EXTERNAL_IP` com o IP público.

3. Suba tudo:
   ```bash
   docker compose up -d --build
   docker compose logs -f server
   curl https://$NEXO_DOMAIN/healthz   # {"ok":true}
   ```
   As migrações do banco rodam automaticamente na inicialização do servidor.

4. No aplicativo desktop, em **Configurações → Servidor**, use `https://SEU_DOMINIO`.

### Certificado do TURN (porta 5349)

O `coturn` lê o certificado emitido pelo Caddy (volume `caddy_data`, somente leitura).
Na primeira subida o Caddy ainda pode não ter emitido o certificado; depois que
`https://SEU_DOMINIO` responder, reinicie o TURN para ativar o TLS:
```bash
docker compose restart coturn
```
Sem TLS o TURN continua funcionando em 3478 (UDP/TCP). Renovações: reinicie o
`coturn` periodicamente (ex.: cron semanal) para recarregar o certificado.

## Credenciais TURN

O servidor gera credenciais **efêmeras** (esquema REST do coturn, `use-auth-secret`):
`username = "<expiração-unix>:<deviceId>"`, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`,
válidas por 6 h. Nenhuma senha fixa de TURN é distribuída aos clientes.
O relay é proibido para faixas privadas/loopback (`denied-peer-ip`) para evitar
que o TURN seja usado para acessar a rede interna do servidor.

## Operação

- Backup do banco: `docker compose exec postgres pg_dump -U nexo nexo > backup.sql`
- Atualizar: `git pull && docker compose up -d --build`
- Logs: `docker compose logs -f server coturn`
- Escala: o hub de sinalização mantém presença em memória — rode **uma** instância
  do `server` (para várias instâncias seria necessário um barramento, ex. Redis pub/sub).
