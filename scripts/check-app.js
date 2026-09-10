/**
 * The one command that starts everything.
 *
 *   node scripts/check-app.js        (no server needed)
 *
 * Three projects now have to come up together, and the ways that goes wrong are
 * quiet ones: the runner is handed the private key, or the wrong public one,
 * so it can mint or refuses every token; the UI is built without knowing where
 * to sign in, so the login screen never appears; a stray flag is ignored
 * rather than refused, so `--fast` silently does nothing.
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
console.log('\n— each half is handed its own half of the key —————————');

/**
 * THE thing that goes wrong. The control plane signs with the private key and
 * the runner verifies with the public one, and if the runner were handed the
 * private key it could mint — while a public set that was not made from that
 * private key makes every token a "bad signature", which reads as a broken
 * login rather than a mismatched key.
 */
const KEYS = { privatePem: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2Vw…\n-----END PRIVATE KEY-----\n',
               publicKeys: { 'kid-1': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2Vw…\n-----END PUBLIC KEY-----\n' } };
const on = envFor(parseArgs(['--auth']), KEYS);
if (on.control.GC_SIGNING_KEY === KEYS.privatePem) ok('the control plane is handed the private key');
else bad('the control plane is handed the private key', String(on.control.GC_SIGNING_KEY).slice(0, 30));
if (on.runner.GC_AUTH_PUBLIC_KEYS === JSON.stringify(KEYS.publicKeys)) ok('and the runner the public set', 'kid-1');
else bad('and the runner the public set', String(on.runner.GC_AUTH_PUBLIC_KEYS).slice(0, 30));
const leaked = Object.entries(on.runner).filter(([, v]) => v !== undefined && /PRIVATE KEY/.test(String(v)));
if (!leaked.length) ok('and never the private key, nor the old shared secret');
else bad('and never the private key, nor the old shared secret', leaked.map(([k]) => k).join(', '));
/**
 * Absent is not enough, because the runner is spawned with
 * { ...process.env, ...env.runner }: a name this map does not mention is
 * INHERITED from whatever the operator has exported. So the two signing-key
 * names must be present here with an undefined value, which is how a variable
 * is removed from a child's environment.
 */
const erased = ['GC_SIGNING_KEY', 'GC_AUTH_SECRET'].filter((k) => !(k in on.runner) || on.runner[k] !== undefined);
if (!erased.length) ok('and an exported one is erased, not inherited', 'GC_SIGNING_KEY, GC_AUTH_SECRET');
else bad('and an exported one is erased, not inherited', `${erased.join(', ')} would reach the runner from the shell`);
if (!('GC_AUTH_SECRET' in on.control)) ok('and the control plane is not handed the old secret either');
else bad('and the control plane is not handed the old secret either');

// The browser refuses a credentialed request answered with '*', so the control
// plane has to be told the UI's origin — and it has to be the port the runner
// is actually on, not the default. The runner needs the same origin for the
// socket's Origin check, and the control plane's origin for its CSP.
const moved = envFor(parseArgs(['--auth', '--port', '3100', '--auth-port', '8100']), KEYS);
if (moved.control.GC_WEB_ORIGIN === 'http://localhost:3100' && moved.runner.GC_WEB_ORIGIN === 'http://localhost:3100') ok('CORS and the socket name the port the UI is really on', moved.control.GC_WEB_ORIGIN);
else bad('CORS and the socket name the port the UI is really on', `${moved.control.GC_WEB_ORIGIN} / ${moved.runner.GC_WEB_ORIGIN}`);
if (moved.build.VITE_AUTH_URL === 'http://localhost:8100') ok('and the UI is built pointing at the real one', moved.build.VITE_AUTH_URL);
else bad('and the UI is built pointing at the real one', String(moved.build.VITE_AUTH_URL));
if (moved.runner.GC_AUTH_ORIGIN === 'http://localhost:8100') ok('and the runner lets the UI connect to it', 'GC_AUTH_ORIGIN, for the CSP');
else bad('and the runner lets the UI connect to it', String(moved.runner.GC_AUTH_ORIGIN));

/**
 * A laptop with a login is still a laptop: the bundled apps on the runner's
 * own port are what there is to drive. So --auth says, by name, that the demo
 * fixtures are served and the private-address block is off — the two things
 * a deployed runner turns on with the gate, and which compose does not set.
 */
if (on.runner.GC_DEMO === '1' && on.runner.GC_BLOCK_PRIVATE === '0') ok('--auth keeps the demo apps drivable', 'GC_DEMO=1 GC_BLOCK_PRIVATE=0, said by name');
else bad('--auth keeps the demo apps drivable', JSON.stringify({ GC_DEMO: on.runner.GC_DEMO, GC_BLOCK_PRIVATE: on.runner.GC_BLOCK_PRIVATE }));

/**
 * Off is off. A key set in the environment with auth disabled would turn the
 * gate on without anyone asking — the runner enables itself purely on the
 * presence of GC_AUTH_PUBLIC_KEYS.
 */
const offEnv = envFor(parseArgs([]), null);
if (!offEnv.runner.GC_AUTH_PUBLIC_KEYS && !offEnv.control.GC_SIGNING_KEY) ok('and without --auth no key is passed at all');
else bad('and without --auth no key is passed at all', 'the gate would turn itself on');
if ('GC_AUTH_PUBLIC_KEYS' in offEnv.runner && offEnv.runner.GC_AUTH_PUBLIC_KEYS === undefined) ok('and one in the shell is erased too', 'the gate cannot turn itself on');
else bad('and one in the shell is erased too', 'an exported GC_AUTH_PUBLIC_KEYS would be inherited');
if (offEnv.runner.GC_DEMO === undefined && offEnv.runner.GC_BLOCK_PRIVATE === undefined) ok('nor a demo or reach flag', 'the laptop defaults stand');
else bad('nor a demo or reach flag');
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
  : '\n  OK — one command, each half of the key on its own side, the UI built\n'
    + '       pointing at the control plane that is actually running, and a typo\n'
    + '       refused rather than ignored.\n');
process.exit(failures ? 1 : 0);
