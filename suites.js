/**
 * Test suites — the onboarding unit.
 *
 * A suite is how a project enters ghostclick. It is not a folder of scripts; it
 * is the answer to "what are we testing, where does it live, and what has to be
 * true there" — a name, one origin, the discrete pages worth visiting, the
 * expectations each page must satisfy, and the cases recorded against them.
 *
 * Two deliberate choices:
 *
 *  - Suites live in `suites/*.json`, IN the repository, one readable file each.
 *    Run history is machine-local (`.ghostclick/`, gitignored) because it
 *    records what happened on your machine. A suite is the opposite: it is the
 *    shared description of a project, so it should diff, review and merge like
 *    any other source file.
 *
 *  - A suite fixes ONE origin at creation, and every page is a path beneath it.
 *    That is not tidiness. It means adding a page can never walk the runner to
 *    a host nobody allowed — the origin decision happens once, in front of a
 *    person, and the suite cannot widen it afterwards.
 *
 * Creating a suite still does not allow its origin. Onboarding asks for that
 * separately, because allowing an origin is a human act and always has been.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { normalizeUrl } from './origins.js';

const DIR = fileURLToPath(new URL('./suites/', import.meta.url));

const now = () => new Date().toISOString();
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

/** A filename you can recognise in a diff, and that cannot escape the folder. */
function slugify(name) {
  const s = String(name).toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || 'suite';
}

function read(file) {
  try { return JSON.parse(readFileSync(join(DIR, file), 'utf8')); } catch { return null; }
}

function files() {
  try { return readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
}

function write(suite) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${suite.id}.json`), `${JSON.stringify(suite, null, 2)}\n`);
  return suite;
}

// --------------------------------------------------------------- validation

const text = (v, field, max) => {
  const s = String(v ?? '').trim();
  if (!s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long (max ${max})`);
  return s;
};

/**
 * A page path, resolved against the suite's base URL and checked to still be
 * on it. "https://elsewhere.example" as a path is the case this exists for:
 * it resolves cleanly, it just is not this project, so it is refused here
 * rather than at run time.
 */
export function resolvePath(baseUrl, path) {
  const base = new URL(baseUrl);
  let u;
  try { u = new URL(String(path ?? '').trim() || '/', base); }
  catch { throw new Error(`Cannot read "${path}" as a path`); }
  if (u.origin !== base.origin) {
    throw new Error(`"${path}" leaves ${base.origin} — a suite covers one origin`);
  }
  return u;
}

/** Expectations are a closed set, like the op vocabulary. No predicates. */
const EXPECT_KINDS = new Set(['url', 'text']);

function expectation(e) {
  const kind = String(e?.kind ?? '').trim();
  if (!EXPECT_KINDS.has(kind)) {
    throw new Error(`Unknown expectation "${kind}" — expected one of ${[...EXPECT_KINDS].join(', ')}`);
  }
  return { kind, value: text(e.value, 'Expectation value', 200) };
}

// ------------------------------------------------------------------- suites

export function list() {
  return files().map(read).filter(Boolean)
    .map((s) => ({
      id: s.id, name: s.name, description: s.description, baseUrl: s.baseUrl,
      origin: originOf(s), pages: s.pages.length, cases: s.cases.length,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
    }))
    .sort((a, b) => (a.name > b.name ? 1 : -1));
}

export function get(id) {
  const s = read(`${String(id).replace(/[^a-z0-9-]/gi, '')}.json`);
  if (!s) throw new Error(`No suite "${id}"`);
  return s;
}

export const originOf = (s) => { try { return new URL(s.baseUrl).origin; } catch { return null; } };

export function create({ name, baseUrl, description }) {
  const n = text(name, 'Suite name', 80);
  const u = normalizeUrl(baseUrl);           // throws on anything but http(s)

  let id = slugify(n);
  const taken = new Set(files().map((f) => f.replace(/\.json$/, '')));
  if (taken.has(id)) { let i = 2; while (taken.has(`${id}-${i}`)) i++; id = `${id}-${i}`; }

  return write({
    id, name: n,
    description: String(description ?? '').trim().slice(0, 400),
    baseUrl: u.href,
    pages: [], cases: [],
    createdAt: now(), updatedAt: now(),
  });
}

export function update(id, patch) {
  const s = get(id);
  if (patch.name !== undefined) s.name = text(patch.name, 'Suite name', 80);
  if (patch.description !== undefined) s.description = String(patch.description).trim().slice(0, 400);
  if (patch.baseUrl !== undefined) {
    const u = normalizeUrl(patch.baseUrl);
    // Moving the base is allowed, but every page has to survive the move —
    // otherwise you get a suite whose pages point at the old host.
    for (const p of s.pages) resolvePath(u.href, p.path);
    s.baseUrl = u.href;
  }
  s.updatedAt = now();
  return write(s);
}

export function remove(id) {
  get(id);                                    // 404 before unlink
  unlinkSync(join(DIR, `${id}.json`));
  return { id, removed: true };
}

// -------------------------------------------------------------------- pages

export function addPage(id, { name, path, expect }) {
  const s = get(id);
  const u = resolvePath(s.baseUrl, path);
  const page = {
    id: rid('pg'),
    name: text(name, 'Page name', 80),
    path: `${u.pathname}${u.search}${u.hash}`,
    url: u.href,
    expect: (expect ?? []).map(expectation),
    targets: [],                              // filled by a scan
    linked: [],                               // same-origin links found on it
    scannedAt: null,
  };
  s.pages.push(page);
  s.updatedAt = now();
  write(s);
  return page;
}

export function updatePage(id, pageId, patch) {
  const s = get(id);
  const p = s.pages.find((x) => x.id === pageId);
  if (!p) throw new Error(`No page "${pageId}" in ${id}`);
  if (patch.name !== undefined) p.name = text(patch.name, 'Page name', 80);
  if (patch.path !== undefined) {
    const u = resolvePath(s.baseUrl, patch.path);
    p.path = `${u.pathname}${u.search}${u.hash}`;
    p.url = u.href;
  }
  if (patch.expect !== undefined) p.expect = patch.expect.map(expectation);
  if (patch.targets !== undefined) {
    // Discovery output, cached so the expectation picker has something to show
    // without re-driving the browser. Shape-checked because it round-trips
    // through the API.
    p.targets = patch.targets.slice(0, 200).map((t) => ({
      target: String(t.target).slice(0, 200),
      role: String(t.role ?? '').slice(0, 40),
      name: String(t.name ?? '').slice(0, 200),
    }));
    p.scannedAt = now();
  }
  if (patch.linked !== undefined) {
    p.linked = patch.linked.slice(0, 40).map((l) => ({
      path: String(l.path).slice(0, 300),
      name: String(l.name ?? '').slice(0, 80),
    }));
  }
  s.updatedAt = now();
  write(s);
  return p;
}

export function removePage(id, pageId) {
  const s = get(id);
  const i = s.pages.findIndex((x) => x.id === pageId);
  if (i < 0) throw new Error(`No page "${pageId}" in ${id}`);
  s.pages.splice(i, 1);
  // A case whose page is gone still runs — the flow carries its own goto — so
  // it is unlinked rather than deleted. Losing recorded work to a tidy-up is
  // not a trade anyone would take.
  for (const c of s.cases) if (c.pageId === pageId) c.pageId = null;
  s.updatedAt = now();
  write(s);
  return { id: pageId, removed: true };
}

// -------------------------------------------------------------------- cases

/**
 * @param check a validator — the caller passes `flow -> plan` so this module
 *   stays free of the executor. A case that cannot be parsed is never stored:
 *   the point of a suite is that everything in it is runnable.
 */
export function addCase(id, { name, pageId, flow, source }, check) {
  const s = get(id);
  if (pageId && !s.pages.some((p) => p.id === pageId)) throw new Error(`No page "${pageId}" in ${id}`);
  const plan = check(String(flow ?? ''));
  const c = {
    id: rid('cs'),
    name: text(name, 'Case name', 80),
    pageId: pageId ?? null,
    source: source === 'recorded' ? 'recorded' : 'written',
    flow: String(flow),
    steps: plan.steps.length,
    createdAt: now(), updatedAt: now(),
  };
  s.cases.push(c);
  s.updatedAt = now();
  write(s);
  return c;
}

export function updateCase(id, caseId, patch, check) {
  const s = get(id);
  const c = s.cases.find((x) => x.id === caseId);
  if (!c) throw new Error(`No case "${caseId}" in ${id}`);
  if (patch.name !== undefined) c.name = text(patch.name, 'Case name', 80);
  if (patch.pageId !== undefined) {
    if (patch.pageId && !s.pages.some((p) => p.id === patch.pageId)) throw new Error('No such page');
    c.pageId = patch.pageId || null;
  }
  if (patch.flow !== undefined) {
    c.steps = check(String(patch.flow)).steps.length;
    c.flow = String(patch.flow);
  }
  c.updatedAt = now();
  s.updatedAt = now();
  write(s);
  return c;
}

export function removeCase(id, caseId) {
  const s = get(id);
  const i = s.cases.findIndex((x) => x.id === caseId);
  if (i < 0) throw new Error(`No case "${caseId}" in ${id}`);
  s.cases.splice(i, 1);
  s.updatedAt = now();
  write(s);
  return { id: caseId, removed: true };
}

/**
 * A page's expectations as a runnable flow — the check that onboarding buys you
 * before anyone records anything. Reaching the page and finding what should be
 * on it is already a test, and it is the one that catches "the URL moved".
 */
export function pageCheckFlow(suite, page) {
  const lines = [`%% suite "${suite.name} · ${page.name}"`, 'testcase TD', `  n0(("${page.url}"))`];
  const edges = [];
  let prev = 'n0', n = 1;
  for (const e of page.expect) {
    const id = `n${n++}`;
    lines.push(e.kind === 'url' ? `  ${id}["${e.value}"]` : `  ${id}{{"${e.value}"}}`);
    edges.push(`  ${prev} --> ${id}`);
    prev = id;
  }
  return [...lines, '', ...edges].join('\n');
}
