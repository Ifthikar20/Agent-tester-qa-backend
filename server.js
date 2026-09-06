import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { VirtualCursor, sleep } from './cursor.js';
import { OPS, validate } from './ops.js';
import * as origins from './origins.js';
import * as vault from './secrets.js';
import { discover } from './targets.js';
import { parse } from './parse.js';
import { parseFlow, flatten, toFlow } from './flow.js';
import { toMermaid } from './diagram.js';
import { Recorder } from './recorder.js';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT) || 3000;
const VIEW = { width: 1180, height: 760 };
const HOME = process.env.HOME_URL || `http://localhost:${PORT}/demo.html`;

const app = express();
app.use(express.static('public'));
app.use(express.json({ limit: '512kb' }));

/**
 * Where the browser extension drops a recording.
 *
 * It is validated here and put in the viewer's script box — never run. Any
 * page you visit can reach a localhost port, so an endpoint that executed what
 * it was handed would be a remote-code path with extra steps. A human presses
 * Run.
 */
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/api/recording', (req, res) => {
  const flow = String(req.body?.flow ?? '');
  let plan;
  try {
    plan = validate(flatten(parseFlow(flow)));
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  emit({ t: 'imported', flow, steps: plan.steps.length });
  emit({ t: 'log', level: 'info', msg: `recording imported — ${plan.steps.length} steps, not run` });
  res.json({ ok: true, steps: plan.steps.length });
});
// Vendored so the viewer works with no CDN and no network.
app.get('/vendor/mermaid.min.js', (_req, res) =>
  res.sendFile(require.resolve('mermaid/dist/mermaid.min.js')));

const http = app.listen(PORT, () =>
  console.log(`\n  ghostclick  ->  http://localhost:${PORT}` +
              `\n  allowed     ->  ${origins.list().join(', ')}` +
              `\n  secrets     ->  ${vault.names().join(', ') || '(none set)'}\n`));
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

// Teach mode. Canvas clicks reach the page as real DOM events, so the same
// listener sees a human demonstrating and would see the executor replaying —
// which is why recording is gated off during a run.
const recorder = new Recorder(page, {
  onStep: (step, steps) => emit({
    t: 'recorded',
    step,
    count: steps.length,
    flow: toFlow({ suite: 'Recorded flow', steps }),
  }),
  onError: (msg) => emit({ t: 'log', level: 'error', msg }),
});
await recorder.attach();

// An SPA route change is an assertion worth keeping, and it means the target
// panel is stale.
// Only for refreshing the target panel. URL changes reach the recorder
// through the page's own ordered event channel, not from here — watching
// navigation separately filed clicks after the transitions they caused.
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) publishTargets();
});

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
  const wasRecording = recorder.recording;
  recorder.recording = false;

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
  recorder.recording = wasRecording;
  emit({ t: 'run.end', ok });
}

// ---------------------------------------------------------------- sockets
wss.on('connection', async (ws) => {
  clients.add(ws);

  // Frames are damage-driven: a static page emits nothing, so a viewer
  // connecting to an idle session would stare at a blank canvas. Prime them
  // with the last frame we held.
  if (lastFrame) ws.send(lastFrame, { binary: true });
  ws.send(JSON.stringify({
    t: 'ready', url: page.url(),
    origins: origins.list(),
    secrets: vault.names(),        // names only — a value never leaves the server
  }));
  await publishTargets();

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'command') {
      let plan;
      try {
        // Two front ends, one IR: the line DSL and the mermaid flow language
        // meet at validate() and the executor never learns which was typed.
        const isFlow = /\b(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/.test(m.text) || /-{2,3}>/.test(m.text);
        plan = validate(isFlow ? flatten(parseFlow(m.text)) : parse(m.text));
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
      let url;
      try {
        url = origins.normalizeUrl(m.url).href;   // "acme.com" is a host, not a path
      } catch (err) {
        return emit({ t: 'log', level: 'error', msg: err.message });
      }
      if (!origins.has(new URL(url).origin)) {
        // Offer the one thing that unblocks it, rather than an error that
        // ends in "restart with an env var".
        return emit({ t: 'needs.origin', origin: new URL(url).origin, url });
      }
      try {
        await OPS.goto(page, { url }, { cursor, emit, onNavigate: publishTargets });
        emit({ t: 'log', level: 'info', msg: `opened ${url}` });
      } catch (err) {
        emit({ t: 'log', level: 'error', msg: err.message });
      }
      return;
    }

    // Allowing an origin is a human act, through the UI. No plan can reach it.
    if (m.t === 'origin.add') {
      try {
        const r = origins.add(m.origin);
        emit({ t: 'origins', origins: origins.list() });
        emit({ t: 'log', level: 'info',
               msg: `${r.added ? 'allowed' : 'already allowed'} ${r.origin}` +
                    (r.private ? ' — private address, allowed by name' : '') });
        if (m.thenOpen) ws.send(JSON.stringify({ t: 'reopen', url: m.thenOpen }));
      } catch (err) {
        emit({ t: 'log', level: 'error', msg: err.message });
      }
      return;
    }
    if (m.t === 'origin.remove') {
      try {
        origins.remove(m.origin);
        emit({ t: 'origins', origins: origins.list() });
      } catch (err) {
        emit({ t: 'log', level: 'error', msg: err.message });
      }
      return;
    }
    if (m.t === 'secrets.reload') {
      emit({ t: 'secrets', secrets: vault.reload() });
      return;
    }

    if (m.t === 'inspect' && !running) return void publishTargets();

    // ------------------------------------------------------------ teach mode
    if (m.t === 'record.start' && !running) {
      // Fingerprint where the recording begins, so replay can tell you when the
      // entry URL does not actually get you back here.
      const entry = await discover(page).then((i) => i.map((t) => t.target)).catch(() => []);
      const steps = recorder.start(page.url(), entry);
      emit({ t: 'record.state', on: true });
      emit({ t: 'recorded', step: steps[0], count: steps.length,
             flow: toFlow({ suite: 'Recorded flow', steps }) });
      return;
    }
    if (m.t === 'record.stop') {
      const steps = recorder.stop(page.url());
      emit({ t: 'record.state', on: false });
      emit({ t: 'recorded', count: steps.length,
             flow: toFlow({ suite: 'Recorded flow', steps }) });
      return;
    }

    // Human takeover. The same VirtualCursor the executor uses, so the drawn
    // arrow stays authoritative across the handoff — and so the demonstration
    // reaches the page as genuine input events the recorder can see.
    if (!running) {
      if (m.t === 'human.move') return void cursor.moveTo(m.x, m.y);
      if (m.t === 'human.click') return void cursor.click();
      if (m.t === 'human.key') {
        if (typeof m.text === 'string' && m.text.length === 1) {
          return void page.keyboard.type(m.text).catch(() => {});
        }
        if (typeof m.key === 'string' && /^[A-Za-z0-9]+$/.test(m.key)) {
          return void page.keyboard.press(m.key).catch(() => {});
        }
      }
    }
  });

  ws.on('close', () => clients.delete(ws));
});

process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { await browser.close(); process.exit(0); });
