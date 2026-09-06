import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { VirtualCursor, sleep } from './cursor.js';
import { OPS, validate } from './ops.js';
import * as origins from './origins.js';
import * as vault from './secrets.js';
import * as history from './runs.js';
import * as suites from './suites.js';
import { discover, links } from './targets.js';
import { parse } from './parse.js';
import { parseFlow, flatten, toFlow } from './flow.js';
import { toMermaid } from './diagram.js';
import { Recorder } from './recorder.js';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT) || 3000;
const VIEW = { width: 1180, height: 760 };
const HOME = process.env.HOME_URL || `http://localhost:${PORT}/demo.html`;

const HEADED = /^(1|true|yes|on)$/i.test(process.env.HEADED ?? '');

const app = express();
/**
 * Static files, with the one header that matters.
 *
 * Vite fingerprints its assets, so those are safe to cache forever. index.html
 * is not fingerprinted — it is the file that NAMES the current fingerprints —
 * so a browser that caches it keeps loading yesterday's JavaScript no matter
 * how many times you pull and rebuild. That is a long afternoon of "why don't I
 * see the new button", and it is one header.
 */
app.use(express.static('public', {
  setHeaders(res, path) {
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (path.includes('/app/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
app.use(express.json({ limit: '512kb' }));

/**
 * The Vue app.
 *
 * It is built to `public/app/` and that build is committed, so `npm start`
 * serves the whole UI with no bundler in the picture — a tool you need a build
 * step to run is a tool people stop running. `npm run dev` puts Vite in front
 * for working on it.
 *
 * Static files win (this sits after express.static), so only client-side routes
 * reach the fallback.
 */
const APP = fileURLToPath(new URL('./public/app/index.html', import.meta.url));
app.get('/', (_req, res) => res.redirect('/app/'));
app.use('/app', (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/assets/')) return next();
  res.sendFile(APP, (err) => {
    if (err) next(new Error('The UI is not built — run `npm run build`'));
  });
});

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

app.get('/api/runs', (req, res) => res.json(history.summary(14, req.query.suite || null)));

// ------------------------------------------------------------ suites (API)
/**
 * Onboarding a project happens over HTTP, not the socket, because it is
 * ordinary CRUD that has to work on a page reload and be linkable. The socket
 * carries what is live — frames, cursor, step outcomes.
 *
 * Two endpoints here touch the browser (scan and run) and both go through the
 * same run lock and the same origin gate as everything else. Neither can add
 * an origin: `POST /api/origins` exists for that, and it is only ever reached
 * by someone pressing a button.
 */
const fail = (res, err, code = 400) => res.status(code).json({ ok: false, error: err.message ?? String(err) });
const sendOk = (res, body) => res.json({ ok: true, ...body });

/** Parse+validate a flow the way the executor will. Suites store nothing unrunnable. */
const checkFlow = (flow) => validate(flatten(parseFlow(flow)));

/** The gate, as an answer the UI can act on rather than an error it must read. */
function gate(res, origin) {
  if (origins.has(origin)) return false;
  res.status(409).json({ ok: false, needsOrigin: origin,
    error: `${origin} is not allowed yet` });
  return true;
}

/**
 * What exactly is running.
 *
 * "Am I on the latest?" should be answerable by looking, not by remembering
 * whether you pulled. The commit is read straight out of .git rather than
 * shelling out, so it works where git is not on PATH.
 */
const version = (() => {
  const read = (p) => { try { return readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8').trim(); } catch { return null; } };
  let commit = null;
  const head = read('./.git/HEAD');
  if (head?.startsWith('ref: ')) commit = read(`./.git/${head.slice(5)}`);
  else if (head) commit = head;
  let built = null;
  try { built = statSync(APP).mtime.toISOString(); } catch { /* not built */ }
  return {
    commit: commit ? commit.slice(0, 7) : null,
    built,
    started: new Date().toISOString(),
  };
})();
app.get('/api/version', (_req, res) => res.json(version));

app.get('/api/state', (_req, res) => res.json({
  url: page?.url() ?? null,
  running,
  recording: recorder?.recording ?? false,
  origins: origins.list(),
  secrets: vault.names(),        // names only — a value never leaves the server
  headed: HEADED,
}));

app.get('/api/origins', (_req, res) => res.json({ origins: origins.list() }));
app.post('/api/origins', (req, res) => {
  try {
    const r = origins.add(req.body?.origin);
    emit({ t: 'origins', origins: origins.list() });
    sendOk(res, { ...r, origins: origins.list() });
  } catch (err) { fail(res, err); }
});
app.delete('/api/origins', (req, res) => {
  try { origins.remove(req.body?.origin); sendOk(res, { origins: origins.list() }); }
  catch (err) { fail(res, err); }
});

/**
 * Every case, across every suite, flat.
 *
 * The console is not inside a suite — you can arrive at it from anywhere — so
 * "run the thing I saved yesterday" needs one list rather than a hunt through
 * the sidebar. The flow rides along because loading a case IS its flow, and a
 * second round trip to fetch it would only make selecting one feel slow.
 */
app.get('/api/cases', (_req, res) => {
  const out = [];
  for (const row of suites.list()) {
    for (const c of suites.get(row.id).cases) {
      out.push({ suiteId: row.id, suite: row.name, ...c });
      if (out.length >= 200) break;              // a picker, not an archive
    }
    if (out.length >= 200) break;
  }
  res.json({ cases: out });
});

app.get('/api/suites', (_req, res) => res.json({ suites: suites.list() }));
app.post('/api/suites', (req, res) => {
  try { sendOk(res, { suite: suites.create(req.body ?? {}) }); } catch (err) { fail(res, err); }
});
app.get('/api/suites/:id', (req, res) => {
  try {
    const s = suites.get(req.params.id);
    // The gate's state travels with the suite, so onboarding can show where it
    // stands without a second round trip.
    res.json({ suite: s, allowed: origins.has(suites.originOf(s)) });
  } catch (err) { fail(res, err, 404); }
});
app.patch('/api/suites/:id', (req, res) => {
  try { sendOk(res, { suite: suites.update(req.params.id, req.body ?? {}) }); } catch (err) { fail(res, err); }
});
app.delete('/api/suites/:id', (req, res) => {
  try { sendOk(res, suites.remove(req.params.id)); } catch (err) { fail(res, err); }
});

app.post('/api/suites/:id/pages', (req, res) => {
  try { sendOk(res, { page: suites.addPage(req.params.id, req.body ?? {}) }); } catch (err) { fail(res, err); }
});
app.patch('/api/suites/:id/pages/:pageId', (req, res) => {
  try { sendOk(res, { page: suites.updatePage(req.params.id, req.params.pageId, req.body ?? {}) }); }
  catch (err) { fail(res, err); }
});
app.delete('/api/suites/:id/pages/:pageId', (req, res) => {
  try { sendOk(res, suites.removePage(req.params.id, req.params.pageId)); } catch (err) { fail(res, err); }
});

/**
 * Open a page in the driven browser and report what it offers.
 *
 * This is the step that turns a URL somebody typed into something scriptable:
 * everything it returns comes from the accessibility tree, so every target
 * listed is one the executor can actually resolve. The result is cached on the
 * page so the expectation picker has something to show later without driving
 * the browser again.
 */
app.post('/api/suites/:id/pages/:pageId/scan', async (req, res) => {
  let suite, pg;
  try {
    suite = suites.get(req.params.id);
    pg = suite.pages.find((p) => p.id === req.params.pageId);
    if (!pg) throw new Error('No such page');
  } catch (err) { return fail(res, err, 404); }

  if (gate(res, suites.originOf(suite))) return;
  if (running) return fail(res, new Error('A run is in progress'), 409);

  running = true;
  try {
    await OPS.goto(page, { url: pg.url }, { cursor, emit, onNavigate: publishTargets });
    const items = await discover(page);
    const linked = await links(page).catch(() => []);
    const saved = suites.updatePage(suite.id, pg.id, { targets: items, linked });
    emit({ t: 'log', level: 'info',
           msg: `scanned ${pg.url} — ${items.length} targets, ${linked.length} links` });
    sendOk(res, { page: saved, url: page.url() });
  } catch (err) {
    fail(res, err);
  } finally {
    running = false;
    await publishTargets();
  }
});

app.post('/api/suites/:id/cases', (req, res) => {
  try { sendOk(res, { case: suites.addCase(req.params.id, req.body ?? {}, checkFlow) }); }
  catch (err) { fail(res, err); }
});
app.patch('/api/suites/:id/cases/:caseId', (req, res) => {
  try { sendOk(res, { case: suites.updateCase(req.params.id, req.params.caseId, req.body ?? {}, checkFlow) }); }
  catch (err) { fail(res, err); }
});
app.delete('/api/suites/:id/cases/:caseId', (req, res) => {
  try { sendOk(res, suites.removeCase(req.params.id, req.params.caseId)); } catch (err) { fail(res, err); }
});

/**
 * Run a suite: every case, or one named by `?case=`.
 *
 * Cases run in order and a failure does not stop the suite — you want the whole
 * board red-or-green, not the first thing that broke. Progress goes out on the
 * socket as it happens; the aggregate comes back here so the caller gets a
 * definitive answer rather than having to infer one from events.
 */
app.post('/api/suites/:id/run', async (req, res) => {
  let suite;
  try { suite = suites.get(req.params.id); } catch (err) { return fail(res, err, 404); }
  if (gate(res, suites.originOf(suite))) return;
  if (running) return fail(res, new Error('A run is in progress'), 409);

  const wanted = req.query.case
    ? suite.cases.filter((c) => c.id === req.query.case)
    : suite.cases;
  if (!wanted.length) return fail(res, new Error('This suite has no cases to run'));

  emit({ t: 'suite.start', suite: suite.name, cases: wanted.length });
  const outcomes = [];
  for (const c of wanted) {
    let plan;
    try {
      plan = checkFlow(c.flow);
    } catch (err) {
      // An unparseable case is a failed case, not a dead suite.
      outcomes.push({ case: c.id, name: c.name, ok: false, error: err.message });
      emit({ t: 'log', level: 'error', msg: `${c.name}: ${err.message}` });
      continue;
    }
    plan.suite = `${suite.name} · ${c.name}`;
    emit({ t: 'diagram', kind: 'plan', mermaid: toMermaid(plan) });
    // Express 4 does not catch a rejection from an async handler, so an
    // unexpected throw here would take the process with it rather than failing
    // one case. A suite run survives a bad case.
    const r = await run(plan, { suiteId: suite.id, caseId: c.id, caseName: c.name })
      .catch((err) => ({ ok: false, passed: 0, total: 0, error: err.message }));
    outcomes.push({ case: c.id, name: c.name, ...r });
  }
  const passed = outcomes.filter((o) => o.ok).length;
  emit({ t: 'suite.end', suite: suite.name, passed, total: outcomes.length });
  sendOk(res, { suite: suite.id, passed, total: outcomes.length, outcomes });
});

/**
 * One URL in, a running test out.
 *
 * The four-step wizard is for a project you are setting up properly. This is for
 * the first minute with your own app: paste the URL, and it opens it, reads what
 * is there, asserts you reached it, and runs that — so you find out whether the
 * runner can drive your app at all before deciding how much to invest.
 *
 * It only ever asserts the URL. Guessing which of a page's words are stable
 * enough to assert would produce a suite that fails for reasons nobody chose;
 * the text expectations stay a human decision, one screen away.
 *
 * The gate is not skipped. A URL nobody has approved comes back as a 409 saying
 * which origin it needs, exactly like every other path to the browser.
 */
app.post('/api/suites/quickstart', async (req, res) => {
  let u;
  try { u = origins.normalizeUrl(req.body?.url); } catch (err) { return fail(res, err); }
  if (gate(res, u.origin)) return;
  if (running) return fail(res, new Error('A run is in progress'), 409);

  let suite, pg, items;
  running = true;
  try {
    // Open it first: the page's own title is a better suite name than anything
    // derived from a hostname, and it costs nothing since we must go there.
    await OPS.goto(page, { url: u.href }, { cursor, emit, onNavigate: publishTargets });
    const title = (await page.title().catch(() => '')).trim().slice(0, 80);
    items = await discover(page);
    const linked = await links(page).catch(() => []);
    const path = `${u.pathname}${u.search}${u.hash}`;

    suite = suites.create({
      name: String(req.body?.name ?? '').trim() || title || u.host,
      baseUrl: u.href,
      description: `Added from ${u.href}`,
    });
    pg = suites.addPage(suite.id, {
      name: title || 'Entry',
      path,
      expect: [{ kind: 'url', value: path }],
    });
    suites.updatePage(suite.id, pg.id, { targets: items, linked });
  } catch (err) {
    return fail(res, err);
  } finally {
    running = false;
  }

  const flow = suites.pageCheckFlow(suites.get(suite.id), suites.get(suite.id).pages[0]);
  const c = suites.addCase(suite.id, { name: `${pg.name} loads`, pageId: pg.id, flow }, checkFlow);
  const outcome = await run(checkFlow(flow), { suiteId: suite.id, caseId: c.id, caseName: c.name });

  sendOk(res, {
    suite: suites.get(suite.id),
    targets: items.length,
    run: outcome,
  });
});

/** A page's expectations, as a flow you can read before you run it. */
app.get('/api/suites/:id/pages/:pageId/check', (req, res) => {
  try {
    const s = suites.get(req.params.id);
    const p = s.pages.find((x) => x.id === req.params.pageId);
    if (!p) throw new Error('No such page');
    res.json({ flow: suites.pageCheckFlow(s, p) });
  } catch (err) { fail(res, err, 404); }
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

// Take the port before anything else starts. A failure here used to surface as
// an unhandled 'error' on the WebSocket server — a stack trace ending in
// EADDRINUSE, several frames deep, for a problem with a one-line fix — and it
// still launched a browser on the way down.
const http = app.listen(PORT);
await new Promise((resolve) => {
  http.once('listening', resolve);
  http.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${PORT} is already taken — usually a ghostclick you left running.\n` +
        `\n  Use another port:      PORT=${PORT + 100} npm start\n` +
        `\n  Or stop the old one. It is still holding a browser, so this is worth doing:\n` +
        `    macOS / Linux        lsof -ti tcp:${PORT} | xargs kill\n` +
        `    Windows (Git Bash)   netstat -ano | findstr :${PORT}\n` +
        `                         taskkill //PID <pid> //F\n` +
        `    Windows (PowerShell) Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess\n`
      );
    } else {
      console.error(`\n  Could not listen on ${PORT}: ${err.message}\n`);
    }
    process.exit(1);
  });
});
// wss shares the server, so it re-emits anything the server emits.
const wss = new WebSocketServer({ server: http });
wss.on('error', (err) => console.error(`  websocket server: ${err.message}`));

// Starting with HOME_URL set is a person naming an origin on the command line,
// which is the same decision the Allow button represents — so honour it rather
// than opening on your own app and immediately refusing to drive it.
if (process.env.HOME_URL) {
  try { origins.add(process.env.HOME_URL); }
  catch (err) { console.error(`  HOME_URL: ${err.message}`); }
}

console.log(`\n  ghostclick  ->  http://localhost:${PORT}` +
            `\n  driving     ->  ${HOME}` +
            `\n  browser     ->  ${HEADED ? 'headed — a real window you can watch' : 'headless — streamed to the canvas (HEADED=1 for a window)'}` +
            `\n  allowed     ->  ${origins.list().join(', ')}` +
            `\n  secrets     ->  ${vault.names().join(', ') || '(none set)'}` +
            `\n  version     ->  ${version.commit ?? 'unknown'}` +
            `${version.built ? `, ui built ${version.built.replace('T', ' ').slice(0, 16)}` : ', ui NOT BUILT'}\n`);

// ---------------------------------------------------------------- browser
/**
 * Headless by default: the browser being driven is streamed onto the canvas, so
 * it can run on a server, in CI, or on a colleague's machine with everyone
 * watching the same feed.
 *
 * HEADED=1 opens a real window instead — same automation, same feed, but you
 * can watch it in a browser you recognise. Useful the first time, when "is it
 * actually doing anything" is the question.
 *
 * Neither mode touches YOUR mouse or YOUR tabs. The pointer you see gliding is
 * drawn over a video of another browser.
 */
const browser = await chromium.launch({
  headless: !HEADED,
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

/**
 * @param meta which suite and case this plan came from, when it came from one.
 *   A plan typed into the console has no suite; that is a legitimate state and
 *   the history records it as such rather than inventing a home for it.
 * @returns {{ok:boolean, passed:number, total:number, error:string|null}}
 */
async function run(plan, meta = {}) {
  if (running) {
    // An error, not a warning. A refused run does nothing visible, so if this
    // is quiet the only symptom is a button that appears not to work.
    emit({ t: 'log', level: 'error', msg: 'A run is already in progress — wait for it to finish' });
    return { ok: false, passed: 0, total: 0, error: 'A run is already in progress' };
  }
  running = true;
  const wasRecording = recorder.recording;
  recorder.recording = false;

  const results = [];
  const ctx = { cursor, emit, onNavigate: publishTargets };
  emit({ t: 'run.start', total: plan.steps.length, suite: plan.suite, ...meta });

  // Everything from here to the finally must be able to throw without wedging
  // the executor. It used to clear the lock on the happy path only, so a
  // failure while recording history or drawing the report left `running` true
  // for the life of the process — and from then on every Run was silently
  // refused. "Run script does nothing" with no error in the log is exactly
  // what that looks like from the outside.
  try {
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

    const passed = results.filter((r) => r.ok).length;
    const ok = results.every((r) => r.ok);
    const entry = history.record({
      suite: plan.suite,
      suiteId: meta.suiteId ?? null,
      caseId: meta.caseId ?? null,
      caseName: meta.caseName ?? null,
      url: plan.steps.find((s) => s.op === 'goto')?.url ?? '',
      ms: results.reduce((a, r) => a + (r.ms ?? 0), 0),
      results,
    });
    // Same function, same IR — with outcomes folded in, the plan diagram
    // becomes the run report. Drawing it is a nicety; failing to draw it must
    // not cost you the run's verdict.
    try {
      emit({ t: 'diagram', kind: 'report', mermaid: toMermaid(plan, { results }) });
    } catch (err) {
      emit({ t: 'log', level: 'error', msg: `could not draw the report: ${err.message}` });
    }
    await publishTargets();
    return { ok, passed, total: results.length, error: entry.error };
  } finally {
    // Clear the lock BEFORE announcing the end. run.end means "you may start
    // another run"; emitting it while still locked makes a caller that runs
    // back-to-back scripts hang on a silently refused second run.
    running = false;
    recorder.recording = wasRecording;
    emit({ t: 'run.end', ok: results.every((r) => r.ok) && results.length > 0, ...meta });
  }
}

// ---------------------------------------------------------------- sockets
wss.on('connection', (ws) => {
  clients.add(ws);

  // LISTEN FIRST, then greet.
  //
  // This handler used to `await publishTargets()` before attaching the message
  // listener, and 'ws' drops messages that arrive with no listener on. So
  // anything you did in that window was silently discarded — and the window is
  // exactly as long as it takes to read the accessibility tree of whatever page
  // is open, which on a real site is long enough to click a button in. The
  // symptom was Run script doing nothing at all, with no error anywhere.
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
        emit({ t: 'log', level: 'error', msg: err.message });
        // An origin the script needs is a decision waiting for a person, not a
        // dead end. Offer the button rather than a sentence about where to
        // find one.
        if (err.origin) emit({ t: 'needs.origin', origin: err.origin, url: err.url });
        return;
      }
      // Draw the plan before running it, so a diagram exists even if step 0
      // fails. The run replaces it with the outcome version.
      emit({ t: 'diagram', kind: 'plan', mermaid: toMermaid(plan) });
      // Deliberately not awaited — the socket must stay responsive while a run
      // is in flight. But an un-awaited promise that rejects is an unhandled
      // rejection, and Node kills the process for those: one unexpected throw
      // inside a step and the whole runner disappeared, which from the browser
      // looks exactly like "Run script does nothing".
      run(plan).catch((err) => {
        emit({ t: 'log', level: 'error', msg: `run failed: ${err.message}` });
        emit({ t: 'run.end', ok: false });
      });
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

    // The canvas asks for a picture. Frames are damage-driven, so a viewer that
    // arrives while the page is sitting still has nothing to show and no reason
    // to expect anything — this is how it gets the current one.
    if (m.t === 'frame.request') {
      if (lastFrame && ws.readyState === 1) ws.send(lastFrame, { binary: true });
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
      if (m.t === 'human.wheel') {
        // A sanity bound, not a speed limit. The client coalesces a frame's
        // worth of wheel events into one message, so a fast flick legitimately
        // carries far more than a single tick — clamping tightly here silently
        // ate scroll distance. No real frame reaches ten thousand pixels.
        const clamp = (v) => Math.max(-10000, Math.min(10000, Number(v) || 0));
        return void cursor.wheel(clamp(m.deltaY), clamp(m.deltaX));
      }

      // Top and bottom are a position, not a very large wheel gesture.
      //
      // They used to send a delta of ±100000 and hope, which the clamp above
      // then truncated — so the buttons moved the page by exactly the clamp and
      // never reached either end. Asking for the position says what is meant
      // and cannot be quietly rescaled.
      if (m.t === 'human.scrollTo' && (m.to === 'top' || m.to === 'bottom')) {
        return void page.evaluate(
          (where) => window.scrollTo({ top: where === 'top' ? 0 : document.body.scrollHeight, behavior: 'instant' }),
          m.to,
        ).catch(() => {});
      }
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

  // Now say hello. Frames are damage-driven — a static page emits nothing — so
  // prime the viewer with the last one we held rather than leaving it black.
  if (lastFrame) ws.send(lastFrame, { binary: true });
  ws.send(JSON.stringify({
    t: 'ready', url: page.url(),
    // The executor's real state. Without this a socket that reconnected during
    // a run kept a disabled Run button until someone reloaded the page.
    running,
    recording: recorder.recording,
    origins: origins.list(),
    secrets: vault.names(),        // names only — a value never leaves the server
  }));
  publishTargets();
});

/**
 * Last line of defence.
 *
 * Node terminates on an unhandled rejection, so a stray throw anywhere in an
 * un-awaited path used to take the runner down with no message — the browser
 * just stopped responding. Every known path is now caught at its source; this
 * says so out loud if a new one appears, rather than dying silently.
 */
process.on('unhandledRejection', (err) => {
  console.error(`\n  unhandled rejection: ${err?.stack ?? err}\n`);
  try { emit({ t: 'log', level: 'error', msg: `internal error: ${err?.message ?? err}` }); } catch {}
});

process.on('SIGINT', async () => { await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { await browser.close(); process.exit(0); });
