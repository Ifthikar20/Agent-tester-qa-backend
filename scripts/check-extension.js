/**
 * The browser extension's load-bearing parts, tested against a real page:
 * the shared proposer, the picker's click suppression, the replay, and the
 * hand-off endpoint.
 *
 *   npm start &
 *   node scripts/check-extension.js
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toFlow } from '../flow.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const fail = (m) => { console.log(`\n  FAIL  ${m}\n`); process.exit(1); };
const ok = (label, detail = '') => console.log(`  ok    ${label.padEnd(46)} ${detail}`);

// ---------------------------------------------------------------- one copy
console.log('\n— one source of truth ————————————————————————————————————');
// flow.js and the vocabulary it reads are both copied in, because the panel
// parses and writes cases without a server. They drift the moment either is
// edited, which is the point of checking.
for (const f of ['flow.js', 'vocabulary.js']) {
  if (readFileSync(root(f), 'utf8') !== readFileSync(root(`extension/lib/${f}`), 'utf8')) {
    fail(`extension/lib/${f} has drifted from ${f} — copy it again`);
  }
  ok(`extension/lib/${f} matches ${f}`);
}
const proposeSrc = readFileSync(root('extension/lib/propose.js'), 'utf8');
if (!readFileSync(root('recorder.js'), 'utf8').includes('extension/lib/propose.js')) {
  fail('recorder.js no longer reads the shared proposer');
}
ok('recorder.js injects the same proposer the extension loads');

// ---------------------------------------------------------------- the picker
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
await page.goto(`${BASE}/demo.html`);

// content.js talks to the extension over chrome.runtime; stand in for it so the
// picker's own logic is what gets exercised.
await page.evaluate(() => {
  window.__msgs = [];
  window.chrome = {
    runtime: {
      sendMessage: (m) => { window.__msgs.push(m); return Promise.resolve(); },
      onMessage: { addListener: (fn) => { window.__onMsg = fn; } },
    },
  };
});
await page.addScriptTag({ content: proposeSrc });
await page.addScriptTag({ content: readFileSync(root('extension/content.js'), 'utf8') });

const armed = await page.evaluate(() => typeof window.__onMsg === 'function');
if (!armed) fail('content.js did not register its message listener');
ok('picker installed');

console.log('\n— pick, annotate, then perform ———————————————————————————');
// The demo's sign-in handler no-ops on empty fields, so give it something to
// do — otherwise "the page did not react" proves nothing about the replay.
await page.getByLabel('Email').fill('qa@example.com');
await page.getByLabel('Password').fill('hunter2');

await page.evaluate(() => window.__onMsg({ t: 'arm' }, null, () => {}));
await page.getByRole('button', { name: 'Sign in' }).click();

const picked = await page.evaluate(() => window.__msgs.find((m) => m.t === 'picked'));
if (!picked) fail('clicking while armed produced no pick');
ok('pick reported', picked.preview);
if (picked.preview !== 'button:Sign in') fail(`expected button:Sign in, got ${picked.preview}`);

// The whole point: the page must NOT have reacted yet.
if (!(await page.getByRole('button', { name: 'Sign in' }).isVisible())) {
  fail('THE CLICK LEAKED — the page reacted before the operation was chosen');
}
ok('click suppressed', 'sign-in form still on screen');

// Now let it through, as answering "click it" does.
await page.evaluate(() => window.__onMsg({ t: 'perform', op: 'click' }, null, () => {}));
await page.waitForTimeout(300);
if (await page.getByRole('button', { name: 'Sign in' }).isVisible()) {
  fail('replaying the click did nothing');
}
ok('click replayed after answering', 'form submitted');

console.log('\n— typing into a field ————————————————————————————————————');
await page.getByRole('link', { name: 'Settings' }).click();
await page.getByRole('button', { name: 'Profile' }).click();
await page.evaluate(() => { window.__msgs.length = 0; window.__onMsg({ t: 'arm' }, null, () => {}); });
await page.getByLabel('Username').click();
const field = await page.evaluate(() => window.__msgs.find((m) => m.t === 'picked'));
if (!field?.isField) fail('a text field was not reported as fillable');
ok('field pick', `${field.preview} · isField=${field.isField}`);

await page.evaluate(() => window.__onMsg({ t: 'perform', op: 'fill', value: 'from-the-extension' }, null, () => {}));
const typed = await page.getByLabel('Username').inputValue();
if (typed !== 'from-the-extension') fail(`fill did not land, field reads "${typed}"`);
ok('fill replayed through the native setter', typed);

// ---------------------------------------------------------------- hand-off
console.log('\n— hand-off to ghostclick —————————————————————————————————');
const steps = [
  { op: 'goto', url: `${BASE}/demo.html` },
  { op: 'fill', target: 'label:Email', value: 'qa@example.com' },
  { op: 'fill', target: 'label:Password', valueRef: 'secrets.QA_PASS' },
  { op: 'click', target: 'button:Sign in' },
  { op: 'expect', assert: 'urlContains', value: '/demo.html#/dashboard' },
];
const flow = toFlow({ suite: 'From the extension', steps });
const res = await fetch(`${BASE}/api/recording`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ flow }),
});
const body = await res.json();
if (!res.ok || !body.ok) fail(`import rejected: ${body.error ?? res.status}`);
ok('POST /api/recording accepted', `${body.steps} steps`);

const bad = await fetch(`${BASE}/api/recording`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ flow: 'flowchart TD\n  a(("http://evil.example.com/")) --> b' }),
});
if (bad.ok) fail('an off-allowlist origin was imported — the gate is not running');
ok('off-allowlist recording rejected', (await bad.json()).error);

await browser.close();

// ---------------------------------------------------------------- real load
console.log('\n— loading it in Chrome for real ——————————————————————————');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const EXT = root('extension');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'gc-ext-')), {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const tab = await ctx.newPage();
  await tab.goto(`${BASE}/demo.html`);
  await tab.waitForTimeout(2000);

  const sw = ctx.serviceWorkers()[0];
  if (!sw) fail('the background service worker never started — check manifest.json');
  ok('service worker running', sw.url().split('/').pop());

  // Ask the extension whether its content script is alive in the tab.
  const reply = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { return await chrome.tabs.sendMessage(t.id, { t: 'href' }); }
    catch (e) { return { error: String(e.message ?? e) }; }
  }).catch((e) => ({ error: String(e.message ?? e) }));
  if (!reply?.href) fail(`content script did not answer: ${reply?.error ?? 'no reply'}`);
  ok('content script injected and answering', reply.href);
} finally {
  await ctx.close();
}

console.log(`
  OK — the picker holds the click until you answer, replays it after,
       and the recording lands in ghostclick through the same gate.
`);
