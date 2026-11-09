// Acesso pela internet para o servidor Nexo rodando num PC (sem VPS):
//  - DuckDNS: endereço fixo gratuito (ex.: minhaempresa.duckdns.org), atualizado com o IP atual.
//  - Let's Encrypt (ACME DNS-01 via DuckDNS): certificado HTTPS válido, renovado sozinho.
//    DNS-01 não precisa de porta 80 aberta; só a porta HTTPS encaminhada no roteador.
//  - Proxy HTTPS/WSS na porta pública -> servidor local (http://127.0.0.1:<porta>).
// Configuração em <dados>/config.json: publicDomain, duckdnsToken, httpsPort (443),
// ou tlsCertFile/tlsKeyFile para usar um certificado próprio.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

// Substituíveis só para testes automatizados (Pebble = servidor ACME de teste do Let's Encrypt).
const DUCKDNS = process.env.NEXO_DUCKDNS_URL || 'https://www.duckdns.org/update';
const ACME_DIRECTORY = process.env.NEXO_ACME_DIRECTORY || '';
const DNS_WAIT_MS = Number(process.env.NEXO_ACME_DNS_WAIT_MS || 45_000);
const RENEW_BEFORE_DAYS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function publicUrlOf(cfg) {
  if (!cfg.publicDomain) return null;
  const port = Number(cfg.httpsPort || 443);
  return `https://${cfg.publicDomain}${port === 443 ? '' : `:${port}`}`;
}

export function isDuckDns(domain) {
  return /\.duckdns\.org$/i.test(domain || '');
}

/** Chama a API do DuckDNS. `params`: { ip } | { txt } | { txt, clear }. Devolve as linhas da resposta. */
export async function duckdns(cfg, params = {}) {
  const u = new URL(DUCKDNS);
  u.searchParams.set('domains', cfg.publicDomain.replace(/\.duckdns\.org$/i, ''));
  u.searchParams.set('token', cfg.duckdnsToken);
  u.searchParams.set('verbose', 'true');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  const lines = (await r.text()).trim().split('\n');
  if (lines[0] !== 'OK') throw new Error('o DuckDNS recusou (confira o subdomínio e o token)');
  return lines; // OK, ipv4, ipv6, UPDATED|NOCHANGE
}

function certExpiry(certPem) {
  try {
    return new Date(new X509Certificate(certPem).validTo);
  } catch {
    return null;
  }
}

async function obtainCertificate(cfg, tlsDir, log) {
  const { default: acme } = await import('acme-client');
  const directoryUrl =
    ACME_DIRECTORY || (cfg.acmeStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production);
  // Conta ACME: chave + URL juntas. Com a URL, a renovação reaproveita a conta sem
  // "atualizá-la" (servidores ACME estritos recusam atualização vazia).
  const accountFile = path.join(tlsDir, 'acme-account.json');
  let account = null;
  try {
    account = JSON.parse(readFileSync(accountFile, 'utf8'));
    if (account.directoryUrl !== directoryUrl) account = null;
  } catch {
    account = null;
  }
  const accountKey = account?.key ? Buffer.from(account.key) : await acme.crypto.createPrivateKey();
  const client = new acme.Client({ directoryUrl, accountKey, accountUrl: account?.url || undefined });
  const [key, csr] = await acme.crypto.createCsr({ commonName: cfg.publicDomain });
  log('Pedindo certificado HTTPS ao Let\'s Encrypt (leva cerca de 1 minuto)...');
  const cert = await client.auto({
    csr,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    // A verificação local de DNS sofre com cache; o DuckDNS publica o TXT na hora.
    skipChallengeVerification: true,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type !== 'dns-01') throw new Error('somente dns-01 é suportado');
      await duckdns(cfg, { txt: keyAuthorization });
      await sleep(DNS_WAIT_MS); // propagação nos servidores de nome do DuckDNS
    },
    challengeRemoveFn: async () => {
      await duckdns(cfg, { txt: 'removed', clear: 'true' }).catch(() => {});
    },
  });
  if (!account?.url) {
    writeFileSync(
      accountFile,
      JSON.stringify({ directoryUrl, url: client.getAccountUrl(), key: accountKey.toString() }),
      { mode: 0o600 },
    );
  }
  writeFileSync(path.join(tlsDir, 'key.pem'), key, { mode: 0o600 });
  writeFileSync(path.join(tlsDir, 'cert.pem'), cert);
  return { key: key.toString(), cert };
}

/** Certificado atual (próprio, salvo ou novo). Renova se faltar menos de 30 dias. */
async function ensureCertificate(cfg, dataDir, log) {
  if (cfg.tlsCertFile && cfg.tlsKeyFile) {
    return { key: readFileSync(cfg.tlsKeyFile, 'utf8'), cert: readFileSync(cfg.tlsCertFile, 'utf8') };
  }
  if (!isDuckDns(cfg.publicDomain) || !cfg.duckdnsToken) {
    throw new Error('para HTTPS automático use um endereço *.duckdns.org com token, ou informe tlsCertFile/tlsKeyFile');
  }
  const tlsDir = path.join(dataDir, 'tls');
  mkdirSync(tlsDir, { recursive: true });
  const certFile = path.join(tlsDir, 'cert.pem');
  const keyFile = path.join(tlsDir, 'key.pem');
  if (existsSync(certFile) && existsSync(keyFile)) {
    const cert = readFileSync(certFile, 'utf8');
    const exp = certExpiry(cert);
    const sameDomain = (() => {
      try {
        return new X509Certificate(cert).checkHost(cfg.publicDomain) !== undefined;
      } catch {
        return false;
      }
    })();
    if (exp && sameDomain && exp.getTime() - Date.now() > RENEW_BEFORE_DAYS * 86400_000) {
      return { key: readFileSync(keyFile, 'utf8'), cert };
    }
  }
  return obtainCertificate(cfg, tlsDir, log);
}

/** Proxy HTTPS (incl. WebSocket) para o servidor local; acrescenta X-Forwarded-For. */
function startProxy({ key, cert }, httpsPort, localPort, log) {
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '', 'x-forwarded-proto': 'https' };
    const up = http.request({ host: '127.0.0.1', port: localPort, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(localPort, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-for') continue;
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      raw += `X-Forwarded-For: ${req.socket.remoteAddress ?? ''}\r\nX-Forwarded-Proto: https\r\n\r\n`;
      up.write(raw);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  server.on('tlsClientError', () => {});
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(httpsPort, '0.0.0.0', () => {
      log(`HTTPS ativo na porta ${httpsPort}.`);
      resolve(server);
    });
  });
}

/**
 * Liga o acesso pela internet. Não bloqueia o servidor local: erros são registrados e o
 * servidor continua atendendo a rede local normalmente.
 */
export async function startInternet({ cfg, dataDir, localPort, log = console.log }) {
  const url = publicUrlOf(cfg);
  if (!url) return null;
  const httpsPort = Number(cfg.httpsPort || 443);

  if (isDuckDns(cfg.publicDomain) && cfg.duckdnsToken) {
    const tick = async () => {
      try {
        const lines = await duckdns(cfg, { ip: '' });
        return lines[1];
      } catch (e) {
        log(`DuckDNS: ${e.message}`);
        return null;
      }
    };
    const ip = await tick();
    if (ip) log(`Endereço ${cfg.publicDomain} -> ${ip}`);
    setInterval(tick, 5 * 60_000).unref();
  }

  const creds = await ensureCertificate(cfg, dataDir, log);
  const server = await startProxy(creds, httpsPort, localPort, log);

  // Renovação automática: confere a cada 12 h e troca o certificado sem derrubar conexões.
  setInterval(async () => {
    try {
      const next = await ensureCertificate(cfg, dataDir, log);
      server.setSecureContext({ key: next.key, cert: next.cert });
    } catch (e) {
      log(`Renovação do certificado falhou (tentará de novo): ${e.message}`);
    }
  }, 12 * 3600_000).unref();

  return { url, server };
}
