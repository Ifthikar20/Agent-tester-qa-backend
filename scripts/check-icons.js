/**
 * The first outbound request this backend makes, and its guards.
 *
 *   node scripts/check-icons.js        (starts its own throwaway site)
 *
 * icons.js exists so the sidebar can show each site's own mark. That is a small
 * feature attached to a large change in what this process is allowed to do:
 * until now nothing here fetched anything, and origins.js is the reason —
 * a server that will retrieve a URL you name, from inside a VPC, is the classic
 * shape of an SSRF hole.
 *
 * So the checks below are not about favicons. Every one of them is about the
 * fetcher refusing, and each is written so that reverting the guard it covers
 * turns this file red.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as origins from '../origins.js';
import { refuse, iconFor, iconHref, dataUri, LINK_LOCAL } from '../icons.js';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(52)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(52)} ${d}`); };
const ROOT = fileURLToPath(new URL('../', import.meta.url));

console.log('\n— what it will not fetch ——————————————————————————————');

/**
 * 1 · The allowlist, and the wildcard that would defeat it.
 *
 * origins.has() is `allowed.has(origin) || allowed.has('*')`. Gating on it
 * would mean any deployment that ever set ALLOWED_ORIGINS=* — a reasonable
 * thing to do on a laptop — turns this route into a proxy that fetches whatever
 * the caller names. So membership is tested exactly, and this proves it in a
 * child process because the wildcard can only arrive at boot.
 */
if (refuse('https://not-on-the-list.example')) ok('an origin not on the allowlist is refused');
else bad('an origin not on the allowlist is refused');

const wild = spawnSync(process.execPath, ['-e', `
  import('./icons.js').then(I => {
    console.log(I.refuse('https://evil.example') ? 'REFUSED' : 'FETCHED');
  });
`], { cwd: ROOT, env: { ...process.env, ALLOWED_ORIGINS: '*' }, encoding: 'utf8' });
if (/REFUSED/.test(wild.stdout)) ok('and a wildcard allowlist does not open it', 'ALLOWED_ORIGINS=* stays shut');
else bad('and a wildcard allowlist does not open it', `origins.has() semantics leaked in: ${wild.stdout.trim() || wild.stderr.trim()}`);

/**
 * 2 · Link-local, refused ahead of the allowlist rather than behind it.
 *
 * 169.254.169.254 answers with EC2 credentials. A person can add any origin
 * through the UI, so "it is on the allowlist" must not be enough here — this
 * adds it deliberately and expects the refusal to stand.
 */
if (LINK_LOCAL.test('169.254.169.254')) ok('link-local is recognised', '169.254.0.0/16 and fe80::');
else bad('link-local is recognised');

const IMDS = 'http://169.254.169.254';
origins.add(IMDS);
try {
  if (origins.list().includes(IMDS)) {
    if (refuse(IMDS)) ok('and is refused EVEN WHEN ALLOWLISTED', 'the ordering that matters on EC2');
    else bad('and is refused EVEN WHEN ALLOWLISTED', 'a person could allow the metadata endpoint');
  } else bad('and is refused EVEN WHEN ALLOWLISTED', 'could not stage the test');
} finally { origins.remove(IMDS); }
if (!origins.list().includes(IMDS)) ok('  (test cleaned up after itself)');
else bad('  (test cleaned up after itself)', 'left 169.254.169.254 on the allowlist');

for (const [bad_, why] of [
  ['http://localhost:3000/path', 'a path, not a bare origin'],
  ['file:///etc/passwd', 'a non-http scheme'],
  ['not-a-url', 'not a URL at all'],
]) {
  if (refuse(bad_)) ok(`refuses ${why}`);
  else bad(`refuses ${why}`);
}

console.log('\n— what it does with a reply ————————————————————————————');

/**
 * 3 · A real site, told to misbehave in the three ways that matter.
 *
 * Serving these from a throwaway server rather than mocking the fetch: the cap
 * has to hold against a body that keeps coming, and that is only true if it is
 * enforced while reading rather than from content-length, which the other end
 * chooses.
 */
/** A different origin, reachable and serving a perfectly good icon. */
const other = createServer((_req, res) => {
  other.hits++;
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
});
other.hits = 0;
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const ELSEWHERE = `http://127.0.0.1:${other.address().port}`;

const site = createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    // Counted for EVERY mode, not just the successful one. Counting only the
    // hits that returned an image made the negative-cache assertion vacuous:
    // a miss incremented nothing, so removing the cache changed no number.
    site.hits++;
    if (site.mode === 'huge') {
      // No content-length: Node would enforce it and truncate the body, so the
      // cap would never be the thing that stopped this. Chunked is also the
      // honest case — a server that lies about its length.
      res.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.alloc(64 * 1024, 0);
      for (let i = 0; i < 12; i++) res.write(chunk);      // 768 KB against a 256 KB cap
      return res.end();
    }
    if (site.mode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>not an icon</html>');
    }
    if (site.mode === 'away') {
      // Pointed at a server that really is there and really does return a
      // valid icon. Redirecting to something unreachable would let this pass
      // because the fetch failed, not because the guard held — which is what
      // the first version of this file did.
      res.writeHead(302, { location: `${ELSEWHERE}/favicon.ico` });
      return res.end();
    }
    if (site.mode === 'good') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
    }
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><head><title>t</title></head></html>');
});
site.hits = 0;
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;
origins.add(ORIGIN);

/**
 * Each case needs a COLD cache, and the cache is on disk and keyed by origin.
 * Stepping the clock past the TTL between cases is how a case gets to make its
 * own request instead of reading the previous case's answer — the first draft
 * of this file did not, and three guards silently tested nothing.
 */
const TTL = 7 * 24 * 3600 * 1000;
let clock = Date.now();
const fresh = () => (clock += TTL + 1000);

try {
  site.mode = 'huge';
  const huge = await iconFor(ORIGIN, { now: fresh() }).catch(() => 'threw');
  if (huge === null) ok('a body over the cap is dropped', '768 KB against a 256 KB limit');
  else bad('a body over the cap is dropped', `got ${huge === 'threw' ? 'a throw' : huge?.body?.length + ' bytes'}`);

  site.mode = 'html';
  const html = await iconFor(ORIGIN, { now: fresh() }).catch(() => 'threw');
  if (html === null) ok('a non-image reply is not served as one', 'content-type is checked');
  else bad('a non-image reply is not served as one');

  site.mode = 'away';
  other.hits = 0;
  const away = await iconFor(ORIGIN, { now: fresh() }).catch(() => 'threw');
  if (away === null && other.hits === 0) ok('a redirect off-origin is not followed', 'the other host was never contacted');
  else bad('a redirect off-origin is not followed',
           other.hits ? `it fetched from ${ELSEWHERE}` : 'it returned something');

  console.log('\n— and when it works ————————————————————————————————————');

  site.mode = 'good';
  site.hits = 0;
  const at = fresh();
  const one = await iconFor(ORIGIN, { now: at });
  if (one?.body?.length && one.type === 'image/png') ok('a real icon comes back', `${one.body.length} bytes, ${one.type}`);
  else bad('a real icon comes back', JSON.stringify(one));

  const two = await iconFor(ORIGIN, { now: at + 1000 });   // same window: must be cached
  if (two?.cached === true && site.hits === 1) ok('and the second look does not leave the box', `${site.hits} outbound request, not 2`);
  else bad('and the second look does not leave the box', `cached=${two?.cached} hits=${site.hits}`);

  /**
   * 4 · The negative case is the one that matters for a sidebar: six suites
   *     with no icons must not mean six outbound requests per navigation.
   */
  site.mode = 'none';
  site.hits = 0;
  const gone = `${ORIGIN}`;
  const miss = fresh();
  await iconFor(gone, { now: miss });
  const before = site.hits;
  await iconFor(gone, { now: miss + 1000 });   // same window: the miss is remembered
  if (site.hits === before) ok('a site with no icon is remembered as such', 'no refetch on every render');
  else bad('a site with no icon is remembered as such', `${site.hits - before} extra request(s)`);
} finally {
  origins.remove(ORIGIN);
  site.close();
  other.close();
}

console.log('\n— reading the page ————————————————————————————————————');
if (iconHref('<link rel="shortcut icon" href="/m.png">') === '/m.png') ok('finds <link rel=icon>');
else bad('finds <link rel=icon>');
if (iconHref('<link rel="stylesheet" href="/a.css">') === null) ok('and is not fooled by a stylesheet');
else bad('and is not fooled by a stylesheet');
if (dataUri('data:image/svg+xml,%3Csvg%3E')?.type === 'image/svg+xml') ok('decodes a data: icon', 'no request at all — what this app itself uses');
else bad('decodes a data: icon');
if (dataUri('data:text/html,<script>') === null) ok('and refuses a data: URI that is not an image');
else bad('and refuses a data: URI that is not an image');

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — the one outbound fetch in this codebase will not leave the\n'
    + '       allowlist, will not touch link-local even when told to, cannot be\n'
    + '       redirected off the host it vetted, and stops reading at 256 KB.\n');
process.exit(failures ? 1 : 0);
