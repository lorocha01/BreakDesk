// Inicializador do servidor Nexo para Windows (pacote portátil).
// - Banco PostgreSQL embutido (PGlite) em .\dados\db — nada para instalar.
// - Gera e guarda um JWT_SECRET forte em .\dados\config.json na primeira execução.
// - Mostra os endereços que os apps devem usar em Configurações → Geral → Servidor.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Dados graváveis pelo usuário (a pasta de instalação em Arquivos de Programas é só leitura).
const dataDir =
  process.env.NEXO_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Nexo', 'Servidor')
    : path.join(here, 'dados'));
mkdirSync(dataDir, { recursive: true });
const cfgFile = path.join(dataDir, 'config.json');
let cfg = {};
if (existsSync(cfgFile)) cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
if (!cfg.jwtSecret || !cfg.instanceId) {
  cfg.jwtSecret ||= randomBytes(48).toString('base64url');
  cfg.instanceId ||= randomUUID();
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
}
const port = Number(process.env.PORT || cfg.port || 8080);

process.env.NODE_ENV ??= 'production';
process.env.JWT_SECRET ??= cfg.jwtSecret;
process.env.PORT = String(port);
process.env.DATABASE_URL ??= 'pglite:' + path.join(dataDir, 'db');
process.env.MIGRATE_ON_START ??= 'true';
process.env.NEXO_INSTANCE_ID ??= cfg.instanceId;
process.env.LOG_LEVEL ??= 'warn';
if (cfg.turnUrls) process.env.TURN_URLS ??= cfg.turnUrls;
if (cfg.turnSecret) process.env.TURN_SECRET ??= cfg.turnSecret;

const ips = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

console.log('');
console.log('  ███ Servidor Nexo ███');
console.log('');
await import(pathToFileURL(path.join(here, 'dist', 'index.js')).href);
console.log(`  Servidor rodando na porta ${port}. Deixe esta janela aberta.`);
console.log('');
console.log('  Neste computador, use no app:   http://localhost:' + port);
for (const ip of ips) console.log('  Em outros computadores da rede: http://' + ip + ':' + port);
console.log('');
console.log('  Para parar: feche esta janela ou pressione Ctrl+C.');
console.log('');
