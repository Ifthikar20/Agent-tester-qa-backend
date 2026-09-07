/**
 * The line between the frontend and the backend, asserted rather than intended.
 *
 *   node scripts/check-boundary.js          (starts its own servers; no npm start needed)
 *
 * They are going to be two repositories. Right now they are two directories,
 * which is the arrangement where a boundary quietly stops existing: an import
 * that reaches one directory up costs nothing and works forever, until the day
 * the directory above is a different repository and the build fails with no
 * clue about when it broke. Every coupling this file checks was a real line of
 * code here a commit ago.
 *
 *   web/vite.config.js wrote its build into public/app/  — the frontend could
 *                      not build without the backend's tree to write into
 *   ConsoleView.vue    imported ../../vocabulary.js       — and could not build
 *                      without the backend's SOURCE beside it
 *   api.js / live.js   assumed the page's own origin      — worked until the UI
 *                      was hosted anywhere the API is not
 *   server.js          hard-coded public/app/index.html   — could serve exactly
 *                      one UI, the one inside its own repository
 *
 * So: the frontend reads nothing outside web/ and writes nothing outside web/;
 * the backend reads nothing under web/ except the built directory it is POINTED
 * at, and that pointing is proved by running a server against a UI that is not
 * this repository's.
 *
 * docs/BOUNDARY.md is the prose. This is the part that fails.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'web');

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const inside = (dir, p) => {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Every file under a directory, filtered by extension. */
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p, exts, out); }
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log('\n— the frontend reads nothing outside web/ —————————————');

/**
 * Relative specifiers only. `vue`, `pinia` and friends are bare and come from
 * node_modules, which every repository has its own of; `@/…` and `@lang` are
 * aliases and are checked against the config below, where they are defined.
 */
const SPEC = /(?:^|[\s;])(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
let escapes = 0;
for (const file of walk(join(WEB, 'src'), ['.js', '.vue'])) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] ?? m[2];
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    if (inside(WEB, target)) continue;
    escapes++;
    bad('a frontend file reaches outside web/', `${relative(ROOT, file)} → ${spec}`);
  }
}
if (!escapes) ok('no relative import climbs out of web/', `${walk(join(WEB, 'src'), ['.js', '.vue']).length} files`);

const config = (await import(pathToFileURL(join(WEB, 'vite.config.js')))).default;
for (const [name, target] of Object.entries(config.resolve?.alias ?? {})) {
  if (inside(WEB, target)) ok(`the ${name} alias resolves inside web/`, relative(ROOT, target));
  else bad(`the ${name} alias resolves inside web/`, `${relative(ROOT, target)} is outside`);
}

// ---------------------------------------------------------------------------
console.log('\n— and writes nothing outside it ——————————————————————');

const outDir = resolve(config.root ?? WEB, config.build?.outDir ?? 'dist');
if (inside(WEB, outDir)) ok('the build lands inside web/', relative(ROOT, outDir));
else bad('the build lands inside web/', `${relative(ROOT, outDir)} is the backend's tree`);

// ---------------------------------------------------------------------------
console.log('\n— the backend never looks at the frontend’s source ————');

/**
 * The modules the server actually loads — the .js files at the root. Those are
 * what the backend repository would contain, so a `web/src` path in one of them
 * is a repository that cannot start on its own.
 *
 * scripts/ is deliberately not scanned. It is the development harness, it is
 * never imported by the server, and it is *supposed* to span both projects:
 * start.js builds the UI, check-freshness.js stats a component to prove the
 * build is not older than its source. `web/dist` is allowed everywhere, since
 * that is the built directory rather than the source.
 */
const backend = readdirSync(ROOT)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(ROOT, f));
let reaches = 0;
for (const file of backend) {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')       // comments explain the boundary; they do not cross it
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const hit of src.matchAll(/['"`][^'"`]*\bweb\/(?!dist\b)[^'"`]*['"`]/g)) {
    reaches++;
    bad('a backend module names the frontend source', `${relative(ROOT, file)}: ${hit[0]}`);
  }
}
if (!reaches) ok('no server module names web/ but the built dir', `${backend.length} modules`);

// ---------------------------------------------------------------------------
console.log('\n— the UI is a directory it is pointed at ——————————————');

/**
 * The claim that matters, and the only way to test it is to run one.
 *
 * A UI that is demonstrably NOT this repository's — a temp directory with one
 * file in it — served at /app/ by a server started with GC_WEB_DIR. A backend
 * that has gone back to owning `public/app` cannot pass this, and no amount of
 * reading the source proves it the way this does.
 */
const fake = mkdtempSync(join(tmpdir(), 'gc-web-'));
writeFileSync(join(fake, 'index.html'), '<!doctype html><title>not this repo</title><p id=marker>elsewhere</p>');
mkdirSync(join(fake, 'assets'), { recursive: true });
writeFileSync(join(fake, 'assets', 'app-deadbeef.js'), 'export const from = "elsewhere";\n');

const PORT = Number(process.env.GC_BOUNDARY_PORT) || 3402;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), GC_WEB_DIR: fake, HOME_URL: '' },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${BASE}/api/state`).then((r) => r.ok).catch(() => false);
    if (!up) await wait(500);
  }
  if (!up) {
    bad('a server starts against another UI', `no answer on ${PORT}\n${out.trim().split('\n').slice(-6).join('\n')}`);
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

    // The cache rules travel with the directory, or the split quietly costs you
    // the header that makes rebuilds visible.
    if (/no-cache/.test(index.headers.get('cache-control') ?? '')) ok('index.html is still never cached');
    else bad('index.html is still never cached', index.headers.get('cache-control') ?? '(none)');

    const asset = await fetch(`${BASE}/app/assets/app-deadbeef.js`);
    if (/immutable/.test(asset.headers.get('cache-control') ?? '')) ok('its assets are still cached hard');
    else bad('its assets are still cached hard', asset.headers.get('cache-control') ?? '(none)');

    // And the backend did not decide to build a frontend it does not own.
    if (/not mine/.test(out)) ok('start.js does not build a UI it was handed', 'GC_WEB_DIR');
    else bad('start.js does not build a UI it was handed', (out.split('\n').find((l) => l.includes('ui ')) ?? '').trim());
  }
} finally {
  child.kill('SIGTERM');
  await wait(300);
  child.kill('SIGKILL');
  rmSync(fake, { recursive: true, force: true });
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — web/ builds and imports entirely within itself, the server\n'
    + '       names no frontend source, and it serves whatever built UI it\n'
    + '       is pointed at. Either half can be lifted into its own repo.\n');
process.exit(failures ? 1 : 0);
