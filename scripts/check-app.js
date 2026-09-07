/**
 * The one command that starts everything.
 *
 *   node scripts/check-app.js        (no server needed)
 *
 * Three projects now have to come up together, and the ways that goes wrong are
 * quiet ones: the runner and the control plane are handed different secrets, so
 * every token is refused; the UI is built without knowing where to sign in, so
 * the login screen never appears; a stray flag is ignored rather than refused,
 * so `--fast` silently does nothing.
 *
 * None of that shows up as an error. It shows up as "I signed in and it did not
 * work", half an hour later. So the composition is a pure function and this
 * pins it, rather than testing it by starting three servers and looking.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, envFor, choosePython, authBuildDir } from './app.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };

// ---------------------------------------------------------------------------
console.log('\n— the flags mean what they say ————————————————————————');

const plain = parseArgs([]);
if (!plain.auth && !plain.fast && plain.port === 3000 && plain.authPort === 8000) {
  ok('no arguments is the runner on 3000', 'no sign-in, no changes');
} else bad('no arguments is the runner on 3000', JSON.stringify(plain));

const full = parseArgs(['--auth', '--fast', '--headed', '--port', '3100', '--auth-port', '8100']);
const wanted = { auth: true, fast: true, headed: true, port: 3100, authPort: 8100 };
const off = Object.entries(wanted).filter(([k, v]) => full[k] !== v);
if (!off.length) ok('and every flag is read', '--auth --fast --headed --port --auth-port');
else bad('and every flag is read', JSON.stringify(off));

/**
 * A typo must be refused, not ignored.
 *
 * `--fastt` silently doing nothing is the worst outcome: you conclude the
 * feature does not work rather than that you misspelled it.
 */
if (parseArgs(['--fastt']).unknown.join() === '--fastt') ok('a flag it does not know is kept, to refuse');
else bad('a flag it does not know is kept, to refuse', JSON.stringify(parseArgs(['--fastt'])));

// ---------------------------------------------------------------------------
console.log('\n— both halves are handed the same secret ——————————————');

/**
 * THE thing that goes wrong. The runner verifies with GC_AUTH_SECRET and the
 * control plane signs with it, and if the two ever differ every token is a
 * "bad signature" — which reads as a broken login, not a mismatched key.
 */
const SECRET = 'x'.repeat(48);
const on = envFor(parseArgs(['--auth']), SECRET);
if (on.runner.GC_AUTH_SECRET === SECRET && on.control.GC_AUTH_SECRET === SECRET) {
  ok('the runner and the control plane share one key');
} else {
  bad('the runner and the control plane share one key',
    `runner=${String(on.runner.GC_AUTH_SECRET).slice(0, 8)} control=${String(on.control.GC_AUTH_SECRET).slice(0, 8)}`);
}

// The browser refuses a credentialed request answered with '*', so the control
// plane has to be told the UI's origin — and it has to be the port the runner
// is actually on, not the default.
const moved = envFor(parseArgs(['--auth', '--port', '3100', '--auth-port', '8100']), SECRET);
if (moved.control.GC_WEB_ORIGIN === 'http://localhost:3100') ok('CORS names the port the UI is really on', moved.control.GC_WEB_ORIGIN);
else bad('CORS names the port the UI is really on', String(moved.control.GC_WEB_ORIGIN));
if (moved.build.VITE_AUTH_URL === 'http://localhost:8100') ok('and the UI is built pointing at the real one', moved.build.VITE_AUTH_URL);
else bad('and the UI is built pointing at the real one', String(moved.build.VITE_AUTH_URL));

/**
 * Off is off. A secret in the environment with auth disabled would turn the
 * gate on without anyone asking — the runner enables itself purely on the
 * presence of GC_AUTH_SECRET.
 */
const offEnv = envFor(parseArgs([]), SECRET);
if (!offEnv.runner.GC_AUTH_SECRET && !offEnv.control.GC_AUTH_SECRET) ok('and without --auth no key is passed at all');
else bad('and without --auth no key is passed at all', 'the gate would turn itself on');
if (offEnv.build.VITE_AUTH_URL === '') ok('so the UI is built with no sign-in', 'VITE_AUTH_URL=""');
else bad('so the UI is built with no sign-in', String(offEnv.build.VITE_AUTH_URL));

/**
 * The committed build must survive --auth.
 *
 * web/dist is in git, which is why `npm start` needs no bundler. An auth build
 * bakes VITE_AUTH_URL into the bundle, so building into web/dist would commit a
 * UI that demands a login at localhost:8000 on whichever machine last ran
 * --auth. It builds, it runs, it works there — and it is broken for everyone
 * who pulls it, with nothing to say so.
 */
const authDir = authBuildDir('/repo');
if (!authDir.includes(`${'web'}/dist`) && authDir.includes('.ghostclick')) {
  ok('an auth build lands outside the committed one', authDir.replace('/repo/', ''));
} else bad('an auth build lands outside the committed one', authDir);
if (on.runner.GC_WEB_DIR && on.runner.GC_WEB_DIR.includes('.ghostclick')) {
  ok('and the runner is pointed at it', 'GC_WEB_DIR');
} else bad('and the runner is pointed at it', String(on.runner.GC_WEB_DIR));
if (offEnv.runner.GC_WEB_DIR === undefined) ok('while without --auth nothing moves', 'the committed build is served');
else bad('while without --auth nothing moves', String(offEnv.runner.GC_WEB_DIR));

// --fast is a build-time nothing and a runtime everything.
if (envFor(parseArgs(['--fast']), '').runner.GC_PACE_MS === '0') ok('--fast reaches the runner', 'GC_PACE_MS=0');
else bad('--fast reaches the runner', JSON.stringify(envFor(parseArgs(['--fast']), '').runner.GC_PACE_MS));
if (envFor(parseArgs([]), '').runner.GC_PACE_MS === undefined) ok('and is absent otherwise', 'the server default stands');
else bad('and is absent otherwise', 'a default was invented');

// ---------------------------------------------------------------------------
console.log('\n— finding a python ————————————————————————————————————');

if (choosePython([{ name: 'python3', ok: false }, { name: 'python', ok: true }]) === 'python') {
  ok('the first one that actually runs wins', 'not the first one named');
} else bad('the first one that actually runs wins');
if (choosePython([{ name: 'python3', ok: false }]) === null) ok('and none is null, not a guess');
else bad('and none is null, not a guess');

// ---------------------------------------------------------------------------
console.log('\n— and it runs ————————————————————————————————————————');

const run = (args) => spawnSync(process.execPath, [`${ROOT}scripts/app.js`, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 120000 });

const help = run(['--help']);
if (help.status === 0 && /npm run app/.test(help.stdout)) ok('--help explains itself', 'exit 0');
else bad('--help explains itself', `exit ${help.status}`);

const typo = run(['--fastt']);
if (typo.status === 1 && /--fastt/.test(`${typo.stdout}${typo.stderr}`)) ok('a typo is refused by name', 'exit 1');
else bad('a typo is refused by name', `exit ${typo.status} — a misspelled flag was ignored`);

/**
 * Idempotent, and provably so: the second run must be as clean as the first.
 * A setup step that only works once is one that fails on everybody's machine
 * except the one it was written on.
 */
const first = run(['--setup']);
const again = run(['--setup']);
if (first.status === 0 && again.status === 0) ok('--setup is safe to run twice', 'both exit 0');
else bad('--setup is safe to run twice', `first=${first.status} second=${again.status}\n${(again.stdout ?? '') + (again.stderr ?? '')}`.slice(0, 300));
if (/already installed/.test(again.stdout ?? '')) ok('and says what it skipped', 'rather than working silently');
else bad('and says what it skipped', 'no idea what it did');

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — one command, the same key on both sides, the UI built pointing at\n'
    + '       the control plane that is actually running, and a typo refused\n'
    + '       rather than ignored.\n');
process.exit(failures ? 1 : 0);
