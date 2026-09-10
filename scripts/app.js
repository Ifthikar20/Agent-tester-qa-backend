/**
 * One command, from a fresh clone to a running application.
 *
 *   node scripts/app.js              the runner, no sign-in     (npm run app)
 *   node scripts/app.js --auth       and the control plane, with sign-in
 *   node scripts/app.js --fast       runs skip the performance
 *   node scripts/app.js --setup      do the first-run work and stop
 *
 * Two services live here — the runner and the Django control plane in auth/ —
 * and getting them up means npm install, a Playwright browser download, pip, a
 * migration, and a signing keypair whose two halves go to two different
 * processes. Every one of those is a step someone can forget, and most of them
 * fail in a way that looks like something else.
 *
 * So this does them, skips the ones already done, and SAYS which is which. A
 * setup script that works silently is one you cannot debug when it does not.
 *
 * The UI is the third thing the application needs and the one thing this
 * cannot do, because it is a different repository now (docs/BOUNDARY.md). It
 * is built there and handed over as a directory in GC_WEB_DIR. That makes it
 * the step most likely to be missing and the least likely to announce itself,
 * so it is checked FIRST — before the install, the download and the migration
 * — and, with --auth, the build is inspected for the one thing that cannot be
 * fixed from this side: whether it was built knowing where to sign in.
 *
 * What it will not do is invent a credential. If the control plane has no
 * accounts it tells you to create one; a script that quietly makes an admin
 * user with a password it chose is a script that has put a login you do not
 * know about on your machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';

// npm and npx are batch files on Windows, and spawn will not run one without
// a shell. This is the whole reason `npm install` from a script fails on Git
// Bash with ENOENT and no explanation.
//
// ONLY those, though. `shell: true` makes Node concatenate the arguments
// unescaped and hand the line to cmd.exe, which then reads its own
// metacharacters out of them — and the probe below is
// `node -e "import('playwright').then(async p => { … })"`, whose `=>` cmd.exe
// takes as an output redirect. That is where the zero-byte file called `{`
// kept appearing in the repository root: the probe was writing its stdout
// into it. It also meant the probe never succeeded on Windows, so every
// `--setup` re-downloaded a browser that was already installed. node and
// python are real executables and need no shell.
const SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);
const runner = (cmd) => ({ command: cmd, shell: WIN && SHIMS.has(cmd) });

/** Run something to completion, inheriting the terminal. */
function sh(cmd, args, opts = {}) {
  const { command, shell } = runner(cmd);
  return spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell, ...opts });
}

/** Run something quietly and hand back what it said. */
function quiet(cmd, args, opts = {}) {
  const { command, shell } = runner(cmd);
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', shell, ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), status: r.status };
}

// ---------------------------------------------------------------- arguments
/**
 * Pure, so the flags can be tested without starting a browser.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    auth: false, fast: false, setupOnly: false, headed: false,
    port: 3000, authPort: 8000, help: false, unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => Number(argv[++i]);
    if (a === '--auth') opts.auth = true;
    else if (a === '--fast') opts.fast = true;
    else if (a === '--setup' || a === '--setup-only') opts.setupOnly = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--port') opts.port = num();
    else if (a === '--auth-port') opts.authPort = num();
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.unknown.push(a);
  }
  return opts;
}

/**
 * The environment each process gets.
 *
 * Pure and exported because this is where the two halves of the keypair go
 * their separate ways: the PRIVATE key reaches the control plane as
 * GC_SIGNING_KEY and nothing else, and the PUBLIC set reaches the runner as
 * GC_AUTH_PUBLIC_KEYS and nothing else. A runner handed the private key is a
 * runner that can mint; a control plane handed nothing cannot; either produces
 * a login screen that cannot log in, which is a bad afternoon to debug and a
 * cheap thing to test.
 *
 * `uiBuild` is the odd one out: it is not an environment for anything this
 * script starts. It is what the OTHER repository must have built with, which
 * this side can state and check but not do. It stays in this function because
 * it is derived from the same ports as the two real environments, and three
 * places deriving the control plane's address is how they come to disagree.
 *
 * @param keys  { privatePem, publicKeys } from keypair(), or null without --auth
 */
export function envFor(opts, keys, base = {}, root = ROOT) {
  const authUrl = `http://localhost:${opts.authPort}`;
  const webOrigin = `http://localhost:${opts.port}`;
  return {
    runner: {
      ...base,
      PORT: String(opts.port),
      // ERASED, not merely absent. The child is spawned with
      // { ...process.env, ...env.runner }, so a developer who exported
      // GC_SIGNING_KEY — or an operator who sourced .env.prod into their
      // shell — would otherwise hand signing material to the process that
      // drives the browser, and this map is where that is decided. An
      // `undefined` value removes the variable from the child's environment
      // rather than passing the string "undefined".
      GC_SIGNING_KEY: undefined,
      GC_AUTH_SECRET: undefined,
      // Same reasoning for the public set with auth off: the runner turns its
      // gate on purely on the presence of GC_AUTH_PUBLIC_KEYS, so one left in
      // the shell would gate a run nobody asked to gate.
      ...(opts.auth ? {} : { GC_AUTH_PUBLIC_KEYS: undefined }),
      ...(opts.auth ? {
        GC_AUTH_PUBLIC_KEYS: JSON.stringify(keys.publicKeys),
        GC_WEB_ORIGIN: webOrigin,
        // The control plane is on another port here, so the UI's CSP has to
        // let it connect there; deployed, both sit behind one origin.
        GC_AUTH_ORIGIN: authUrl,
        // A laptop with a login is still a laptop: the bundled apps on this
        // very port are what there is to drive, so the demo fixtures stay
        // served and the private-address block that production turns on
        // with the gate is turned off here, by name. Neither is set without
        // --auth, where both are already the laptop defaults.
        GC_DEMO: '1',
        GC_BLOCK_PRIVATE: '0',
        // GC_WEB_DIR is deliberately NOT invented here, or anywhere below. It
        // names a build this repository cannot make, so a value chosen here
        // could only be a guess at where somebody else's output landed — and a
        // guess that happens to exist is worse than one that does not, because
        // it serves a stale app instead of saying anything. main() passes the
        // operator's own value through, resolved.
      } : {}),
      ...(opts.fast ? { GC_PACE_MS: '0' } : {}),
      ...(opts.headed ? { HEADED: '1' } : {}),
    },
    control: {
      ...base,
      // The private key, and the key second factors are encrypted with:
      // both the control plane's alone (docs/AUTH.md §12).
      ...(opts.auth ? { GC_SIGNING_KEY: keys.privatePem, GC_MFA_KEY: keys.mfaKey, GC_WEB_ORIGIN: webOrigin } : {}),
      DJANGO_DEBUG: '1',
      DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1,[::1]',
    },
    // What the UI in the other repository must have been built with, and the
    // reason it has to be a build-time fact rather than something set here:
    // VITE_AUTH_URL is baked into the bundle, so the address of the sign-in is
    // decided by whoever ran `npm run build` over there, minutes or weeks ago.
    //
    // Which means turning --auth on and off HERE cannot change the app. A
    // bundle built without it has no login screen at all, and pointing an
    // authenticated runner at that bundle produces a UI that shows the console,
    // fetches /api, and is refused on every call with no way offered to sign
    // in. Nothing is broken; it is just two halves that were never told the
    // same thing. So this is stated, printed at boot, and looked for in the
    // build — see uiNote() below.
    uiBuild: { VITE_AUTH_URL: opts.auth ? authUrl : undefined },
  };
}

/** Which python to use, given what is on this machine. Pure; the probing is not. */
export function choosePython(candidates) {
  return candidates.find((c) => c.ok)?.name ?? null;
}

/**
 * What to say about a UI build, given what is in it. Pure, so the sentences
 * can be tested without a build to look at.
 *
 * `index` is the text of the build's index.html plus the assets it names —
 * everything the browser would load — and `wanted` is the address the sign-in
 * should be at, or undefined when there is no sign-in. VITE_AUTH_URL is baked
 * in literally, so it is either in those bytes or it is not, and that is the
 * one question about someone else's build this side can answer for itself.
 *
 * Never fatal. This is a heuristic about a minified bundle from another
 * repository, and a heuristic that can stop your application from starting is
 * a heuristic you will eventually be forced to work around.
 *
 * @returns {{level: 'ok'|'warn', text: string}}
 */
export function uiNote(index, wanted) {
  const has = (url) => index.includes(url);
  if (!wanted) {
    // The reverse mismatch, and the quieter of the two: a bundle built for a
    // sign-in, served by a runner with no gate. It shows a login screen, the
    // login works, and the token it comes back with is ignored — so every
    // account looks like it has the same empty workspace.
    const baked = index.match(/https?:\/\/[^"'`\s]+?:\d{2,5}/)?.[0];
    return baked && /localhost|127\.0\.0\.1/.test(baked)
      ? { level: 'warn', text: `built with a sign-in at ${baked}, but this runner has no gate — the login will succeed and be ignored (--auth, or rebuild without VITE_AUTH_URL)` }
      : { level: 'ok', text: 'no sign-in, matching this runner' };
  }
  return has(wanted)
    ? { level: 'ok', text: `signs in at ${wanted}` }
    : { level: 'warn', text: `does NOT mention ${wanted} — it was built without VITE_AUTH_URL, or against another port, so no login will appear. Rebuild it: VITE_AUTH_URL=${wanted} npm run build` };
}

/**
 * The built UI, and everything that can be wrong with the way it was named.
 *
 * Checked before anything slow, because the alternative is finding out after
 * the install, the browser download and the migration — and finding out from a
 * blank page rather than from the terminal that is already open.
 */
function webDir(opts) {
  const given = process.env.GC_WEB_DIR;
  if (!given) {
    fail(`GC_WEB_DIR is not set, and the UI is a different repository now.

    Build it there, then point this at the result:

      cd ../poc-qa-stack && npm install && ${opts.auth ? `VITE_AUTH_URL=http://localhost:${opts.authPort} ` : ''}npm run build
      cd -  &&  GC_WEB_DIR=../poc-qa-stack/dist npm run app${opts.auth ? ' -- --auth' : ''}

    Or run the runner with the API and no app:  npm run serve`);
  }
  const dir = resolve(given);
  if (!existsSync(join(dir, 'index.html'))) {
    fail(`GC_WEB_DIR names ${dir}, which has no index.html.\n\n    That is a source tree or an empty directory, not a build. The build is\n    the poc-qa-stack repository's dist/, after \`npm run build\` there.`);
  }
  return dir;
}

/** What the browser would load from a build: index.html and the assets it names. */
function uiBytes(dir) {
  let text = readFileSync(join(dir, 'index.html'), 'utf8');
  for (const m of text.matchAll(/(?:src|href)="([^"]+\.js)"/g)) {
    // A path relative to the build root, which is how vite emits them; anything
    // it cannot read simply contributes nothing, since this only ever adds
    // evidence and never takes any away.
    try { text += readFileSync(join(dir, m[1].replace(/^\/?(app\/)?/, '')), 'utf8'); } catch { /* not on disk */ }
  }
  return text;
}

// ---------------------------------------------------------------- the keypair
const PRIVATE_FILE = join(ROOT, '.ghostclick', 'signing-key.pem');
const PUBLIC_FILE = join(ROOT, '.ghostclick', 'auth-public-keys.json');
const MFA_KEY_FILE = join(ROOT, '.ghostclick', 'mfa-key');
const OLD_SECRET_FILE = join(ROOT, '.ghostclick', 'auth-secret');

/**
 * The key the control plane encrypts authenticator secrets with, kept
 * beside the signing key for the same reason: regenerated on every start it
 * would make every enrolled second factor unreadable, which reads as "my
 * code stopped working". Made by the control plane's own command, 0600,
 * handed to the control plane's process and to no other.
 */
function mfaKey(py) {
  if (existsSync(MFA_KEY_FILE)) {
    const key = readFileSync(MFA_KEY_FILE, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{43}=$/.test(key)) return key;
  }
  const r = quiet(py, ['manage.py', 'mfa_key', '--json'], { cwd: join(ROOT, 'auth'), env: { ...process.env, DJANGO_DEBUG: '1' } });
  if (!r.ok) fail(`could not generate a second-factor key:\n${r.out}`);
  const key = JSON.parse(r.out.trim().split(/\r?\n/).pop()).mfa_key;
  mkdirSync(dirname(MFA_KEY_FILE), { recursive: true });
  writeFileSync(MFA_KEY_FILE, `${key}\n`, { mode: 0o600 });
  return key;
}

/**
 * The keypair executor tokens are signed with, made by the control plane's
 * own command so the kid is derived the one way there is.
 *
 * Generated once and kept in .ghostclick/, which is gitignored — the same place
 * run history lives, for the same reason. Regenerating it on every start would
 * invalidate every token in flight and look like a login that randomly stops
 * working. The private key is 0600 and read by nothing but this script, which
 * hands it to the control plane's process and to no other.
 */
function keypair(py) {
  if (existsSync(PRIVATE_FILE) && existsSync(PUBLIC_FILE)) {
    try {
      const publicKeys = JSON.parse(readFileSync(PUBLIC_FILE, 'utf8'));
      const privatePem = readFileSync(PRIVATE_FILE, 'utf8');
      if (/PRIVATE KEY/.test(privatePem) && Object.keys(publicKeys).length) return { privatePem, publicKeys, made: false };
    } catch { /* unreadable; make a new pair below */ }
  }
  const r = quiet(py, ['manage.py', 'signing_key', '--new', '--json'],
    { cwd: join(ROOT, 'auth'), env: { ...process.env, DJANGO_DEBUG: '1' } });
  if (!r.ok) fail(`could not generate a signing key:\n${r.out}`);
  const made = JSON.parse(r.out.trim().split(/\r?\n/).pop());
  mkdirSync(dirname(PRIVATE_FILE), { recursive: true });
  writeFileSync(PRIVATE_FILE, made.private_pem, { mode: 0o600 });
  writeFileSync(PUBLIC_FILE, `${JSON.stringify(made.public_keys, null, 2)}\n`);
  return { privatePem: made.private_pem, publicKeys: made.public_keys, made: true };
}

// ---------------------------------------------------------------- the steps
const step = (label, detail) => console.log(`  ${label.padEnd(14)}${detail}`);

function nodeModules() {
  if (existsSync(join(ROOT, 'node_modules', 'express'))) return step('deps', 'already installed');
  step('deps', 'installing — this is the slow one, once');
  if (sh('npm', ['install']).status !== 0) fail('npm install failed');
}

function browser() {
  if (process.env.CHROMIUM_PATH) return step('browser', `CHROMIUM_PATH=${process.env.CHROMIUM_PATH}`);
  // Playwright's own check is the honest one: it knows where it put things.
  const probe = quiet('node', ['-e',
    "import('playwright').then(async p => { console.log(p.chromium.executablePath()); })"]);
  if (probe.ok && probe.out && existsSync(probe.out.split('\n').pop().trim())) {
    return step('browser', 'chromium is installed');
  }
  step('browser', 'downloading chromium — also once');
  if (sh('npx', ['playwright', 'install', 'chromium']).status !== 0) {
    fail('could not install chromium — run `npx playwright install chromium` and look at why');
  }
}

function python() {
  const names = WIN ? ['python', 'python3', 'py'] : ['python3', 'python'];
  const probed = names.map((name) => ({ name, ok: quiet(name, ['--version']).ok }));
  const found = choosePython(probed);
  if (!found) fail('no python on PATH, and --auth needs one. Install Python 3.11+ and try again.');
  return found;
}

function django(py) {
  if (quiet(py, ['-c', 'import django, corsheaders']).ok) return step('control plane', 'dependencies present');
  step('control plane', 'installing Django');
  if (sh(py, ['-m', 'pip', 'install', '-r', join('auth', 'requirements.txt')]).status !== 0) {
    fail('pip install failed — a virtualenv is the usual fix on a managed Python');
  }
}

function migrate(py, env) {
  const r = quiet(py, ['manage.py', 'migrate', '--no-input'], { cwd: join(ROOT, 'auth'), env: { ...process.env, ...env } });
  if (!r.ok) fail(`migrate failed:\n${r.out}`);
  step('database', /No migrations to apply/.test(r.out) ? 'up to date' : 'migrated');
}

/** Say how to make an account. Never make one. */
function accounts(py, env) {
  const r = quiet(py, ['manage.py', 'shell', '-c',
    'from django.contrib.auth import get_user_model as G; print(G().objects.count())'],
  { cwd: join(ROOT, 'auth'), env: { ...process.env, ...env } });
  const n = Number((r.out.match(/\d+\s*$/) ?? ['0'])[0]);
  if (n > 0) return step('accounts', `${n} account${n === 1 ? '' : 's'}`);
  step('accounts', 'NONE — you will not be able to sign in until you make one:');
  console.log(`\n      cd auth && ${py} manage.py createsuperuser      it asks for a password; the first sign-in asks for a code, printed in this terminal`);
  console.log('      bash scripts/adduser.sh you@example.com        it generates one; the address counts as verified');
  console.log('      GC_SIGNUP_MODE=open npm run app -- --auth      or sign up at /app/signup — the code is printed here\n');
}

/** Say which build is being served and whether it agrees with --auth. */
function ui(dir, wanted) {
  step('ui', dir);
  const note = uiNote(uiBytes(dir), wanted);
  step('', note.level === 'ok' ? note.text : `WARNING: it ${note.text}`);
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const HELP = `
  ghostclick — one command to run it

    npm run app                  the runner and the UI, no sign-in
    npm run app -- --auth        and the Django control plane, with sign-in
    npm run app -- --fast        runs skip the performance (see GC_PACE_MS)
    npm run app -- --setup       do the first-run work and stop
    npm run app -- --headed      drive a real browser window you can watch
    npm run app -- --port 3100   somewhere else

  The UI is the poc-qa-stack repository. Build it there and name the build:

    GC_WEB_DIR=../poc-qa-stack/dist npm run app -- --auth
`;

// ---------------------------------------------------------------- main
async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void console.log(HELP);
  if (opts.unknown.length) fail(`I do not know ${opts.unknown.join(' ')}.${HELP}`);

  console.log('\n  getting ready\n');
  // First, because it is the one step this repository cannot do for you and
  // the one whose absence would otherwise be discovered from a blank page.
  const web = webDir(opts);
  nodeModules();
  browser();

  let py = null;
  let keys = null;
  if (opts.auth) {
    // Django first: the keypair is made by its own management command, so
    // that the kid is derived exactly the way the control plane derives it.
    py = python();
    django(py);
    keys = keypair(py);
    keys.mfaKey = mfaKey(py);
  }
  const env = envFor(opts, keys);

  if (opts.auth) {
    migrate(py, env.control);
    accounts(py, env.control);
    step('signing key', keys.made
      ? `generated, kept in .ghostclick/signing-key.pem (private) and auth-public-keys.json (${Object.keys(keys.publicKeys).join(', ')})`
      : `kept — kid ${Object.keys(keys.publicKeys).join(', ')}`);
    // The runner enforces the plan (docs/AUTH.md §10), and a personal
    // organisation starts on `free`, which has no vault — so the bundled
    // demo's sign-in flow, which reads $QA_PASS, is refused with a 402
    // until the organisation is moved to a plan that has one. Said here,
    // because from the console it reads as a step that failed.
    step('plans', 'every personal organisation starts on free (3 suites, 2 origins, no vault); move it to team in /admin/ to run the demo sign-in flow');
    if (existsSync(OLD_SECRET_FILE)) {
      step('', '.ghostclick/auth-secret is the old shared HMAC secret; nothing reads it now, delete it');
    }
  }
  ui(web, env.uiBuild.VITE_AUTH_URL);

  if (opts.setupOnly) return void console.log('\n  setup done — `npm run app` to start it.\n');

  const children = [];
  const stopAll = () => {
    for (const c of children) { try { c.kill(WIN ? undefined : 'SIGTERM'); } catch { /* already gone */ } }
  };
  process.on('SIGINT', () => { stopAll(); process.exit(0); });
  process.on('SIGTERM', () => { stopAll(); process.exit(0); });

  if (opts.auth) {
    const { command, shell } = runner(py);
    const control = spawn(command, ['manage.py', 'runserver', String(opts.authPort), '--noreload'], {
      cwd: join(ROOT, 'auth'), stdio: ['ignore', 'pipe', 'pipe'], shell,
      env: { ...process.env, ...env.control },
    });
    // Its own log would drown the runner's, so only its problems are shown.
    control.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line && !/^\[|Watching for file changes|Quit the server|System check|Django version|Starting development/.test(line)) {
        console.error(`  control plane: ${line}`);
      }
    });
    // Its stdout is the mail. On a laptop the control plane's mail backend
    // is the console, so every sign-up code, invitation and reset link is
    // printed here — and nowhere else, which is why it cannot be dropped.
    control.stdout.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.log(`  control plane: ${line}`);
    });
    children.push(control);
    console.log(`\n  control plane  ->  http://localhost:${opts.authPort}/admin/  (sign-in at /app/login; its mail prints here)`);
  }

  // The runner prints its own banner, which is the detailed one. No shell
  // here: node is an executable, not a batch file, and on Windows it usually
  // lives under "Program Files" — a path a shell splits at the space.
  const app = spawn(process.execPath, [join(ROOT, 'scripts', 'start.js')], {
    // GC_WEB_DIR resolved: the child's cwd is the repository root, not the
    // shell's, so `GC_WEB_DIR=../poc-qa-stack/dist npm run app` from a
    // subdirectory would otherwise resolve against a different directory than
    // the one the person was looking at when they typed it.
    cwd: ROOT, stdio: 'inherit', shell: false, env: { ...process.env, ...env.runner, GC_WEB_DIR: web },
  });
  children.push(app);
  app.on('exit', (code) => { stopAll(); process.exit(code ?? 0); });
}

// Only when run, not when a check imports the pure helpers above.
if (process.argv[1] && process.argv[1].endsWith(join('scripts', 'app.js'))) {
  await main(process.argv.slice(2));
}
