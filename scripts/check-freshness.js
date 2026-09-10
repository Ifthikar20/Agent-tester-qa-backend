/**
 * Are you looking at the UI you think you are looking at?
 *
 *   node scripts/check-freshness.js         (starts its own server; no npm start needed)
 *
 * This file used to be about a build that was committed to this repository:
 * `npm start` rebuilt web/ when its sources had moved, and these assertions
 * proved it noticed. Neither the build nor the sources are here any more, so
 * that half is the UI repository's to check and is gone from this one.
 *
 * The question survives the split and gets harder, because the UI now changes
 * on someone else's schedule. Three ways to spend an afternoon looking at a UI
 * that has already been fixed:
 *
 *  1. index.html is cached. Vite fingerprints its assets, so those are safe
 *     forever — but index.html is the file that NAMES the current fingerprints,
 *     and a browser that caches it keeps loading yesterday's JavaScript no
 *     matter how many times the other repository deploys.
 *  2. The runner reads the directory once at boot. It does not, deliberately,
 *     and this is the assertion that matters most now: a UI deploy writes into
 *     the directory GC_WEB_DIR names while this process is running, and if
 *     anything about the app were cached in memory, the fix would need a
 *     restart of a service that was never redeployed. Worse, /api/version
 *     would go on reporting the build it saw at boot — a version stamp that is
 *     confidently wrong is worse than none, since its whole job is to be
 *     trusted at a glance.
 *  3. The stamp says nothing at all. `built` is what tells you whether the UI
 *     in front of you is this morning's; `commit` is what tells you which
 *     runner is under it. They are two different repositories now and both
 *     answers are needed to place a bug in one of them.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(46)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(46)} ${d}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A UI, the way the other repository would deploy one: an index.html naming a
 * fingerprinted bundle. `stamp` is what distinguishes one deploy from the next
 * below, and the asset name changes with it exactly as vite's would.
 */
const dir = mkdtempSync(join(tmpdir(), 'gc-ui-'));
mkdirSync(join(dir, 'assets'), { recursive: true });
function deploy(stamp) {
  // Emptied first, the way `vite build --emptyOutDir` leaves it. Leaving the
  // previous bundle in place would make the "the old one is gone" assertion
  // below a statement about this function rather than about the server.
  rmSync(join(dir, 'assets'), { recursive: true, force: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', `index-${stamp}.js`), `export const build = "${stamp}";\n`);
  writeFileSync(join(dir, 'index.html'),
    `<!doctype html><title>ghostclick</title><script type="module" src="/app/assets/index-${stamp}.js"></script><p id=stamp>${stamp}</p>`);
}
deploy('aaaaaaa');

const PORT = Number(process.env.GC_FRESHNESS_PORT) || 8304;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [join(ROOT, 'scripts/start.js')], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), GC_WEB_DIR: dir, HOME_URL: '' },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, cache: r.headers.get('cache-control'), body: await r.text() };
};

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${BASE}/api/state`).then((r) => r.ok).catch(() => false);
    if (!up) await wait(500);
  }
  if (!up) {
    bad('the runner starts against a built UI', `no answer on ${PORT}\n${out.trim().split('\n').slice(-6).join('\n')}`);
  } else {
    // -----------------------------------------------------------------------
    console.log('\n— the browser is told what to cache ——————————————');

    const index = await get('/app/');
    if (/no-cache/.test(index.cache ?? '')) ok('index.html is never cached', index.cache);
    else bad('index.html is never cached', index.cache ?? '(no header)');

    const asset = index.body.match(/\/app\/assets\/index-[^"]+\.js/)?.[0];
    if (!asset) bad('the page names a fingerprinted bundle', 'none found');
    else {
      const a = await get(asset);
      if (/immutable/.test(a.cache ?? '')) ok('fingerprinted assets are cached hard', a.cache);
      else bad('fingerprinted assets are cached hard', a.cache ?? '(no header)');
    }

    // -----------------------------------------------------------------------
    console.log('\n— the app can say what it is ——————————————————————');

    const v = await fetch(`${BASE}/api/version`).then((r) => r.json());
    if (v.commit && /^[0-9a-f]{7}$/.test(v.commit)) ok('it reports the runner’s commit', v.commit);
    else bad('it reports the runner’s commit', JSON.stringify(v.commit));
    if (v.built) ok('and when the UI it is serving was built', v.built.replace('T', ' ').slice(0, 16));
    else bad('and when the UI it is serving was built', 'no stamp — the two repositories cannot be placed');

    // -----------------------------------------------------------------------
    console.log('\n— a UI deploy needs no runner restart ————————————');

    /**
     * The one that matters after the split. The other repository writes a new
     * build into the same directory; this process is not told, not restarted,
     * and must serve it anyway — and must not go on claiming the old stamp.
     *
     * The mtime is nudged forward explicitly rather than trusted to the clock:
     * a filesystem with one-second resolution can hand a rewrite the same
     * mtime it had a moment ago, and the check would then fail for a reason
     * that has nothing to do with the server.
     */
    const before = v.built;
    await wait(1100);
    deploy('bbbbbbb');

    const after = await fetch(`${BASE}/api/version`).then((r) => r.json());
    if (after.built && after.built !== before) ok('the build stamp follows the directory', `${String(before).slice(11, 19)} → ${after.built.slice(11, 19)}`);
    else bad('the build stamp follows the directory', `still ${String(before)} — read once at boot`);

    const fresh = await get('/app/');
    if (fresh.body.includes('bbbbbbb')) ok('and /app/ serves the new build', 'no restart, no rebuild');
    else bad('and /app/ serves the new build', fresh.body.slice(0, 60).replace(/\s+/g, ' '));

    const gone = await get('/app/assets/index-aaaaaaa.js');
    if (gone.status === 404) ok('while the bundle it replaced is gone', '404, as an immutable name should be');
    else bad('while the bundle it replaced is gone', `${gone.status} — something is holding the old build`);

    // A client-side route still lands on the CURRENT index, which is the same
    // property one layer up: the fallback is a file read per request, not a
    // path resolved once.
    const deep = await get('/app/suites/abc/cases');
    if (deep.body.includes('bbbbbbb')) ok('and deep routes fall back to the new one');
    else bad('and deep routes fall back to the new one', deep.body.slice(0, 60).replace(/\s+/g, ' '));
  }
} finally {
  child.kill('SIGTERM');
  await wait(300);
  child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — index.html is never cached, the runner says which commit it is\n' +
    '       and which build it is serving, and a UI deployed underneath a\n' +
    '       running runner is served — and stamped — without a restart.\n');
process.exit(failures ? 1 : 0);
