// E2E com host REAL (nexo-hostd em Rust capturando um Xvfb) e a UI web real (Chromium).
// Executado por e2e/run.sh, que prepara servidor, coturn, Xvfb e o agente.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { HOST_ID, SERVER, APP, E2E_WORK, DISPLAY } = process.env;
const OUT = path.join(E2E_WORK, 'out');
const PASSWORD = 'senha-e2e-123';
let failures = 0;
const log = (...a) => console.log('[e2e]', ...a);
const check = (cond, msg) => {
  if (cond) log('PASS', msg);
  else { failures++; log('FAIL', msg); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostMouse = () => {
  const out = execFileSync('xdotool', ['getmouselocation', '--shell'], { env: { ...process.env, DISPLAY } }).toString();
  const x = Number(/X=(\d+)/.exec(out)[1]);
  const y = Number(/Y=(\d+)/.exec(out)[1]);
  return { x, y };
};
async function waitFor(fn, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

async function runScenario(browser, { name, relayOnly }) {
  log(`=== cenário: ${name}`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(({ server, relayOnly }) => {
    if (!localStorage.getItem('nexo.web.settings.v1')) localStorage.setItem('nexo.web.settings.v1', JSON.stringify({ serverUrl: server }));
    if (relayOnly) {
      // Simula redes que não permitem conexão direta: o viewer só pode usar candidatos TURN.
      const Orig = window.RTCPeerConnection;
      window.RTCPeerConnection = function (cfg, ...rest) { return new Orig({ ...(cfg || {}), iceTransportPolicy: 'relay' }, ...rest); };
      window.RTCPeerConnection.prototype = Orig.prototype;
      Object.setPrototypeOf(window.RTCPeerConnection, Orig);
    }
  }, { server: SERVER, relayOnly });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  await page.goto(APP);
  await page.waitForSelector('[data-testid=connection-status][data-state=online]', { timeout: 20000 });
  const ownId = await page.getAttribute('[data-testid=own-id]', 'data-id');
  check(/^[1-9]\d{8}$/.test(ownId), `viewer registrado e online (ID ${ownId})`);

  // Pedido não supervisionado com senha errada → prompt → senha correta
  await page.fill('[data-testid=remote-id-input]', HOST_ID);
  await page.click('[data-testid=mode-toggle] button:nth-child(2)');
  await page.fill('[data-testid=unattended-password]', 'senha-errada');
  await page.click('[data-testid=connect-button]');
  await page.waitForSelector('[data-testid=password-input]', { timeout: 30000 }).catch(async (e) => {
    await page.screenshot({ path: path.join(OUT, `falha-${name}.png`) });
    throw e;
  });
  check(true, 'host Rust recusou senha errada e pediu a senha');
  await page.fill('[data-testid=password-input]', PASSWORD);
  await page.click('[data-testid=auth-submit]');
  await page.waitForSelector('[data-testid=session-status][data-status=streaming]', { timeout: 30000 });
  check(true, 'sessão autenticada e transmitindo');

  await page.waitForFunction(() => document.querySelector('[data-testid=remote-video]')?.videoWidth > 0, null, { timeout: 20000 });
  const v = await page.evaluate(() => { const el = document.querySelector('[data-testid=remote-video]'); return { w: el.videoWidth, h: el.videoHeight }; });
  check(v.w >= 640, `vídeo H.264 do host decodificado (${v.w}x${v.h})`);

  // Rota e qualidade (getStats)
  await page.waitForFunction(() => Number(document.querySelector('[data-testid=quality-indicator]')?.dataset.level) > 0, null, { timeout: 15000 });
  const route = await page.getAttribute('[data-testid=quality-indicator]', 'data-route');
  check(route === (relayOnly ? 'relay' : 'p2p'), `rota detectada: ${route}`);

  // Frames chegando continuamente
  const f1 = await page.evaluate(() => document.querySelector('[data-testid=remote-video]').getVideoPlaybackQuality().totalVideoFrames);
  await sleep(2000);
  const f2 = await page.evaluate(() => document.querySelector('[data-testid=remote-video]').getVideoPlaybackQuality().totalVideoFrames);
  check(f2 - f1 >= 6, `frames contínuos (${f2 - f1} frames em 2 s)`);

  // Mouse: aponta para 25%/75% do vídeo e confere a posição REAL do cursor no Xvfb (1600x900)
  const rect = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=remote-video]');
    const r = el.getBoundingClientRect();
    const s = Math.min(r.width / el.videoWidth, r.height / el.videoHeight);
    const w = el.videoWidth * s, h = el.videoHeight * s;
    return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, w, h };
  });
  await page.mouse.move(rect.x + rect.w * 0.25, rect.y + rect.h * 0.75, { steps: 5 });
  const okMouse = await waitFor(() => { const m = hostMouse(); return Math.abs(m.x - 400) <= 8 && Math.abs(m.y - 675) <= 8; }, 4000);
  const m = hostMouse();
  check(okMouse, `cursor real do host movido para (${m.x},${m.y}) ≈ (400,675)`);

  // Teclado: digita um comando no terminal do host e confere o efeito no disco
  const marker = path.join(E2E_WORK, `teclado-${name}.txt`);
  await page.mouse.click(rect.x + rect.w * 0.5, rect.y + rect.h * 0.5);
  // Digita como um teclado físico: caracteres com Shift seguram ShiftLeft de verdade.
  const SHIFTED = { '>': 'Period', '<': 'Comma', '_': 'Minus', ':': 'Semicolon' };
  for (const ch of `echo nexo-${name} > ${marker}`) {
    if (SHIFTED[ch]) { await page.keyboard.down('Shift'); await page.keyboard.press(SHIFTED[ch]); await page.keyboard.up('Shift'); }
    else await page.keyboard.type(ch);
    await sleep(10);
  }
  await page.keyboard.press('Enter');
  const okKbd = await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === `nexo-${name}`, 6000);
  try { execFileSync('import', ['-display', DISPLAY, '-window', 'root', path.join(OUT, `host-tela-${name}.png`)]); } catch {}
  check(okKbd, 'teclado remoto executou comando no terminal do host');

  // Upload: arquivo do viewer → pasta de recebimento do host
  await page.click('[data-testid=files-button]');
  await page.waitForSelector('[data-testid=remote-file-list]', { timeout: 10000 });
  const upName = `upload-${name}.bin`;
  const upPath = path.join(OUT, upName);
  const upData = require('crypto').randomBytes(700_000);
  fs.writeFileSync(upPath, upData);
  await page.setInputFiles('[data-testid=upload-input]', upPath);
  const recvPath = path.join(E2E_WORK, 'received', upName);
  const okUp = await waitFor(() => fs.existsSync(recvPath) && fs.statSync(recvPath).size === upData.length, 20000);
  check(okUp && fs.readFileSync(recvPath).equals(upData), `upload de ${upData.length} bytes íntegro no host`);

  // Download: navega no disco do host até host-share/pasta e baixa dados.bin
  const segs = path.join(E2E_WORK, 'host-share', 'pasta').split('/').filter(Boolean);
  await page.locator('[data-testid=remote-entry]').first().waitFor({ timeout: 10000 });
  const rootEntry = page.locator('[data-testid=remote-entry][data-name="/"]');
  if (await rootEntry.count()) await rootEntry.dblclick();
  // Navega pasta a pasta; repete o duplo clique se a lista ainda estava sendo redesenhada.
  const steps = [...segs, null];
  for (let i = 0; i < segs.length; i++) {
    const cur = page.locator(`[data-testid=remote-entry][data-name="${segs[i]}"]`);
    const next = steps[i + 1] ?? 'dados.bin';
    const nextLoc = page.locator(`[data-testid=remote-entry][data-name="${next}"]`);
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      if (await cur.count()) await cur.first().dblclick().catch(() => {});
      ok = await nextLoc.first().waitFor({ timeout: 4000 }).then(() => true, () => false);
    }
    if (!ok) {
      await page.screenshot({ path: path.join(OUT, `falha-nav-${name}-${segs[i]}.png`) });
      throw new Error(`não navegou para ${segs[i]}`);
    }
  }
  await page.locator('[data-testid=remote-entry][data-name="dados.bin"]').waitFor({ timeout: 10000 });
  const dlP = page.waitForEvent('download', { timeout: 20000 });
  await page.locator('[data-testid=remote-entry][data-name="dados.bin"] [data-testid=download-entry]').click({ force: true });
  const dl = await dlP;
  const got = fs.readFileSync(await dl.path());
  const orig = fs.readFileSync(path.join(E2E_WORK, 'host-share', 'pasta', 'dados.bin'));
  check(got.equals(orig), `download de ${got.length} bytes íntegro (${dl.suggestedFilename()})`);

  await page.click('[data-testid=stats-button]').catch(() => {});
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, `sessao-${name}.png`) });

  await page.click('[data-testid=end-session]');
  await page.waitForSelector('[data-testid=own-id]', { timeout: 10000 });
  check(true, 'sessão encerrada pelo viewer');

  await page.click('[data-testid=nav-history]');
  await page.waitForSelector('[data-testid=sessions-table] tbody tr', { timeout: 10000 });
  const txt = await page.locator('[data-testid=sessions-table] tbody tr').first().innerText();
  check(txt.includes(HOST_ID.slice(0, 3)), 'histórico registra a sessão com o host');
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream'] });
  try {
    await runScenario(browser, { name: 'p2p', relayOnly: false });
    await runScenario(browser, { name: 'relay', relayOnly: true });
  } catch (e) {
    failures++;
    log('ERRO', e.stack || e.message);
  } finally {
    await browser.close();
  }
  log(failures === 0 ? 'TODOS OS TESTES PASSARAM' : `${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
