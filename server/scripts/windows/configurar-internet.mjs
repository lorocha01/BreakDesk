// Assistente: libera o acesso ao servidor Nexo pela internet (PC como servidor, sem VPS).
// Guarda a configuração em %LOCALAPPDATA%\Nexo\Servidor\config.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { duckdns, publicUrlOf } from './internet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir =
  process.env.NEXO_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Nexo', 'Servidor')
    : path.join(here, 'dados'));
mkdirSync(dataDir, { recursive: true });
const cfgFile = path.join(dataDir, 'config.json');
const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};

// Fila de linhas: funciona digitando, colando várias linhas de uma vez ou com entrada redirecionada.
const rl = createInterface({ input: process.stdin, terminal: false });
const queued = [];
const waiting = [];
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : queued.push(l)));
rl.on('close', () => waiting.splice(0).forEach((w) => w('')));
const ask = async (q, def = '') => {
  process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
  const line = queued.length ? queued.shift() : await new Promise((r) => waiting.push(r));
  return line.trim() || def;
};
const say = (s = '') => console.log('  ' + s);

console.log('');
say('███ Nexo — acesso pela internet ███');
say();
say('Este PC vai ser o servidor público do Nexo. Você precisa de:');
say('  1. Um endereço gratuito no DuckDNS: entre em https://www.duckdns.org');
say('     (login com Google ou GitHub), crie um subdomínio e copie o "token".');
say('  2. Acesso ao roteador desta rede, para encaminhar uma porta para este PC.');
say();
if (cfg.publicDomain) say(`Configuração atual: ${publicUrlOf(cfg)}`);
say('(Para DESLIGAR o acesso pela internet, digite "desligar" no subdomínio.)');
say();

let sub = await ask('Subdomínio do DuckDNS (ex.: minhaempresa)', (cfg.publicDomain || '').replace(/\.duckdns\.org$/i, ''));
if (sub.toLowerCase() === 'desligar') {
  delete cfg.publicDomain;
  delete cfg.duckdnsToken;
  delete cfg.httpsPort;
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  say();
  say('Acesso pela internet desligado. Feche e abra o "Servidor Nexo" para aplicar.');
  rl.close();
  process.exit(0);
}
sub = sub.toLowerCase().replace(/^https?:\/\//, '').replace(/\.duckdns\.org.*$/, '');
if (!/^[a-z0-9-]{1,63}$/.test(sub)) {
  say('Subdomínio inválido. Use só letras, números e hífen.');
  process.exit(1);
}
const token = await ask('Token do DuckDNS', cfg.duckdnsToken || '');
const httpsPort = Number(await ask('Porta HTTPS a liberar no roteador', String(cfg.httpsPort || 443)));
if (!/^[0-9a-f-]{30,40}$/i.test(token) || !(httpsPort > 0 && httpsPort < 65536)) {
  say('Token ou porta inválidos.');
  process.exit(1);
}

const next = { ...cfg, publicDomain: `${sub}.duckdns.org`, duckdnsToken: token, httpsPort };
say();
say('Testando o DuckDNS...');
let publicIp = '';
try {
  const lines = await duckdns(next, { ip: '' });
  publicIp = lines[1] || '';
  say(`OK: ${next.publicDomain} agora aponta para ${publicIp}`);
} catch (e) {
  say(`Falhou: ${e.message}`);
  rl.close();
  process.exit(1);
}
writeFileSync(cfgFile, JSON.stringify(next, null, 2));

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);
const cgnat = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(publicIp);

say();
say('================ FALTA SÓ O ROTEADOR ================');
say(`No roteador, crie um "Encaminhamento de porta" (Port Forwarding / Virtual Server):`);
say(`  Porta externa: ${httpsPort}  ->  IP interno: ${lan[0] || '(IP deste PC)'}  porta ${httpsPort}  (protocolo TCP)`);
if (lan.length > 1) say(`  (IPs deste PC: ${lan.join(', ')} — use o da rede do roteador)`);
say('Dica: no roteador, fixe o IP deste PC (reserva DHCP) para o encaminhamento não quebrar.');
say();
say('Atenção: se o seu provedor usa CGNAT, encaminhar porta não funciona.');
say('Para saber: compare o "IP WAN" mostrado no roteador com ' + (publicIp || 'o IP acima') + '.');
say('Se forem diferentes (ou o WAN começar com 100.64 a 100.127), peça ao provedor um IP público.');
if (cgnat) say('>>> O IP detectado parece ser CGNAT. Fale com o provedor antes de continuar. <<<');
say();
say('Depois:');
say('  1. Feche e abra o "Servidor Nexo" (na 1ª vez ele pede o certificado HTTPS, ~1 min).');
say(`  2. Teste no celular, FORA do Wi-Fi: https://${next.publicDomain}${httpsPort === 443 ? '' : ':' + httpsPort}/healthz`);
say('     Deve aparecer {"ok":true}.');
say(`  3. Os apps desta rede aprendem o endereço sozinhos. Fora dela, use em`);
say(`     Configurações -> Geral -> Servidor: ${publicUrlOf(next)}`);
say();
rl.close();
