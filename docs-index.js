/**
 * The documentation, searchable.
 *
 * The runner's own markdown — the README, SETUP and docs/ — cut into sections
 * and ranked for a question, so the chat can answer "how do I record a test?"
 * or "what does the heal switch do?" from what the repository says rather than
 * from what a model remembers (chat-tools.js `docs`).
 *
 * Retrieval is lexical: BM25 over stemmed words, a heading's words counted
 * three times. Not embeddings, on purpose — there is no second provider, no
 * key and no network in it, a few hundred sections rank in microseconds, and
 * the answer is deterministic: the same question finds the same section on
 * every runner. The scorer is the one thing to swap should a corpus ever
 * outgrow it; the tool and the sections it hands back would not change.
 *
 * Read once at boot (server.js) and never written. A section carries the file
 * and the heading it came from, so a reply can say where it looked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The files that are documentation, in the order a reader would meet them. Missing ones are skipped. */
export const FILES = Object.freeze(['README.md', 'SETUP.md', 'docs/ARCHITECTURE.md', 'docs/AUTH.md', 'docs/DEPLOY.md', 'docs/HARDENING.md', 'docs/BOUNDARY.md']);
/** A section longer than this is cut on a paragraph: a model reads a page, not a chapter. */
export const CHUNK_MAX = 1400;
/** A word in a heading is the section's subject; it counts this many times. */
export const HEADING_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are', 'was', 'were', 'be', 'it', 'its',
  'this', 'that', 'these', 'those', 'with', 'as', 'by', 'from', 'do', 'does', 'did', 'i', 'we', 'you', 'my', 'our', 'your', 'can',
  'what', 'how', 'why', 'where', 'when', 'which', 'who', 'not', 'no', 'so', 'if', 'then', 'than', 'but', 'into', 'out', 'up',
  'there', 'here', 'me', 'us', 'them', 'they', 'he', 'she', 'have', 'has', 'had', 'will', 'would', 'should', 'could', 'about']);

/**
 * A conservative stem: plurals and the two verb endings, and a trailing e so
 * "refuse" and "refused" meet. Nothing cleverer — a real stemmer turns
 * "billing" into "bill" and finds the wrong section.
 */
export function stem(t) {
  let w = t;
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Text → the words worth matching on, stemmed, stop words and single letters dropped. */
export function words(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/**
 * The product's own vocabulary, where a question and the documentation use
 * different words for one thing: a person asks how to record a test, the
 * Teach mode section says flow and script. A synonym joins the search at
 * half the weight of a word the person actually used, and never counts as a
 * match of the question. Small on purpose; it is not a thesaurus.
 */
export const SYNONYM_WEIGHT = 0.5;
const SYNONYMS = Object.fromEntries(Object.entries({
  test: ['case', 'flow', 'script'], case: ['test', 'flow'], flow: ['test', 'case'], script: ['test', 'flow'],
  record: ['teach'], teach: ['record'],
  defect: ['bug', 'failure'], bug: ['defect'],
  deploy: ['production', 'host', 'aws'], production: ['deploy'],
  monitor: ['watch', 'incident'], watch: ['monitor'],
  secret: ['vault', 'password'], password: ['vault', 'secret'], vault: ['secret'],
  suite: ['project'], project: ['suite'],
  origin: ['allowlist', 'domain'],
  login: ['sign', 'auth'], sign: ['login', 'auth'],
  run: ['replay'], replay: ['run'],
}).map(([k, v]) => [stem(k), v.map(stem)]));

const HEADING = /^(#{1,3})\s+(.+?)\s*#*$/;
const FENCE = /^\s*(```|~~~)\s*(\w+)?/;

/**
 * Markdown → sections: one per heading, the text under it up to the next
 * heading, cut on paragraphs past CHUNK_MAX. A `#` inside a code fence is not
 * a heading; a mermaid diagram is dropped rather than indexed as words.
 * @returns {Array<{id:string, file:string, heading:string, path:string[], level:number, text:string}>}
 */
export function chunk(markdown, file) {
  // An HTML comment is a note to whoever edits the file, not to a reader —
  // and a quoted section should never carry one into a reply.
  markdown = String(markdown ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const stack = [];          // [level, heading] of the sections above this one
  let heading = null;
  let level = 0;
  let lines = [];
  let fence = null;          // the fence marker while inside one, and whether its lines are kept
  let n = 0;
  const flush = () => {
    if (heading == null) { lines = []; return; }
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    lines = [];
    if (!text) return;
    const path = stack.filter(([l]) => l < level).map(([, h]) => h);
    split(text).forEach((part, i) => out.push({ id: `${file}#${++n}`, file, heading, path, level, part: i + 1, text: part }));
  };
  for (const raw of String(markdown ?? '').replace(/\r/g, '').split('\n')) {
    if (fence) {
      // The closing line is kept with its block: a fence with one end is a
      // fence that swallows everything after it when the text is drawn.
      if (raw.trim().startsWith(fence.mark)) { if (fence.keep) lines.push(raw); fence = null; }
      else if (fence.keep) lines.push(raw);
      continue;
    }
    const f = FENCE.exec(raw);
    if (f) { fence = { mark: f[1], keep: f[2] !== 'mermaid' }; if (fence.keep) lines.push(raw); continue; }
    const h = HEADING.exec(raw);
    if (h) {
      flush();
      level = h[1].length;
      heading = h[2].replace(/`/g, '').trim();
      while (stack.length && stack[stack.length - 1][0] >= level) stack.pop();
      stack.push([level, heading]);
      continue;
    }
    lines.push(raw);
  }
  flush();
  return out;
}

/** Inside a code fence: an odd number of fence markers so far. */
const openFence = (s) => ((s.match(/^\s*(```|~~~)/gm) ?? []).length % 2) === 1;

/**
 * A long section, cut on paragraphs — never inside a code fence, whose two
 * halves would each read as a fence of their own — and a paragraph longer
 * than the cap, cut where it must be.
 */
function split(text) {
  if (text.length <= CHUNK_MAX) return [text];
  const parts = [];
  let cur = '';
  for (const para of text.split(/\n\n+/)) {
    const p = para.length > CHUNK_MAX && !openFence(cur) ? para.slice(0, CHUNK_MAX) : para;
    if (cur && cur.length + p.length + 2 > CHUNK_MAX && !openFence(cur)) { parts.push(cur); cur = p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** One section, whatever part of it: the file and every heading above the text. */
const keyOf = (s) => `${s.file}#${[...s.path, s.heading].join('›')}`;

/** Sections → the index BM25 needs: term frequencies with headings weighted, document frequencies, the mean length. */
export function buildIndex(sections) {
  const docs = sections.map((section) => {
    const tf = new Map();
    const body = words(section.text);
    const head = words(`${section.path.join(' ')} ${section.heading}`);
    // The file's own name is part of what a section is about: every section
    // of docs/DEPLOY.md is about deploying, whether or not it says the word.
    const name = words(section.file.replace(/^.*\//, '').replace(/\.md$/, ''));
    for (const w of body) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of head) tf.set(w, (tf.get(w) ?? 0) + HEADING_WEIGHT);
    for (const w of name) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { section, tf, len: body.length + head.length * HEADING_WEIGHT + name.length };
  });
  const df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  // A section's first part, by section: the lead-in a quote should start from.
  const first = new Map();
  for (const s of sections) if (s.part === 1) first.set(keyOf(s), s);
  return { docs, df, avg, n: docs.length, first };
}

/**
 * The sections that answer a question best, most likely first.
 * `score` is BM25; `matched` of `terms` says how much of the question the
 * section actually contains, which is the honest measure of a hit.
 */
export function search(index, query, { limit = 4 } = {}) {
  const asked = [...new Set(words(query))];
  if (!asked.length || !index?.n) return [];
  const extra = new Set();
  for (const w of asked) for (const s of SYNONYMS[w] ?? []) if (!asked.includes(s)) extra.add(s);
  const qs = [...asked.map((w) => ({ w, weight: 1, own: true })), ...[...extra].map((w) => ({ w, weight: SYNONYM_WEIGHT, own: false }))];
  const scored = [];
  for (const d of index.docs) {
    let score = 0;
    let matched = 0;
    for (const { w, weight, own } of qs) {
      const f = d.tf.get(w);
      if (!f) continue;
      if (own) matched++;
      const n = index.df.get(w) ?? 0;
      const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
      score += weight * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / index.avg)));
    }
    if (score > 0) scored.push({ section: d.section, score: Math.round(score * 1000) / 1000, matched, terms: asked.length });
  }
  scored.sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id));
  // One entry per section: a long section was cut into parts, and its best
  // part stands for it, so three hits are three answers rather than one twice.
  const seen = new Set();
  const out = [];
  for (const r of scored) {
    const key = keyOf(r.section);
    if (seen.has(key)) continue;
    seen.add(key);
    const first = index.first?.get(key) ?? null;
    out.push({ ...r, lead: first && first !== r.section ? first : null });
    if (out.length >= Math.max(1, Math.min(10, limit))) break;
  }
  return out;
}

/** The first part of a section, cut on a paragraph or a sentence past `max`, so a quoted answer stays readable. */
export function excerpt(text, max = 900) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const para = head.lastIndexOf('\n\n');
  let cut;
  if (para > max * 0.4) cut = head.slice(0, para).trim();
  else {
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'));
    cut = sentence > max * 0.4 ? head.slice(0, sentence + 1).trim() : head.trim();
  }
  // A fence the cut left open would swallow everything after it as code.
  return openFence(cut) ? `${cut}\n\`\`\`\n…` : `${cut} …`;
}

/**
 * Everything the chat needs, read from one checkout: the files that exist,
 * their sections, and `search`. Missing files are simply not there — a runner
 * deployed without its docs still boots, with a docs tool that finds nothing.
 */
export function load(root) {
  const files = [];
  const sections = [];
  for (const f of FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    files.push(f);
    sections.push(...chunk(readFileSync(p, 'utf8'), f));
  }
  const index = buildIndex(sections);
  return { files, sections, search: (query, limit) => search(index, query, { limit }) };
}
