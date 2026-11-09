# Nexo — Especificação de protocolo (contrato entre componentes)

Este documento é o **contrato** entre `server/` (Node/TS), `core/` (Rust, motor de host),
`desktop/src-tauri` (shell Tauri) e `desktop/src` (UI React). Qualquer mudança de
mensagem deve ser feita aqui primeiro.

Convenções:
- Todos os binários em JSON são **base64 padrão** (com padding).
- `deviceId`: string de 9 dígitos, primeiro dígito ≠ 0 (ex.: `"482913075"`), exibido como `482 913 075`.
- `fingerprint` de uma chave pública Ed25519 (32 bytes brutos):
  `SHA-256(pub)` → hex maiúsculo → primeiros 32 caracteres → grupos de 4 separados por `:`
  (ex.: `1A2B:3C4D:5E6F:7081:92A3:B4C5:D6E7:F809`).
- Tempo: ISO-8601 em REST; `ts` em ms epoch nas mensagens de tempo real.

## 1. Identidade do dispositivo

Cada instalação gera um par **Ed25519** no primeiro uso (privada nunca sai do Rust/
armazenamento local). O ID numérico é atribuído pelo servidor e associado à chave pública.
Autenticação do dispositivo = desafio/resposta assinado.

## 2. REST — base `/api/v1`

| Método | Rota | Auth | Corpo → Resposta |
|---|---|---|---|
| GET | `/healthz` (sem prefixo) | — | `{ok:true}` |
| POST | `/devices/register` | — (rate limit IP 20/h) | `{publicKey, name, os, appVersion}` → `{deviceId, fingerprint}` (idempotente por publicKey) |
| POST | `/auth/device/challenge` | — | `{deviceId}` → `{challengeId, nonce}` (TTL 60 s, uso único) |
| POST | `/auth/device/token` | — | `{challengeId, deviceId, signature}` → `{token, expiresAt}` |
| PATCH | `/devices/me` | device | `{name?, appVersion?, os?}` → `{ok:true}` |
| GET | `/devices/:id/public` | device | → `{deviceId, name, os, fingerprint, publicKey, online}` |
| GET | `/ice` | device | → `{iceServers:[{urls, username?, credential?}], ttl}` |
| GET | `/sessions?limit=50` | device | → `{sessions:[SessionRow]}` |
| GET | `/audit?limit=100` | device | → `{events:[AuditRow]}` |
| POST | `/auth/register` | — | `{email, password (≥10), displayName}` → `{user, token}` |
| POST | `/auth/login` | — | `{email, password}` → `{user, token}` (bloqueio: 5 falhas/15 min por e-mail+IP → 429) |
| GET | `/me` | user | → `{user}` |
| POST | `/account/devices/link` | device | `{userToken}` → `{ok:true}` |
| GET | `/account/devices` | user | → `{devices:[{deviceId,name,os,fingerprint,online,lastSeenAt}]}` |
| DELETE | `/account/devices/:id` | user | → `{ok:true}` |

Assinatura do token de dispositivo: Ed25519 sobre UTF-8 de
`nexo-auth-v1:${nonce}:${deviceId}` (nonce exatamente como string base64 recebida).

Auth: `Authorization: Bearer <jwt>`. JWT HS256 (`JWT_SECRET`), `typ` = `device` (12 h, `sub`=deviceId)
ou `user` (7 d, `sub`=userId). Rotas recusam o tipo errado com 401.

Erros REST: status HTTP + `{error: CODE, message}`.

`SessionRow`: `{id, viewerId, hostId, viewerName, hostName, mode, status, role:'viewer'|'host',
createdAt, acceptedAt, endedAt, durationSec, endReason}`.
`status ∈ pending|active|rejected|cancelled|timeout|ended`.

`AuditRow`: `{id, at, event, actorDevice, sessionId, ip, detail}`.

TURN (coturn `use-auth-secret`): `username = "${expiryEpochSec}:${deviceId}"`,
`credential = base64(HMAC-SHA1(TURN_SECRET, username))`, ttl 6 h.
Variáveis: `STUN_URLS`, `TURN_URLS` (separadas por vírgula), `TURN_SECRET`.

## 3. Sinalização — WebSocket `/ws?token=<device jwt>`

Uma conexão por dispositivo (nova substitui a antiga; antiga fecha com código `4001`).
Token inválido → fecha `4401`. Mensagens JSON `{type, ...}`, máx. 64 KiB.
Servidor envia ping de protocolo a cada 25 s; sem pong em 60 s → derruba.

### Servidor → cliente na conexão
- `{type:'welcome', deviceId, serverTime}`
- `{type:'active_sessions', sessions:[SessionStarted sem 'type']}` (sessões ativas a retomar)

### Cliente → servidor
| Mensagem | Quem | Efeito |
|---|---|---|
| `{type:'ping', ts}` | qualquer | → `{type:'pong', ts, serverTime}` |
| `{type:'connect', reqId, targetId, mode:'attended'\|'unattended', viewerName}` | viewer | cria sessão `pending` |
| `{type:'cancel', sessionId}` | viewer | pending → `cancelled` |
| `{type:'accept', sessionId, permissions:{input,files,chat}}` | host | pending → `active` |
| `{type:'reject', sessionId, reason?}` | host | pending → `rejected` (`reason` ex.: `user`, `busy`, `not_allowed`) |
| `{type:'signal', sessionId, data}` | qualquer parte da sessão ativa | repassado ao par |
| `{type:'end', sessionId, reason?}` | qualquer parte | → `ended` |
| `{type:'audit', sessionId?, event, detail?}` | qualquer | grava evento de auditoria `client.<event>` |

### Servidor → cliente
- `{type:'connect_pending', reqId, sessionId, target:{deviceId,name,os,fingerprint}}`
- `{type:'error', reqId?, sessionId?, code, message}` — `code ∈ NOT_FOUND|TARGET_OFFLINE|SELF|RATE_LIMITED|BUSY|BAD_REQUEST|FORBIDDEN`
- `{type:'incoming', sessionId, mode, viewer:{deviceId,name,os,fingerprint,publicKey}}` (ao host)
- `{type:'session_started', sessionId, role:'viewer'|'host', mode, peer:{deviceId,name,os,fingerprint,publicKey}, permissions, iceServers, resumed?:bool}` (às duas partes)
- `{type:'signal', sessionId, from, data}`
- `{type:'peer_status', sessionId, online}` (o WS do par caiu/voltou; carência de 45 s, depois `session_ended` com `peer_lost`)
- `{type:'session_ended', sessionId, reason}` — `reason ∈ rejected|cancelled|timeout|peer_ended|peer_lost|<reason enviado>`

Regras do servidor: alvo deve existir e estar online; não pode conectar em si mesmo;
máx. 10 `connect`/min por viewer; máx. 3 pendentes por host; pending expira em 60 s.

## 4. Mídia/dados ponto-a-ponto (WebRTC)

- **Host = offerer** (Rust, `webrtc-rs`). **Viewer = answerer** (RTCPeerConnection do WebView).
- Fluxo: após `session_started`, viewer envia `signal {kind:'ready'}`. Host cria PC com `iceServers`,
  adiciona trilha de vídeo **H.264 Constrained Baseline** (`profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1`),
  cria data channels `control` e `files` (ordenados, confiáveis), gera offer.
- `data` de signal:
  - `{kind:'ready'}` (viewer → host; se recebido de novo, host recria a PC)
  - `{kind:'offer', sdp, sig, restart?:bool}` (host → viewer)
  - `{kind:'answer', sdp, sig}` (viewer → host)
  - `{kind:'ice', candidate:{candidate, sdpMid, sdpMLineIndex}}` (ambos; trickle)
  - `{kind:'restart_request'}` (viewer → host; host faz ICE restart)
- **Assinatura de SDP (anti-MITM do servidor):** `sig = base64(Ed25519(privada do remetente,
  UTF-8 de "nexo-sdp-v1:${sessionId}:${kind}:${sdp}"))`. O receptor verifica com `peer.publicKey`
  e faz *pinning* TOFU por deviceId (alerta se a chave de um ID conhecido mudar). SDP inválido → encerra sessão.
- Reconexão: estado ICE `disconnected` > 4 s ou `failed` → host emite offer com ICE restart
  (`restart:true`). WebSocket de sinalização reconecta com backoff exponencial (1 s → 15 s).

### 4.1 Canal `control` (JSON texto, campo `t`)

Viewer → host:
- `{t:'auth', password}` — apenas modo `unattended`
- `{t:'mm', x, y}` — mouse absoluto normalizado 0..1 no monitor atual
- `{t:'md', b}` / `{t:'mu', b}` — botão 0=esq,1=meio,2=dir
- `{t:'wh', dx, dy}` — roda (deltaY do DOM em pixels; host converte ~100 px = 1 linha, acumulando)
- `{t:'kd', code, key}` / `{t:'ku', code, key}` — `KeyboardEvent.code`/`key`
- `{t:'combo', codes:[...]}` — pressiona em ordem e solta em ordem inversa (ex.: `['ControlLeft','ShiftLeft','Escape']`, `['MetaLeft']`, `['AltLeft','Tab']`)
- `{t:'text', text}` — digita texto (colar)
- `{t:'monitor', index}`
- `{t:'quality', preset:'auto'|'quality'|'balanced'|'speed', fps:15|30|60}`
- `{t:'viewport', w, h}` — tamanho útil em px físicos do viewer (modo `auto` reduz escala p/ caber)
- `{t:'keyframe'}`
- `{t:'ping', id, ts}`
- `{t:'chat', id, text, ts}`

Host → viewer:
- `{t:'auth_required'}` / `{t:'auth_result', ok, reason?, attemptsLeft?}`
- `{t:'hello', hostName, os, monitors:[{index,name,x,y,width,height,scale,primary}], current, permissions:{input,files,chat}}` — após autorização; início do vídeo
- `{t:'monitor_changed', index, width, height}`
- `{t:'stats', fps, encodeMs, bitrateKbps, width, height}` (a cada 2 s)
- `{t:'pong', id, ts}`
- `{t:'chat', id, text, ts}`
- `{t:'perm', permissions}`
- `{t:'bye', reason}`

Presets: `quality` 8 Mbps, `balanced` 4 Mbps, `speed` 1.5 Mbps (escala ½ se largura > 1920),
`auto` 4 Mbps + escala para caber em `viewport`. Dimensões sempre pares.
Bloqueio: 5 falhas de `auth` por viewer → bloqueado 15 min (no host).

### 4.2 Canal `files`

Quadros texto = JSON com campo `op`. Quadros binários = cabeçalho 8 bytes
`[u32 BE transferId][u32 BE fileIndex]` + payload (≤ 16 KiB). Controle de fluxo por
`bufferedAmount` (pausa acima de 1 MiB, retoma abaixo de 256 KiB).

Navegação (viewer → host):
- `{op:'ls', reqId, path}` (`path:''` = raízes: unidades no Windows, `/` e home em outros) →
  `{op:'ls_result', reqId, path, parent, entries:[{name, path, isDir, size, modified}]}` ou `{op:'error', reqId, message}`

Envio viewer → host (upload):
- `{op:'put', id, name, relPath, size, dest?}` → `{op:'put_ok', id}` | `{op:'put_err', id, message}`
  (`dest` vazio = pasta de recebimento do host; `relPath` permite pastas, sanitizado contra `..`)
- binários `[id][0]` …, depois `{op:'put_end', id}` → `{op:'done', id, path}`

Recebimento host → viewer (download):
- `{op:'get', id, path}` → `{op:'get_meta', id, files:[{fileIndex, relPath, size}], totalSize}`
- binários `[id][fileIndex]`…, `{op:'file_end', id, fileIndex}` por arquivo, depois `{op:'done', id}`
- erro: `{op:'error', id, message}`

Ambos: `{op:'cancel', id}` (o outro lado para e descarta parciais).

## 5. Interface Rust ↔ UI (Tauri)

Comandos (`invoke`), nomes em snake_case, argumentos camelCase:
- `identity_get()` → `{publicKey, fingerprint}`
- `identity_sign({message})` → `string` (sig base64)
- `identity_verify({publicKey, message, signature})` → `bool`
- `device_info()` → `{hostname, os, appVersion}`
- `monitors_list()` → `Monitor[]`
- `settings_get()` → `Settings` / `settings_set({settings})`
- `security_set_unattended_password({password})` (armazena hash Argon2id) / `security_clear_unattended_password()`
- `host_start({sessionId, mode, iceServers, permissions, viewer:{deviceId,name}})`
- `host_signal({sessionId, data})` (data = `ready`/`answer`/`ice`/`restart_request`; `answer` já verificado pela UI)
- `host_send_chat({sessionId, text})`
- `host_set_permissions({sessionId, permissions})`
- `host_stop({sessionId, reason})`
- `dl_open({id, fileIndex, destRoot, relPath})` → caminho final; `dl_write` (corpo bruto `Uint8Array`, headers `x-id`, `x-file-index`); `dl_close({id, fileIndex})`; `dl_abort({id})`
- `audit_local_list({limit})` → eventos locais do host
- `open_path({path})` (abre pasta no explorador)

Eventos (`listen`):
- `host://offer` `{sessionId, sdp, restart}` → UI assina e envia `signal offer`
- `host://ice` `{sessionId, candidate}`
- `host://state` `{sessionId, state:'connecting'|'awaiting_auth'|'streaming'|'reconnecting'|'closed', detail?}`
- `host://chat` `{sessionId, id, text, ts}`
- `host://transfer` `{sessionId, id, direction:'upload'|'download', name, bytes, total, state:'active'|'done'|'cancelled'|'error', message?}`
- `host://auth` `{sessionId, ok, viewerId}`
- `host://ended` `{sessionId, reason}` (Rust encerrou: ex. bloqueio de auth, PC falhou definitivamente)

`Settings` (JSON persistido em `<app config>/settings.json`):
```json
{
  "serverUrl": "http://localhost:8080",
  "deviceName": "",
  "theme": "system",
  "launchOnStartup": false,
  "quality": "auto", "fps": 30,
  "audioEnabled": false,
  "defaultPermissions": {"input": true, "files": true, "chat": true},
  "unattended": {"enabled": false, "hasPassword": false, "allowedDeviceIds": []},
  "receiveDir": "",
  "autoUpdate": true,
  "trustedKeys": {}
}
```
`hasPassword` é somente leitura (derivado do hash armazenado à parte em `secrets.json`).
