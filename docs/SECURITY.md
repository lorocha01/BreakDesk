# Nexo — Modelo de segurança

## Princípios

1. **Consentimento explícito.** Nenhuma sessão começa sem o proprietário aceitar o pedido na
   tela, exceto no modo não supervisionado, que precisa ser **ligado manualmente**, exige
   **senha** (Argon2id, guardada só no computador acessado) e pode ser restrito a uma lista
   de IDs autorizados.
2. **Visibilidade permanente.** Enquanto houver sessão, o computador acessado mostra uma
   janela indicadora sempre visível (ID/nome de quem acessa, tempo, chat e botão **Encerrar**)
   e o ícone da bandeja muda. Não existe modo oculto.
3. **Encerramento imediato.** O botão Encerrar (janela indicadora, bandeja ou app) derruba a
   PeerConnection localmente — não depende do servidor.
4. **Permissões por sessão.** Controle de mouse/teclado, arquivos e chat são concedidos no
   aceite e podem ser revogados durante a sessão.

## Criptografia (somente bibliotecas/protocolos consolidados)

| Camada | Mecanismo |
|---|---|
| App ↔ servidor | HTTPS/WSS (TLS 1.2+/1.3 via Caddy + Let's Encrypt) |
| Mídia e dados entre computadores | WebRTC: DTLS-SRTP (vídeo) e SCTP sobre DTLS (controle, arquivos, chat) — ponta a ponta, inclusive via TURN (o relay só vê pacotes cifrados) |
| Identidade de dispositivo | Ed25519 (ed25519-dalek no Rust, @noble/ed25519 no web viewer). Chave privada nunca sai do dispositivo |
| Anti-MITM do servidor de sinalização | SDP (que contém a impressão digital DTLS) é **assinado** com a chave Ed25519 do dispositivo; o par verifica e faz *pinning* TOFU por ID. Troca de chave de um ID conhecido gera alerta e a conexão é recusada até o usuário confiar de novo |
| Senhas | Argon2id (contas no servidor; senha de acesso não supervisionado só no host) |
| Tokens | JWT HS256 de curta duração (dispositivo 12 h, usuário 7 d) |
| TURN | Credenciais efêmeras (TURN REST API, HMAC com segredo compartilhado com o coturn) |

## Proteções contra abuso

- Rate limit: registro (20/h por IP), pedidos de conexão (10/min por dispositivo, 3 pendentes por host),
  login (bloqueio após 5 falhas em 15 min por e-mail+IP).
- Senha não supervisionada: 5 tentativas erradas por ID de origem → bloqueio de 15 min no host;
  a senha trafega apenas pelo canal WebRTC cifrado (o servidor nunca a vê).
- Pedidos pendentes expiram em 60 s; nenhum vídeo é enviado e nenhuma entrada é aceita antes
  da autorização.
- Transferência de arquivos: caminhos recebidos são sanitizados (sem `..`, sem caminhos absolutos),
  gravados apenas na pasta escolhida; nomes duplicados recebem sufixo.
- coturn configurado com `denied-peer-ip` para faixas privadas (evita uso do relay para atacar a
  rede interna do servidor), sem multicast e sem CLI.

## Auditoria

- Servidor: tabela `audit_log` (registro de dispositivo, autenticação, login/falha, pedidos,
  aceite/recusa, fim de sessão com duração e motivo, eventos relatados pelos clientes).
- Host: arquivo local JSONL com pedidos recebidos, aceites, recusas, falhas de senha, transferências
  de arquivos e encerramentos — visível em Histórico → Auditoria.

## Notas legais / operacionais

- **OpenH264 compilado a partir do código-fonte** não é coberto pela licença de patentes
  MPEG LA paga pela Cisco (que cobre apenas os binários oficiais baixados da Cisco). Para
  distribuição comercial, baixe o binário oficial em tempo de execução ou use o codificador
  H.264 do Windows (Media Foundation), cujas royalties são cobertas pela licença do Windows.
- Use o Nexo apenas em computadores próprios ou com autorização do proprietário.
