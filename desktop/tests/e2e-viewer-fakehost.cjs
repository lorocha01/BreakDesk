// E2E of the web-mode viewer against the real server, with a scripted in-browser fake host.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP = 'http://localhost:1420';
const SERVER = process.env.SERVER || 'http://localhost:8090';
const OUT = process.env.OUT || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

function log(...a) {
  console.log('[e2e]', ...a);
}

async function fakeHost(page, server, opts) {
  await page.goto(`${APP}/favicon.svg`);
  return page.evaluate(
    async ({ server, opts }) => {
      const { newKeypair, signEd25519, verifyEd25519 } = await import('/src/platform/crypto.ts');
      const { bytesToB64 } = await import('/src/lib/b64.ts');
      const kp = await newKeypair();
      const pub = bytesToB64(kp.publicKey);
      const post = async (p, body) => {
        const r = await fetch(`${server}/api/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
        return r.json();
      };
      const reg = await post('/devices/register', { publicKey: pub, name: 'Fake Host', os: 'Windows 11 (fake)', appVersion: 'test' });
      const ch = await post('/auth/device/challenge', { deviceId: reg.deviceId });
      const sig = await signEd25519(kp.secret, `nexo-auth-v1:${ch.nonce}:${reg.deviceId}`);
      const tok = await post('/auth/device/token', { challengeId: ch.challengeId, deviceId: reg.deviceId, signature: sig });
      const H = (window.__host = { id: reg.deviceId, received: [], files: [], uploads: {}, events: [], ended: null });
      const ws = new WebSocket(`${server.replace('http', 'ws')}/ws?token=${encodeURIComponent(tok.token)}`);
      let session = null;
      let pc = null;
      let control = null;
      let filesDc = null;
      const send = (m) => ws.send(JSON.stringify(m));
      ws.onmessage = async (ev) => {
        const m = JSON.parse(ev.data);
        H.events.push(m.type);
        if (m.type === 'incoming') {
          send({ type: 'accept', sessionId: m.sessionId, permissions: { input: true, files: true, chat: true } });
        } else if (m.type === 'session_started') {
          session = m;
        } else if (m.type === 'session_ended') {
          H.ended = m.reason;
        } else if (m.type === 'signal') {
          const d = m.data;
          if (d.kind === 'ready') await startPc();
          else if (d.kind === 'answer') {
            const ok = await verifyEd25519(session.peer.publicKey, `nexo-sdp-v1:${session.sessionId}:answer:${d.sdp}`, d.sig);
            H.answerSigOk = ok;
            await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
          } else if (d.kind === 'ice') {
            await pc.addIceCandidate(d.candidate).catch(() => {});
          } else if (d.kind === 'restart_request') {
            H.restartRequested = true;
          }
        }
      };
      async function startPc() {
        const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const g = canvas.getContext('2d');
        let n = 0;
        setInterval(() => {
          n++;
          g.fillStyle = `hsl(${n % 360},60%,40%)`;
          g.fillRect(0, 0, 1280, 720);
          g.fillStyle = '#fff';
          g.font = '48px sans-serif';
          g.fillText(`frame ${n}`, 80, 120);
        }, 33);
        const stream = canvas.captureStream(30);
        pc = new RTCPeerConnection({ iceServers: session.iceServers });
        const tr = pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', streams: [stream] });
        const caps = RTCRtpSender.getCapabilities('video').codecs;
        tr.setCodecPreferences([...caps.filter((c) => /h264/i.test(c.mimeType)), ...caps.filter((c) => !/h264/i.test(c.mimeType))]);
        control = pc.createDataChannel('control');
        filesDc = pc.createDataChannel('files');
        filesDc.binaryType = 'arraybuffer';
        control.onopen = () => {
          if (opts.unattended) control.send(JSON.stringify({ t: 'auth_required' }));
          else hello();
        };
        const hello = () =>
          control.send(
            JSON.stringify({
              t: 'hello',
              hostName: 'Fake Host',
              os: 'Windows 11',
              monitors: [
                { index: 0, name: 'Monitor 1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
                { index: 1, name: 'Monitor 2', x: 1920, y: 0, width: 1280, height: 1024, scale: 1, primary: false },
              ],
              current: 0,
              permissions: { input: true, files: true, chat: true },
            }),
          );
        control.onmessage = (e) => {
          const m = JSON.parse(e.data);
          H.received.push(m);
          if (m.t === 'ping') control.send(JSON.stringify({ t: 'pong', id: m.id, ts: m.ts }));
          if (m.t === 'chat') control.send(JSON.stringify({ t: 'chat', id: 'echo-' + m.id, text: 'eco: ' + m.text, ts: Date.now() }));
          if (m.t === 'auth') {
            if (m.password === opts.password) {
              control.send(JSON.stringify({ t: 'auth_result', ok: true }));
              hello();
            } else control.send(JSON.stringify({ t: 'auth_result', ok: false, attemptsLeft: 4 }));
          }
          if (m.t === 'monitor') control.send(JSON.stringify({ t: 'monitor_changed', index: m.index, width: 1280, height: 1024 }));
        };
        filesDc.onmessage = (e) => {
          if (typeof e.data !== 'string') {
            const dv = new DataView(e.data);
            const id = dv.getUint32(0);
            H.uploads[id] = (H.uploads[id] || 0) + e.data.byteLength - 8;
            return;
          }
          const m = JSON.parse(e.data);
          H.files.push(m);
          if (m.op === 'ls') {
            filesDc.send(
              JSON.stringify({
                op: 'ls_result',
                reqId: m.reqId,
                path: m.path || '',
                parent: m.path ? '' : null,
                entries: m.path
                  ? [{ name: 'notas.txt', path: 'C:\\Users\\Ana\\notas.txt', isDir: false, size: 11, modified: new Date().toISOString() }]
                  : [
                      { name: 'C:', path: 'C:\\', isDir: true, size: 0, modified: null },
                      { name: 'relatorio.txt', path: 'C:\\relatorio.txt', isDir: false, size: 40000, modified: null },
                    ],
              }),
            );
          } else if (m.op === 'put') {
            filesDc.send(JSON.stringify({ op: 'put_ok', id: m.id }));
          } else if (m.op === 'put_end') {
            filesDc.send(JSON.stringify({ op: 'done', id: m.id, path: 'C:\\Users\\Ana\\Downloads\\Nexo\\' + m.id }));
          } else if (m.op === 'get') {
            const data = new Uint8Array(40000).map((_, i) => 65 + (i % 26));
            filesDc.send(JSON.stringify({ op: 'get_meta', id: m.id, files: [{ fileIndex: 0, relPath: 'relatorio.txt', size: data.length }], totalSize: data.length }));
            for (let off = 0; off < data.length; off += 16384) {
              const chunk = data.subarray(off, off + 16384);
              const f = new Uint8Array(8 + chunk.length);
              const dv = new DataView(f.buffer);
              dv.setUint32(0, m.id);
              dv.setUint32(4, 0);
              f.set(chunk, 8);
              filesDc.send(f);
            }
            filesDc.send(JSON.stringify({ op: 'file_end', id: m.id, fileIndex: 0 }));
            filesDc.send(JSON.stringify({ op: 'done', id: m.id }));
          }
        };
        pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', sessionId: session.sessionId, data: { kind: 'ice', candidate: e.candidate.toJSON() } });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdp = pc.localDescription.sdp;
        const osig = await signEd25519(kp.secret, `nexo-sdp-v1:${session.sessionId}:offer:${sdp}`);
        send({ type: 'signal', sessionId: session.sessionId, data: { kind: 'offer', sdp, sig: osig } });
      }
      await new Promise((r) => (ws.onopen = r));
      return reg.deviceId;
    },
    { server, opts },
  );
}

async function run() {
  const browser = await chromium.launch();
  let failures = 0;
  const check = (cond, msg) => {
    if (cond) log('PASS', msg);
    else {
      failures++;
      log('FAIL', msg);
    }
  };

  for (const scenario of ['attended', 'unattended']) {
    log('=== scenario', scenario);
    const hostCtx = await browser.newContext();
    const hostPage = await hostCtx.newPage();
    hostPage.on('pageerror', (e) => log('HOST PAGEERROR', e.message));
    const hostId = await fakeHost(hostPage, SERVER, { unattended: scenario === 'unattended', password: 'segredo-123' });
    log('fake host id', hostId);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await ctx.addInitScript((server) => {
      if (!localStorage.getItem('nexo.web.settings.v1')) localStorage.setItem('nexo.web.settings.v1', JSON.stringify({ serverUrl: server }));
    }, SERVER);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('VIEWER PAGEERROR', e.message));
    page.on('console', (m) => m.type() === 'error' && log('VIEWER console.error', m.text()));
    await page.goto(APP);
    await page.waitForSelector('[data-testid=own-id]', { timeout: 15000 });
    const ownId = await page.getAttribute('[data-testid=own-id]', 'data-id');
    check(/^[1-9]\d{8}$/.test(ownId), `viewer registered with id ${ownId}`);
    await page.waitForSelector('[data-testid=connection-status][data-state=online]', { timeout: 15000 });
    check(true, 'signaling online');

    await page.fill('[data-testid=remote-id-input]', hostId);
    if (scenario === 'unattended') {
      await page.click('[data-testid=mode-toggle] button:nth-child(2)');
      await page.fill('[data-testid=unattended-password]', 'errada');
    }
    await page.click('[data-testid=connect-button]');

    if (scenario === 'unattended') {
      await page.waitForSelector('[data-testid=password-input]', { timeout: 20000 });
      check(true, 'auth prompt shown after wrong pre-filled password');
      await page.fill('[data-testid=password-input]', 'segredo-123');
      await page.click('[data-testid=auth-submit]');
    }

    await page.waitForSelector('[data-testid=session-status][data-status=streaming]', { timeout: 20000 });
    check(true, 'session streaming');
    await page.waitForFunction(() => document.querySelector('[data-testid=remote-video]')?.videoWidth > 0, null, { timeout: 15000 });
    const vw = await page.evaluate(() => document.querySelector('[data-testid=remote-video]').videoWidth);
    check(vw > 0, `remote video decoding (${vw}px wide; sender adapts resolution)`);
    const answerOk = await hostPage.evaluate(() => window.__host.answerSigOk);
    check(answerOk === true, 'answer signature verified by host');

    if (scenario === 'attended') {
      // codec
      const codec = await page.evaluate(async () => null);
      void codec;
      // input
      const box = await page.locator('[data-testid=remote-stage]').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.press('KeyA');
      await page.keyboard.press('Control+KeyC');
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(500);
      const rec = await hostPage.evaluate(() => window.__host.received);
      const mm = rec.filter((m) => m.t === 'mm');
      check(mm.length > 0 && mm.every((m) => m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1), `mouse moves normalized (${mm.length})`);
      const centre = mm[mm.length - 1];
      check(centre && Math.abs(centre.x - 0.5) < 0.02 && Math.abs(centre.y - 0.5) < 0.02, `centre maps to ~0.5,0.5 (${centre && centre.x.toFixed(3)},${centre && centre.y.toFixed(3)})`);
      check(rec.some((m) => m.t === 'md' && m.b === 0) && rec.some((m) => m.t === 'mu' && m.b === 0), 'mouse down/up');
      check(rec.some((m) => m.t === 'kd' && m.code === 'KeyA') && rec.some((m) => m.t === 'ku' && m.code === 'KeyA'), 'key down/up');
      check(rec.some((m) => m.t === 'kd' && m.code === 'ControlLeft'), 'modifier keys');
      check(rec.some((m) => m.t === 'wh' && m.dy > 0), 'wheel');
      check(rec.some((m) => m.t === 'viewport' && m.w > 0), 'viewport reported');
      check(rec.some((m) => m.t === 'quality'), 'quality sent after hello');

      // special combo
      await page.click('[data-testid=keys-button]');
      await page.click('text=Ctrl + Alt + Del');
      await page.waitForTimeout(200);
      const rec2 = await hostPage.evaluate(() => window.__host.received);
      check(rec2.some((m) => m.t === 'combo' && m.codes.join() === 'ControlLeft,AltLeft,Delete'), 'combo Ctrl+Alt+Del');

      // monitors
      await page.click('[data-testid=monitors-button]');
      await page.click('[data-testid=monitor-1]');
      await page.waitForTimeout(300);
      const rec3 = await hostPage.evaluate(() => window.__host.received);
      check(rec3.some((m) => m.t === 'monitor' && m.index === 1), 'monitor switch');

      // chat
      await page.click('[data-testid=chat-button]');
      await page.fill('[data-testid=chat-input]', 'olá host');
      await page.click('[data-testid=chat-send]');
      await page.waitForSelector('[data-testid=chat-msg-peer]:has-text("eco: olá host")', { timeout: 5000 });
      check(true, 'chat round trip');

      // files
      await page.click('[data-testid=files-button]');
      await page.waitForSelector('[data-testid=remote-entry][data-name="relatorio.txt"]', { timeout: 8000 });
      check(true, 'remote listing');
      const tmp = path.join(OUT, 'upload-test.bin');
      fs.writeFileSync(tmp, Buffer.alloc(300_000, 7));
      await page.setInputFiles('[data-testid=upload-input]', tmp);
      await page.waitForSelector('[data-testid=transfer-item][data-state=done]', { timeout: 15000 });
      const up = await hostPage.evaluate(() => window.__host.uploads);
      const total = Object.values(up).reduce((a, b) => a + b, 0);
      check(total === 300_000, `upload bytes received by host (${total})`);
      const putMsg = (await hostPage.evaluate(() => window.__host.files)).find((m) => m.op === 'put');
      check(putMsg && putMsg.relPath === 'upload-test.bin' && putMsg.size === 300000, 'put header');
      const dlPromise = page.waitForEvent('download', { timeout: 10000 });
      await page.locator('[data-testid=remote-entry][data-name="relatorio.txt"] [data-testid=download-entry]').click({ force: true });
      const dl = await dlPromise;
      const dlPath = await dl.path();
      const size = fs.statSync(dlPath).size;
      check(size === 40000 && dl.suggestedFilename() === 'relatorio.txt', `download received (${size} bytes, ${dl.suggestedFilename()})`);

      // stats / quality
      await page.waitForFunction(() => Number(document.querySelector('[data-testid=quality-indicator]')?.dataset.level) > 0, null, { timeout: 8000 });
      const route = await page.getAttribute('[data-testid=quality-indicator]', 'data-route');
      check(route === 'p2p', `route detected (${route})`);
      await page.click('[data-testid=stats-button]');
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, 'e2e-session.png') });
    }

    await page.click('[data-testid=end-session]');
    await page.waitForSelector('[data-testid=own-id]', { timeout: 8000 });
    await hostPage.waitForFunction(() => window.__host.ended, null, { timeout: 8000 });
    const reason = await hostPage.evaluate(() => window.__host.ended);
    check(reason === 'peer_ended' || reason === 'user', `host notified of end (${reason})`);

    if (scenario === 'attended') {
      await page.click('[data-testid=nav-history]');
      await page.waitForSelector('[data-testid=sessions-table] tbody tr', { timeout: 8000 });
      const rows = await page.locator('[data-testid=sessions-table] tbody tr').count();
      check(rows >= 1, `history shows ${rows} session(s)`);
      await page.screenshot({ path: path.join(OUT, 'e2e-history.png') });
      await page.click('[data-testid=nav-home]');
      await page.waitForSelector(`[data-testid=recent-${hostId}]`, { timeout: 5000 });
      check(true, 'recent device listed');
    }
    await ctx.close();
    await hostCtx.close();
  }

  // Rejection / not found
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript((server) => localStorage.setItem('nexo.web.settings.v1', JSON.stringify({ serverUrl: server })), SERVER);
    const page = await ctx.newPage();
    await page.goto(APP);
    await page.waitForSelector('[data-testid=connection-status][data-state=online]', { timeout: 15000 });
    await page.fill('[data-testid=remote-id-input]', '199999999');
    await page.click('[data-testid=connect-button]');
    await page.waitForSelector('[data-testid=outgoing-status][data-status=error]', { timeout: 8000 });
    const txt = await page.textContent('.modal-sub');
    check(/encontrado|offline/i.test(txt), `unknown id error shown: "${txt}"`);
    await ctx.close();
  }

  // Offline server: graceful
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => localStorage.setItem('nexo.web.settings.v1', JSON.stringify({ serverUrl: 'http://127.0.0.1:9' })));
    const page = await ctx.newPage();
    await page.goto(APP);
    await page.waitForSelector('[data-testid=retry-server]', { timeout: 8000 });
    check(true, 'offline banner with retry');
    await page.screenshot({ path: path.join(OUT, 'e2e-offline.png') });
    await ctx.close();
  }

  await browser.close();
  log(failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`);
  process.exit(failures ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
