/**
 * The line between this repository and the UI's, asserted rather than intended.
 *
 *   node scripts/check-boundary.js          (starts its own servers; no npm start needed)
 *
 * This file used to enforce, inside one repository, the separation that is now
 * a repository boundary. Two of its four rules have been taken over by that
 * boundary and are gone from here — "the frontend reads nothing outside web/"
 * and "and writes nothing outside it" are the UI repository's to make, and it
 * cannot break them from over there without breaking its own build. Asserting
 * them here would mean asserting something about files this checkout does not
 * contain, which is a check that passes because it found nothing.
 *
 * What is left is the half the split did NOT make safe, and it is the half
 * worth the servers this file starts:
 *
 *   the runner must still not read UI source   — nothing stops someone adding
 *       vite back to package.json and a `web/` beside it. The pull is real:
 *       "just build it here, it's one dependency", and it is one dependency
 *       until it is a toolchain, and then the two repositories are one again.
 *
 *   the runner must serve whatever it is POINTED at  — the only rule with a
 *       server behind it, because the only way to prove a directory is not
 *       owned is to hand over one that demonstrably is not this repository's
 *       and ask for it over HTTP. A backend that has gone back to owning
 *       `public/app` cannot pass it.
 *
 *   and say so when it is pointed at nothing   — new, and the failure the
 *       split introduced. GC_WEB_DIR is now the single thread holding the
 *       application together and it has no default, so the interesting
 *       question is no longer "which UI" but "what happens with none". A 404
 *       reads as a broken deploy; the answer has to name the variable.
 *
 *   the control plane is still a third project  — and THIS one now has more
 *       teeth than it had, not fewer. auth/ and the runner are still one
 *       repository, so nothing but this check stops the control plane reading
 *       the runner's suites to decide whether an origin is allowed. Two
 *       services with an opinion about the same rule is how a hard gate
 *       becomes advisory, and that is a security property, not a build one.
 *
 * docs/BOUNDARY.md is the prose. This is the part that fails.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every file under a directory, filtered by extension. */
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p, exts, out); }
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** The modules the server actually loads: the .js files at the root. */
const backend = readdirSync(ROOT).filter((f) => f.endsWith('.js')).map((f) => join(ROOT, f));

/** Source with its comments removed — they explain the boundary, they do not cross it. */
const code = (file) => readFileSync(file, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------------------------------------------------------------------------
console.log('\n— the runner reads no UI source ——————————————————————');

/**
 * A `web/` path in a module the server loads is a repository that cannot start
 * on its own. `web/dist` is not an exception any more — there is no such
 * directory here, and naming one would be naming a build this repository
 * cannot produce.
 *
 * scripts/ is deliberately not scanned: it is the development harness, it is
 * never imported by the server, and this very file mentions the UI throughout.
 */
let reaches = 0;
for (const file of backend) {
  for (const hit of code(file).matchAll(/['"`][^'"`]*\bweb\/[^'"`]*['"`]/g)) {
    reaches++;
    bad('a server module names UI source', `${relative(ROOT, file)}: ${hit[0]}`);
  }
}
if (!reaches) ok('no server module names a path under web/', `${backend.length} modules`);

/**
 * And the bundler has not crept back.
 *
 * The source check above passes the moment someone writes `vite build` into a
 * script rather than into a string in a module, so the manifest is checked
 * too: nothing in either dependency set builds a UI, and no script runs one.
 * These names are the ones this repository actually shipped before the split,
 * which is what makes the list a list rather than a guess.
 */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const BUNDLER = /^(vite|vue|vue-router|pinia|tailwindcss|@vitejs\/|@tailwindcss\/)/;
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => BUNDLER.test(d));
if (!deps.length) ok('and nothing in package.json builds one', 'no vite, vue or tailwind');
else bad('and nothing in package.json builds one', deps.join(', '));

const builds = Object.entries(pkg.scripts ?? {}).filter(([, v]) => /\bvite\b|\bwebpack\b|\brollup\b/.test(v));
if (!builds.length) ok('nor does any npm script', `${Object.keys(pkg.scripts ?? {}).length} scripts`);
else bad('nor does any npm script', builds.map(([k]) => k).join(', '));

if (!existsSync(join(ROOT, 'node_modules', 'vite'))) ok('nor is one installed', 'node_modules has no vite');
else bad('nor is one installed', 'node_modules/vite — a dependency was added and not declared');

// ---------------------------------------------------------------------------
console.log('\n— and the control plane is a third project ————————————');

/**
 * auth/ went to its own directory rather than its own repository, so unlike
 * the UI's rules this one is held up by nothing but this check.
 *
 * The temptation is not a build problem, it is the security model: the control
 * plane's pull is to reach INTO the runner — to read suites/, to check the
 * origin allowlist itself, to decide something the executor is supposed to
 * decide. They are joined by one signed token and one HTTP call, and by
 * nothing else.
 */
const AUTH = join(ROOT, 'auth');
if (!existsSync(AUTH)) {
  bad('the control plane is in this checkout', 'auth/ is absent — this repository holds both services');
} else {
  /**
   * What counts as crossing, and what does not.
   *
   * `/auth/login` in a UI is a URL. It is the CORRECT way to reach this
   * service and must not be flagged — an HTTP call between two services is the
   * boundary working, not a breach of it. What matters is a FILE path: an
   * import, or something handed to fs. The first version of this check matched
   * the bare string and failed on five honest lines, which is worse than no
   * check at all, because a check people learn to ignore is one that stops
   * being read on the day it is right.
   */
  const py = walk(AUTH, ['.py']);
  const DOCSTRINGS = /"""[\s\S]*?"""|'''[\s\S]*?'''/g;
  let leaks = 0;
  for (const file of py) {
    // Docstrings explain the boundary — this file's own does — and prose about
    // a path is not a path.
    const src = readFileSync(file, 'utf8').replace(DOCSTRINGS, '').replace(/^\s*#.*$/gm, '');
    for (const hit of src.matchAll(/parent\s*\.\s*parent\s*\.\s*parent|['"]\.\.\/[^'"]*['"]|['"][^'"]*\b(?:suites|\.ghostclick|public)\/[^'"]*['"]/g)) {
      leaks++;
      bad('the control plane reaches into another project', `${relative(ROOT, file)}: ${hit[0].slice(0, 48)}`);
    }
  }
  if (!leaks) ok('auth/ reads nothing outside itself', `${py.length} files`);

  /**
   * And back the other way: the runner must not load the control plane's code.
   *
   * An import specifier, or a path carrying a Python-side extension. `./auth.js`
   * is the runner's own verifier and is a file rather than this directory, so
   * the slash is what decides; `auth/.env` inside an error message is prose
   * telling a person where to put a value, and prose is not a dependency.
   */
  const CROSSINGS = [
    /(?:from|require\s*\(|import\s*\()\s*['"][^'"]*\bauth\/[^'"]*['"]/g,
    /['"][^'"]*\bauth\/[^'"]*\.(?:py|txt|cfg|toml|sqlite3)['"]/g,
  ];
  let named = 0;
  for (const file of backend) {
    for (const re of CROSSINGS) {
      for (const hit of code(file).matchAll(re)) {
        named++;
        bad('the runner loads control-plane code', `${relative(ROOT, file)}: ${hit[0]}`);
      }
    }
  }
  if (!named) ok('and the runner loads no file from auth/', 'joined by a token and a URL');
}

// ---------------------------------------------------------------------------
console.log('\n— the UI is a directory it is pointed at ——————————————');

/**
 * The claim that matters, and the only way to test it is to run one.
 *
 * A UI that is demonstrably NOT this repository's — a temp directory with two
 * files in it — served at /app/ by a server started with GC_WEB_DIR.
 */
const fake = mkdtempSync(join(tmpdir(), 'gc-web-'));
writeFileSync(join(fake, 'index.html'), '<!doctype html><title>not this repo</title><p id=marker>elsewhere</p>');
mkdirSync(join(fake, 'assets'), { recursive: true });
writeFileSync(join(fake, 'assets', 'app-deadbeef.js'), 'export const from = "elsewhere";\n');

/**
 * Two servers on two ports, because the second case is the ABSENCE of the
 * first and one process cannot demonstrate both. HOME_URL is blanked so
 * neither adds an origin to the laptop's allowlist on its way past.
 */
const PORT = Number(process.env.GC_BOUNDARY_PORT) || 8302;
const start = (entry, env) => {
  const child = spawn(process.execPath, [join(ROOT, entry)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME_URL: '', ...env },
  });
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.out += d; });
  return child;
};
const up = async (base) => {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/api/state`).then((r) => r.ok).catch(() => false)) return true;
    await wait(500);
  }
  return false;
};
const stop = async (child) => {
  child.kill('SIGTERM');
  await wait(300);
  child.kill('SIGKILL');
};

const pointed = start('scripts/start.js', { PORT: String(PORT), GC_WEB_DIR: fake });
const BASE = `http://127.0.0.1:${PORT}`;
try {
  if (!await up(BASE)) {
    bad('a server starts against another UI', `no answer on ${PORT}\n${pointed.out.trim().split('\n').slice(-6).join('\n')}`);
  } else {
    const index = await fetch(`${BASE}/app/`);
    const body = await index.text();
    if (body.includes('id=marker')) ok('/app/ serves the directory it was given', 'GC_WEB_DIR');
    else bad('/app/ serves the directory it was given', body.slice(0, 80).replace(/\s+/g, ' '));

    // Client-side routes fall back to that index too, not to a 404 and not to
    // some other repository's index.html.
    const deep = await fetch(`${BASE}/app/suites/abc/cases`).then((r) => r.text());
    if (deep.includes('id=marker')) ok('and every client-side route falls back to it');
    else bad('and every client-side route falls back to it', deep.slice(0, 80).replace(/\s+/g, ' '));

    // The cache rules travel with the directory, or the split quietly costs
    // you the header that makes a UI deploy visible.
    if (/no-cache/.test(index.headers.get('cache-control') ?? '')) ok('index.html is still never cached');
    else bad('index.html is still never cached', index.headers.get('cache-control') ?? '(none)');

    const asset = await fetch(`${BASE}/app/assets/app-deadbeef.js`);
    if (/immutable/.test(asset.headers.get('cache-control') ?? '')) ok('its assets are still cached hard');
    else bad('its assets are still cached hard', asset.headers.get('cache-control') ?? '(none)');

    /**
     * And it reported that UI rather than making one. The wording is not
     * asserted, only that the directory it named is the one it was handed —
     * a start.js that decided to build something would have to name somewhere
     * else to put the result.
     */
    const line = (pointed.out.split('\n').find((l) => l.includes('ui ')) ?? '').trim();
    if (line.includes(fake)) ok('start.js reports the build it was handed', 'and makes none');
    else bad('start.js reports the build it was handed', line || '(said nothing about a ui)');
  }
} finally {
  await stop(pointed);
}

// ---------------------------------------------------------------------------
console.log('\n— and says so when it is pointed at nothing ———————————');

/**
 * The failure the split introduced, and the one an operator will actually hit.
 *
 * With no GC_WEB_DIR there is no UI anywhere on disk to fall back to, so the
 * only question is what the server does about it. Three answers, each of which
 * has been the wrong one somewhere: it must not refuse to start, because the
 * API is the half that does not need a UI; it must not answer a bare 404,
 * which reads as a broken deploy rather than as an unfinished one; and what it
 * does answer has to name the variable, so that it can be acted on without
 * reading this repository.
 *
 * server.js directly, not scripts/start.js, and the difference is the point:
 * `npm start` means "run the application" and refuses without a UI, which is
 * why the case above goes through it. This case is `npm run serve` — the
 * server on its own — and it is the one that has to keep working.
 */
const NOPORT = PORT + 1;
const NOBASE = `http://127.0.0.1:${NOPORT}`;
const blind = start('server.js', { PORT: String(NOPORT), GC_WEB_DIR: undefined });
try {
  if (!await up(NOBASE)) {
    bad('a server with no UI still starts', `no answer on ${NOPORT}\n${blind.out.trim().split('\n').slice(-6).join('\n')}`);
  } else {
    ok('a server with no UI still starts', 'the API is the half that does not need one');
    const r = await fetch(`${NOBASE}/app/`);
    const said = await r.text();
    if (r.status === 503) ok('and /app/ is a 503, not a 404', 'the route exists; the wiring is unfinished');
    else bad('and /app/ is a 503, not a 404', String(r.status));
    if (/GC_WEB_DIR/.test(said)) ok('whose answer names the variable', 'actionable without reading the source');
    else bad('whose answer names the variable', said.slice(0, 80).replace(/\s+/g, ' '));
    const version = await fetch(`${NOBASE}/api/version`).then((v) => v.json());
    if (version.built === null) ok('and /api/version says there is no build', 'rather than stamping a UI nobody is serving');
    else bad('and /api/version says there is no build', JSON.stringify(version.built));
  }
} finally {
  await stop(blind);
  rmSync(fake, { recursive: true, force: true });
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the runner has no bundler and names no UI source, it and the\n'
    + '       control plane share no file in either direction, it serves whatever\n'
    + '       built UI it is pointed at, and with none it says which variable to\n'
    + '       set rather than answering 404.\n');
process.exit(failures ? 1 : 0);
