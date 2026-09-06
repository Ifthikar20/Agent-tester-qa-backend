import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { VirtualCursor, sleep } from './cursor.js';
import { OPS, validate, ALLOWED_ORIGINS } from './ops.js';
import { discover } from './targets.js';
import { parse } from './parse.js';
import { toMermaid } from './diagram.js';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT) || 3000;
const VIEW = { width: 1180, height: 760 };
const HOME = process.env.HOME_URL || `http://localhost:${PORT}/demo.html`;

const app = express();
app.use(express.static('public'));
// Vendored so the viewer works with no CDN and no network.
app.get('/vendor/mermaid.min.js', (_req, res) =>
  res.sendFile(require.resolve('mermaid/dist/mermaid.min.js')));

const http = app.listen(PORT, () =>
  console.log(`\n  ghostclick  ->  http://localhost:${PORT}` +
              `\n  origins     ->  ${ALLOWED_ORIGINS.join(', ')}\n`));
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
await page.goto(HOME);

/** What can the current page be told to do? Emitted whenever it changes. */
async function publishTargets() {
  try {
    emit({ t: 'targets', url: page.url(), items: await discover(page) });
  } catch (err) {
    emit({ t: 'log', level: 'error', msg: `discovery failed: ${err.message}` });
  }
}

// ---------------------------------------------------------------- executor
let running = false;

async function run(plan) {
  if (running) return emit({ t: 'log', level: 'warn', msg: 'A run is already in progress' });
  running = true;

  const results = [];
  const ctx = { cursor, emit, onNavigate: publishTargets };
  emit({ t: 'run.start', total: plan.steps.length, suite: plan.suite });

  for (const [i, step] of plan.steps.entries()) {
    emit({ t: 'step.start', i, step });
    const t0 = Date.now();
    try {
      await OPS[step.op](page, step, ctx);
      results.push({ i, ok: true, ms: Date.now() - t0 });
      emit({ t: 'step.pass', i, ms: Date.now() - t0 });
    } catch (err) {
      results.push({ i, ok: false, ms: Date.now() - t0, error: err.message });
      emit({ t: 'step.fail', i, ms: Date.now() - t0, error: err.message });
      break;
    }
    await sleep(120);
  }

  const ok = results.every((r) => r.ok);
  // Same function, same IR — with outcomes folded in, the plan diagram
  // becomes the run report.
  emit({ t: 'diagram', kind: 'report', mermaid: toMermaid(plan, { results }) });
  await publishTargets();

  // Clear the lock BEFORE announcing the end. run.end means "you may start
  // another run"; emitting it while still locked makes a caller that runs
  // back-to-back scripts hang on a silently refused second run.
  running = false;
  emit({ t: 'run.end', ok });
}

// ---------------------------------------------------------------- sockets
wss.on('connection', async (ws) => {
  clients.add(ws);

  // Frames are damage-driven: a static page emits nothing, so a viewer
  // connecting to an idle session would stare at a blank canvas. Prime them
  // with the last frame we held.
  if (lastFrame) ws.send(lastFrame, { binary: true });
  ws.send(JSON.stringify({ t: 'ready', origins: ALLOWED_ORIGINS, url: page.url() }));
  await publishTargets();

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'command') {
      let plan;
      try {
        plan = validate(parse(m.text));
      } catch (err) {
        return emit({ t: 'log', level: 'error', msg: err.message });
      }
      // Draw the plan before running it, so a diagram exists even if step 0
      // fails. The run replaces it with the outcome version.
      emit({ t: 'diagram', kind: 'plan', mermaid: toMermaid(plan) });
      run(plan);
      return;
    }

    // Point the browser anywhere the allowlist permits, then ask the page
    // what it can be told to do. This is what makes an unseen URL scriptable.
    if (m.t === 'open' && !running) {
      try {
        await OPS.goto(page, { url: m.url }, { cursor, emit, onNavigate: publishTargets });
        emit({ t: 'log', level: 'info', msg: `opened ${m.url}` });
      } catch (err) {
        emit({ t: 'log', level: 'error', msg: err.message });
      }
      return;
    }

    if (m.t === 'inspect' && !running) await publishTargets();
  });

  ws.on('close', () => clients.delete(ws));
});

process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { await browser.close(); process.exit(0); });
