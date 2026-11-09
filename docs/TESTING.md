# Nexo — Testes

## Resumo do que é testado automaticamente

| Suíte | Comando | O que cobre |
|---|---|---|
| Servidor (29 testes, PostgreSQL real) | `cd server && npm test` | Registro idempotente, desafio/assinatura Ed25519, tokens, contas e bloqueio de login, credenciais TURN (HMAC conferido), fluxo completo de sinalização com dois WebSockets (connect → incoming → accept → relay → end), recusa, cancelamento, timeout, alvo offline, rate limits, substituição de socket, retomada e `peer_lost`, histórico com duração e auditoria |
| Núcleo Rust (28 testes) | `cargo test -p nexo-core` | Vetor RFC 8032, fingerprint, conversão BT.601/escala, IDR H.264, mapa de teclas, sanitização de caminhos, cabeçalho de quadros, bloqueio de senha, formato das configurações |
| Sessão de host em processo | `DISPLAY=:99 cargo test -p nexo-core --test host_session` | Motor de host contra um viewer webrtc-rs: senha errada/certa, ping, chat, listagem, upload, upload malicioso `../` bloqueado, download recursivo, RTP H.264 real |
| UI (viewer web) contra host simulado | `node desktop/tests/e2e-viewer-fakehost.cjs` | Toda a UI do viewer, incluindo protocolo de arquivos e chat |
| **E2E real** | `e2e/run.sh` e `HOST_KIND=desktop e2e/run.sh` | Ver abaixo |

## E2E real (`e2e/run.sh`)

Sobe PostgreSQL, o servidor, um **coturn** real, uma tela virtual (Xvfb) com um terminal, e um host
real: o agente `nexo-hostd` (padrão) ou o **app desktop Tauri** completo (`HOST_KIND=desktop`).
Depois a interface web real é aberta no Chromium (Playwright) e roda dois cenários:

- **p2p**: conexão direta.
- **relay**: o viewer só pode usar candidatos TURN (`iceTransportPolicy: 'relay'`), simulando
  redes que não permitem conexão direta. O tráfego passa pelo coturn.

Em cada cenário (12 verificações, 24 no total):
1. Viewer registra e fica online.
2. Pedido não supervisionado com senha errada → host recusa e pede a senha.
3. Senha correta → sessão transmitindo; vídeo H.264 decodificado (≈1438×808).
4. Rota detectada corretamente (`p2p` / `relay`) e frames contínuos (~23 fps).
5. Mouse: o cursor **real** do host (lido com `xdotool`) vai para o ponto clicado.
6. Teclado: digita `echo … > arquivo` no terminal do host e o arquivo aparece no disco.
7. Upload de 700 KB e download de 250 KB com conteúdo idêntico byte a byte.
8. Encerramento e registro no histórico.

Resultado na última execução: **24/24 com `nexo-hostd` e 24/24 com o app desktop Tauri como host**.

## Teste manual entre dois computadores reais (Windows)

1. Suba a infraestrutura em uma VPS (`infra/README.md`) com domínio e as portas abertas.
2. Gere o instalador pelo GitHub Actions (`desktop-build.yml`) ou localmente no Windows:
   `cd desktop && npm ci && npx tauri build` (defina `VITE_NEXO_SERVER=https://seu-dominio`).
3. Instale em dois PCs **em redes diferentes** (ex.: um no Wi-Fi do escritório, outro no 4G
   roteado do celular).
4. No PC A, digite o ID do PC B → Conectar. No PC B, aceite o pedido.
5. Verifique: imagem, mouse/teclado, atalhos (menu de teclas especiais), troca de monitor,
   tela cheia, chat, envio e recebimento de arquivos/pastas, indicador de qualidade
   (badge P2P/Relay), janela indicadora no PC B e o botão Encerrar dos dois lados.
6. Para forçar o relay: bloqueie UDP de saída exceto 3478 no firewall de um dos lados.
7. Instabilidade: desligue o Wi-Fi por ~5 s e religue; a sessão deve se recuperar (ICE restart).

## Limitações do ambiente de teste

Os testes automáticos rodam em Linux (Xvfb). O código específico do Windows (SendInput,
listagem de unidades, captura GDI do xcap) compila para `x86_64-pc-windows-*`, mas a primeira
execução real em Windows acontece no CI (`desktop-build.yml`) e no teste manual acima.
