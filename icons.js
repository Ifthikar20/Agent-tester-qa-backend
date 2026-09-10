/**
 * The favicon of each site you have added, fetched once and kept.
 *
 * The sidebar used to draw the same three-bar glyph beside every suite, so a
 * list of six projects was six identical rows you had to read. A site's own
 * mark is the thing you actually recognise.
 *
 * THIS IS THE FIRST OUTBOUND REQUEST THIS BACKEND HAS EVER MADE.
 *
 * That is worth saying at the top, because the rest of this server is built on
 * the opposite property: origins.js exists to stop generated text from reaching
 * arbitrary hosts, and the browser it drives is the only thing that fetches
 * anything. A server-side fetcher is a different shape of risk — it runs inside
 * the VPC, with no allowlist between it and the network — so every guard below
 * is load-bearing rather than defensive habit:
 *
 *   - the origin must be on the allowlist BY EXACT MEMBERSHIP. Not
 *     `origins.has()`, which is `allowed.has(origin) || allowed.has('*')`
 *     (origins.js:41) — a wildcard would turn this into an open proxy that
 *     fetches whatever the caller names.
 *   - link-local is refused whatever the allowlist says. 169.254.169.254 is
 *     where cloud credentials live and is never a favicon.
 *   - redirects are followed at most twice and never off-origin, so an
 *     allowlisted site cannot bounce us somewhere that is not.
 *   - the body is capped WHILE READING, not after. A content-length header is
 *     a claim by the other end, not a fact.
 *   - the response must be an image, by its own content-type.
 *
 * Other private addresses stay allowed on purpose: the bundled demo suite is
 * http://localhost:3000, and a QA tool whose whole job is internal systems that
 * refused to show their own icon would be a strange tool.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./.ghostclick/icons/', import.meta.url));

const TIMEOUT_MS = 3000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;
/** How long before we look again — for a hit and, more importantly, for a miss. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Only the head is read looking for a <link rel=icon>; a whole page is not needed. */
const HTML_SNIFF = 64 * 1024;

/** Link-local, including the address cloud metadata answers on. */
export const LINK_LOCAL = /^(169\.254\.\d{1,3}\.\d{1,3}|\[?fe80:)/i;

const key = (origin) => createHash('sha256').update(origin).digest('hex').slice(0, 32);
const metaPath = (origin) => `${DIR}${key(origin)}.json`;
const bytesPath = (origin) => `${DIR}${key(origin)}.bin`;

/**
 * Exact membership in the CALLER'S allowlist.
 *
 * Two rules in one line. It is exact rather than origins.has(), because
 * has() answers true for a wildcard entry and reverting to it is what turns a
 * favicon cache into an SSRF proxy on any deployment that ever set
 * ALLOWED_ORIGINS=*. And the list is handed in rather than read from a
 * module-level store, because there is no longer one allowlist: each
 * organisation has its own (docs/AUTH.md §10), and a cache that consulted a
 * global would let one organisation warm and read icons for another's
 * origins — a tenancy leak wearing a performance feature's clothes.
 */
export const allowed = (origin, list = []) => list.includes(origin);

export function refuse(origin, list = []) {
  let u;
  try { u = new URL(origin); } catch { return 'not a URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol} is not fetchable`;
  if (u.origin !== origin) return 'not a bare origin';
  if (LINK_LOCAL.test(u.hostname)) return 'link-local addresses are never fetched';
  if (!allowed(origin, list)) return 'that origin is not on the allowlist';
  return null;
}

const readMeta = (origin) => {
  try { return JSON.parse(readFileSync(metaPath(origin), 'utf8')); } catch { return null; }
};

const write = (origin, meta, bytes) => {
  try {
    mkdirSync(DIR, { recursive: true });
    if (bytes) writeFileSync(bytesPath(origin), bytes);
    writeFileSync(metaPath(origin), JSON.stringify(meta));
  } catch { /* read-only checkout; the fetch still worked for this process */ }
};

/**
 * One request, with the cap enforced as the bytes arrive.
 *
 * `redirect: 'manual'` rather than 'follow' is the point: follow would happily
 * take us off the origin we checked, and we would never know.
 */
async function once(url) {
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'image/*,text/html;q=0.5', 'user-agent': 'ghostclick-icon/1' },
  });

  if (res.status >= 300 && res.status < 400) {
    return { redirect: res.headers.get('location') };
  }
  if (!res.ok) return { status: res.status };

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const reader = res.body?.getReader();
  if (!reader) return { status: 0 };

  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); return { tooBig: true }; }
    parts.push(value);
  }
  return { type, body: Buffer.concat(parts) };
}

/** Follow at most MAX_REDIRECTS hops, and never leave the origin we vetted. */
async function get(url, origin) {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await once(target);
    if (!r.redirect) return r;
    let next;
    try { next = new URL(r.redirect, target); } catch { return { status: 0 }; }
    if (next.origin !== origin) return { offOrigin: next.origin };
    target = next.href;
  }
  return { status: 0 };   // too many hops
}

/**
 * <link rel="icon" href="..."> from the document head.
 *
 * A regex rather than a parser: this reads one attribute out of the first 64 KB
 * of a document nobody trusts, and adding an HTML parser to the dependency tree
 * to do it would be the larger risk.
 */
export function iconHref(html) {
  const head = String(html).slice(0, HTML_SNIFF);
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (value) return value.trim();
  }
  return null;
}

/**
 * Decode `data:image/...` inline, or return null for anything else.
 *
 * Capped like a fetched body, because a document we do not trust chose its
 * length. Only images: a data: URI naming text/html is not an icon.
 */
export function dataUri(href) {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(String(href).trim());
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!type.startsWith('image/')) return null;
  let body;
  try {
    body = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } catch { return null; }
  if (!body.length || body.length > MAX_BYTES) return null;
  return { body, type };
}

/**
 * The icon for an origin, from cache when we have looked before.
 *
 * Returns { body, type } or null. A null is cached too — a site with no icon
 * must not be re-fetched on every page load, which with six suites in a sidebar
 * would be six outbound requests per navigation.
 */
export async function iconFor(origin, list = [], { now = Date.now() } = {}) {
  const no = refuse(origin, list);
  if (no) throw Object.assign(new Error(no), { refused: true });

  const meta = readMeta(origin);
  if (meta && now - meta.at < TTL_MS) {
    if (!meta.ok) return null;
    try { return { body: readFileSync(bytesPath(origin)), type: meta.type, cached: true }; }
    catch { /* bytes lost, fall through and fetch again */ }
  }

  const candidates = [`${origin}/favicon.ico`];
  try {
    const page = await get(`${origin}/`, origin);
    if (page.body) {
      const href = iconHref(page.body.toString('utf8'));
      if (href) {
        // A data: URI is an icon that has already arrived — no second request,
        // and no host to vet. It is also what this very app uses
        // (web/index.html:7), so the bundled demo suite works with no network
        // at all rather than falling through to a monogram.
        const inline = dataUri(href);
        if (inline) {
          write(origin, { ok: true, type: inline.type, at: now }, inline.body);
          return { ...inline, cached: false };
        }
        try {
          const abs = new URL(href, `${origin}/`);
          if (abs.origin === origin) candidates.unshift(abs.href);
        } catch { /* an href we cannot read is one we do not follow */ }
      }
    }
  } catch { /* the page is a nicety; /favicon.ico is the fallback */ }

  for (const url of candidates) {
    try {
      const r = await get(url, origin);
      if (r.body && r.type.startsWith('image/') && r.body.length) {
        write(origin, { ok: true, type: r.type, at: now }, r.body);
        return { body: r.body, type: r.type, cached: false };
      }
    } catch { /* try the next candidate */ }
  }

  write(origin, { ok: false, at: now });
  return null;
}
