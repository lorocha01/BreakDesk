// DEV-ONLY demo states used for visual review/screenshots (`?demo=home|session|settings|history|hosting|incoming|outgoing`).
// Imported dynamically behind `import.meta.env.DEV`, so it is excluded from production builds.
import { controller } from './session/controller';
import { defaultSettings, type SessionRow } from './net/protocol';
import { emptyStats, setApp, type View } from './store/app';
import { applyTheme } from './theme';

const peer = {
  deviceId: '731204958',
  name: 'Financeiro-PC',
  os: 'Windows 11 Pro',
  fingerprint: '7C2E:91AB:04F3:D8E2:5B17:AA90:3C6D:E412',
  publicKey: 'AAAA',
};

function fakeDesktopStream(): MediaStream | null {
  const c = document.createElement('canvas');
  c.width = 1920;
  c.height = 1080;
  const g = c.getContext('2d');
  if (!g || !('captureStream' in c)) return null;
  let tick = 0;
  const draw = () => {
    tick++;
    const bg = g.createLinearGradient(0, 0, 1920, 1080);
    bg.addColorStop(0, '#1d2b64');
    bg.addColorStop(0.5, '#3a4fb4');
    bg.addColorStop(1, '#1aa59a');
    g.fillStyle = bg;
    g.fillRect(0, 0, 1920, 1080);
    // soft wallpaper shapes
    g.globalAlpha = 0.18;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(1500, 260, 380, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(300, 900, 260, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    // desktop icons
    for (let i = 0; i < 5; i++) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      roundRect(g, 40, 40 + i * 120, 64, 64, 14);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '500 18px Inter, Segoe UI, sans-serif';
      g.fillText(['Documentos', 'Planilhas', 'Lixeira', 'Navegador', 'Relatórios'][i], 26, 130 + i * 120);
    }
    // window 1: spreadsheet
    window_(g, 300, 120, 1040, 640, 'Relatório mensal — Planilha', '#ffffff', (x, y, w) => {
      g.fillStyle = '#eef1f7';
      g.fillRect(x, y, w, 36);
      g.strokeStyle = '#dde2ec';
      for (let r = 0; r < 14; r++) {
        for (let col = 0; col < 7; col++) {
          g.strokeRect(x + col * (w / 7), y + 36 + r * 38, w / 7, 38);
          if (r > 0 && col > 0) {
            g.fillStyle = '#3b4258';
            g.font = '17px Inter, Segoe UI, sans-serif';
            g.fillText(`R$ ${((r * 731 + col * 97) % 9000).toLocaleString('pt-BR')}`, x + col * (w / 7) + 12, y + 62 + r * 38);
          }
        }
      }
      g.fillStyle = '#4c55f0';
      g.fillRect(x + (w / 7) * 2, y + 36 + 3 * 38, w / 7, 38);
    });
    // window 2: chart
    window_(g, 1080, 430, 700, 470, 'Painel de vendas', '#ffffff', (x, y, w, h) => {
      const bars = [0.4, 0.62, 0.5, 0.78, 0.66, 0.9, 0.72];
      bars.forEach((b, i) => {
        const bh = (h - 80) * (b + 0.04 * Math.sin((tick + i * 9) / 18));
        g.fillStyle = i % 2 ? '#12b5a5' : '#5b5cf6';
        roundRect(g, x + 40 + i * ((w - 80) / 7), y + h - 30 - bh, (w - 80) / 7 - 18, bh, 6);
        g.fill();
      });
    });
    // taskbar
    g.fillStyle = 'rgba(15,18,32,0.82)';
    g.fillRect(0, 1020, 1920, 60);
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i === 1 ? '#7c71ff' : 'rgba(255,255,255,0.75)';
      roundRect(g, 760 + i * 66, 1032, 40, 36, 8);
      g.fill();
    }
    g.fillStyle = '#fff';
    g.font = '500 20px Inter, Segoe UI, sans-serif';
    g.fillText('14:32', 1820, 1057);
    // cursor
    const cx = 760 + Math.sin(tick / 40) * 120;
    const cy = 420 + Math.cos(tick / 50) * 80;
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx, cy + 34);
    g.lineTo(cx + 9, cy + 26);
    g.lineTo(cx + 16, cy + 40);
    g.lineTo(cx + 22, cy + 37);
    g.lineTo(cx + 15, cy + 23);
    g.lineTo(cx + 26, cy + 23);
    g.closePath();
    g.fill();
    g.stroke();
    requestAnimationFrame(draw);
  };
  draw();
  return (c as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(30);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function window_(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  bg: string,
  body: (x: number, y: number, w: number, h: number) => void,
) {
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 40;
  g.shadowOffsetY = 14;
  g.fillStyle = bg;
  roundRect(g, x, y, w, h, 12);
  g.fill();
  g.restore();
  g.fillStyle = '#f5f6fa';
  g.beginPath();
  g.roundRect(x, y, w, 46, [12, 12, 0, 0]);
  g.fill();
  g.fillStyle = '#20253a';
  g.font = '600 18px Inter, Segoe UI, sans-serif';
  g.fillText(title, x + 20, y + 29);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(x + w - 90 + i * 26, y + 23, 7, 0, Math.PI * 2);
    g.fill();
  });
  body(x + 16, y + 62, w - 32, h - 78);
}

const sessions: SessionRow[] = [
  mk('a', 'viewer', '731204958', 'Financeiro-PC', 'ended', 3600 * 1.3, 2_400, 'user'),
  mk('b', 'host', '588120347', 'Notebook Ana', 'ended', 3600 * 5, 754, 'peer_ended'),
  mk('c', 'viewer', '904417263', 'Servidor-Backup', 'ended', 86400, 4_210, 'user', 'unattended'),
  mk('d', 'viewer', '316778020', 'Recepção', 'rejected', 86400 * 2, null, null),
  mk('e', 'host', '622310980', 'Suporte TI', 'timeout', 86400 * 3, null, null),
  mk('f', 'viewer', '731204958', 'Financeiro-PC', 'ended', 86400 * 4, 1_180, 'peer_lost'),
];

function mk(
  id: string,
  role: 'viewer' | 'host',
  peerId: string,
  peerName: string,
  status: SessionRow['status'],
  agoSec: number,
  dur: number | null,
  reason: string | null,
  mode: 'attended' | 'unattended' = 'attended',
): SessionRow {
  const created = new Date(Date.now() - agoSec * 1000).toISOString();
  return {
    id: `${id}0000000-0000-4000-8000-000000000000`,
    viewerId: role === 'viewer' ? '482913075' : peerId,
    hostId: role === 'viewer' ? peerId : '482913075',
    viewerName: role === 'viewer' ? 'Estação Design' : peerName,
    hostName: role === 'viewer' ? peerName : 'Estação Design',
    mode,
    status,
    role,
    createdAt: created,
    acceptedAt: dur != null ? created : null,
    endedAt: dur != null ? new Date(Date.now() - agoSec * 1000 + dur * 1000).toISOString() : null,
    durationSec: dur,
    endReason: reason,
  };
}

export function runDemo(kind: string, theme: string | null): void {
  const settings = defaultSettings();
  settings.theme = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system';
  settings.deviceName = 'Estação Design';
  settings.unattended = { enabled: true, hasPassword: true, allowedDeviceIds: ['731204958', '904417263'] };
  settings.trustedKeys = {
    '731204958': { publicKey: 'x', fingerprint: peer.fingerprint, name: 'Financeiro-PC', firstSeen: new Date(Date.now() - 86400e3 * 12).toISOString() },
    '904417263': { publicKey: 'y', fingerprint: '19D0:4A2B:77EE:0C31:B8F4:2E6A:9D05:C7A1', name: 'Servidor-Backup', firstSeen: new Date(Date.now() - 86400e3 * 40).toISOString() },
  };
  applyTheme(settings.theme);
  const now = Date.now();
  const view: View = kind === 'settings' ? 'settings' : kind === 'history' ? 'history' : 'home';
  setApp({
    booted: true,
    view,
    settings,
    identity: { publicKey: 'demo', fingerprint: '3F9A:12C4:8E0B:77D1:A2F6:5C93:0B4E:D1A8' },
    deviceId: '482913075',
    conn: 'online',
    latency: 23,
    recents: [
      { deviceId: '731204958', name: 'Financeiro-PC', os: 'Windows 11', lastAt: now - 3600e3 * 1.3, favorite: true },
      { deviceId: '904417263', name: 'Servidor-Backup', os: 'Windows Server', lastAt: now - 86400e3 },
      { deviceId: '316778020', name: 'Recepção', os: 'Windows 10', lastAt: now - 86400e3 * 2 },
      { deviceId: '588120347', name: 'Notebook Ana', os: 'macOS', lastAt: now - 86400e3 * 5 },
    ],
    notifications: [
      { id: 'n1', kind: 'success', title: 'Sessão iniciada', body: 'Financeiro-PC · 731 204 958', ts: now - 60e3, read: false },
      { id: 'n2', kind: 'info', title: 'Transferência concluída', body: 'relatorio-outubro.xlsx', ts: now - 3600e3, read: true },
    ],
  });
  controller.api.sessions = async () => ({ sessions });
  controller.api.audit = async () => ({
    events: [
      { id: 1, at: new Date(now - 60e3).toISOString(), event: 'session_accepted', actorDevice: '731204958', sessionId: sessions[0].id, ip: '189.40.12.7', detail: { mode: 'attended' } },
      { id: 2, at: new Date(now - 3600e3).toISOString(), event: 'connect_request', actorDevice: '588120347', sessionId: sessions[1].id, ip: '177.12.90.3', detail: {} },
      { id: 3, at: new Date(now - 7200e3).toISOString(), event: 'client.unattended_auth_failed', actorDevice: '482913075', sessionId: null, ip: '10.0.0.4', detail: { viewerId: '316778020' } },
      { id: 4, at: new Date(now - 86400e3).toISOString(), event: 'device_auth', actorDevice: '482913075', sessionId: null, ip: '10.0.0.4', detail: {} },
    ],
  });

  if (kind === 'session') {
    setApp({
      viewer: {
        sessionId: 'demo',
        peer,
        mode: 'attended',
        status: 'streaming',
        monitors: [
          { index: 0, name: 'Monitor 1 (Dell U2720Q)', x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
          { index: 1, name: 'Monitor 2', x: 1920, y: 0, width: 1680, height: 1050, scale: 1, primary: false },
        ],
        currentMonitor: 0,
        permissions: { input: true, files: true, chat: true },
        stats: { ...emptyStats, rttMs: 28, pingMs: 31, fps: 30, bitrateKbps: 3850, width: 1920, height: 1080, route: 'p2p', packetLoss: 0, level: 4, hostFps: 30, encodeMs: 6.2 },
        chat: [
          { id: 'c1', from: 'peer', text: 'Oi! A planilha está travando ao salvar.', ts: now - 120e3 },
          { id: 'c2', from: 'me', text: 'Vou verificar agora, um instante.', ts: now - 90e3 },
        ],
        unread: 1,
        transfers: [],
        startedAt: now - 754e3,
        authError: null,
        authBusy: false,
        peerOffline: false,
        endReason: null,
        quality: 'auto',
        fps: 30,
        stream: fakeDesktopStream(),
        hostName: 'Financeiro-PC',
      },
    });
  }
  if (kind === 'auth') {
    setApp({
      viewer: {
        sessionId: 'demo', peer, mode: 'unattended', status: 'auth', monitors: [], currentMonitor: 0,
        permissions: { input: true, files: true, chat: true }, stats: { ...emptyStats }, chat: [], unread: 0, transfers: [],
        startedAt: now - 5e3, authError: 'left:3', authBusy: false, peerOffline: false, endReason: null, quality: 'auto', fps: 30,
        stream: null, hostName: null,
      },
    });
  }
  if (kind === 'hosting') {
    setApp({
      host: {
        sessionId: 'demo-host',
        peer: { ...peer, deviceId: '588120347', name: 'Suporte TI — Marcos', os: 'Windows 11' },
        mode: 'attended',
        permissions: { input: true, files: true, chat: true },
        state: 'streaming',
        startedAt: now - 312e3,
        chat: [
          { id: 'h1', from: 'peer', text: 'Olá! Já estou vendo sua tela. Vou abrir as configurações de rede.', ts: now - 200e3 },
          { id: 'h2', from: 'me', text: 'Perfeito, obrigado!', ts: now - 180e3 },
        ],
        unread: 0,
        transfers: [
          { id: 't1', direction: 'upload', name: 'driver-impressora.zip', bytes: 18_400_000, total: 31_200_000, state: 'active', startedAt: now - 9e3, speed: 2_150_000 },
        ],
      },
    });
  }
  if (kind === 'incoming') {
    setApp({
      incoming: [{ sessionId: 'demo-in', mode: 'attended', viewer: { ...peer, deviceId: '588120347', name: 'Suporte TI — Marcos' }, receivedAt: now, known: false }],
    });
  }
  if (kind === 'outgoing') {
    setApp({
      outgoing: { reqId: 'r', targetId: '731204958', mode: 'attended', sessionId: 's', targetName: 'Financeiro-PC', status: 'pending', error: null },
    });
  }
}
