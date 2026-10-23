// CDP driver that ONLY touches its own dedicated tab.
// A tab is created once and its targetId is remembered in .tab.json.
// Never picks the user's tabs.
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const REG = path.resolve('.tab.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));

async function listTargets() {
  return await (await fetch(BASE + '/json/list')).json();
}

async function getOwnTab(createUrl) {
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(REG, 'utf8')); } catch {}
  if (reg?.targetId) {
    const list = await listTargets();
    const found = list.find(t => t.id === reg.targetId && t.type === 'page');
    if (found) return found;
  }
  const url = createUrl || 'about:blank';
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const t = await r.json();
  fs.writeFileSync(REG, JSON.stringify({ targetId: t.id, createdAt: Date.now() }, null, 2));
  return t;
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 45000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function connect() {
  const t = await getOwnTab();
  const cdp = await new CDP(t.webSocketDebuggerUrl).open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, target: t };
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function humanScroll(cdp, { total, steps, dir = 'down' } = {}) {
  const T = total ?? rnd(700, 1800);
  const S = steps ?? rnd(4, 8);
  let done = 0;
  for (let i = 0; i < S; i++) {
    const remain = T - done;
    const step = Math.max(50, Math.round(remain / (S - i) * (0.7 + Math.random() * 0.6)));
    await evaluate(cdp, `window.scrollBy({top:${dir === 'down' ? step : -step},left:0,behavior:'smooth'});'ok'`);
    done += step;
    await sleep(rnd(150, 600));
  }
  if (Math.random() < 0.45) {
    await evaluate(cdp, `window.scrollBy({top:-${rnd(40, 150)},left:0,behavior:'smooth'});'ok'`);
    await sleep(rnd(250, 800));
  }
  return done;
}

async function shot(cdp, outPath, full = false) {
  let params = { format: 'png' };
  if (full) {
    const m = await cdp.send('Page.getLayoutMetrics');
    const cs = m.cssContentSize || m.contentSize;
    params = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cs.width, height: Math.min(cs.height, 15000), scale: 1 } };
  }
  const r = await cdp.send('Page.captureScreenshot', params);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'));
  return path.resolve(outPath);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'newtab') {
    const url = rest[0] || 'about:blank';
    try { fs.unlinkSync(REG); } catch {}
    const t = await getOwnTab(url);
    console.log('created tab ' + t.id + ' -> ' + t.url);
  } else if (cmd === 'tabs') {
    const list = await listTargets();
    console.log(JSON.stringify(list.filter(t => t.type === 'page').map(t => ({ id: t.id.slice(0, 8), title: t.title, url: t.url })), null, 2));
  } else {
    const { cdp, target } = await connect();
    try {
      if (cmd === 'goto') {
        await cdp.send('Page.navigate', { url: rest[0] });
        await sleep(rnd(2600, 4600));
        console.log(await evaluate(cdp, 'location.href + " | " + document.title'));
      } else if (cmd === 'eval') {
        const a = rest[0];
        const expr = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : a;
        console.log(JSON.stringify(await evaluate(cdp, expr), null, 2));
      } else if (cmd === 'shot') {
        console.log(await shot(cdp, rest[0] || 'shot.png', rest.includes('--full')));
      } else if (cmd === 'scroll') {
        await humanScroll(cdp, { total: Number(rest[0]) || 1200 });
        console.log('scrolled');
      } else if (cmd === 'human') {
        if (rest[0]) { await cdp.send('Page.navigate', { url: rest[0] }); await sleep(rnd(3000, 5000)); }
        for (let i = 0; i < 3; i++) { await humanScroll(cdp); await sleep(rnd(800, 1800)); }
        console.log(await evaluate(cdp, 'location.href + " | " + document.title'));
      } else if (cmd === 'url') {
        console.log(await evaluate(cdp, 'location.href + " | " + document.title'));
      } else {
        console.log('unknown cmd; target=' + target.id);
      }
    } finally { cdp.close(); }
  }
} catch (e) {
  console.error('ERR ' + e.message);
  process.exit(1);
}
