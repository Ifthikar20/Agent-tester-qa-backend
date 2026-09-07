/**
 * One command, from a fresh clone to a running application.
 *
 *   node scripts/app.js              the runner, no sign-in     (npm run app)
 *   node scripts/app.js --auth       and the control plane, with sign-in
 *   node scripts/app.js --fast       runs skip the performance
 *   node scripts/app.js --setup      do the first-run work and stop
 *
 * There are three projects here now — the runner, the UI in web/, the Django
 * control plane in auth/ — and getting them up meant knowing about npm install,
 * a Playwright browser download, pip, a migration, a shared secret that has to
 * match on two sides, and a UI rebuild with the right variable baked in. Every
 * one of those is a step someone can forget, and most of them fail in a way
 * that looks like something else.
 *
 * So this does them, skips the ones already done, and SAYS which is which. A
 * setup script that works silently is one you cannot debug when it does not.
 *
 * What it will not do is invent a credential. If the control plane has no
 * accounts it tells you to create one; a script that quietly makes an admin
 * user with a password it chose is a script that has put a login you do not
 * know about on your machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';

// npm, npx and pip are batch files on Windows, and spawn will not run one
// without a shell. This is the whole reason `npm install` from a script fails
// on Git Bash with ENOENT and no explanation.
const runner = (cmd) => (WIN ? { command: cmd, shell: true } : { command: cmd, shell: false });

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
 * Pure and exported because this is where the two halves agree: the same secret
 * has to reach the runner as GC_AUTH_SECRET and the control plane as its
 * signing key, and the UI has to be BUILT knowing where to sign in. Getting any
 * one of those wrong produces a login screen that cannot log in, which is a bad
 * afternoon to debug and a cheap thing to test.
 */
export function envFor(opts, secret, base = {}, root = ROOT) {
  const authUrl = `http://localhost:${opts.authPort}`;
  const webOrigin = `http://localhost:${opts.port}`;
  const shared = opts.auth ? { GC_AUTH_SECRET: secret, GC_WEB_ORIGIN: webOrigin } : {};
  return {
    runner: {
      ...base, ...shared,
      PORT: String(opts.port),
      // Serve the machine-local build, leaving the committed one untouched.
      ...(opts.auth ? { GC_WEB_DIR: authBuildDir(root) } : {}),
      ...(opts.fast ? { GC_PACE_MS: '0' } : {}),
      ...(opts.headed ? { HEADED: '1' } : {}),
    },
    control: {
      ...base, ...shared,
      DJANGO_DEBUG: '1',
      DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1,[::1]',
    },
    // Baked into the bundle, so it is a BUILD variable, not a runtime one —
    // which is why turning auth on has to rebuild the UI.
    build: { ...base, ...(opts.auth ? { VITE_AUTH_URL: authUrl } : { VITE_AUTH_URL: '' }) },
  };
}

/**
 * Where an auth-enabled build goes, and why it is not web/dist.
 *
 * web/dist is COMMITTED — that is the whole reason `npm start` needs no
 * bundler. Building into it with VITE_AUTH_URL baked in makes the committed
 * bundle demand a login at localhost:8000 on YOUR machine, for everyone who
 * pulls it. Nothing would tell you: it builds, it runs, it works here.
 *
 * So an auth build is machine-local and gitignored, and the runner is POINTED
 * at it — which is precisely what GC_WEB_DIR exists for. Without --auth nothing
 * moves and the committed build is what gets served.
 */
export const authBuildDir = (root) => join(root, '.ghostclick', 'web-auth');

/** Which python to use, given what is on this machine. Pure; the probing is not. */
export function choosePython(candidates) {
  return candidates.find((c) => c.ok)?.name ?? null;
}

// ---------------------------------------------------------------- the secret
const SECRET_FILE = join(ROOT, '.ghostclick', 'auth-secret');

/**
 * The key the runner and the control plane share.
 *
 * Generated once and kept in .ghostclick/, which is gitignored — the same place
 * run history lives, for the same reason. Regenerating it on every start would
 * invalidate every session and look like a login that randomly stops working.
 */
function sharedSecret() {
  if (existsSync(SECRET_FILE)) {
    const kept = readFileSync(SECRET_FILE, 'utf8').trim();
    if (kept.length >= 32) return { secret: kept, made: false };
  }
  const secret = randomBytes(48).toString('base64url');
  mkdirSync(dirname(SECRET_FILE), { recursive: true });
  writeFileSync(SECRET_FILE, `${secret}\n`, { mode: 0o600 });
  return { secret, made: true };
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
  console.log(`\n      cd auth && ${py} manage.py createsuperuser      it asks for a password`);
  console.log('      bash scripts/adduser.sh you@example.com        it generates one\n');
}

function buildUi(env) {
  if (!existsSync(join(ROOT, 'node_modules', 'vite'))) return step('ui', 'vite absent — serving the committed build');
  // Absolute: this runs with cwd=web/, and a relative path would look for
  // web/node_modules/vite, which is not where it is.
  const args = [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'];
  if (env.VITE_AUTH_URL) args.push('--outDir', authBuildDir(ROOT), '--emptyOutDir');
  const r = quiet('node', args, { cwd: join(ROOT, 'web'), env: { ...process.env, ...env } });
  if (!r.ok) fail(`the UI build failed:\n${r.out.split('\n').slice(-12).join('\n')}`);
  step('ui', env.VITE_AUTH_URL
    ? `built to .ghostclick/web-auth — the committed build is untouched`
    : 'built, no sign-in');
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
`;

// ---------------------------------------------------------------- main
async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return void console.log(HELP);
  if (opts.unknown.length) fail(`I do not know ${opts.unknown.join(' ')}.${HELP}`);

  console.log('\n  getting ready\n');
  nodeModules();
  browser();

  const { secret, made } = opts.auth ? sharedSecret() : { secret: '', made: false };
  const env = envFor(opts, secret);

  let py = null;
  if (opts.auth) {
    py = python();
    django(py);
    migrate(py, env.control);
    accounts(py, env.control);
    if (made) step('secret', 'generated, kept in .ghostclick/auth-secret');
  }
  buildUi(env.build);

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
    children.push(control);
    console.log(`\n  control plane  ->  http://localhost:${opts.authPort}/admin/  (sign-in at /auth)`);
  }

  // The runner prints its own banner, which is the detailed one.
  const { command, shell } = runner(process.execPath);
  const app = spawn(command, [join(ROOT, 'scripts', 'start.js')], {
    cwd: ROOT, stdio: 'inherit', shell, env: { ...process.env, ...env.runner },
  });
  children.push(app);
  app.on('exit', (code) => { stopAll(); process.exit(code ?? 0); });
}

// Only when run, not when a check imports the pure helpers above.
if (process.argv[1] && process.argv[1].endsWith(join('scripts', 'app.js'))) {
  await main(process.argv.slice(2));
}
