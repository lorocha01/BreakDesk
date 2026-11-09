# Nexo — Arquitetura

```
 ┌──────────────────────── Computador A (quem acessa / viewer) ───────────────────────┐
 │  App Nexo (Tauri 2)                                                               │
 │   UI React/TS ── RTCPeerConnection do WebView2 (decodifica H.264 por hardware)    │
 │        │  ▲  data channels: control (mouse/teclado/chat) · files (arquivos)       │
 └────────┼──┼───────────────────────────────────────────────────────────────────────┘
          │  │            ① HTTPS REST (identidade, tokens, ICE, histórico)
          │  │            ② WSS sinalização (pedido → consentimento → SDP/ICE)
          ▼  │
 ┌───────────────────── Infraestrutura (VPS) ─────────────────────┐
 │ Caddy (TLS) → Nexo Server (Node/TS, Fastify + ws) → PostgreSQL │
 │ coturn (STUN/TURN, credenciais efêmeras HMAC)                  │
 └────────────────────────────────────────────────────────────────┘
          ▲  │
          │  ▼        ③ Mídia + dados: WebRTC (DTLS-SRTP / SCTP-DTLS)
          │             P2P direto quando possível; relay TURN quando necessário
 ┌────────┼──┼──────────────────── Computador B (acessado / host) ────────────────────┐
 │  App Nexo (Tauri 2)                                                               │
 │   UI React (consentimento, indicador de sessão, chat)                             │
 │   Núcleo Rust `nexo-core`: captura (xcap) → I420 → H.264 (OpenH264)               │
 │                            → webrtc-rs → rede; entrada (enigo); arquivos          │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

## Componentes

| Pasta | Tecnologia | Responsabilidade |
|---|---|---|
| `server/` | Node 22, TypeScript, Fastify 5, ws, pg, Argon2id, JWT | Registro de dispositivos (ID de 9 dígitos), autenticação por desafio Ed25519, contas de usuário, sinalização WebSocket, máquina de estados de sessão, credenciais TURN, histórico e auditoria |
| `infra/` | Docker Compose, PostgreSQL 16, coturn, Caddy | Implantação em um servidor com domínio e TLS automático |
| `core/` | Rust (`nexo-core`) | Identidade, captura de tela multi-monitor, conversão de cor, codificação H.264, WebRTC (host), injeção de entrada, transferência de arquivos, autenticação não supervisionada, auditoria local. Binário `nexo-hostd`: agente headless não supervisionado |
| `desktop/src-tauri` | Rust, Tauri 2 | Shell nativo: comandos/eventos entre UI e núcleo, bandeja, janela indicadora de sessão, inicialização com o sistema, instância única, atualizador |
| `desktop/src` | React 19, TypeScript, Vite | Interface (tela inicial, sessão remota, arquivos, chat, histórico, configurações), cliente de sinalização, viewer WebRTC, orquestração do host. Também roda em navegador comum como *web viewer* |

## Por que essas escolhas

- **Host em Rust com webrtc-rs, viewer no WebView2.** O lado que captura precisa de acesso
  nativo (DXGI/GDI, SendInput) e controle fino do codificador; o lado que exibe ganha
  decodificação H.264 acelerada por hardware, jitter buffer e controle de congestionamento
  do Chromium (WebView2) de graça.
- **H.264 Constrained Baseline via OpenH264.** Decodificado por qualquer WebView2/Chromium,
  baixa latência (sem B-frames), licença BSD. Ver nota de patentes em `SECURITY.md`.
- **Host como *offerer*.** O host controla codec, data channels e ICE restart — reconexão
  fica em um único lado.
- **Sinalização na UI (TypeScript), mídia no Rust.** Um único cliente WebSocket no app;
  o Rust recebe apenas SDP/ICE já verificados. O `nexo-hostd` tem seu próprio cliente
  Rust porque roda sem interface.
- **Nada de criptografia própria.** TLS 1.3 (Caddy) no transporte de sinalização; DTLS-SRTP
  e SCTP sobre DTLS (WebRTC) ponta a ponta para mídia/dados; Ed25519 (ed25519-dalek /
  @noble) para identidade; Argon2id para senhas; HMAC-SHA1 padrão TURN REST.

## Fluxo de uma conexão

1. Ambos os apps estão online: cada um tem token de dispositivo (desafio Ed25519) e WSS aberto.
2. Viewer envia `connect {targetId}` → servidor cria sessão `pending` → host recebe `incoming`.
3. Host vê o pedido (ID, nome, impressão digital da chave) e **aceita** escolhendo permissões
   (controle, arquivos, chat) — ou recusa. Modo não supervisionado só é aceito automaticamente
   se habilitado explicitamente, com senha definida e, opcionalmente, lista de IDs autorizados.
4. Servidor envia `session_started` aos dois com credenciais TURN efêmeras.
5. Viewer manda `ready`; host cria a PeerConnection, assina o SDP com sua chave Ed25519 e envia
   a oferta. Viewer verifica a assinatura com a chave do par (com *pinning* TOFU), responde
   com resposta assinada. ICE trickle → par selecionado (host/srflx = P2P, relay = TURN).
6. No modo não supervisionado o host pede a senha pelo canal `control` (cifrado ponta a ponta —
   o servidor nunca vê a senha) antes de enviar qualquer quadro ou aceitar entrada.
7. Host envia `hello` (monitores), começa a transmitir vídeo; viewer envia mouse/teclado.
8. Qualquer lado encerra → `end` → servidor grava duração/motivo; host fecha a janela indicadora.

## Reconexão

- WebSocket: backoff exponencial 1 s → 15 s; sessões ativas são retomadas (`active_sessions`).
- Servidor mantém a sessão por 45 s de carência se um lado perder o WebSocket (`peer_status`).
- ICE: `disconnected` > 4 s ou `failed` → host faz ICE restart com nova oferta assinada.

## Limitações conhecidas (roadmap)

- **Tela segura do Windows (UAC, Ctrl+Alt+Del, tela de bloqueio)** exige um serviço Windows
  rodando como SYSTEM que troca de *desktop* (`OpenInputDesktop`/`SetThreadDesktop`); o app
  atual roda na sessão do usuário. O `nexo-hostd` é a base para esse serviço.
- **Áudio** (WASAPI loopback + Opus) ainda não implementado — a configuração aparece desabilitada.
- **Captura DXGI/Windows Graphics Capture**: hoje via `xcap`; um backend WGC aumentaria FPS em 4K.
- **Codificação por hardware** (NVENC/QSV/AMF via Media Foundation) é um próximo passo natural.
