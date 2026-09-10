import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VirtualCursor, sleep } from './cursor.js';
import { OPS, validate, PACE, paceOf } from './ops.js';
import { normalizeUrl } from './origins.js';
import { iconFor } from './icons.js';
import { chooseHome } from './home.js';
import { bearer, verify } from './auth.js';
import { AUTH_ON, DEMO, PUBLIC_KEYS, KEY_ERROR, WEB_ORIGIN, EXTENSION_ORIGINS, EXTENSION_ERROR, TURNSTILE, csp } from './mode.js';
import * as tickets from './tickets.js';
import * as tenancy from './tenancy.js';
import { LOCAL } from './org.js';
import { blocked } from './reach.js';
import { NoSuchSuite, originOf, pageCheckFlow } from './suites.js';
import { discover, links } from './targets.js';
import { parse } from './parse.js';
import { parseFlow, flatten, toFlow } from './flow.js';
import { toMermaid } from './diagram.js';
import { Recorder } from './recorder.js';
import { NavigationLog } from './navlog.js';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT) || 3000;
const VIEW = { width: 1180, height: 760 };

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
 *
 * GC_SIGNING_KEY is refused for the same reason and needs saying twice as
 * loudly, because it is the LIVE private key rather than a retired one: an
 * operator who sourced .env.prod into their shell before starting the runner
 * by hand, or a developer who exported it, hands signing material to the
 * process that drives the browser, and nothing else in the runner would
 * notice.
 */
const SIGNING_IN_ENV = ['GC_AUTH_SECRET', 'GC_SIGNING_KEY'].filter((name) => name in process.env);
if (SIGNING_IN_ENV.length) {
  console.error(
    `\n  ${SIGNING_IN_ENV.join(' and ')} is set, and this process must not hold a signing key.\n` +
    '\n  Tokens are signed with an Ed25519 private key that lives ONLY in the control\n' +
    "  plane (GC_SIGNING_KEY). The runner is given the public half:\n" +
    '\n    cd auth && python manage.py signing_key --new\n' +
    '\n  and GC_AUTH_PUBLIC_KEYS is the line it prints for the runner. Keep the\n' +
    `  private half out of this process's environment; unset ${SIGNING_IN_ENV.join(' and ')}.\n`
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
if (EXTENSION_ERROR) {
  // A web origin in the extension list is the CORS wildcard by another
  // name (mode.js); refused at boot, where the message names the variable,
  // rather than honoured on every request.
  console.error(`\n  ${EXTENSION_ERROR}\n`);
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
 * Every store is keyed by organisation (tenancy.js, docs/AUTH.md §10). The
 * flat files a pre-tenancy runner left behind are moved under `local` first,
 * BEFORE any store is opened, so the move is one rename and not a merge.
 */
const migrated = tenancy.migrate();
/** The laptop's one organisation. With auth on nothing signs in as it. */
const local = tenancy.workspace(LOCAL);

/** Where the runner points when it starts — the rule itself is in home.js. */
const homeUrl = () => chooseHome({
  envUrl: process.env.HOME_URL,
  runs: local.history.list(),
  isAllowed: (origin) => local.origins.has(origin),
});

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
/**
 * The rest of the driven session, and why these are `let` rather than `const`.
 *
 * There is one Chromium, and the lock on it changes hands between
 * organisations. A handover REPLACES the browser context (see `resetSession`),
 * so the CDP session, the cursor drawn over the video and the navigation log
 * all belong to the page of the moment rather than to the process. Every
 * caller reads them at request time, which is why rebinding them is enough.
 */
let cdp = null;
let cursor = null;
let nav = null;
// Set once the browser is actually up. The port opens ~100 lines before
// chromium.launch, so "the server answers" and "the app works" are two
// different facts. /healthz reports this one, and a deploy waits on it.
let browserReady = false;
/**
 * The viewers and the last picture, declared up here for the same reason:
 * a socket can connect, and a route can try to tell one something, in the
 * seconds before the browser exists.
 */
let lastFrame = null;
const clients = new Set();

/**
 * The address on the driven page, or null when there is nothing open.
 *
 * `about:blank` is where a browser context starts and where a handover leaves
 * it, and it is truthy — so reporting it verbatim tells a viewer that a page
 * is open and puts the string in the console's URL bar. Nothing open is a
 * real state and deserves to be said as one.
 */
const currentUrl = () => {
  const here = page?.url() ?? '';
  return here && here !== 'about:blank' ? here : null;
};

/**
 * Who is driving the one browser (tenancy.js). With auth off it is `local`
 * from the first moment and never anyone else, so the lock is never held
 * against anybody and every socket sees the page — the laptop is unchanged.
 * With auth on nobody drives until an organisation opens a page or starts a
 * run, and until then no socket receives a frame of anything.
 *
 * GC_RUNNER_IDLE_MS is how long an organisation keeps the browser after its
 * run has ended with none of its sockets doing anything; a minute by default
 * (docs/AUTH.md §10), and configuration rather than code because the checks
 * need to watch the lock lapse without waiting a minute for it.
 */
const driver = new tenancy.Driver({
  idleMs: Math.max(1000, Number(process.env.GC_RUNNER_IDLE_MS) || tenancy.IDLE_MS),
  isRunning: () => running,
});
if (!AUTH_ON) driver.claim(LOCAL);

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

/**
 * The refusals the plan and the lock produce, in the shapes the UI reads
 * (docs/AUTH.md §10): a 402 names the limit and the plan, a 409 names who is
 * driving, a 403 says which role it wanted. Every route goes through `fail`,
 * so a new route cannot answer a plan refusal with a 400 by forgetting.
 */
const fail = (res, err, code = 400) => {
  if (err instanceof tenancy.EntitlementError) {
    return res.status(402).json({ ok: false, error: 'entitlement', limit: err.limit, plan: err.plan });
  }
  if (err instanceof tenancy.RunnerBusy) return res.status(409).json({ ok: false, error: 'runner_busy', org: err.org });
  if (err instanceof tenancy.Forbidden) return res.status(403).json({ ok: false, error: 'forbidden', needs: 'admin' });
  // A suite this organisation does not have is a 404 from every route that can
  // reach one — the nested ones used to answer 400, which contradicts §10 for
  // no gain, since the body is the same either way.
  if (err instanceof NoSuchSuite) return res.status(404).json({ ok: false, error: err.message });
  return res.status(code).json({ ok: false, error: err.message ?? String(err) });
};
const sendOk = (res, body) => res.json({ ok: true, ...body });

app.use('/api', (req, res, next) => {
  // The app's origin, or one of the operator's extension origins (mode.js):
  // each is echoed back exactly, never a pattern, and nothing else is.
  const origin = req.headers.origin;
  if (origin && ((WEB_ORIGIN && origin === WEB_ORIGIN) || EXTENSION_ORIGINS.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
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

  if (!AUTH_ON) {
    // The laptop: one organisation, no plan, nobody to refuse.
    req.user = null;
    req.space = local;
    req.ent = tenancy.entitlements(null);
    return next();
  }

  /**
   * No exceptions. POST /api/recording used to be the one route left open
   * for the extension, which records on a page where it has no session. With
   * auth on it is under the gate like everything else: the extension's
   * background worker asks the control plane for a token of its own with
   * the person's session cookie (extension/background.js; docs/AUTH.md §11
   * [browser-side-2]) and presents it here the way the UI does.
   */
  const token = bearer(req.headers.authorization);
  if (!token) return res.status(401).json({ ok: false, error: 'Not signed in' });
  try {
    // The claims are `req.user`, and they are USED: the organisation keys
    // every store, `su` gates allowing an origin, `role` and `ent` are read
    // where they are enforced. Nothing about who is calling is ever read
    // from anywhere else.
    req.user = verify(token, PUBLIC_KEYS);
    // A token minted before the plan changed is refused once a newer one has
    // been seen, so a downgrade is not ten minutes away (docs/AUTH.md §8.6).
    // 401, because the remedy is the same as for an expired token: the UI
    // forgets it and mints again.
    tenancy.noteVersion(req.user);
  } catch (err) {
    // The reason is safe to say: the caller already holds the token, so
    // "expired" versus "bad signature" tells them nothing they could not
    // determine anyway, and it is the difference between the UI silently
    // re-authenticating and a person staring at a spinner.
    const error = err instanceof tenancy.StaleEntitlements ? 'stale_entitlements' : err.message;
    return res.status(401).json({ ok: false, error });
  }
  req.space = tenancy.workspace(req.user.org);
  req.ent = tenancy.entitlements(req.user);
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

/**
 * The organisation's history, pruned to what its plan keeps before it is
 * read (docs/AUTH.md §10 `history.retention_days`). Pruning on read rather
 * than on a timer means the number a plan says is the number a page shows,
 * and there is no job to forget to run.
 */
const historyOf = (req) => {
  req.space.history.prune(req.ent.limit('history.retention_days'));
  return req.space.history;
};

app.get('/api/runs', (req, res) => res.json(historyOf(req).summary(14, req.query.suite || null)));
app.get('/api/defects', (req, res) => res.json(historyOf(req).defects(14)));

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
 *
 * Behind the /api gate like everything else, and it consults the CALLER'S
 * allowlist rather than a global one: each organisation has its own now
 * (docs/AUTH.md §10), so this cannot be used to warm or read icons for
 * origins that belong to somebody else.
 */
app.get('/api/sites/icon', async (req, res) => {
  const origin = String(req.query.origin ?? '');
  try {
    const icon = await iconFor(origin, req.space.origins.list());
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
 *
 * Every one of them reads `req.space.suites`: the calling organisation's
 * directory and no other, so an id from another organisation is "no suite"
 * here exactly as it would be for an id nobody ever made.
 */

/** Parse+validate a flow the way the executor will, against THIS organisation's allowlist. Suites store nothing unrunnable. */
const checkFlowFor = (space) => (flow) => validate(flatten(parseFlow(flow)), { origins: space.origins });

/**
 * A plan that does not open a page of its own is refused unless the page
 * already open is this organisation's to drive.
 *
 * validate() checks a URL against the allowlist, and a plan whose first step is
 * a `click` gives it none — so for that plan the origin gate would simply not
 * happen (docs/AUTH.md §11, "the gate is not skipped"). Two things have to hold
 * instead: the browser must already be this organisation's, because inheriting
 * somebody else's open page is the crossing §10 forbids, and that page must
 * stand at an origin this organisation has allowed. With auth off there is one
 * organisation, it always holds the browser, and anything open was opened
 * through this same gate — so a laptop is unaffected.
 *
 * @returns null when the plan may run, otherwise what to tell the caller.
 */
const NOTHING_OPEN = 'Nothing is open yet — start the script with a `goto`';
function unanchored(plan, space) {
  if (plan.navigates) return null;
  if (!driver.sees(space.org)) return { error: NOTHING_OPEN };
  const url = currentUrl();
  if (!url) return { error: NOTHING_OPEN };
  let origin;
  try { origin = new URL(url).origin; } catch { return { error: NOTHING_OPEN }; }
  if (space.origins.has(origin)) return null;
  return { origin, url, error: `${origin} is not allowed yet` };
}

/** The gate, as an answer the UI can act on rather than an error it must read. */
function gate(res, origin, space) {
  if (space.origins.has(origin)) return false;
  res.status(409).json({ ok: false, needsOrigin: origin,
    error: `${origin} is not allowed yet` });
  return true;
}

/**
 * Take the browser for an organisation, telling the room when it changes
 * hands — whoever had it, and whoever was waiting. A failure is a
 * RunnerBusy, which `fail` turns into the 409 the UI reads.
 *
 * The lock alone would only decide who may ASK for the browser. There is one
 * Chromium and one BrowserContext, so a lock that changes hands without
 * resetting the session hands the incoming organisation the outgoing one's
 * live page — its last frame, its URL, its target list, its cookies and its
 * storage — and, worse, the ability to drive that page on an origin the
 * newcomer never allowed. That is precisely the "view of someone else's
 * browser" §10 exists to prevent, so the session goes with the lock: awaited,
 * before the caller is allowed to touch `page`.
 */
async function take(org) {
  const changed = driver.claim(org);
  if (changed) {
    await resetSession();
    announceDriving();
  }
  armRelease();
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

/**
 * How much of the plan this organisation has used, counted by the runner
 * from its own stores — the same numbers the refusals are made from, so the
 * page that shows them cannot disagree with the 402 that follows.
 */
const usage = (req) => ({
  suites: { used: req.space.suites.list().length, max: req.ent.limit('suites.max') },
  runs: { used: req.space.history.today(), max: req.ent.limit('runs.per_day') },
  origins: { used: req.space.origins.list().length, max: req.ent.limit('origins.max') },
  vault: req.ent.enabled('vault.enabled'),
  retentionDays: req.ent.limit('history.retention_days'),
});

app.get('/api/state', (req, res) => {
  // The page belongs to whoever is driving. Another organisation is told the
  // runner is busy and nothing about the address on it.
  const mine = driver.sees(req.space.org);
  res.json({
    url: mine ? currentUrl() : null,
    running: mine && running,
    recording: mine && (recorder?.recording ?? false),
    origins: req.space.origins.list(),
    secrets: req.space.vault.names(),   // names only — a value never leaves the server
    headed: HEADED,
    // How patient the runner is, so it is visible rather than folklore.
    timeoutMs: Number(process.env.GC_TIMEOUT_MS) || 8000,
    settleMs: Number(process.env.GC_SETTLE_MS) || 250,
    // How much of a run is performed for a watcher. The UI offers a per-run
    // override, and needs to know what it is overriding.
    paceMs: PACE,
    org: req.space.org,
    plan: req.ent.plan,
    driving: driver.describe(req.space.org),
    usage: usage(req),
  });
});


app.get('/api/origins', (req, res) => res.json({ origins: req.space.origins.list() }));
app.post('/api/origins', (req, res) => {
  try {
    // Origins are an owner's or admin's to change (docs/AUTH.md §10), and
    // then only with a recent authentication, and then only within the plan.
    tenancy.requireManager(req.user);
    if (!steppedUp(req.user)) return res.status(403).json({ ok: false, error: 'step_up_required' });
    const r = req.space.origins.add(req.body?.origin,
      () => req.ent.check('origins.max', req.space.origins.list().length));
    emitTo(req.space.org, { t: 'origins', origins: req.space.origins.list() });
    sendOk(res, { ...r, origins: req.space.origins.list() });
  } catch (err) { fail(res, err); }
});
app.delete('/api/origins', (req, res) => {
  try {
    tenancy.requireManager(req.user);
    req.space.origins.remove(req.body?.origin);
    emitTo(req.space.org, { t: 'origins', origins: req.space.origins.list() });
    sendOk(res, { origins: req.space.origins.list() });
  } catch (err) { fail(res, err); }
});

/**
 * Every case, across every suite, flat.
 *
 * The console is not inside a suite — you can arrive at it from anywhere — so
 * "run the thing I saved yesterday" needs one list rather than a hunt through
 * the sidebar. The flow rides along because loading a case IS its flow, and a
 * second round trip to fetch it would only make selecting one feel slow.
 */
app.get('/api/cases', (req, res) => {
  const out = [];
  for (const row of req.space.suites.list()) {
    for (const c of req.space.suites.get(row.id).cases) {
      out.push({ suiteId: row.id, suite: row.name, ...c });
      if (out.length >= 200) break;              // a picker, not an archive
    }
    if (out.length >= 200) break;
  }
  res.json({ cases: out });
});

app.get('/api/suites', (req, res) => res.json({ suites: req.space.suites.list() }));
app.post('/api/suites', (req, res) => {
  try {
    req.ent.check('suites.max', req.space.suites.list().length);
    sendOk(res, { suite: req.space.suites.create(req.body ?? {}) });
  } catch (err) { fail(res, err); }
});
app.get('/api/suites/:id', (req, res) => {
  try {
    const s = req.space.suites.get(req.params.id);
    // The gate's state travels with the suite, so onboarding can show where it
    // stands without a second round trip.
    res.json({ suite: s, allowed: req.space.origins.has(originOf(s)) });
  } catch (err) { fail(res, err, 404); }
});
app.patch('/api/suites/:id', (req, res) => {
  try { sendOk(res, { suite: req.space.suites.update(req.params.id, req.body ?? {}) }); }
  catch (err) { fail(res, err); }
});
app.delete('/api/suites/:id', (req, res) => {
  try { sendOk(res, req.space.suites.remove(req.params.id)); }
  catch (err) { fail(res, err); }
});

app.post('/api/suites/:id/pages', (req, res) => {
  try { sendOk(res, { page: req.space.suites.addPage(req.params.id, req.body ?? {}) }); } catch (err) { fail(res, err); }
});
app.patch('/api/suites/:id/pages/:pageId', (req, res) => {
  try { sendOk(res, { page: req.space.suites.updatePage(req.params.id, req.params.pageId, req.body ?? {}) }); }
  catch (err) { fail(res, err); }
});
app.delete('/api/suites/:id/pages/:pageId', (req, res) => {
  try { sendOk(res, req.space.suites.removePage(req.params.id, req.params.pageId)); } catch (err) { fail(res, err); }
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
  const space = req.space;
  let suite, pg;
  try {
    suite = space.suites.get(req.params.id);
    pg = suite.pages.find((p) => p.id === req.params.pageId);
    if (!pg) throw new Error('No such page');
  } catch (err) { return fail(res, err, 404); }

  if (gate(res, originOf(suite), space)) return;
  // The lock before the run lock: an organisation that cannot have the
  // browser is told it is busy, not that "a run is in progress" — which is
  // someone else's run, and none of its business.
  try { await take(space.org); } catch (err) { return fail(res, err); }
  if (running) return fail(res, new Error('A run is in progress'), 409);

  running = true;
  try {
    await OPS.goto(page, { url: pg.url }, { cursor, emit, nav, onNavigate: publishTargets, origins: space.origins });
    const items = await discover(page);
    const linked = await links(page).catch(() => []);
    const saved = space.suites.updatePage(suite.id, pg.id, { targets: items, linked });
    emit({ t: 'log', level: 'info',
           msg: `scanned ${pg.url} — ${items.length} targets, ${linked.length} links` });
    sendOk(res, { page: saved, url: page.url() });
  } catch (err) {
    fail(res, err);
  } finally {
    running = false;
    armRelease();
    await publishTargets();
  }
});

app.post('/api/suites/:id/cases', (req, res) => {
  try { sendOk(res, { case: req.space.suites.addCase(req.params.id, req.body ?? {}, checkFlowFor(req.space)) }); }
  catch (err) { fail(res, err); }
});
app.patch('/api/suites/:id/cases/:caseId', (req, res) => {
  try { sendOk(res, { case: req.space.suites.updateCase(req.params.id, req.params.caseId, req.body ?? {}, checkFlowFor(req.space)) }); }
  catch (err) { fail(res, err); }
});
app.delete('/api/suites/:id/cases/:caseId', (req, res) => {
  try { sendOk(res, req.space.suites.removeCase(req.params.id, req.params.caseId)); } catch (err) { fail(res, err); }
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
  const space = req.space;
  let suite;
  try { suite = space.suites.get(req.params.id); } catch (err) { return fail(res, err, 404); }
  if (gate(res, originOf(suite), space)) return;

  const wanted = req.query.case
    ? suite.cases.filter((c) => c.id === req.query.case)
    : suite.cases;
  if (!wanted.length) return fail(res, new Error('This suite has no cases to run'));
  // The whole suite, counted up front: a run that would stop at case three
  // of five is refused before case one, not discovered halfway. And the
  // plan before the lock: a run the plan refuses never takes the browser.
  try {
    req.ent.check('runs.per_day', space.history.today(), wanted.length);
    await take(space.org);
  } catch (err) { return fail(res, err); }
  if (running) return fail(res, new Error('A run is in progress'), 409);

  // How much of this run to perform, for this run only. Absent means the
  // server's default, so a caller that has never heard of pace is unaffected.
  const pace = paceOf(req.query.pace, PACE);
  const checkFlow = checkFlowFor(space);

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
    const r = await run(plan, { suiteId: suite.id, caseId: c.id, caseName: c.name, pace, space, ent: req.ent })
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
  const space = req.space;
  let u;
  try { u = normalizeUrl(req.body?.url); } catch (err) { return fail(res, err); }
  try {
    req.ent.check('suites.max', space.suites.list().length);
    req.ent.check('runs.per_day', space.history.today());
  } catch (err) { return fail(res, err); }
  if (gate(res, u.origin, space)) return;
  try { await take(space.org); } catch (err) { return fail(res, err); }
  if (running) return fail(res, new Error('A run is in progress'), 409);

  let suite, pg, items;
  running = true;
  try {
    // Open it first: the page's own title is a better suite name than anything
    // derived from a hostname, and it costs nothing since we must go there.
    await OPS.goto(page, { url: u.href }, { cursor, emit, nav, onNavigate: publishTargets, origins: space.origins });
    const title = (await page.title().catch(() => '')).trim().slice(0, 80);
    items = await discover(page);
    const linked = await links(page).catch(() => []);
    const path = `${u.pathname}${u.search}${u.hash}`;

    suite = space.suites.create({
      name: String(req.body?.name ?? '').trim() || title || u.host,
      baseUrl: u.href,
      description: `Added from ${u.href}`,
    });
    pg = space.suites.addPage(suite.id, {
      name: title || 'Entry',
      path,
      expect: [{ kind: 'url', value: path }],
    });
    space.suites.updatePage(suite.id, pg.id, { targets: items, linked });
  } catch (err) {
    return fail(res, err);
  } finally {
    running = false;
    armRelease();
  }

  const checkFlow = checkFlowFor(space);
  const flow = pageCheckFlow(space.suites.get(suite.id), space.suites.get(suite.id).pages[0]);
  const c = space.suites.addCase(suite.id, { name: `${pg.name} loads`, pageId: pg.id, flow }, checkFlow);
  const outcome = await run(checkFlow(flow), { suiteId: suite.id, caseId: c.id, caseName: c.name, space, ent: req.ent });

  sendOk(res, {
    suite: space.suites.get(suite.id),
    targets: items.length,
    run: outcome,
  });
});

/** A page's expectations, as a flow you can read before you run it. */
app.get('/api/suites/:id/pages/:pageId/check', (req, res) => {
  try {
    const s = req.space.suites.get(req.params.id);
    const p = s.pages.find((x) => x.id === req.params.pageId);
    if (!p) throw new Error('No such page');
    res.json({ flow: pageCheckFlow(s, p) });
  } catch (err) { fail(res, err, 404); }
});

/**
 * Where the browser extension drops a recording.
 *
 * It is validated here and put in the viewer's script box — never run. Any
 * page you visit can reach a localhost port, so an endpoint that executed what
 * it was handed would be a remote-code path with extra steps. A human presses
 * Run.
 *
 * Scoped to the organisation of the token that brought it: the recording is
 * checked against that organisation's allowlist and lands in that
 * organisation's script boxes and nobody else's (docs/AUTH.md §10).
 */
app.post('/api/recording', (req, res) => {
  const flow = String(req.body?.flow ?? '');
  let plan;
  try {
    plan = validate(flatten(parseFlow(flow)), { origins: req.space.origins });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  emitTo(req.space.org, { t: 'imported', flow, steps: plan.steps.length });
  emitTo(req.space.org, { t: 'log', level: 'info', msg: `recording imported — ${plan.steps.length} steps, not run` });
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
    ws.org = tenancy.orgOf(claims);
    wss.emit('connection', ws, req);
  });
});

// Starting with HOME_URL set is a person naming an origin on the command line,
// which is the same decision the Allow button represents — so honour it rather
// than opening on your own app and immediately refusing to drive it. It is the
// laptop's decision, so it goes to the laptop's organisation.
if (process.env.HOME_URL) {
  try { local.origins.add(process.env.HOME_URL); }
  catch (err) { console.error(`  HOME_URL: ${err.message}`); }
}

console.log(`\n  ghostclick  ->  http://localhost:${PORT}` +
            `\n  serving     ->  ${WEB_DIR}${process.env.GC_WEB_DIR ? '  (GC_WEB_DIR)' : ''}` +
            `\n  driving     ->  ${homeUrl() ?? 'nothing yet — open a URL in the console'}` +
            `\n  auth        ->  ${AUTH_ON
              ? `on — an EdDSA token from the control plane is required; keys: ${[...PUBLIC_KEYS.keys()].join(', ')}`
              : 'OFF — GC_AUTH_PUBLIC_KEYS unset, anyone who can reach this port can drive it'}` +
            `\n  tenancy     ->  ${AUTH_ON
              ? 'state is kept per organisation under .ghostclick/<org>/ and suites/<org>/; one organisation drives at a time'
              : `one workspace, "${LOCAL}" — .ghostclick/${LOCAL}/ and suites/${LOCAL}/`}` +
            `${migrated.moved.length ? `\n  migrated    ->  ${migrated.moved.join('; ')}` : ''}` +
            `${migrated.failed.length ? `\n  NOT moved   ->  ${migrated.failed.join('; ')} — serving them where they are` : ''}` +
            `${TURNSTILE ? '\n  turnstile   ->  the CSP admits challenges.cloudflare.com (GC_TURNSTILE_SITE_KEY is set)' : ''}` +
            `${AUTH_ON ? `\n  extension   ->  ${EXTENSION_ORIGINS.length
              ? `${EXTENSION_ORIGINS.join(', ')} may post a recording with a token (GC_EXTENSION_ORIGINS)`
              : 'no origin listed in GC_EXTENSION_ORIGINS — the recorder cannot hand off to this runner'}` : ''}` +
            `\n  reach       ->  ${BLOCK_PRIVATE
              ? 'the driven page cannot reach loopback, private or link-local addresses'
              : 'unrestricted — the driven page may reach anything this host can (GC_BLOCK_PRIVATE=1 to close it)'}` +
            `\n  demo        ->  ${DEMO
              ? 'the bundled apps and /go/* fixtures are served'
              : 'not served — GC_DEMO=1 serves them behind the gate'}` +
            `\n  browser     ->  ${HEADED ? 'headed — a real window you can watch' : 'headless — streamed to the canvas (HEADED=1 for a window)'}` +
            `\n  allowed     ->  ${AUTH_ON ? 'per organisation' : local.origins.list().join(', ')}` +
            `\n  secrets     ->  ${AUTH_ON ? 'per organisation' : local.vault.names().join(', ') || '(none set)'}` +
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

/**
 * Broadcast is per organisation (docs/AUTH.md §9.6 [websocket-3]).
 *
 * `emitTo` reaches the sockets of one organisation. `emit` — what the
 * executor, the cursor, the navigation log and the page's console call — is
 * the driving organisation's sockets and nobody else's: those events
 * describe the page, and the page belongs to whoever is driving it. With
 * auth off every socket is `local` and so is the driver, which is the
 * room-wide broadcast the laptop always had.
 */
function emitTo(org, ev) {
  const msg = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1 && c.org === org) c.send(msg);
}
function emit(ev) {
  if (driver.org) emitTo(driver.org, ev);
}

/**
 * Tell every socket where the lock stands, each in its own terms. Called
 * when the lock lapses on its own — the organisation that was waiting has
 * no other way to learn the browser is free.
 */
function announceDriving() {
  for (const c of clients) {
    if (c.readyState === 1) c.send(JSON.stringify({ t: 'driving', ...driver.describe(c.org) }));
  }
}
let releaseTimer = null;
function armRelease() {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  const inMs = driver.lapsesIn();
  if (inMs === null) return;
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    // Something may have touched the lock since; if so it re-armed this.
    if (!driver.held()) announceDriving();
  }, inMs + 50);
  releaseTimer.unref?.();
}


/**
 * The driven page's own console, forwarded.
 *
 * A failing step usually has a reason the page already printed — an uncaught
 * TypeError, a 500 that the app's fetch wrapper logged — and until now that
 * reason existed only inside a browser nobody could open devtools on. You saw
 * "expected the URL to contain /dashboard" and had to guess why it did not.
 *
 * Vault values are redacted on the way out — the driving organisation's,
 * since its page is the one that could print them. An app logging the token
 * it just received is not unusual, and a secret that never leaves the
 * server must not leave it through here either. Long lines are cut: a page
 * that dumps a 2MB JSON blob into console.log should not be able to do it
 * down this socket.
 */
const LINE_MAX = 2000;
function redact(text) {
  let out = String(text ?? '');
  const vault = tenancy.workspace(driver.org ?? LOCAL).vault;
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




/** What can the current page be told to do? Emitted whenever it changes. */
async function publishTargets() {
  try {
    emit({ t: 'targets', url: currentUrl(), items: await discover(page) });
  } catch (err) {
    emit({ t: 'log', level: 'error', msg: `discovery failed: ${err.message}` });
  }
}

/**
 * Build a driven session: a fresh browser context, its page, and everything
 * that listens to it.
 *
 * One function because it has two callers that must agree exactly. At boot it
 * is the browser the laptop drives; on a handover between organisations it is
 * what `resetSession` puts in place of the outgoing one's, and anything this
 * forgets to re-attach is a feature that silently stops working for whoever
 * drives second.
 */
async function newSession() {
  page = await browser.newPage({
    viewport: VIEW,
    // The route handler below is the only thing between an allowed page and
    // this container's network, and Playwright does not run it for a service
    // worker's requests. So when the reach rule is on, a page may not have
    // one: a secure context is all a worker needs, and one fetch from inside
    // it would otherwise bypass reach.js entirely [browser-side-1].
    serviceWorkers: BLOCK_PRIVATE ? 'block' : 'allow',
  });
  cdp = await page.context().newCDPSession(page);

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

  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    // ACK FIRST. Chrome sends no further frames until this lands — it is the
    // backpressure valve, and forgetting it looks exactly like "streaming broke".
    try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}

    // Nothing open, nothing to show. A fresh context — at boot, and after a
    // handover resets one — sits on about:blank, and Chrome emits a frame of
    // it as soon as the screencast starts: five kilobytes of white that says
    // a page is being driven when none is. Held as `lastFrame` it would also
    // be what the next viewer is primed with.
    if (!currentUrl()) return;

    lastFrame = Buffer.from(data, 'base64');
    for (const c of clients) {
      // Only the driving organisation's viewers: a frame is a picture of
      // somebody's page. Drop frames for a viewer that is already behind
      // rather than queueing them in Node. Video is the one thing that is
      // always safe to drop.
      if (c.readyState === 1 && driver.sees(c.org) && c.bufferedAmount < 1 << 20) c.send(lastFrame, { binary: true });
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

  cursor = new VirtualCursor(cdp, emit);

  /**
   * Every top-level navigation, with the hops it went through.
   *
   * A link that lands on the right URL can still have 301'd through a path that
   * no longer exists, detoured via a tracker, or arrived at a friendly 404. The
   * final URL says none of that, so the chain is kept and shown.
   */
  page.on('console', (msg) => fromPage(msg.type(), msg.text()));
  // An uncaught exception never reaches console.*, and it is the one you most
  // want: it is usually why the next step could not find anything.
  page.on('pageerror', (err) => fromPage('error', err?.stack || String(err)));

  nav = new NavigationLog(page, {
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
    emit({ t: 'url', url: currentUrl() });
    publishTargets();
  });
}

/**
 * Throw the driven session away and build another.
 *
 * Called when the lock changes hands. Closing the CONTEXT rather than the page
 * is the point: the page's cookies, localStorage, service workers and HTTP
 * cache belong to the context, and an organisation that inherited those would
 * be signed in as the last one wherever it went next. The held frame goes too,
 * so a viewer of the new session is not primed with a picture of the old page,
 * and any recording in flight is dropped rather than continued into somebody
 * else's browser.
 */
async function resetSession() {
  browserReady = false;
  lastFrame = null;
  if (recorder?.recording) { try { recorder.stop(null); } catch {} }
  const old = page;
  try { await old?.context().close(); } catch { /* already gone is the outcome we wanted */ }
  await newSession();
  browserReady = true;
}

await newSession();
browserReady = true;

const home = homeUrl();
if (home) await page.goto(home).catch((err) => console.error(`  could not open ${home}: ${err.message}`));

// ---------------------------------------------------------------- executor
// `running` is declared at the top, so /api/state can be answered during boot.

/**
 * The organisation's vault, as the executor sees it: the plan's switch in
 * front of the value (docs/AUTH.md §10 `vault.enabled`). The step that
 * resolves a `$KEY` on a plan without the vault fails with the plan's
 * refusal, and the socket is told in the shape the UI turns into an
 * upgrade prompt.
 */
const vaultFor = (space, ent) => ({
  get(ref) {
    ent.demand('vault.enabled');
    return space.vault.get(ref);
  },
});

/**
 * @param meta which suite and case this plan came from, when it came from one.
 *   A plan typed into the console has no suite; that is a legitimate state and
 *   the history records it as such rather than inventing a home for it.
 *   `space` and `ent` are the calling organisation's workspace and plan;
 *   absent, the laptop's.
 * @returns {{ok:boolean, passed:number, total:number, error:string|null}}
 */
async function run(plan, meta = {}) {
  const space = meta.space ?? local;
  const ent = meta.ent ?? tenancy.entitlements(null);
  if (running) {
    // An error, not a warning. A refused run does nothing visible, so if this
    // is quiet the only symptom is a button that appears not to work.
    emitTo(space.org, { t: 'log', level: 'error', msg: 'A run is already in progress — wait for it to finish' });
    return { ok: false, passed: 0, total: 0, error: 'A run is already in progress' };
  }
  // A plan with no `goto` of its own is only allowed to run on a page this
  // organisation already holds — checked BEFORE the lock, so a refused plan
  // does not take the browser away from whoever has it.
  const stray = unanchored(plan, space);
  if (stray) {
    emitTo(space.org, { t: 'log', level: 'error', msg: stray.error });
    if (stray.origin) emitTo(space.org, { t: 'needs.origin', origin: stray.origin, url: stray.url });
    return { ok: false, passed: 0, total: 0, error: stray.error };
  }
  // The browser is the driving organisation's for the length of the run, and
  // a run is the plan's to count. Both refusals are answered to the
  // organisation that asked, in the shape its UI acts on.
  try {
    ent.check('runs.per_day', space.history.today());
    await take(space.org);
  } catch (err) {
    emitTo(space.org, { t: 'refused', of: 'run', ...refusal(err) });
    emitTo(space.org, { t: 'log', level: 'error', msg: err.message });
    return { ok: false, passed: 0, total: 0, error: err.message };
  }
  running = true;
  const wasRecording = recorder.recording;
  recorder.recording = false;

  const results = [];
  // A run can be told how much of itself to perform. Unset means this server's
  // default, so nothing that does not ask is affected.
  const ctx = {
    cursor, emit, nav, onNavigate: publishTargets, pace: paceOf(meta.pace, PACE),
    origins: space.origins, vault: vaultFor(space, ent),
  };
  emit({ t: 'run.start', total: plan.steps.length, suite: plan.suite, suiteId: meta.suiteId, caseId: meta.caseId, caseName: meta.caseName });

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
        // A step the plan refused is a plan refusal, not a broken page.
        if (err instanceof tenancy.EntitlementError) emit({ t: 'refused', of: 'run', ...refusal(err) });
        break;
      }
      await sleep(120);
    }

    const passed = results.filter((r) => r.ok).length;
    const ok = results.every((r) => r.ok);
    const entry = space.history.record({
      suite: plan.suite,
      suiteId: meta.suiteId ?? null,
      caseId: meta.caseId ?? null,
      caseName: meta.caseName ?? null,
      url: plan.steps.find((s) => s.op === 'goto')?.url ?? '',
      ms: results.reduce((a, r) => a + (r.ms ?? 0), 0),
      results,
    });
    space.history.prune(ent.limit('history.retention_days'));
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
    driver.touch(space.org);
    armRelease();
    emit({ t: 'run.end', ok: results.every((r) => r.ok) && results.length > 0, suiteId: meta.suiteId, caseId: meta.caseId, caseName: meta.caseName });
  }
}

/** A refusal, in the shape the UI reads off the socket — the same words as the HTTP status would carry. */
function refusal(err) {
  if (err instanceof tenancy.EntitlementError) return { error: 'entitlement', limit: err.limit, plan: err.plan };
  if (err instanceof tenancy.RunnerBusy) return { error: 'runner_busy', org: err.org };
  if (err instanceof tenancy.Forbidden) return { error: 'forbidden', needs: 'admin' };
  return { error: err.message };
}

// ---------------------------------------------------------------- sockets
/** Live sockets per subject. A fourth closes the oldest [websocket-5]. */
const MAX_SOCKETS_PER_SUB = 3;

wss.on('connection', (ws) => {
  const claims = ws.claims ?? null;
  const org = ws.org;
  const space = tenancy.workspace(org);
  const ent = tenancy.entitlements(claims);
  // Only to this viewer — a refusal is theirs, not the room's.
  const tell = (ev) => { if (ws.readyState === 1) ws.send(JSON.stringify(ev)); };
  /** Say no, in the shape the UI acts on, and in words for the log. */
  const refuse = (of, err) => {
    tell({ t: 'refused', of, ...refusal(err) });
    tell({ t: 'log', level: 'error', msg: err.message });
  };

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
  // Arriving counts as activity: an organisation whose viewer has just
  // connected is not one whose browser should be handed away.
  driver.touch(org);
  armRelease();
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

    /**
     * Every message is authorised against the claims bound at the upgrade,
     * exactly as the HTTP routes are against req.user — never against
     * anything in the message (docs/AUTH.md §9.5 [websocket-2]). The
     * organisation is `org`; whether it may have the browser is the
     * driver's answer; whether it may change origins is its role's; and a
     * socket whose plan has changed under it is closed so the UI comes
     * back with a token that says so.
     */
    if (tenancy.stale(claims)) return void ws.close(4401, 'the plan changed; reconnect with a fresh token');
    driver.touch(org);
    armRelease();

    // The UI says goodbye on sign-out and before a new sign-in, and the
    // socket is dropped at once rather than left to time out [session-3].
    // So are the session's other sockets: `sid` is the session, and a
    // session that signed out in one tab has signed out in all of them.
    if (m.t === 'bye') {
      ws.close(1000, 'bye');
      if (claims?.sid) {
        for (const c of clients) if (c !== ws && c.claims?.sid === claims.sid) c.close(4403, 'signed out');
      }
      return;
    }

    if (m.t === 'command') {
      let plan;
      try {
        // Two front ends, one IR: the line DSL and the mermaid flow language
        // meet at validate() and the executor never learns which was typed.
        const isFlow = /\b(testcase|flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/.test(m.text) || /-{2,3}>/.test(m.text);
        plan = validate(isFlow ? flatten(parseFlow(m.text)) : parse(m.text), { origins: space.origins });
      } catch (err) {
        emitTo(org, { t: 'log', level: 'error', msg: err.message });
        // An origin the script needs is a decision waiting for a person, not a
        // dead end. Offer the button rather than a sentence about where to
        // find one.
        if (err.origin) emitTo(org, { t: 'needs.origin', origin: err.origin, url: err.url });
        return;
      }
      // The plan before the lock, the same order the HTTP routes use: a script
      // that cannot even be read never takes the browser from whoever has it.
      try { await take(org); } catch (err) { return refuse('command', err); }
      // Draw the plan before running it, so a diagram exists even if step 0
      // fails. The run replaces it with the outcome version. Addressed to the
      // asking organisation by name rather than through `emit`, which follows
      // the lock — and the lock is only just this organisation's.
      emitTo(org, { t: 'diagram', kind: 'plan', mermaid: toMermaid(plan) });
      // Deliberately not awaited — the socket must stay responsive while a run
      // is in flight. But an un-awaited promise that rejects is an unhandled
      // rejection, and Node kills the process for those: one unexpected throw
      // inside a step and the whole runner disappeared, which from the browser
      // looks exactly like "Run script does nothing".
      run(plan, { pace: paceOf(m.pace, PACE), space, ent }).catch((err) => {
        emitTo(org, { t: 'log', level: 'error', msg: `run failed: ${err.message}` });
        emitTo(org, { t: 'run.end', ok: false });
      });
      return;
    }

    // Point the browser anywhere the allowlist permits, then ask the page
    // what it can be told to do. This is what makes an unseen URL scriptable.
    if (m.t === 'open') {
      let url;
      try {
        url = normalizeUrl(m.url).href;   // "acme.com" is a host, not a path
      } catch (err) {
        return emitTo(org, { t: 'log', level: 'error', msg: err.message });
      }
      if (!space.origins.has(new URL(url).origin)) {
        // Offer the one thing that unblocks it, rather than an error that
        // ends in "restart with an env var".
        return emitTo(org, { t: 'needs.origin', origin: new URL(url).origin, url });
      }
      // The allowlist before the lock, so an address this organisation may not
      // open does not cost the current driver its browser.
      try { await take(org); } catch (err) { return refuse('open', err); }
      if (running) return;
      try {
        await OPS.goto(page, { url }, { cursor, emit, nav, onNavigate: publishTargets, origins: space.origins });
        emit({ t: 'log', level: 'info', msg: `opened ${url}` });
      } catch (err) {
        emit({ t: 'log', level: 'error', msg: err.message });
      }
      return;
    }

    // Allowing an origin is a human act, through the UI — an owner's or an
    // admin's, and, identical to POST /api/origins, one with a recent
    // authentication and room left on the plan. No plan can reach it.
    if (m.t === 'origin.add') {
      try { tenancy.requireManager(claims); } catch (err) { return refuse('origin.add', err); }
      if (!steppedUp(claims)) {
        tell({ t: 'refused', of: 'origin.add', error: 'step_up_required' });
        tell({ t: 'log', level: 'error', msg: 'allowing an origin needs a recent sign-in — sign in again and retry' });
        return;
      }
      try {
        const r = space.origins.add(m.origin,
          () => ent.check('origins.max', space.origins.list().length));
        emitTo(org, { t: 'origins', origins: space.origins.list() });
        emitTo(org, { t: 'log', level: 'info',
               msg: `${r.added ? 'allowed' : 'already allowed'} ${r.origin}` +
                    (r.private ? ' — private address, allowed by name' : '') });
        if (m.thenOpen) ws.send(JSON.stringify({ t: 'reopen', url: m.thenOpen }));
      } catch (err) {
        refuse('origin.add', err);
      }
      return;
    }
    if (m.t === 'origin.remove') {
      try {
        tenancy.requireManager(claims);
        space.origins.remove(m.origin);
        emitTo(org, { t: 'origins', origins: space.origins.list() });
      } catch (err) {
        refuse('origin.remove', err);
      }
      return;
    }
    if (m.t === 'secrets.reload') {
      // Names only, and only to the socket that asked: the greeting never
      // carries them, and neither does anyone else's socket [websocket-3].
      try { tenancy.requireManager(claims); } catch (err) { return refuse('secrets.reload', err); }
      tell({ t: 'secrets', secrets: space.vault.reload() });
      return;
    }

    // The canvas asks for a picture. Frames are damage-driven, so a viewer that
    // arrives while the page is sitting still has nothing to show and no reason
    // to expect anything — this is how it gets the current one. Only ever the
    // driving organisation's picture, to the driving organisation.
    if (m.t === 'frame.request') {
      if (driver.sees(org) && lastFrame && ws.readyState === 1) ws.send(lastFrame, { binary: true });
      return;
    }

    // Everything below acts on the page that is open, so it is the driving
    // organisation's to do. A person's mouse moving over a busy runner is
    // dropped without a word — the notice on their screen already says why —
    // and the deliberate acts are refused out loud.
    if (!driver.sees(org)) {
      if (/^human\./.test(String(m.t))) return;
      if (['inspect', 'record.start', 'record.stop'].includes(m.t)) {
        return refuse(m.t, driver.org ? new tenancy.RunnerBusy(driver.org) : new Error('Nothing is open yet — open a URL first'));
      }
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
  // prime the viewer with the last one we held rather than leaving it black —
  // if the page is theirs to see. The greeting carries the driven URL and the
  // origins of THIS organisation, and never the vault's key names: those come
  // from GET /api/state under the token [websocket-3] [authz-tenancy-4].
  const mine = driver.sees(org);
  if (mine && lastFrame) ws.send(lastFrame, { binary: true });
  ws.send(JSON.stringify({
    t: 'ready',
    url: mine ? currentUrl() : null,
    // The executor's real state. Without this a socket that reconnected during
    // a run kept a disabled Run button until someone reloaded the page.
    running: mine && running,
    recording: mine && (recorder?.recording ?? false),
    origins: space.origins.list(),
    org,
    driving: driver.describe(org),
  }));
  if (mine) publishTargets();
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
