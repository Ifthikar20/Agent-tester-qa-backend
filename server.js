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
import * as vault from './secrets.js';
import * as history from './runs.js';
import { chooseHome } from './home.js';
import { bearer, verify } from './auth.js';
import { AUTH_ON, DEMO, PUBLIC_KEYS, KEY_ERROR, WEB_ORIGIN, TURNSTILE, csp } from './mode.js';
import * as tickets from './tickets.js';
import { blocked } from './reach.js';
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
 * Auth is OFF unless GC_AUTH_PUBLIC_KEYS names a key (mode.js), and that is a
 * deliberate default for a tool whose normal shape is one person, one laptop,
 * one localhost port. What is not acceptable is being quiet about it — an
 * operator who thinks this is protected and is wrong is worse off than one
 * who knows it is open — so the boot banner says which mode it is in, every
 * time.
 *
 * Set, it is enforced on every /api route and on the socket, with PUBLIC keys
 * only. The one thing this process must never be handed is signing material:
 * a runner that could mint would be a runner that can authorise itself, and
 * the cutover from the shared HMAC secret is one-directional on purpose — a
 * GC_AUTH_SECRET still in the environment is refused, not ignored, because it
 * means a deployment that was half moved and still has the old key lying
 * around next to the browser [token-1] [token-2].
 */
if ('GC_AUTH_SECRET' in process.env) {
  console.error(
    '\n  GC_AUTH_SECRET is set, and this process must not hold a signing key.\n' +
    '\n  Tokens are signed with an Ed25519 private key that lives ONLY in the control\n' +
    "  plane (GC_SIGNING_KEY). The runner is given the public half:\n" +
    '\n    cd auth && python manage.py signing_key --new\n' +
    '\n  and GC_AUTH_PUBLIC_KEYS is the line it prints for the runner. Remove\n' +
    '  GC_AUTH_SECRET from every environment; nothing reads it any more.\n'
  );
  process.exit(1);
}
if (KEY_ERROR) {
  console.error(`\n  ${KEY_ERROR}\n\n  \`cd auth && python manage.py signing_key\` prints the value the runner expects.\n`);
  process.exit(1);
}
if (AUTH_ON && !WEB_ORIGIN) {
  // Every socket upgrade is checked against the app origin when auth is on,
  // so a gated runner with no origin to check against is one nobody's
  // browser can connect to. Say so now rather than as a 403 on every socket.
  console.error(
    '\n  GC_AUTH_PUBLIC_KEYS is set but GC_WEB_ORIGIN is not.\n' +
    '\n  With auth on, a socket is accepted only from the origin the UI is served at,\n' +
    '  so the runner has to be told what that is — e.g. GC_WEB_ORIGIN=http://localhost:3000.\n'
  );
  process.exit(1);
}
/**
 * Whether the driven page may reach private addresses (reach.js). On
 * whenever auth is on, because that is the deployed shape; GC_BLOCK_PRIVATE
 * overrides either way, and `npm run app -- --auth` turns it off with GC_DEMO
 * on so a laptop with a login can still drive the bundled apps on localhost.
 */
const BLOCK_PRIVATE = process.env.GC_BLOCK_PRIVATE != null
  ? /^(1|true|yes|on)$/i.test(process.env.GC_BLOCK_PRIVATE)
  : AUTH_ON;

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
 * The headers every response carries (docs/AUTH.md §11 [browser-side-3]
 * [browser-side-4]).
 *
 * The CSP is written for the UI: no inline script, nothing from another
 * origin, the socket and the control plane as the only things it may connect
 * to, and no framing at all. It is set on every response rather than on the
 * UI's alone because "every response" is a rule that survives a new route
 * and "the UI's" is a list that has to be kept. connect-src carries the
 * control plane's origin when the UI signs in somewhere else (the laptop);
 * deployed, both sit behind one origin and 'self' already says it. The
 * Turnstile host joins script-src and frame-src only when the control
 * plane will ask for the widget (mode.js).
 */
const CSP = csp();
/**
 * The bundled demo apps carry their behaviour in inline scripts — they are
 * fixtures whose job is to be driven, not the UI — so the pages under
 * public/ keep everything above except the inline-script rule. They are
 * only served in demo mode at all.
 */
const FIXTURE_CSP = csp({ turnstile: false }).replace("default-src 'self';", "default-src 'self'; script-src 'self' 'unsafe-inline';");
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

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
/**
 * The demo apps are fixtures, and a gated runner on a public address does
 * not serve fixtures: the pages exist to be driven, and driving this
 * process's own origin is exactly what production must not do. Off when
 * auth is on unless GC_DEMO=1 says so [browser-side-6]. The hero images are
 * the operator's own pictures for the dashboard, not a fixture, so they stay.
 */
const PUBLIC = fileURLToPath(new URL('./public', import.meta.url));
app.use('/hero', express.static(join(PUBLIC, 'hero'), { setHeaders: cacheHeaders }));
if (DEMO) {
  app.use(express.static(PUBLIC, { setHeaders: (res, path) => {
    cacheHeaders(res, path);
    if (path.endsWith('.html')) res.setHeader('Content-Security-Policy', FIXTURE_CSP);
  } }));
}
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
 * With auth off, `*`: the extension POSTs a recording from whatever page you
 * were recording on, so there is no single origin to name, and an open
 * runner has nothing to protect from a cross-origin read. With auth on the
 * wildcard is gone: only GC_WEB_ORIGIN is echoed, and any other origin gets
 * no CORS headers at all, so a page elsewhere cannot use a token it somehow
 * holds from a browser [browser-side-4].
 *
 * Echoed rather than starred because a browser rejects `*` on any
 * credentialed request. `Vary: Origin` is what stops a cache handing one
 * origin's response to another.
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

const fail = (res, err, code = 400) => res.status(code).json({ ok: false, error: err.message ?? String(err) });
const sendOk = (res, body) => res.json({ ok: true, ...body });

app.use('/api', (req, res, next) => {
  if (WEB_ORIGIN && req.headers.origin === WEB_ORIGIN) {
    res.set('Access-Control-Allow-Origin', WEB_ORIGIN);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
  } else if (!AUTH_ON) {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Access-Control-Allow-Headers', 'content-type, authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  // A preflight carries no Authorization header by definition, so it must be
  // answered before the gate. Requiring auth here would make every
  // cross-origin call fail at the preflight, which reads as a CORS bug.
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  if (!AUTH_ON) return next();

  /**
   * No exceptions. POST /api/recording used to be the one route left open
   * for the extension, which records on a page where it has no session. With
   * auth on it is under the gate like everything else: the extension gets a
   * token of its own through the control plane (docs/AUTH.md §11
   * [browser-side-2]), which is the ops flow's to build, and until then the
   * hand-off is a laptop feature.
   */
  const token = bearer(req.headers.authorization);
  if (!token) return res.status(401).json({ ok: false, error: 'Not signed in' });
  try {
    // The claims are `req.user`, and they are USED: the organisation keys
    // every store, `su` gates allowing an origin, `role` and `ent` are read
    // where they are enforced. Nothing about who is calling is ever read
    // from anywhere else.
    req.user = verify(token, PUBLIC_KEYS);
  } catch (err) {
    // The reason is safe to say: the caller already holds the token, so
    // "expired" versus "bad signature" tells them nothing they could not
    // determine anyway, and it is the difference between the UI silently
    // re-authenticating and a person staring at a spinner.
    return res.status(401).json({ ok: false, error: err.message });
  }
  next();
});

/**
 * Trade a token for a socket ticket (tickets.js). A browser cannot set
 * headers on a WebSocket, so the socket is opened with this instead of the
 * token: thirty seconds, one use, bound to these claims. Exists only when
 * auth is on; an open runner's socket needs nothing.
 */
app.post('/api/socket-ticket', (req, res) => {
  if (!AUTH_ON) return res.status(404).json({ ok: false, error: 'auth is off; the socket needs no ticket' });
  try { res.json({ ok: true, ...tickets.issue(req.user) }); }
  catch (err) { fail(res, err, err.name === 'TooManyTickets' ? 429 : 500); }
});

/**
 * Step-up: is this token fresh enough for the one action that demands it?
 *
 * Allowing an origin is the blast-radius action — it is what decides where
 * the browser may be pointed — so it wants a recent authentication, not a
 * session that has been sitting open since Monday. The control plane does
 * the reasoning about which factor counts and writes the answer into the
 * token as `su`, "step-up valid until"; the runner's whole check is that the
 * clock has not passed it (docs/AUTH.md §9 [mfa-recovery-2]).
 */
const steppedUp = (claims) => !AUTH_ON || (typeof claims?.su === 'number' && Date.now() / 1000 < claims.su);

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

app.get('/api/origins', (_req, res) => res.json({ origins: origins.list() }));
app.post('/api/origins', (req, res) => {
  if (!steppedUp(req.user)) return res.status(403).json({ ok: false, error: 'step_up_required' });
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
 *
 * Demo mode only, like the pages they lead to. And /go/r takes a relative
 * path and nothing else: an open redirect on a gated runner is a way to make
 * an allowed origin lead anywhere [browser-side-6].
 */
if (DEMO) {
  app.get('/go/tracked', (_req, res) => res.redirect(302, '/go/r?to=/pricing.html'));
  app.get('/go/r', (req, res) => {
    const to = String(req.query.to || '/');
    // One leading slash, not two: `//evil.example` is a protocol-relative URL
    // and a browser follows it off this host. A backslash is what some
    // browsers read as a slash.
    if (!/^\/(?![\/\\])/.test(to)) return res.status(400).send('relative paths only');
    res.redirect(302, to);
  });
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
}

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
 * The socket, upgraded by hand so the ticket can be checked first.
 *
 * `new WebSocketServer({ server })` would accept the upgrade and only then let
 * us look, which means an unauthenticated client is already a connected client
 * receiving screencast frames. noServer + an explicit handler is the difference
 * between refusing and disconnecting.
 *
 * What rides in the query string is a TICKET (tickets.js), never the token: a
 * browser cannot set headers when opening a WebSocket, and a URL is what logs,
 * referrers and history keep, so the thing in it is thirty seconds long and
 * good once. A `?t=` token in the URL is refused outright — a token in a URL
 * must fail, not work, or someone will keep doing it [ops-supply-4].
 *
 * Origin is checked when auth is on: a page on another origin can open a
 * WebSocket to this one — the browser sends no preflight for sockets — and
 * with a ticket it somehow obtained would be a viewer. The app origin is the
 * only one that may connect [websocket-6] [browser-side-5]. With auth off
 * nothing is checked, and the repository's own check scripts, which connect
 * from Node with no Origin at all, keep working.
 *
 * The PATH is deliberately not restricted. The browser uses /ws, but the
 * check scripts connect to the root, and the path was never the boundary.
 *
 * maxPayload: a message from a viewer is a command or a cursor position, and
 * a megabyte is a generous bound on either [websocket-5].
 */
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
wss.on('error', (err) => console.error(`  websocket server: ${err.message}`));

http.on('upgrade', (req, socket, head) => {
  // A real HTTP response, not a bare destroy: a socket that closes with no
  // status looks like a crashed server, and the UI would sit reconnecting
  // on its timer forever without ever saying why.
  const refuse = (code, text, why) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`);
    socket.destroy();
  };
  let claims = null;
  if (AUTH_ON) {
    let params;
    try { params = new URL(req.url, 'http://localhost').searchParams; } catch { return refuse(400, 'Bad Request', 'unreadable url'); }
    if (params.has('t')) return refuse(401, 'Unauthorized', 'a token in a URL is refused; POST /api/socket-ticket and open the socket with ?ticket=');
    if (req.headers.origin !== WEB_ORIGIN) return refuse(403, 'Forbidden', 'the socket is open to the app origin only');
    claims = tickets.redeem(params.get('ticket'));
    if (!claims) return refuse(401, 'Unauthorized', 'no ticket, or a ticket already spent or expired');
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Bound at the upgrade and read by every message handler. `null` is auth
    // off, and nothing downstream may treat null as "anyone".
    ws.claims = claims;
    wss.emit('connection', ws, req);
  });
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
            `\n  auth        ->  ${AUTH_ON
              ? `on — an EdDSA token from the control plane is required; keys: ${[...PUBLIC_KEYS.keys()].join(', ')}`
              : 'OFF — GC_AUTH_PUBLIC_KEYS unset, anyone who can reach this port can drive it'}` +
            `${TURNSTILE ? '\n  turnstile   ->  the CSP admits challenges.cloudflare.com (GC_TURNSTILE_SITE_KEY is set)' : ''}` +
            `\n  reach       ->  ${BLOCK_PRIVATE
              ? 'the driven page cannot reach loopback, private or link-local addresses'
              : 'unrestricted — the driven page may reach anything this host can (GC_BLOCK_PRIVATE=1 to close it)'}` +
            `\n  demo        ->  ${DEMO
              ? 'the bundled apps and /go/* fixtures are served'
              : 'not served — GC_DEMO=1 serves them behind the gate'}` +
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
const cdp = await page.context().newCDPSession(page);

let lastFrame = null;
const clients = new Set();

function emit(ev) {
  const msg = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}

/**
 * Every request the driven page makes, inspected (reach.js). The allowlist
 * decides where the browser may NAVIGATE; this decides what a page there may
 * then fetch, which is the half an allowlist cannot see. Installed before
 * browserReady, so nothing is driven through a gap.
 */
if (BLOCK_PRIVATE) {
  await page.context().route('**/*', async (route) => {
    const url = route.request().url();
    const why = await blocked(url);
    if (!why) return route.continue();
    emit({ t: 'log', level: 'error', msg: `blocked ${url} — ${why}` });
    return route.abort('blockedbyclient');
  });
}
browserReady = true;

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
/** Live sockets per subject. A fourth closes the oldest [websocket-5]. */
const MAX_SOCKETS_PER_SUB = 3;

wss.on('connection', (ws) => {
  const claims = ws.claims ?? null;
  // Only to this viewer — a refusal is theirs, not the room's.
  const tell = (ev) => { if (ws.readyState === 1) ws.send(JSON.stringify(ev)); };

  let expiry = null;
  if (claims) {
    const sub = String(claims.sub);
    // Insertion order is age: the Set was added to as sockets arrived.
    const mine = [...clients].filter((c) => c.claims && String(c.claims.sub) === sub);
    while (mine.length >= MAX_SOCKETS_PER_SUB) mine.shift().close(4409, 'replaced by a newer connection');
    // The socket lives exactly as long as the token that opened it. The UI
    // reconnects with a fresh ticket from a fresh token, so a session that
    // has ended stops seeing frames within ten minutes, with no revocation
    // channel needed [websocket-1].
    expiry = setTimeout(() => ws.close(4401, 'token expired'), Math.max(0, claims.exp * 1000 - Date.now()));
  }
  clients.add(ws);
  // A socket that sends more than maxPayload, or breaks the framing, raises
  // 'error' on the socket — and an 'error' event with no listener is an
  // uncaught exception that takes the whole runner down. One bad viewer
  // must not cost everyone else the browser.
  ws.on('error', (err) => console.error(`  socket: ${err.message}`));

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
    if (!m || typeof m !== 'object') return;

    // Every message is authorised against the claims bound at the upgrade,
    // exactly as the HTTP routes are against req.user — never against
    // anything in the message. The driving-org lock and the per-org
    // broadcast (docs/AUTH.md §9.5–6) read `claims.org` here; that is the
    // runner-tenancy step. What is enforced today is step-up on origin.add.

    // The UI says goodbye on sign-out and before a new sign-in, and the
    // socket is dropped at once rather than left to time out [session-3].
    if (m.t === 'bye') return void ws.close(1000, 'bye');

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

    // Allowing an origin is a human act, through the UI. No plan can reach it,
    // and — identical to POST /api/origins — it wants a recent authentication.
    if (m.t === 'origin.add') {
      if (!steppedUp(claims)) {
        tell({ t: 'refused', of: 'origin.add', error: 'step_up_required' });
        tell({ t: 'log', level: 'error', msg: 'allowing an origin needs a recent sign-in — sign in again and retry' });
        return;
      }
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

  ws.on('close', () => { clients.delete(ws); if (expiry) clearTimeout(expiry); });

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
