// Descoberta automática na rede local: o app envia um broadcast UDP "NEXO_DISCOVER_V1"
// e o servidor responde (unicast) com a porta HTTP. Assim os computadores da mesma rede
// encontram o servidor sem digitar endereço. Desative com DISCOVERY=false.
import dgram from 'node:dgram';
import os from 'node:os';

export const DISCOVERY_PORT = 41234;
export const DISCOVERY_PROBE = 'NEXO_DISCOVER_V1';

export function startDiscovery(httpPort: number, port = Number(process.env.DISCOVERY_PORT ?? DISCOVERY_PORT)): dgram.Socket | null {
  if (process.env.DISCOVERY === 'false') return null;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const reply = Buffer.from(JSON.stringify({ nexo: 1, port: httpPort, name: os.hostname() }));
  sock.on('message', (msg, rinfo) => {
    if (msg.length > 64 || !msg.toString('utf8').startsWith(DISCOVERY_PROBE)) return;
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => {
    console.warn(`Descoberta na rede local indisponível (UDP ${port}): ${e.message}`);
    sock.close();
  });
  sock.bind(port, '0.0.0.0');
  sock.unref();
  return sock;
}
