import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VirtualCursor, sleep } from './cursor.js';
import { OPS, validate, PACE, paceOf } from './ops.js';
import * as origins from './origins.js';
import { iconFor } from './icons.js';
import * as vault from './secrets.js';
import * as history from './runs.js';
import { chooseHome } from './home.js';
import { bearer, verify, MIN_SECRET } from './auth.js';
import * as suites from './suites.js';
import { discover, links } from './targets.js';
import { parse } from './parse.js';
import { parseFlow, flatten, toFlow } from './flow.js';
import { toMermaid } from './diagram.js';
import { Recorder } from './recorder.js';
import { NavigationLog } from './navlog.js';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT) || 3000;
const VIEW = { width: 1180, height: 760 };
/** Where the runner points when it starts — the rule itself is in home.js. */
const homeUrl = () => chooseHome({
  envUrl: process.env.HOME_URL,
  runs: history.list(),
  isAllowed: (origin) => origins.has(origin),
});

/**
 * Auth is OFF unless GC_AUTH_SECRET is set, and that is a deliberate default
 * for a tool whose normal shape is one person, one laptop, one localhost port.
 * What is not acceptable is being quiet about it — an operator who thinks this
 * is protected and is wrong is worse off than one who knows it is open — so the
 * boot banner says which mode it is in, every time.
 *
 * Set, it is enforced on every /api route and on the socket. Set to something
 * short, the process refuses to start: a weak shared key still "works", which
 * means nothing ever surfaces the mistake.
 */
const AUTH_SECRET = process.env.GC_AUTH_SECRET ?? '';
if (AUTH_SECRET && AUTH_SECRET.length < MIN_SECRET) {
  console.error(
    `\n  GC_AUTH_SECRET is ${AUTH_SECRET.length} characters; it must be at least ${MIN_SECRET}.\n` +
    '\n  It is the key this runner and the Django control plane share, so a short\n' +
    '  one weakens both and nothing would tell you. Generate one:\n' +
    '\n    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n' +
    '\n  Then set the SAME value here and in auth/.env.\n'
  );
  process.exit(1);
}

const HEADED = /^(1|true|yes|on)$/i.test(process.env.HEADED ?? '');

/**
 * The runner's live state, declared before anything can be asked about it.
 *
 * These are assigned further down, after a browser has been launched — which
 * takes seconds. The port, though, opens the moment express is ready, roughly
 * two hundred lines earlier. So there is a window in which the server accepts
 * requests and `page`, `recorder` and `running` do not exist yet, and reading a
 * `let` before its declaration is not `undefined`, it is a ReferenceError.
 *
 * /api/state reads all three, and it is the first thing the UI asks for. It
 * answered that question with a 500 and an express stack trace, which reads as
 * a broken server rather than one that is still starting.
 *
 * The handler was already written for this — `page?.url()`, `recorder?.recording`
 * — the optional chaining just never got the chance to work, because the
 * bindings were not merely unset but unreachable. Declaring them here is what
 * makes that guard mean something: during boot the honest answer is "nothing
 * open, not running", and now that is what comes back.
 */
let page = null;
let recorder = null;
let running = false;
// Set once the browser is actually up. The port opens ~100 lines before
// chromium.launch, so "the server answers" and "the app works" are two
// different facts. /healthz reports this one, and a deploy waits on it.
let browserReady = false;

const app = express();

/**
 * Cache-Control, the one header that matters here.
 *
 * Vite fingerprints its assets, so those are safe to cache forever. index.html
 * is not fingerprinted — it is the file that NAMES the current fingerprints —
 * so a browser that caches it keeps loading yesterday's JavaScript no matter
 * how many times you pull and rebuild. That is a long afternoon of "why don't I
 * see the new button", and it is one header.
 */
const cacheHeaders = (res, path) => {
  if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  else if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
};

/**
 * The backend's own files: the pages you can drive, and the hero images.
 *
 * Resolved from this module rather than the working directory. `express.static('public')`
 * reads process.cwd(), so the server only worked when started from the repo
 * root — fine for `npm start`, wrong the moment it is started by a process
 * manager, a container ENTRYPOINT, or from anywhere else.
 */
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url)), { setHeaders: cacheHeaders }));
app.use(express.json({ limit: '512kb' }));

/**
 * The UI, which is a DIRECTORY this server is pointed at — not a path it owns.
 *
 *   GC_WEB_DIR=/srv/ghostclick-web/dist npm start
 *
 * It used to be `public/app/`, written there by the frontend's own build
 * config. That is the coupling that makes two repositories impossible: the
 * frontend cannot build without the backend's tree to write into, and the
 * backend cannot serve a UI that was deployed anywhere else. Now the frontend
 * builds to its own `web/dist/` and this reads whatever directory it is given,
 * so the same server serves a sibling checkout, a CI artefact, or nothing at
 * all — see docs/BOUNDARY.md.
 *
 * The default is the sibling `web/dist/`, whose build is committed, so `npm
 * start` still needs no bundler — a tool you need a build step to run is a tool
 * people stop running.
 *
 * Static files win (this sits before the fallback), so only client-side routes
 * reach it.
 */
const WEB_DIR = process.env.GC_WEB_DIR
  ? resolve(process.env.GC_WEB_DIR)
  : fileURLToPath(new URL('./web/dist', import.meta.url));
const APP = join(WEB_DIR, 'index.html');

app.get('/', (_req, res) => res.redirect('/app/'));
app.use('/app', express.static(WEB_DIR, { setHeaders: cacheHeaders }));
app.use('/app', (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/assets/')) return next();
  res.sendFile(APP, (err) => {
    if (err) next(new Error(`No UI at ${WEB_DIR} — run \`npm run build\`, or point GC_WEB_DIR at one`));
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
/**
 * Who may call the API from a browser.
 *
 * `*` is the base case and it is deliberate: the extension POSTs a recording
 * from whatever page you were recording on, so there is no single origin to
 * name. It costs nothing here because every /api route is either a read or
 * gated — /api/recording validates and never executes, and nothing can add an
 * allowed origin except a person pressing a button.
 *
 * GC_WEB_ORIGIN names the frontend when it is deployed somewhere this server is
 * not. It has to be echoed rather than starred: a browser rejects `*` on any
 * credentialed request, so the day this grows a session cookie, `*` is the
 * header that silently blocks the whole app. `Vary: Origin` is what stops a
 * cache handing one origin's response to another.
 */
/**
 * Liveness, and the only route outside the gate that answers anything.
 *
 * A deploy needs to know the difference between "express is listening" and
 * "there is a browser". Polling the UI proves the first, which is why the
 * previous readiness loop passed instantly against a runner whose
 * chromium.launch had failed — a green deploy with no browser, and every
 * page-touching route failing minutes later.
 *
 * Deliberately three booleans and nothing else. Everything adjacent to this in
 * /api/state — the current URL, the origin allowlist, the vault's key names —
 * is behind the gate for a reason, and an unauthenticated endpoint is the
 * wrong place to start leaking the address of the page under test.
 */
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(browserReady ? 200 : 503).json({ ok: browserReady, browser: browserReady, busy: running });
});

const WEB_ORIGIN = (process.env.GC_WEB_ORIGIN ?? '').replace(/\/+$/, '');
app.use('/api', (req, res, next) => {
  if (WEB_ORIGIN && req.headers.origin === WEB_ORIGIN) {
    res.set('Access-Control-Allow-Origin', WEB_ORIGIN);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
  } else {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Access-Control-Allow-Headers', 'content-type, authorization');
  // A preflight carries no Authorization header by definition, so it must be
  // answered before the gate. Requiring auth here would make every
  // cross-origin call fail at the preflight, which reads as a CORS bug.
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  if (!AUTH_SECRET) return next();

  /**
   * One exception, and it is the extension.
   *
   * POST /api/recording is called from whatever page you were recording on. It
   * has no session with the control plane and no way to be handed a token, so
   * requiring one here does not secure the endpoint, it deletes the feature.
   *
   * It is the safest route to leave open: it parses a flow, validates it
   * through the same origin gate as everything else, and puts the text in the
   * script box. It never executes anything — a human presses Run. Giving the
   * extension a real token is worth doing and is not this change.
   */
  if (req.method === 'POST' && req.path === '/recording') return next();

  const token = bearer(req.headers.authorization);
  if (!token) return res.status(401).json({ ok: false, error: 'Not signed in' });
  try {
    req.user = verify(token, AUTH_SECRET);
  } catch (err) {
    // The reason is safe to say: the caller already holds the token, so
    // "expired" versus "bad signature" tells them nothing they could not
    // determine anyway, and it is the difference between the UI silently
    // re-authenticating and a person staring at a spinner.
    return res.status(401).json({ ok: false, error: err.message });
  }
  next();
});

app.get('/api/runs', (req, res) => res.json(history.summary(14, req.query.suite || null)));
app.get('/api/defects', (_req, res) => res.json(history.defects(14)));

/**
 * Pictures for the hero panels, if anyone has put any there.
 *
 * Read per request rather than at boot, so dropping a folder of images into
 * public/hero and reloading is the whole procedure — a feature whose setup step
 * is "now restart the server" is a feature people give up on.
 */
const HERO = fileURLToPath(new URL('./public/hero', import.meta.url));
app.get('/api/hero', (_req, res) => {
  let images = [];
  try {
    images = readdirSync(HERO)
      .filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => `/hero/${encodeURIComponent(f)}`);
  } catch { /* no folder is the normal case */ }
  res.json({ images });
});

/**
 * The favicon of a site you have added.
 *
 * Served from our own origin rather than pointed at from the sidebar, so that
 * opening the app does not make your browser announce, to every site in your
 * suite list, that you are looking at it. The bytes are fetched once by the
 * server and cached — see icons.js, where every guard on that fetch is written
 * down, because it is the only outbound request this process makes.
 *
 * 404 rather than a placeholder image when a site has no icon: the sidebar
 * draws a monogram in that case, and it can do that better than we can.
 */
app.get('/api/sites/icon', async (req, res) => {
  const origin = String(req.query.origin ?? '');
  try {
    const icon = await iconFor(origin);
    if (!icon) return res.status(404).json({ ok: false, error: 'no icon' });
    // A day in the browser, since the server-side entry lasts a week anyway;
    // private, because which sites are in your sidebar is not for a shared cache.
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(icon.type).send(icon.body);
  } catch (err) {
    if (err.refused) return res.status(403).json({ ok: false, error: err.message });
    res.status(502).json({ ok: false, error: 'could not reach that site' });
  }
});

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
 *
 * The commit and the start time are fixed for this process. The BUILD time is
 * not: express serves the UI directory off disk, so a `vite build` in another
 * terminal changes what the browser gets without this process noticing. Read
 * at boot, the stamp then claims a UI older than the one being served — a
 * version stamp that is confidently wrong is worse than none, since its entire
 * job is to be trusted at a glance.
 */
const identity = (() => {
  const read = (p) => { try { return readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8').trim(); } catch { return null; } };
  // In a container there is no .git — .dockerignore excludes it, so that a
  // build context cannot carry the repository's history into an image layer.
  // The sha arrives as a build argument instead. Env first, disk second: the
  // image is the case where disk has no answer, not a case where it has a
  // worse one.
  let commit = process.env.GC_GIT_SHA?.trim() || null;
  if (!commit) {
    const head = read('./.git/HEAD');
    if (head?.startsWith('ref: ')) commit = read(`./.git/${head.slice(5)}`);
    else if (head) commit = head;
  }
  return {
    commit: commit ? commit.slice(0, 7) : null,
    started: new Date().toISOString(),
  };
})();
const buildTime = () => {
  try { return statSync(APP).mtime.toISOString(); } catch { return null; }   // not built
};
app.get('/api/version', (_req, res) => res.json({ ...identity, built: buildTime() }));

app.get('/api/state', (_req, res) => res.json({
  url: page?.url() ?? null,
  running,
  recording: recorder?.recording ?? false,
  origins: origins.list(),
  secrets: vault.names(),        // names only — a value never leaves the server
  headed: HEADED,
  // How patient the runner is, so it is visible rather than folklore.
  timeoutMs: Number(process.env.GC_TIMEOUT_MS) || 8000,
  settleMs: Number(process.env.GC_SETTLE_MS) || 250,
  // How much of a run is performed for a watcher. The UI offers a per-run
  // override, and needs to know what it is overriding.
  paceMs: PACE,
}));

/**
 * Who may change the allowlist.
 *
 * Until now the token was verified and its claims were then never read — the
 * one `req.user` in this file was the line that assigned it. That is
 * authentication without authorisation: every account that could sign in could
 * also add an origin, and the allowlist is the gate the rest of this design
 * rests on. A gate anyone signed in can widen is a log, not a gate.
 *
 * So the line is drawn here and nowhere else. Running a suite stays open to
 * every account, because that is the product. Adding a place this browser is
 * allowed to go is a staff decision, and the control plane says which kind of
 * account this is in the token itself (auth/accounts/tokens.py).
 *
 * When AUTH_SECRET is unset there is no token to read a claim from, and the
 * runner has already said at boot that it is open — a single-user laptop, where
 * demanding a staff claim nobody can obtain would just break the feature.
 */
const staffOnly = (req, res, next) => {
  if (!AUTH_SECRET) return next();
  if (req.user?.admin === true) return next();
  return res.status(403).json({
    ok: false,
    error: 'Changing the origin allowlist needs a staff account. '
         + 'This one can run tests but not choose where they may go.',
  });
};

app.get('/api/origins', (_req, res) => res.json({ origins: origins.list() }));
app.post('/api/origins', staffOnly, (req, res) => {
  try {
    const r = origins.add(req.body?.origin);
    emit({ t: 'origins', origins: origins.list() });
    sendOk(res, { ...r, origins: origins.list() });
  } catch (err) { fail(res, err); }
});
app.delete('/api/origins', staffOnly, (req, res) => {
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
    await OPS.goto(page, { url: pg.url }, { cursor, emit, nav, onNavigate: publishTargets });
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

  // How much of this run to perform, for this run only. Absent means the
  // server's default, so a caller that has never heard of pace is unaffected.
  const pace = paceOf(req.query.pace, PACE);

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
    const r = await run(plan, { suiteId: suite.id, caseId: c.id, caseName: c.name, pace })
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
    await OPS.goto(page, { url: u.href }, { cursor, emit, nav, onNavigate: publishTargets });
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
/**
 * Redirect shapes worth testing, for the bundled demo.
 *
 * Every one of these is a link that "works" — you land on a page, the URL looks
 * plausible — and every one is a different kind of wrong. They exist so the
 * redirect assertions have something honest to assert against.
 */
app.get('/go/tracked', (_req, res) => res.redirect(302, '/go/r?to=/pricing.html'));
app.get('/go/r', (req, res) => res.redirect(302, String(req.query.to || '/')));
app.get('/go/moved', (_req, res) => res.redirect(301, '/go/moved-again'));
// Leaves the origin, the way http://acme.com → https://www.acme.com does. The
// host differs, so the browser follows it quite legitimately and lands
// somewhere nobody allowed.
app.get('/go/offsite', (_req, res) =>
  res.redirect(302, `http://127.0.0.1:${process.env.PORT || 3000}/demo.html`));
app.get('/go/moved-again', (_req, res) => res.redirect(302, '/pricing.html'));
app.get('/go/gone', (_req, res) => res.status(404).send(
  '<!doctype html><title>Not found</title><h1>Page not found</h1>' +
  '<p>The friendly 404 that makes a URL assertion pass anyway.</p>'));
app.get('/pricing.html', (_req, res) => res.send(
  '<!doctype html><title>Pricing</title><h1>Pricing</h1><p>Three plans.</p>'));

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
/**
 * The socket, upgraded by hand so the token can be checked first.
 *
 * `new WebSocketServer({ server })` would accept the upgrade and only then let
 * us look, which means an unauthenticated client is already a connected client
 * receiving screencast frames. noServer + an explicit handler is the difference
 * between refusing and disconnecting.
 *
 * The token rides in the query string because a browser cannot set headers when
 * opening a WebSocket — there is no `fetch`-style options object for
 * `new WebSocket()`. That puts a credential somewhere URLs get logged, which is
 * exactly why the control plane mints them ten minutes long.
 *
 * The PATH is deliberately not restricted. The browser uses /ws, but this
 * repository's own check scripts connect to the root, and the path was never
 * the boundary — the token is. Narrowing it here would break six checks and
 * secure nothing.
 */
const wss = new WebSocketServer({ noServer: true });
wss.on('error', (err) => console.error(`  websocket server: ${err.message}`));

http.on('upgrade', (req, socket, head) => {
  if (AUTH_SECRET) {
    let token = null;
    try { token = new URL(req.url, 'http://localhost').searchParams.get('t'); } catch { /* unparseable */ }
    try {
      verify(token, AUTH_SECRET);
    } catch (err) {
      // A real HTTP response, not a bare destroy: a socket that closes with no
      // status looks like a crashed server, and the UI would sit reconnecting
      // on its timer forever without ever saying why.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Starting with HOME_URL set is a person naming an origin on the command line,
// which is the same decision the Allow button represents — so honour it rather
// than opening on your own app and immediately refusing to drive it.
if (process.env.HOME_URL) {
  try { origins.add(process.env.HOME_URL); }
  catch (err) { console.error(`  HOME_URL: ${err.message}`); }
}

console.log(`\n  ghostclick  ->  http://localhost:${PORT}` +
            `\n  serving     ->  ${WEB_DIR}${process.env.GC_WEB_DIR ? '  (GC_WEB_DIR)' : ''}` +
            `\n  driving     ->  ${homeUrl() ?? 'nothing yet — open a URL in the console'}` +
            `\n  auth        ->  ${AUTH_SECRET
              ? 'on — a token from the control plane is required'
              : 'OFF — GC_AUTH_SECRET unset, anyone who can reach this port can drive it'}` +
            `\n  browser     ->  ${HEADED ? 'headed — a real window you can watch' : 'headless — streamed to the canvas (HEADED=1 for a window)'}` +
            `\n  allowed     ->  ${origins.list().join(', ')}` +
            `\n  secrets     ->  ${vault.names().join(', ') || '(none set)'}` +
            `\n  patience    ->  waits ${Number(process.env.GC_TIMEOUT_MS) || 8000}ms for a target, ` +
            `settles ${Number(process.env.GC_SETTLE_MS) || 250}ms after a click ` +
            `(GC_TIMEOUT_MS, GC_SETTLE_MS)` +
            `\n  pace        ->  ${PACE ? `${PACE}ms of performance per step, so a run can be watched` : '0 — no performance, as fast as the page allows'}` +
            ` (GC_PACE_MS)` +
            `\n  version     ->  ${identity.commit ?? 'unknown'}` +
            `${buildTime() ? `, ui built ${buildTime().replace('T', ' ').slice(0, 16)}` : ', ui NOT BUILT'}\n`);

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
page = await browser.newPage({ viewport: VIEW });
browserReady = true;
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

/**
 * Every top-level navigation, with the hops it went through.
 *
 * A link that lands on the right URL can still have 301'd through a path that
 * no longer exists, detoured via a tracker, or arrived at a friendly 404. The
 * final URL says none of that, so the chain is kept and shown.
 */
/**
 * The driven page's own console, forwarded.
 *
 * A failing step usually has a reason the page already printed — an uncaught
 * TypeError, a 500 that the app's fetch wrapper logged — and until now that
 * reason existed only inside a browser nobody could open devtools on. You saw
 * "expected the URL to contain /dashboard" and had to guess why it did not.
 *
 * Vault values are redacted on the way out. An app logging the token it just
 * received is not unusual, and a secret that never leaves the server must not
 * leave it through here either. Long lines are cut: a page that dumps a 2MB
 * JSON blob into console.log should not be able to do it down this socket.
 */
const LINE_MAX = 2000;
function redact(text) {
  let out = String(text ?? '');
  for (const name of vault.names()) {
    const v = vault.get(`secrets.${name}`);
    // Two characters would match everywhere; a real secret is not that short.
    if (typeof v === 'string' && v.length >= 4) out = out.split(v).join(`$${name}`);
  }
  return out;
}
const LEVELS = { warning: 'warn', error: 'error', assert: 'error', trace: 'debug' };
const fromPage = (level, text) => emit({
  t: 'console',
  level: LEVELS[level] ?? (['log', 'info', 'debug'].includes(level) ? level : 'log'),
  text: redact(text).slice(0, LINE_MAX),
  at: Date.now(),
});

page.on('console', (msg) => fromPage(msg.type(), msg.text()));
// An uncaught exception never reaches console.*, and it is the one you most
// want: it is usually why the next step could not find anything.
page.on('pageerror', (err) => fromPage('error', err?.stack || String(err)));

const nav = new NavigationLog(page, {
  onNavigation: (n) => {
    emit({ t: 'nav', ...n });
    if (n.redirects) {
      emit({ t: 'log', level: n.status >= 400 ? 'error' : 'info',
             msg: `${n.redirects} redirect${n.redirects === 1 ? '' : 's'} → ${n.status} ${n.url}` });
    } else if (n.status >= 400) {
      emit({ t: 'log', level: 'error', msg: `${n.status} at ${n.url}` });
    }
  },
});
nav.attach();

/**
 * Where a recording should say it begins: the URL you ASKED for, not the one a
 * redirect left you on.
 *
 * You type strix.ai/enterprise; it 307s to https://www.strix.ai/enterprise,
 * which is a different origin — different host, different scheme — and one
 * nobody allowed. Recording the landing URL produces a case whose very first
 * step is blocked by the origin gate, so it can never be saved and could never
 * replay. Recording the URL you asked for replays the redirect instead, which
 * is both what you meant and the only version that runs.
 *
 * Only when the chain really is this document's: an SPA route change pushes a
 * new URL without navigating, and the last chain would then belong to the
 * document load before it — taking hops[0] there would quietly drop the route
 * you are standing on.
 */
function entryUrl(page) {
  // `about:blank` is truthy, and the recorder only guards on falsiness — so a
  // Record pressed before anything was opened used to produce a case whose
  // step 0 was `goto "about:blank"`, which the origin gate then refuses
  // forever. Unsaveable, unrunnable, and no way to tell from looking at it.
  const here = page.url();
  if (!here || here === 'about:blank') return null;
  const n = nav.summary();
  const asked = n.hops[0]?.url;
  return n.redirects > 0 && n.url === here && asked ? asked : here;
}

// Teach mode. Canvas clicks reach the page as real DOM events, so the same
// listener sees a human demonstrating and would see the executor replaying —
// which is why recording is gated off during a run.
recorder = new Recorder(page, {
  nav,
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
  if (f !== page.mainFrame()) return;
  /**
   * The address first, and on its own.
   *
   * There is no browser chrome here — the canvas is a video — so the URL bar in
   * the console is the ONLY way to know what you are looking at. It used to
   * arrive as a field on the `targets` event, which is emitted after
   * discovery has taken an aria snapshot of the whole page. That is hundreds of
   * milliseconds on a real site, during which the console showed the previous
   * address: you watch a redirect happen on the canvas and the bar still says
   * where you came from.
   *
   * Reading page.url() costs nothing, so it goes out immediately and discovery
   * follows when it is ready. This also covers the navigations that produce no
   * document at all — a pushState or a hash change in an SPA — which have no
   * response, so the NavigationLog never sees them.
   */
  emit({ t: 'url', url: page.url() });
  publishTargets();
});

const home = homeUrl();
if (home) await page.goto(home).catch((err) => console.error(`  could not open ${home}: ${err.message}`));

/** What can the current page be told to do? Emitted whenever it changes. */
async function publishTargets() {
  try {
    emit({ t: 'targets', url: page.url(), items: await discover(page) });
  } catch (err) {
    emit({ t: 'log', level: 'error', msg: `discovery failed: ${err.message}` });
  }
}

// ---------------------------------------------------------------- executor
// `running` is declared at the top, so /api/state can be answered during boot.

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
  // A run can be told how much of itself to perform. Unset means this server's
  // default, so nothing that does not ask is affected.
  const ctx = { cursor, emit, nav, onNavigate: publishTargets, pace: paceOf(meta.pace, PACE) };
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
        const isFlow = /\b(testcase|flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/.test(m.text) || /-{2,3}>/.test(m.text);
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
      run(plan, { pace: paceOf(m.pace, PACE) }).catch((err) => {
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
        await OPS.goto(page, { url }, { cursor, emit, nav, onNavigate: publishTargets });
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
      const steps = recorder.start(entryUrl(page), entry);
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
