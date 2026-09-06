/**
 * Renders every generated diagram with the real mermaid parser and fails on
 * a syntax error. Generated mermaid that does not parse is worse than none —
 * it fails silently inside someone else's docs.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from '../parse.js';
import { toMermaid } from '../diagram.js';
import { asFlowchart, toFlow } from '../flow.js';

const require = createRequire(import.meta.url);
const MERMAID = require.resolve('mermaid/dist/mermaid.min.js');

const CASES = {
  'plan (no results)': [
    `suite "Username length boundary"
goto   "http://localhost:3000/demo.html"
fill   auth.email    with $secrets.QA_USER
fill   auth.password with $secrets.QA_PASS
click  auth.submit
click  nav.settings
expect url contains "/settings"
click  settings.profileTab
fill   profile.username with repeat("a", 20)
click  profile.save
expect text "Profile saved"
expect value profile.username is repeat("a", 20)`, null],

  'run report (one failure)': [null, 'reuse'],

  'dynamic targets, no aliases': [
    `suite "Any page, no registry"
goto   "http://localhost:3000/shop.html"
fill   textbox:Search with "widget"
click  button:Search
expect text "results"
click  link:Cart
expect url contains "#/cart"`, null],

  'single step': [`goto "http://localhost:3000/demo.html"`, null],

  'quotes and specials in labels': [
    `suite "He said \\"hi\\" & left"
goto "http://localhost:3000/demo.html"
expect text "a<b>c & d"`, null],
};

const RESULTS = [
  { i: 0, ok: true, ms: 18 }, { i: 1, ok: true, ms: 1426 }, { i: 2, ok: true, ms: 1756 },
  { i: 3, ok: true, ms: 708 }, { i: 4, ok: true, ms: 708 }, { i: 5, ok: true, ms: 2 },
  { i: 6, ok: true, ms: 708 }, { i: 7, ok: true, ms: 1591 }, { i: 8, ok: true, ms: 705 },
  { i: 9, ok: true, ms: 4 },
  { i: 10, ok: false, ms: 3, error: 'profile.username is "aaaaaaaaaaaaaaaa" (16 chars), expected 20 chars' },
];

const docs = [];
for (const [name, [text]] of Object.entries(CASES)) {
  if (name === 'run report (one failure)') {
    const plan = parse(Object.values(CASES)[0][0]);
    docs.push({ name, src: toMermaid(plan, { results: RESULTS }) });
  } else {
    docs.push({ name, src: toMermaid(parse(text)) });
  }
}

/**
 * A test case is not a flowchart — but it must still become one on demand, or
 * the "paste it into a README and GitHub draws your suite" promise is a lie.
 * These go through the same real parser as the block-beta reports, because a
 * translation nobody renders is a translation nobody knows is broken.
 */
const FLOWS = {
  'case → flowchart': toFlow({ suite: 'Recorded flow', steps: [
    { op: 'goto', url: 'https://example.com/learn' },
    { op: 'scroll', to: 'top' },
    { op: 'click', target: 'navigation/link:Learn' },
    { op: 'click', target: 'navigation/link:Changelog' },
    { op: 'expect', assert: 'urlContains', value: '/changelog' },
  ] }),
  // The characters mermaid cannot lex, which the case is now allowed to keep.
  'case with brackets': toFlow({ suite: 'Downloads (2024)', steps: [
    { op: 'goto', url: 'https://example.com/files' },
    { op: 'click', target: 'link:Download (PDF) [2024]' },
    { op: 'fill', target: 'textbox:Note', value: 'a "quoted" note' },
    { op: 'expect', assert: 'urlContains', value: '/files' },
  ] }),
};
for (const [name, text] of Object.entries(FLOWS)) docs.push({ name, src: asFlowchart(text) });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.setContent('<body style="margin:0;background:#fff"><div id="out"></div></body>');
await page.addScriptTag({ path: MERMAID });
await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }));

let bad = 0;
for (const [n, d] of docs.entries()) {
  const res = await page.evaluate(async ({ src, id }) => {
    try {
      await window.mermaid.parse(src);
      const { svg } = await window.mermaid.render(id, src);
      document.getElementById('out').innerHTML = svg;
      return { ok: true, bytes: svg.length };
    } catch (e) { return { ok: false, error: String(e.message ?? e).split('\n').slice(0, 4).join(' | ') }; }
  }, { src: d.src, id: `d${n}` });

  console.log(`  ${res.ok ? 'parses ' : 'BROKEN '} ${d.name.padEnd(28)} ${res.ok ? res.bytes + ' bytes svg' : res.error}`);
  if (!res.ok) { bad++; console.log('\n' + d.src + '\n'); continue; }
  if (process.env.SHOTS) {
    await page.locator('#out svg').screenshot({ path: `/tmp/diagram-${n}.png` }).catch(() => {});
  }
}

writeFileSync('/tmp/diagram-sample.mmd', docs[1].src);
await browser.close();
if (bad) { console.log(`\n  FAIL — ${bad} diagram(s) do not parse\n`); process.exit(1); }
console.log(`\n  OK — ${docs.length} diagrams parse and render.\n`);
