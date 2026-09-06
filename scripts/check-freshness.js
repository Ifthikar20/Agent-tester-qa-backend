/**
 * Are you running what you think you are running?
 *
 *   npm start &
 *   node scripts/check-freshness.js
 *
 * Two ways to spend an afternoon looking at a UI you already fixed:
 *
 *  1. `npm start` served the committed build and never rebuilt, so editing a
 *     component and restarting showed you the old one with no hint anything
 *     was stale.
 *  2. index.html had no cache headers. Vite fingerprints its assets, so those
 *     are safe forever — but index.html is the file that NAMES the current
 *     fingerprints, and a browser that caches it keeps loading yesterday's
 *     JavaScript no matter how many times you pull and rebuild.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };

// ---------------------------------------------------------------------------
console.log('\n— the browser is told what to cache ——————————————');

const head = async (path) => {
  const r = await fetch(`${BASE}${path}`, { method: 'GET' });
  return { status: r.status, cache: r.headers.get('cache-control'), body: await r.text() };
};

const index = await head('/app/');
if (/no-cache/.test(index.cache ?? '')) ok('index.html is never cached', index.cache);
else bad('index.html is never cached', index.cache ?? '(no header)');

const asset = index.body.match(/\/app\/assets\/index-[^"]+\.js/)?.[0];
if (!asset) bad('the page names a fingerprinted bundle', 'none found');
else {
  const a = await head(asset);
  if (/immutable/.test(a.cache ?? '')) ok('fingerprinted assets are cached hard', a.cache);
  else bad('fingerprinted assets are cached hard', a.cache ?? '(no header)');
}

// ---------------------------------------------------------------------------
console.log('\n— the app can say what it is ——————————————————————');

const v = await fetch(`${BASE}/api/version`).then((r) => r.json());
if (v.commit && /^[0-9a-f]{7}$/.test(v.commit)) ok('it reports its commit', v.commit);
else bad('it reports its commit', JSON.stringify(v.commit));
if (v.built) ok('and when the UI was built', v.built.replace('T', ' ').slice(0, 16));
else bad('and when the UI was built', 'the UI is not built');

// The build must actually be newer than the sources it came from, or the stamp
// is reassuring you about the wrong thing.
const src = statSync(`${ROOT}web/src/views/ConsoleView.vue`).mtimeMs;
if (new Date(v.built).getTime() >= src) ok('and the build is not older than its source');
else bad('and the build is not older than its source', 'run npm start');

// ---------------------------------------------------------------------------
console.log('\n— npm start rebuilds only what changed ————————————');

const start = (env = {}) => spawnSync(process.execPath, [`${ROOT}scripts/start.js`],
  { cwd: ROOT, timeout: 25000, encoding: 'utf8', env: { ...process.env, ...env } });

const line = (r) => ((r.stdout ?? '').split('\n').find((l) => l.includes('ui ')) ?? '').split('->')[1]?.trim() ?? '';

const clean = start();
if (/up to date/.test(line(clean))) ok('a start with no changes does not build', line(clean));
else bad('a start with no changes does not build', line(clean) || '(no output)');

// Touch a source file and it must notice.
const target = `${ROOT}web/src/components/StatusPill.vue`;
const now = new Date();
utimesSync(target, now, now);
const dirty = start();
if (/rebuilt/.test(line(dirty))) ok('a changed source triggers a rebuild', line(dirty));
else bad('a changed source triggers a rebuild', line(dirty) || '(no output)');

const again = start();
if (/up to date/.test(line(again))) ok('and then settles again', line(again));
else bad('and then settles again', line(again));

// A checkout with no bundler still runs — refusing to start would be worse.
const skipped = start({ GC_SKIP_BUILD: '1' });
if (/skipped/.test(line(skipped))) ok('and can be told not to', line(skipped));
else bad('and can be told not to', line(skipped));

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the UI rebuilds when its source changes, index.html is never\n' +
    '       cached, and the app tells you which commit it is running.\n');
process.exit(failures ? 1 : 0);
