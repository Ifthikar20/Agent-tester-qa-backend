import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { VirtualCursor, sleep } from './cursor.js';
import { OPS, validate, registry } from './ops.js';
import { parse } from './parse.js';

const PORT = Number(process.env.PORT) || 3000;
const VIEW = { width: 1180, height: 760 };

const app = express();
app.use(express.static('public'));
const http = app.listen(PORT, () =>
  console.log(`\n  ghostclick  ->  http://localhost:${PORT}\n`)
);
const wss = new WebSocketServer({ server: http });

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({
  // Set CHROMIUM_PATH when the sandbox ships a Chromium that does not match
  // the revision this Playwright build would download. Otherwise leave unset.
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage', '--force-color-profile=srgb'],
});
const page = await browser.newPage({ viewport: VIEW });
const cdp = await page.context().newCDPSession(page);

let lastFrame = null;
const clients = new Set();

function emit(ev) {
  const msg = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}

cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  // ACK FIRST. Chrome sends no further frames until this lands — it is the
  // backpressure valve, and forgetting it looks exactly like "streaming broke".
  try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}

  lastFrame = Buffer.from(data, 'base64');
  for (const c of clients) {
    // Drop frames for a viewer that is already behind rather than queueing
    // them in Node. Video is the one thing that is always safe to drop.
    if (c.readyState === 1 && c.bufferedAmount < 1 << 20) c.send(lastFrame, { binary: true });
  }
});

await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 62,
  // Must match the viewport. Set these smaller and Chrome scales the frame,
  // the canvas stretches it back, and every coordinate silently picks up a
  // proportional offset that looks exactly like a broken cursor.
  maxWidth: VIEW.width,
  maxHeight: VIEW.height,
  everyNthFrame: 1,
});

const cursor = new VirtualCursor(cdp, emit);
await page.goto(`http://localhost:${PORT}/demo.html`);

// ---------------------------------------------------------------- executor
let running = false;

async function run(plan) {
  if (running) return emit({ t: 'log', level: 'warn', msg: 'A run is already in progress' });
  running = true;

  const ctx = { cursor, emit };
  emit({ t: 'run.start', total: plan.steps.length, suite: plan.suite });

  let failed = false;
  for (const [i, step] of plan.steps.entries()) {
    emit({ t: 'step.start', i, step });
    const t0 = Date.now();
    try {
      await OPS[step.op](page, step, ctx);
      emit({ t: 'step.pass', i, ms: Date.now() - t0 });
    } catch (err) {
      emit({ t: 'step.fail', i, ms: Date.now() - t0, error: err.message });
      failed = true;
      break;
    }
    await sleep(120);
  }

  emit({ t: 'run.end', ok: !failed });
  running = false;
}

// ---------------------------------------------------------------- sockets
wss.on('connection', (ws) => {
  clients.add(ws);

  // Frames are damage-driven: a static page emits nothing, so a viewer
  // connecting to an idle session would stare at a blank canvas. Prime them
  // with the last frame we held.
  if (lastFrame) ws.send(lastFrame, { binary: true });
  ws.send(JSON.stringify({ t: 'ready', targets: Object.keys(registry) }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t !== 'command') return;
    try {
      run(validate(parse(m.text)));
    } catch (err) {
      emit({ t: 'log', level: 'error', msg: err.message });
    }
  });

  ws.on('close', () => clients.delete(ws));
});

process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { await browser.close(); process.exit(0); });
