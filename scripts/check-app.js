/**
 * The one command that starts everything.
 *
 *   node scripts/check-app.js        (no server needed)
 *
 * Two services and a UI from another repository have to come up together, and
 * the ways that goes wrong are quiet ones: the runner is handed the private
 * key, or the wrong public one, so it can mint or refuses every token; the UI
 * was built without knowing where to sign in, so the login screen never
 * appears; a stray flag is ignored rather than refused, so `--fast` silently
 * does nothing.
 *
 * None of that shows up as an error. It shows up as "I signed in and it did not
 * work", half an hour later. So the composition is a pure function and this
 * pins it, rather than testing it by starting three servers and looking.
 *
 * The UI half of that changed shape with the split rather than going away. The
 * script cannot build the app any more, so what is pinned here is what it says
 * about a build it was handed — including the case it can no longer prevent,
 * where the bundle and the runner disagree about whether there is a sign-in.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, envFor, choosePython, uiNote } from './app.js';

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
if (moved.uiBuild.VITE_AUTH_URL === 'http://localhost:8100') ok('and the UI is expected to point at the real one', moved.uiBuild.VITE_AUTH_URL);
else bad('and the UI is expected to point at the real one', String(moved.uiBuild.VITE_AUTH_URL));
if (moved.runner.GC_AUTH_ORIGIN === 'http://localhost:8100') ok('and the runner lets the UI connect to it', 'GC_AUTH_ORIGIN, for the CSP');
else bad('and the runner lets the UI connect to it', String(moved.runner.GC_AUTH_ORIGIN));

/**
 * A laptop with a login is still a laptop: the apps on localhost are what
 * there is to drive, so --auth turns the private-address block off by name —
 * the one thing a deployed runner turns on with the gate that a laptop must
 * not. It does not serve the bundled demo site any more: that was the fallback
 * the console kept landing on, so GC_DEMO is left for a shell to set on purpose.
 */
if (on.runner.GC_BLOCK_PRIVATE === '0' && on.runner.GC_DEMO === undefined) ok('--auth drives localhost, without the demo site', 'GC_BLOCK_PRIVATE=0 by name, and no GC_DEMO');
else bad('--auth drives localhost, without the demo site', JSON.stringify({ GC_DEMO: on.runner.GC_DEMO, GC_BLOCK_PRIVATE: on.runner.GC_BLOCK_PRIVATE }));

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
if (offEnv.uiBuild.VITE_AUTH_URL === undefined) ok('so the UI is expected to have no sign-in', 'a plain `npm run build` over there');
else bad('so the UI is expected to have no sign-in', String(offEnv.uiBuild.VITE_AUTH_URL));

/**
 * And neither mode invents a GC_WEB_DIR.
 *
 * This used to point the runner at a machine-local auth build, because the
 * committed web/dist had to survive --auth. There is no build here to make or
 * to protect now, and a directory guessed on this side could only be a guess
 * at where the other repository's output landed. A guess that happens to
 * exist is the bad case: it serves a stale app rather than saying anything.
 * The operator's own value is passed through, resolved, in main().
 */
const invented = [on, offEnv].filter((e) => e.runner.GC_WEB_DIR !== undefined);
if (!invented.length) ok('and neither mode invents a GC_WEB_DIR', 'the operator names the build; this never guesses');
else bad('and neither mode invents a GC_WEB_DIR', String(invented[0].runner.GC_WEB_DIR));

// --fast is a build-time nothing and a runtime everything.
if (envFor(parseArgs(['--fast']), '').runner.GC_PACE_MS === '0') ok('--fast reaches the runner', 'GC_PACE_MS=0');
else bad('--fast reaches the runner', JSON.stringify(envFor(parseArgs(['--fast']), '').runner.GC_PACE_MS));
if (envFor(parseArgs([]), '').runner.GC_PACE_MS === undefined) ok('and is absent otherwise', 'the server default stands');
else bad('and is absent otherwise', 'a default was invented');

// ---------------------------------------------------------------------------
console.log('\n— what it says about somebody else’s build ————————————');

/**
 * The failure the split created, and the only one on this list that cannot be
 * PREVENTED from here — only noticed.
 *
 * VITE_AUTH_URL is baked into the bundle by whoever ran the build in the UI
 * repository, so a runner started with --auth against a bundle built without
 * it gets a UI that shows the console, calls /api, is refused on every call
 * and offers no way to sign in. Nothing errors; the two halves were simply
 * never told the same thing. So the bytes are read and the mismatch is said
 * out loud, in both directions.
 */
const AUTH_AT = 'http://localhost:8000';
const withLogin = `import{c}from"./x.js";const A="${AUTH_AT}";`;
const withoutLogin = 'import{c}from"./x.js";const A="";';

if (uiNote(withLogin, AUTH_AT).level === 'ok') ok('a build that names the control plane is fine', AUTH_AT);
else bad('a build that names the control plane is fine', uiNote(withLogin, AUTH_AT).text);

const missing = uiNote(withoutLogin, AUTH_AT);
if (missing.level === 'warn' && /VITE_AUTH_URL/.test(missing.text)) ok('one that does not is called out', 'and told how to rebuild');
else bad('one that does not is called out', `${missing.level}: ${missing.text}`);

// A build made for another port is the same mistake wearing a disguise, and
// the one a second checkout on --auth-port 8100 produces.
const elsewhere = uiNote(`const A="http://localhost:8100";`, AUTH_AT);
if (elsewhere.level === 'warn') ok('and so is one built for another port', 'the address is baked in, not negotiated');
else bad('and so is one built for another port', elsewhere.text);

/**
 * The reverse, which is quieter and therefore worse: a bundle built FOR a
 * sign-in, served by a runner with no gate. The login screen appears, the
 * login succeeds, and the token comes back to a runner that ignores it — so
 * every account looks like it has the same empty workspace.
 */
const reversed = uiNote(withLogin, undefined);
if (reversed.level === 'warn' && /no gate/.test(reversed.text)) ok('a login against an open runner is called out too', 'it would succeed and be ignored');
else bad('a login against an open runner is called out too', `${reversed.level}: ${reversed.text}`);
if (uiNote(withoutLogin, undefined).level === 'ok') ok('and two halves that agree say nothing', 'no warning to learn to ignore');
else bad('and two halves that agree say nothing', uiNote(withoutLogin, undefined).text);

// ---------------------------------------------------------------------------
console.log('\n— finding a python ————————————————————————————————————');

if (choosePython([{ name: 'python3', ok: false }, { name: 'python', ok: true }]) === 'python') {
  ok('the first one that actually runs wins', 'not the first one named');
} else bad('the first one that actually runs wins');
if (choosePython([{ name: 'python3', ok: false }]) === null) ok('and none is null, not a guess');
else bad('and none is null, not a guess');

// ---------------------------------------------------------------------------
console.log('\n— and it runs ————————————————————————————————————————');

/**
 * A stand-in for the other repository's build, because --setup now insists on
 * one. Two files, which is all the difference between a directory and a build
 * amounts to as far as this side is concerned.
 */
const web = mkdtempSync(join(tmpdir(), 'gc-web-'));
mkdirSync(join(web, 'assets'), { recursive: true });
writeFileSync(join(web, 'assets', 'index-0000000.js'), 'export const build = "elsewhere";\n');
writeFileSync(join(web, 'index.html'),
  '<!doctype html><script type="module" src="/app/assets/index-0000000.js"></script>');

const run = (args, env = {}) => spawnSync(process.execPath, [`${ROOT}scripts/app.js`, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, GC_WEB_DIR: web, ...env } });

const help = run(['--help']);
if (help.status === 0 && /npm run app/.test(help.stdout)) ok('--help explains itself', 'exit 0');
else bad('--help explains itself', `exit ${help.status}`);

const typo = run(['--fastt']);
if (typo.status === 1 && /--fastt/.test(`${typo.stdout}${typo.stderr}`)) ok('a typo is refused by name', 'exit 1');
else bad('a typo is refused by name', `exit ${typo.status} — a misspelled flag was ignored`);

/**
 * No UI, no start — and said before any of the slow work, because the whole
 * value of refusing here rather than at the first page load is that it costs
 * seconds instead of an install, a browser download and a migration.
 *
 * GC_UI_REPO is pinned to a directory that does not exist. Without it this
 * would look for ../poc-qa-stack, and on any machine laid out the way SETUP.md
 * says — which is most of them — that is a real checkout, so the run would
 * build it and succeed, and this assertion would fail for being right.
 */
const noWeb = run(['--setup'], { GC_WEB_DIR: undefined, GC_UI_REPO: join(web, 'no-such-ui-checkout') });
const saidNoWeb = `${noWeb.stdout ?? ''}${noWeb.stderr ?? ''}`;
if (noWeb.status === 1 && /GC_WEB_DIR/.test(saidNoWeb)) ok('without a built UI it refuses by name', 'GC_WEB_DIR, exit 1');
else bad('without a built UI it refuses by name', `exit ${noWeb.status}: ${saidNoWeb.slice(0, 120).replace(/\s+/g, ' ')}`);
if (!/deps|browser|chromium/.test(saidNoWeb)) ok('and refuses before doing any of the slow work', 'seconds, not an install');
else bad('and refuses before doing any of the slow work', 'it installed something first');

// A source tree is the other half of the same mistake: `../poc-qa-stack`
// where `../poc-qa-stack/dist` was meant. It exists, so `existsSync` alone
// would pass it, and it 404s every route.
const notABuild = run(['--setup'], { GC_WEB_DIR: ROOT });
if (notABuild.status === 1 && /index\.html/.test(`${notABuild.stdout}${notABuild.stderr}`)) ok('and a source tree is not a build', 'no index.html in it');
else bad('and a source tree is not a build', `exit ${notABuild.status}`);

/**
 * No GC_WEB_DIR, but a UI checkout to build: the one command for both repos.
 *
 * A stand-in for poc-qa-stack whose build writes dist/index.html and bakes
 * whatever VITE_AUTH_URL it was handed into it. So one run proves two things:
 * the launcher builds the sibling and serves what it built, and it ERASES a
 * sign-in address inherited from the shell when this run has no sign-in —
 * uiNote reads a localhost address back out of the bundle and warns if one
 * survived, which is exactly the stale-login bug a reused build would ship.
 */
const sibling = mkdtempSync(join(tmpdir(), 'gc-ui-repo-'));
mkdirSync(join(sibling, 'node_modules'));   // present, so nothing gets installed
writeFileSync(join(sibling, 'package.json'),
  JSON.stringify({ name: 'stub-ui', private: true, scripts: { build: 'node build.js' } }));
writeFileSync(join(sibling, 'build.js'), [
  "const fs = require('fs');",
  "fs.mkdirSync('dist', { recursive: true });",
  "fs.writeFileSync('dist/index.html', '<!doctype html><title>stub</title><!-- ' + (process.env.VITE_AUTH_URL || 'no sign-in address') + ' -->');",
].join('\n'));
const built = run(['--setup'], { GC_WEB_DIR: undefined, GC_UI_REPO: sibling, VITE_AUTH_URL: 'http://localhost:1234' });
const saidBuilt = `${built.stdout ?? ''}${built.stderr ?? ''}`;
if (built.status === 0 && /built from/.test(saidBuilt)) ok('with no GC_WEB_DIR it builds the UI checkout beside it', 'one command, both repositories');
else bad('with no GC_WEB_DIR it builds the UI checkout beside it', `exit ${built.status}: ${saidBuilt.slice(-220).replace(/\s+/g, ' ')}`);
if (built.status === 0 && /no sign-in/.test(saidBuilt) && !/WARNING/.test(saidBuilt)) ok('and erases a sign-in address inherited from the shell', 'no stale login baked in');
else bad('and erases a sign-in address inherited from the shell', 'VITE_AUTH_URL from the shell leaked into a build with no sign-in');

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
if (/^\s+ui\s+.*gc-web-/m.test(again.stdout ?? '')) ok('and which UI it is about to serve', 'the directory, by name');
else bad('and which UI it is about to serve', (again.stdout ?? '').split('\n').find((l) => l.includes('ui ')) ?? '(said nothing)');

rmSync(web, { recursive: true, force: true });

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — one command, each half of the key on its own side, a UI it is\n'
    + '       pointed at rather than one it builds, a bundle whose sign-in does\n'
    + '       not match the runner’s said out loud, and a typo refused rather\n'
    + '       than ignored.\n');
process.exit(failures ? 1 : 0);
