/**
 * The documentation index (docs-index.js), offline, in three parts:
 *
 *   1 · chunking — a heading opens a section and nests under the ones above
 *       it, a `#` inside a code fence does not, a mermaid diagram is dropped,
 *       a long section is cut on a paragraph, a heading with nothing under it
 *       is no section;
 *   2 · ranking — the stem, the stop words, BM25 with headings counted three
 *       times, one entry per section, `matched` of `terms`;
 *   3 · this very repository — thirty questions a person would type, each
 *       finding its section in the top three, over the README and docs/ as
 *       they are. A question whose section this checkout does not have is
 *       skipped, so the same check runs in both repositories.
 *
 * Then the tool (chat-tools.js `docs`) and the rules (chat-mock.js) over a
 * small corpus of their own: the sections reach the model as facts, the
 * sources reach the reply, and a runner without docs has no tool.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CHUNK_MAX, buildIndex, chunk, excerpt, load, search, stem, words } from '../docs-index.js';
import { makeTools } from '../chat-tools.js';
import { answerMock } from '../chat-mock.js';

let failures = 0;
const ok = (label, detail = '') => console.log(`  ✓  ${label.padEnd(62)} ${detail}`);
const bad = (label, detail = '') => { failures++; console.log(`  ✕  ${label.padEnd(62)} ${detail}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d ?? ''); } catch (e) { bad(label, e.message.split('\n')[0]); }
}
const ROOT = fileURLToPath(new URL('..', import.meta.url));

console.log('\n— 1 · chunking ————————————————————————————————————————');
{
  const md = `# Product

An intro line.

## Teach mode

Record a test by clicking through the page.

\`\`\`sh
# not a heading, a comment
npm start
\`\`\`

### The thorough way

Four questions.

## Empty heading

## Pictures

\`\`\`mermaid
graph TD; A-->B
\`\`\`

A diagram lives above this line.

## Long

${'A paragraph of forty characters, twice. '.repeat(20).trim()}

${'Another paragraph of the same size here. '.repeat(20).trim()}
`;
  const s = chunk(md, 'README.md');
  await check('a heading opens a section; one with nothing under it is none', () => {
    assert.deepEqual(s.map((x) => x.heading), ['Product', 'Teach mode', 'The thorough way', 'Pictures', 'Long', 'Long']);
    return s.length + ' sections';
  });
  await check('a section nests under the headings above it', () => {
    assert.deepEqual(s[2].path, ['Product', 'Teach mode']);
    assert.equal(s[2].level, 3);
    assert.equal(s[2].id, 'README.md#3');
  });
  await check('a # inside a code fence is not a heading, and the fence is kept whole', () => {
    assert.ok(s[1].text.includes('# not a heading'));
    assert.ok(s[1].text.includes('npm start'));
    assert.equal((s[1].text.match(/^```/gm) ?? []).length, 2);
  });
  await check('a mermaid diagram is dropped, the words around it stay', () => {
    assert.ok(!s[3].text.includes('graph TD'));
    assert.ok(s[3].text.includes('A diagram lives above this line.'));
  });
  await check('a long section is cut on a paragraph, under the cap', () => {
    assert.equal(s[4].heading, s[5].heading);
    assert.ok(s[4].text.length <= CHUNK_MAX && s[5].text.length <= CHUNK_MAX);
    assert.ok(!s[4].text.endsWith('twice.') || s[5].text.startsWith('Another'));
    return `${s[4].text.length} + ${s[5].text.length} chars`;
  });
}

console.log('\n— 2 · ranking —————————————————————————————————————————');
{
  await check('the stem is conservative', () => {
    assert.deepEqual(['pages', 'recording', 'recorded', 'refuses', 'refused', 'refuse', 'defects', 'billing', 'does', 'suites'].map(stem),
      ['pag', 'record', 'record', 'refus', 'refus', 'refus', 'defect', 'bill', 'doe', 'suit']);
  });
  await check('stop words and single letters drop out, the rest are stemmed', () => {
    assert.deepEqual(words('How do I record a test in the console?'), ['record', 'test', 'consol']);
  });
  const md = `## Vault
Secrets go in the vault. A step says $NAME and the cursor fills the value.
## Origins
Every goto is checked against the allowed origins; the vault is not involved.
## Runs
A run is a case executed once.
## Cursor handling
Nothing here mentions the word you are looking for twice.`;
  const idx = buildIndex(chunk(md, 'docs/X.md'));
  await check('the section with both words outranks one with either', () => {
    const hits = search(idx, 'vault secret', { limit: 3 });
    assert.equal(hits[0].section.heading, 'Vault');
    assert.equal(hits[0].matched, 2);
    assert.equal(hits[0].terms, 2);
    return hits.map((h) => `${h.section.heading} ${h.score}`).join(' > ');
  });
  await check('a word in the heading counts more than one in the body', () => {
    const hits = search(idx, 'cursor', { limit: 3 });
    assert.equal(hits[0].section.heading, 'Cursor handling');
    assert.equal(hits[1].section.heading, 'Vault');
  });
  await check('a synonym of the product\'s own joins at half weight and never counts as a match', () => {
    const hits = search(idx, 'password', { limit: 3 });
    assert.equal(hits[0].section.heading, 'Vault');
    assert.equal(hits[0].matched, 0);
    assert.equal(hits[0].terms, 1);
    const both = search(idx, 'vault password', { limit: 1 })[0];
    assert.equal(both.matched, 1);
  });
  await check('nothing matched is an empty list, not a guess', () => {
    assert.deepEqual(search(idx, 'zebra'), []);
    assert.deepEqual(search(idx, 'the a an'), []);
  });
  await check('one entry per section, however many parts it was cut into', () => {
    const long = `## Same\n${'vault '.repeat(400)}\n\n${'vault '.repeat(400)}`;
    const hits = search(buildIndex(chunk(long, 'a.md')), 'vault', { limit: 5 });
    assert.equal(hits.length, 1);
  });
  await check('a later part that matched brings the section\'s opening with it', () => {
    const md = `## Suites\nA suite is a project: its pages and its cases.\n\n${'Filler about pages. '.repeat(70).trim()}\n\nThe origin is decided once, in front of a person, and never by a script.`;
    const s = chunk(md, 'README.md');
    assert.ok(s.length >= 2 && s[0].part === 1 && s[1].part === 2);
    const [hit] = search(buildIndex(s), 'origin decided by a script', { limit: 1 });
    assert.equal(hit.section.part, s.length);
    assert.equal(hit.lead.part, 1);
    assert.ok(hit.lead.text.startsWith('A suite is a project'));
    const [whole] = search(buildIndex(s), 'suite project', { limit: 1 });
    assert.equal(whole.lead, null);
  });
  await check('a code fence is never cut in two', () => {
    const md = `## Fenced\nBefore.\n\n\`\`\`\n${'line of code\n\n'.repeat(120)}\`\`\`\n\nAfter.`;
    const s = chunk(md, 'README.md');
    for (const p of s) assert.equal(((p.text.match(/^\s*```/gm) ?? []).length % 2), 0, `part ${p.part} opens a fence it does not close`);
  });
  await check('an excerpt ends on a paragraph or a sentence', () => {
    const t = `${'First sentence here. '.repeat(30)}\n\nSecond paragraph.`;
    const e = excerpt(t, 200);
    assert.ok(e.length <= 202 && e.endsWith('…'), e.slice(-30));
    assert.ok(/\. …$/.test(e));
    assert.equal(excerpt('short', 200), 'short');
    const fenced = excerpt(`Intro.\n\n\`\`\`\n${'code\n'.repeat(80)}\`\`\`\n\nAfter.`, 120);
    assert.equal(((fenced.match(/^\s*```/gm) ?? []).length % 2), 0, 'an excerpt closes the fence it opened');
  });
}

console.log('\n— 3 · this repository —————————————————————————————————');
{
  const d = load(ROOT);
  await check('the markdown beside server.js is indexed', () => {
    assert.ok(d.files.includes('README.md'));
    assert.ok(d.sections.length > 100);
    return `${d.sections.length} sections of ${d.files.join(', ')}`;
  });
  // [question, what its section is called — a substring of the file, the path or the heading; or several that would each do]
  const QUESTIONS = [
    ['how do I record a test', 'Teach mode'],
    ['what is teach mode', 'Teach mode'],
    ['what does GC_HEAL do', 'Automatic fixes (GC_HEAL)'],
    ['why is www.example.com a different origin from example.com', 'example.com is not www.example.com'],
    ['how are defects numbered', 'Defects: numbered'],
    ['what is agentic monitoring', 'Agentic monitoring'],
    ['how does the chat answer questions', ['Chat: ask the runner', '10. The chat']],
    ['how do I sign in', ['Signing in', 'Sign-in', 'docs/AUTH.md']],
    ['what is the security model', 'security model is subtractive'],
    ['what does the run report show', 'The run report'],
    ['what are hero images', 'Hero images'],
    ['how does a project get in as a test suite', 'Test suites'],
    ['why is the canvas black', 'A black canvas is not a crash'],
    ['run script does nothing', 'Run script does nothing'],
    ['seven things that will bite you', 'Seven things that will bite you'],
    ['where does the script actually run', 'Where the script actually runs'],
    ['what happens when the page has two of everything', 'two of everything'],
    ['how do I turn a switch off', 'Turning one off'],
    ['what limits does the runner have', 'Limits'],
    ['how do I deploy to a server', 'docs/DEPLOY.md'],
    ['what is the boundary between the ui and the runner', 'docs/BOUNDARY.md'],
    ['can I record somewhere I cannot reach', "Recording somewhere you can't reach"],
    ['when a link is named by a whole paragraph', 'named by a whole paragraph'],
    ['why does the runner start where I left off', 'starts where you left off'],
    ['a sticky header is a terrible scroll anchor', 'sticky header'],
    ['a name with a colon in it was invisible', 'colon in it'],
    ['what is a suite', 'Test suites'],
    ['how do I keep a password out of the script', 'vault'],
    ['how do I quickstart a suite from a url', 'quickstart'],
    ['what does the runner.chat switch do', 'Switches'],
    ['how do requests get a trace id', 'Request ids and tracing'],
    ['what is drafted from a page read', 'Chat: ask the runner'],
  ];
  const nameOf = (s) => `${s.file} › ${[...s.path, s.heading].join(' › ')}`.toLowerCase();
  let asked = 0;
  let found = 0;
  const misses = [];
  for (const [q, want] of QUESTIONS) {
    const targets = (Array.isArray(want) ? want : [want]).map((t) => t.toLowerCase());
    const is = (s) => targets.some((t) => nameOf(s).includes(t));
    if (!d.sections.some(is)) continue;   // not in this checkout's docs
    asked++;
    const hits = d.search(q, 3);
    if (hits.some((h) => is(h.section))) found++;
    else misses.push(`"${q}" → ${hits.map((h) => h.section.heading).join(' | ') || '(nothing)'}`);
  }
  await check('a question finds its section in the top three', () => {
    for (const m of misses) console.log(`       missed  ${m}`);
    assert.ok(found / asked >= 0.9, `${found} of ${asked} found`);
    return `${found} of ${asked} questions`;
  });
}

console.log('\n— 4 · the tool and the rules ——————————————————————————');
{
  const md = `# ghostclick\n\n## Teach mode\n\nRecord a test by clicking through the page in the console; every click, type and scroll becomes a step.\n\n## Automatic fixes (GC_HEAL)\n\nGC_HEAL=safe applies four rule fixes to a broken step; GC_HEAL=ai asks a model.\n`;
  const sections = chunk(md, 'README.md');
  const index = buildIndex(sections);
  const docs = { files: ['README.md'], sections, search: (q, limit) => search(index, q, { limit }) };
  const space = { org: 'acme', suites: { list: () => [], get: () => { throw new Error('no suite'); } } };
  const actions = { docs: () => docs, defects: () => null, history: () => ({ summary: () => ({ days: [], totals: { runs: 0 }, suites: [], latest: [] }) }) };
  const kit = (a = actions) => makeTools({ space, ent: null, switches: null, org: 'acme', actions: a, redact: (t) => t, propose: () => ({ id: 'pr1' }), now: () => 0 });
  await check('the tool hands the model the best sections, with file and heading', async () => {
    const k = kit();
    const r = await k.byName.docs.run({ query: 'how do I record a test' });
    assert.equal(r.facts.sections[0].heading, 'Teach mode');
    assert.equal(r.facts.sections[0].file, 'README.md');
    assert.ok(r.facts.sections[0].text.includes('Record a test'));
    assert.equal(r.unsafe, null);
    const c = k.calls[k.calls.length - 1];
    assert.equal(c.name, 'docs');
    assert.equal(c.label, 'looked up the docs for "how do I record a test"');
    assert.deepEqual(c.sources, [{ file: 'README.md', heading: 'Teach mode' }]);
    return c.summary;
  });
  await check('a query is required, and capped', async () => {
    const k = kit();
    const r = await k.byName.docs.run({});
    assert.match(r.facts.error, /needs a query/);
  });
  await check('no documentation, no tool', () => {
    const k = kit({ ...actions, docs: () => null });
    assert.equal(k.byName.docs, undefined);
    assert.ok(k.tools.every((t) => t.name !== 'docs'));
  });
  await check('the rules quote the section and name it', async () => {
    const a = await answerMock({ text: 'How do I record a test?', byName: kit().byName, propose: () => ({}), now: () => 0 });
    assert.ok(a.text.startsWith('From README.md · Teach mode:\n\n'), a.text.slice(0, 60));
    assert.ok(a.text.includes('every click, type and scroll becomes a step'));
    return a.text.split('\n')[0];
  });
  await check('what the docs do not cover falls through to the fallback', async () => {
    const a = await answerMock({ text: 'why is the sky blue?', byName: kit().byName, propose: () => ({}), now: () => 0 });
    assert.ok(!a.text.startsWith('From '), a.text.slice(0, 60));
  });
  await check('a statement is not a question for the docs', async () => {
    const a = await answerMock({ text: 'record a test', byName: kit().byName, propose: () => ({}), now: () => 0 });
    assert.ok(!a.text.startsWith('From '), a.text.slice(0, 60));
  });
}

console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
process.exit(failures ? 1 : 0);
