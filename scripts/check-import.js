/**
 * What the chat is handed, read: files and pastes (chat-import.js), test
 * code translated into checks (chat-translate.js), and the charts made from
 * records or a table (chat-charts.js) — with no server, no browser and no
 * network.
 *
 *   node scripts/check-import.js
 *
 *   1  intake         the caps, the kinds, what is refused and why
 *   2  tables         CSV with quotes and line breaks, TSV, JSON, a spreadsheet built here
 *   3  translation    Playwright, Cypress, Selenium, Puppeteer, the flow language
 *   4  the gates      no address, a relative one, a credential, the validator
 *   5  charts         runs per day, by suite, defects, monitors, a table
 */
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  ATTACHMENTS_MAX, ATTACHMENT_MAX_BYTES, TABLE_ROWS_MAX, acceptAttachments, attachmentMeta, chartableColumns, checkColumns,
  kindOf, numberOf, parseDelimited, parseJsonTable, sniffDelimiter, tableFromXlsx, unzip,
} from '../chat-import.js';
import { CHECKS_MAX, compileCheck, detectFramework, guessTarget, humanise, originOfCheck, statements, translate } from '../chat-translate.js';
import { LABELS_MAX, SERIES_MAX, bySuite, defectsBy, describeChart, monitorsByState, runsPerDay, tableChart } from '../chat-charts.js';
import { parse } from '../flow.js';

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(58)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(58)} ${d}`); };
const check = (label, fn) => { try { fn(); ok(label); } catch (e) { bad(label, e.message.split('\n')[0]); } };
const section = (t) => console.log(`\n— ${t} ${'—'.repeat(Math.max(2, 58 - t.length))}`);

// ---- a spreadsheet, made by hand -------------------------------------------------------------
/** A zip of stored or deflated entries, the way a spreadsheet is one — enough of the format for the reader. */
function zip(entries, { deflate = false } = {}) {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[i] = c; }
  const crc = (buf) => { let c = -1; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8');
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(crc(data), 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc(data), 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, body);
    central.push(cd, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** rows of cells → the sheet XML: strings shared, numbers plain, booleans typed, one inline string. */
function xlsx(rows, { deflate = false, sheet = 'Runs' } = {}) {
  const shared = [];
  const si = (s) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const col = (i) => String.fromCharCode(65 + i);
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${col(ci)}${ri + 1}`;
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (String(v).startsWith('inline:')) return `<c r="${ref}" t="inlineStr"><is><t>${esc(String(v).slice(7))}</t></is></c>`;
    if (v === '') return '';
    return `<c r="${ref}" t="s"><v>${si(String(v))}</v></c>`;
  }).join('')}</row>`).join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<?xml version="1.0"?><worksheet><sheetData></sheetData></worksheet>',
  }, { deflate });
}

// ---------------------------------------------------------------------------
section('1 · intake');
const csv = 'suite,runs,passed\nAcme,12,11\nHarbour,3,1\n';
check('a CSV is a table, with its shape kept on the message', () => {
  const { items, rejected } = acceptAttachments([{ name: 'runs.csv', encoding: 'text', data: csv }]);
  assert.deepEqual(rejected, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'table');
  assert.deepEqual(items[0].table.columns.map((c) => `${c.name}:${c.type}`), ['suite:text', 'runs:number', 'passed:number']);
  assert.deepEqual(attachmentMeta(items[0]), { name: 'runs.csv', kind: 'table', size: csv.length, rows: 2, columns: 3 });
});
check('a paste is read by what is in it, not what it is called', () => {
  assert.equal(kindOf('pasted.txt', "await page.goto('https://a.b'); await expect(page).toHaveURL(/x/);"), 'code');
  assert.equal(kindOf('pasted.txt', 'a,b\n1,2\n3,4'), 'table');
  assert.equal(kindOf('pasted.txt', '[{"a":1},{"a":2}]'), 'table');
  assert.equal(kindOf('pasted.txt', '%% suite "X"\ntestcase TD\n  n0(("https://a.b/"))\n'), 'flow');
  assert.equal(kindOf('notes.txt', 'Some prose about the release.\nAnother line.'), 'text');
  assert.equal(detectFramework("cy.visit('/'); cy.get('#a').click();"), 'cypress');
  assert.equal(detectFramework('driver.get("https://a.b")\ndriver.find_element(By.ID, "x").click()'), 'selenium');
  assert.equal(detectFramework('hello world'), null);
});
check('a file of a kind the chat does not read is refused, by name', () => {
  const { items, rejected } = acceptAttachments([{ name: 'shot.png', encoding: 'base64', data: Buffer.from('\x89PNG').toString('base64') }]);
  assert.equal(items.length, 0);
  assert.match(rejected[0].why, /does not read/);
  assert.equal(rejected[0].name, 'shot.png');
});
check('the caps: bytes each, files together, a list at all', () => {
  const big = { name: 'big.csv', encoding: 'text', data: 'a,b\n' + '1,2\n'.repeat((ATTACHMENT_MAX_BYTES / 4) + 10) };
  assert.match(acceptAttachments([big]).rejected[0].why, /files up to/);
  const many = Array.from({ length: ATTACHMENTS_MAX + 1 }, (_, i) => ({ name: `f${i}.csv`, encoding: 'text', data: csv }));
  const r = acceptAttachments(many);
  assert.equal(r.items.length, ATTACHMENTS_MAX);
  assert.match(r.rejected[0].why, /at most/);
  assert.equal(acceptAttachments('nope').rejected[0].why, 'not a list');
  assert.deepEqual(acceptAttachments(undefined), { items: [], rejected: [] });
  assert.equal(acceptAttachments([{ name: 'x.csv', encoding: 'text', data: '' }]).rejected[0].why, 'empty');
});
check('a name is one line without a path', () => {
  const { items } = acceptAttachments([{ name: '../../etc/passwd\n.csv', encoding: 'text', data: csv }]);
  assert.equal(items[0].name, '.. .. etc passwd.csv');
});

// ---------------------------------------------------------------------------
section('2 · tables');
check('CSV: quotes, doubled quotes and a line break inside a cell', () => {
  const t = parseDelimited('name,note,n\n"Acme, Inc.","says ""hi""\nover two lines",3\nHarbour,,4\n');
  assert.deepEqual(t.columns.map((c) => c.name), ['name', 'note', 'n']);
  assert.deepEqual(t.rows[0], ['Acme, Inc.', 'says "hi"\nover two lines', '3']);
  assert.deepEqual(t.rows[1], ['Harbour', '', '4']);
  assert.equal(t.columns[2].type, 'number');
});
check('TSV and semicolons are sniffed; a first row of numbers is data', () => {
  assert.equal(sniffDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(sniffDelimiter('a;b\n1;2\n'), ';');
  assert.equal(sniffDelimiter('just words\nmore words'), null);
  const t = parseDelimited('1,2\n3,4\n');
  assert.deepEqual(t.columns.map((c) => c.name), ['column 1', 'column 2']);
  assert.equal(t.rows.length, 2);
});
check('JSON: objects, arrays, and a list under a key', () => {
  assert.deepEqual(parseJsonTable('[{"a":1,"b":"x"},{"a":2,"c":true}]').columns.map((c) => c.name), ['a', 'b', 'c']);
  assert.deepEqual(parseJsonTable('[["day","runs"],["2026-09-01",4]]').rows, [['2026-09-01', '4']]);
  assert.equal(parseJsonTable('{"meta":1,"rows":[{"x":1}]}').rows.length, 1);
  assert.throws(() => parseJsonTable('{"a":1}'), /not a table/);
  assert.throws(() => parseJsonTable('nope'), /not JSON/);
});
check('numbers and dates are told apart from words', () => {
  assert.equal(numberOf('1,234'), 1234);
  assert.equal(numberOf('$5.60'), 5.6);
  assert.equal(numberOf('12%'), 12);
  assert.equal(numberOf('abc'), null);
  const t = parseDelimited('date,n\n2026-09-01,1\n2026-09-02,2\n');
  assert.equal(t.columns[0].type, 'date');
});
check('a spreadsheet: shared strings, numbers, booleans, an inline string, a date by its heading', () => {
  const rows = [['date', 'suite', 'runs', 'ok', 'note'], [45900, 'Acme', 12, true, 'inline:hello & <bye>'], [45901, 'Harbour', 3, false, '']];
  const t = tableFromXlsx(xlsx(rows));
  assert.deepEqual(t.columns.map((c) => `${c.name}:${c.type}`), ['date:date', 'suite:text', 'runs:number', 'ok:text', 'note:text']);
  assert.deepEqual(t.rows[0], ['2025-08-31', 'Acme', '12', 'true', 'hello & <bye>']);
  assert.equal(t.sheet, 'Runs');
  assert.equal(t.sheets, 2);
});
check('a deflated spreadsheet reads the same', () => {
  const t = tableFromXlsx(xlsx([['a', 'b'], [1, 2]], { deflate: true }));
  assert.deepEqual(t.rows, [['1', '2']]);
  assert.deepEqual(unzip(xlsx([['a']], { deflate: true })).names.length, 6);
});
check('the intake reads a spreadsheet from base64', () => {
  const { items, rejected } = acceptAttachments([{ name: 'runs.xlsx', encoding: 'base64', data: xlsx([['a', 'b'], [1, 2]]).toString('base64') }]);
  assert.deepEqual(rejected, []);
  assert.equal(items[0].kind, 'table');
  assert.equal(items[0].table.rows.length, 1);
  assert.match(acceptAttachments([{ name: 'x.xlsx', encoding: 'text', data: 'not a zip' }]).rejected[0].why, /no zip signature/);
});
check('a table is cut at the cap and says so', () => {
  const t = parseDelimited('n\n' + Array.from({ length: TABLE_ROWS_MAX + 50 }, (_, i) => `${i}\n`).join(''));
  assert.equal(t.rows.length, TABLE_ROWS_MAX);
  assert.equal(t.truncated, true);
});
check('which columns could be charted, and which rows are checks', () => {
  const t = parseDelimited('name,flow,url\nA,"testcase TD",https://a.b\n');
  assert.deepEqual(checkColumns(t), { flow: 1, name: 0, url: 2 });
  assert.equal(checkColumns(parseDelimited('a,b\n1,2\n')), null);
  const c = chartableColumns(parseDelimited('day,runs,note\n2026-09-01,3,x\n'));
  assert.deepEqual(c.x.map((x) => x.name), ['day', 'note']);
  assert.deepEqual(c.y.map((y) => y.name), ['runs']);
});

// ---------------------------------------------------------------------------
section('3 · translation');
const PLAYWRIGHT = `import { test, expect } from '@playwright/test';
test.describe('Sign in', () => {
  test.beforeEach(async ({ page }) => { await page.goto('https://acme.example/login'); });
  test('signs in', async ({ page }) => {
    await page.getByLabel('Email').fill('qa@acme.example');
    await page.getByLabel('Password').fill('hunter2-real');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/dashboard/);
    await expect(page.getByText('Welcome back')).toBeVisible();
  });
  test('footer pricing', async ({ page }) => {
    await page.getByRole('contentinfo').getByRole('link', { name: 'Pricing' }).click();
    await expect(page.getByRole('heading', { name: /Plans/i })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Yearly' }).check();
    await expect(page.getByTestId('total')).toHaveText('$120');
    await expect(page.getByText('Spinner')).not.toBeVisible();
  });
});`;
const CYPRESS = `describe('Contact', () => {
  beforeEach(() => { cy.visit('/contact'); });
  it('sends a message', () => {
    cy.get('#name').type('Ada');
    cy.get('[data-testid="message"]').type('Hello{enter}');
    cy.contains('button', 'Send').click();
    cy.contains('Thanks, Ada').should('be.visible');
    cy.url().should('include', '/thanks');
    cy.get('.spinner').should('not.exist');
  });
});`;
const SELENIUM = `from selenium import webdriver
from selenium.webdriver.common.by import By
import time

def test_search():
    driver = webdriver.Chrome()
    driver.get("https://acme.example/")
    driver.find_element(By.NAME, "q").send_keys("widgets")
    driver.find_element(By.ID, "search-btn").click()
    time.sleep(1)
    assert "Results for widgets" in driver.page_source
    assert "/search" in driver.current_url
    driver.find_element(By.XPATH, "//div[@class='x']").click()
    driver.quit()
`;
const PUPPETEER = `const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('https://acme.example/pricing');
  await page.waitForSelector('#plans');
  await page.click('[data-testid="monthly"]');
  await page.type('#coupon', 'SAVE10');
  await page.waitForTimeout(300);
  await browser.close();
})();`;
const FLOW = '%% suite "Acme · Home"\ntestcase TD\n  n0(("https://acme.example/"))\n  n1{{"Welcome"}}\n\n  n0 --> n1\n';
const checkFlow = (flow) => parse(flow);
const compileAll = (r, base = 'https://acme.example') => r.checks.map((c) => compileCheck(c, { suiteName: 'Acme', base, checkFlow }));

check('the statements of a file: blocks split, object literals kept whole', () => {
  const s = statements("test('a', async ({ page }) => {\n  await page.getByRole('button', { name: 'X' }).click();\n});");
  assert.deepEqual(s, ["test('a', async ({ page }) =>", '{', "await page.getByRole('button', { name: 'X' }).click()", '}', ')']);
});
check('Playwright: two tests, the setup goto prepended, the password a vault reference', () => {
  const r = translate(PLAYWRIGHT, { name: 'login.spec.ts' });
  assert.equal(r.framework, 'playwright');
  assert.deepEqual(r.checks.map((c) => c.name), ['signs in', 'footer pricing']);
  const [a, b] = r.checks;
  assert.deepEqual(a.steps[0], { op: 'goto', url: 'https://acme.example/login' });
  assert.deepEqual(a.steps[1], { op: 'fill', target: 'label:Email', value: 'qa@acme.example' });
  assert.deepEqual(a.steps[2], { op: 'fill', target: 'label:Password', valueRef: 'secrets.PASSWORD' });
  assert.ok(!JSON.stringify(r).includes('hunter2-real'), 'the literal password is nowhere in the result');
  assert.match(a.notes[0], /typed from the vault as \$PASSWORD/);
  assert.deepEqual(a.steps[3], { op: 'click', target: 'button:Sign in' });
  assert.deepEqual(a.steps[4], { op: 'expect', assert: 'urlContains', value: '/dashboard' });
  assert.deepEqual(a.steps[5], { op: 'expect', assert: 'textVisible', value: 'Welcome back' });
  assert.deepEqual(b.steps[1], { op: 'click', target: 'contentinfo/link:Pricing' });
  assert.deepEqual(b.steps[2], { op: 'expect', assert: 'textVisible', value: 'Plans' });
  assert.deepEqual(b.steps[3], { op: 'expect', assert: 'textVisible', value: '$120' });
  assert.equal(b.dropped.length, 2);
  assert.match(b.dropped[0].why, /ticking a checkbox is not in the language yet/);
  assert.match(b.dropped[1].why, /absence/);
  const out = compileAll(r);
  assert.ok(out.every((o) => o.ok), JSON.stringify(out.map((o) => o.why)));
  assert.match(out[0].flow, /fill 'Password' : label = \$PASSWORD/);
  assert.match(out[0].flow, /^%% suite "Acme · signs in"/);
  assert.match(out[1].flow, /click 'Pricing' : contentinfo\/link/);
});
check('Cypress: a relative visit completed by the suite, a guessed id, a key press left out', () => {
  const r = translate(CYPRESS);
  assert.equal(r.framework, 'cypress');
  const [c] = r.checks;
  assert.equal(c.name, 'sends a message');
  assert.deepEqual(c.steps[0], { op: 'goto', url: '/contact' });
  assert.deepEqual(c.steps[1], { op: 'fill', target: 'label:Name', value: 'Ada' });
  assert.deepEqual(c.steps[2], { op: 'fill', target: 'testid:message', value: 'Hello' });
  assert.deepEqual(c.steps[3], { op: 'click', target: 'button:Send' });
  assert.ok(c.notes.some((n) => /guessed from #name/.test(n)));
  assert.ok(c.notes.some((n) => /key press/.test(n)));
  assert.match(c.dropped[0].why, /names nothing a person reads/);
  assert.match(compileAll(r, null)[0].why, /relative address \/contact/);
  const out = compileAll(r)[0];
  assert.ok(out.ok, out.why);
  assert.match(out.flow, /n0\(\("https:\/\/acme\.example\/contact"\)\)/);
});
check('Selenium: By.NAME and By.ID guessed, sleep a wait, the page source a text check, XPath dropped', () => {
  const r = translate(SELENIUM);
  assert.equal(r.framework, 'selenium');
  const [c] = r.checks;
  assert.equal(c.name, 'Search');
  assert.deepEqual(c.steps.map((s) => s.op), ['goto', 'fill', 'click', 'wait', 'expect', 'expect']);
  assert.equal(c.steps[3].ms, 1000);
  assert.deepEqual(c.steps[4], { op: 'expect', assert: 'textVisible', value: 'Results for widgets' });
  assert.match(c.dropped[0].why, /XPath/);
  assert.ok(compileAll(r)[0].ok);
});
check('Puppeteer: selectors guessed, a script with no test() is one check', () => {
  const r = translate(PUPPETEER, { name: 'pricing.js' });
  assert.equal(r.framework, 'puppeteer');
  assert.equal(r.checks.length, 1);
  assert.deepEqual(r.checks[0].steps.map((s) => s.op), ['goto', 'expect', 'click', 'fill', 'wait']);
  assert.deepEqual(r.checks[0].steps[2], { op: 'click', target: 'testid:monthly' });
  assert.ok(compileAll(r)[0].ok);
});
check('the flow language is taken as it is', () => {
  const r = translate(FLOW, { name: 'home.flow' });
  assert.equal(r.framework, 'flow');
  assert.equal(r.checks[0].name, 'Acme · Home');
  const out = compileCheck(r.checks[0], { checkFlow });
  assert.ok(out.ok);
  assert.match(out.flow, /n1\{\{"Welcome"\}\}/);
});
check('what is not a test says so', () => {
  const r = translate('The quick brown fox.');
  assert.equal(r.framework, null);
  assert.match(r.why, /not a test the runner recognises/);
});
check('a file of many tests keeps the first eight and counts the rest', () => {
  const many = Array.from({ length: CHECKS_MAX + 3 }, (_, i) => `test('t${i}', async ({ page }) => { await page.goto('https://a.b/${i}'); await expect(page.getByText('x')).toBeVisible(); });`).join('\n');
  const r = translate(many);
  assert.equal(r.checks.length, CHECKS_MAX);
  assert.equal(r.extra, 3);
});
check('selectors: what can be guessed, what cannot', () => {
  assert.deepEqual(guessTarget('[data-testid="save"]'), { target: 'testid:save' });
  assert.equal(guessTarget('#first-name', 'fill').target, 'label:First name');
  assert.equal(guessTarget('input[type="email"]', 'fill').target, 'label:Email');
  assert.equal(guessTarget('button[type=submit]').target, 'button:Submit');
  assert.equal(guessTarget('text=Sign in').target, 'text:Sign in');
  assert.equal(guessTarget('button:has-text("Go")').target, 'button:Go');
  assert.match(guessTarget('.btn-primary').why, /names nothing a person reads/);
  assert.match(guessTarget('//div[@id="x"]').why, /XPath/);
  assert.match(guessTarget('[data-cy="x"]').why, /data-cy is not data-testid/);
  assert.match(guessTarget('a').why, /every link on the page/);
  assert.equal(humanise('email-input'), 'Email');
  assert.equal(humanise('firstName'), 'First name');
});
check('a credential typed anywhere is masked when the line is echoed', () => {
  const r = translate("test('x', async ({ page }) => { await page.goto('https://a.b/'); await page.locator('.pw').fill('s3cret-token-value'); });");
  assert.ok(!JSON.stringify(r).includes('s3cret-token-value'));
  assert.match(r.checks[0].dropped[0].line, /'…'/);
});

// ---------------------------------------------------------------------------
section('4 · the gates');
check('a check with no address, and one with nothing checked, are both said', () => {
  assert.match(compileCheck({ name: 'x', steps: [{ op: 'click', target: 'button:Go' }] }, { checkFlow }).why, /no address to open/);
  const out = compileCheck({ name: 'x', steps: [{ op: 'goto', url: 'https://acme.example/' }, { op: 'click', target: 'button:Go' }] }, { checkFlow, suiteName: 'Acme' });
  assert.ok(out.ok);
  assert.ok(out.steps.some((s) => s.assert === 'status'), 'a status check is added so something is checked');
});
check('the goto is put first; a later goto is a new page in the same check', () => {
  const out = compileCheck({ name: 'x', steps: [{ op: 'click', target: 'button:Go' }, { op: 'goto', url: 'https://acme.example/' }, { op: 'expect', assert: 'textVisible', value: 'Hi' }] }, { checkFlow });
  assert.ok(out.ok);
  assert.equal(out.steps[0].op, 'goto');
});
check('the validator has the last word', () => {
  const out = compileCheck({ name: 'x', steps: [{ op: 'goto', url: 'https://acme.example/' }, { op: 'fill', target: 'label:Card', value: 'my password' }] }, { checkFlow: (f) => { const p = parse(f); if (p.steps.some((s) => /password/.test(s.value ?? ''))) throw new Error('literal credential — use valueRef'); return p; } });
  assert.match(out.why, /refused by the validator: literal credential/);
  assert.equal(originOfCheck({ steps: [{ op: 'goto', url: '/x' }] }, 'https://acme.example'), 'https://acme.example');
  assert.equal(originOfCheck({ steps: [] }), null);
});

// ---------------------------------------------------------------------------
section('5 · charts');
check('runs per day: passed neutral, failed the colour, dates as labels', () => {
  const s = runsPerDay([{ day: Date.UTC(2026, 8, 1), passed: 3, failed: 1 }, { day: Date.UTC(2026, 8, 2), passed: 0, failed: 2 }]);
  assert.equal(s.kind, 'chart');
  assert.equal(s.type, 'bar');
  assert.equal(s.stacked, true);
  assert.deepEqual(s.labels, ['2026-09-01', '2026-09-02']);
  assert.deepEqual(s.series.map((x) => [x.name, x.role, x.values]), [['Passed', 'pass', [3, 0]], ['Failed', 'fail', [1, 2]]]);
});
check('by suite: sideways, sorted, a pass rate in percent', () => {
  const s = bySuite([{ suite: 'Acme', runs: 10, passed: 9 }, { suite: 'Harbour', runs: 4, passed: 1 }], { metric: 'passRate' });
  assert.equal(s.horizontal, true);
  assert.equal(s.unit, '%');
  assert.deepEqual(s.labels, ['Acme', 'Harbour']);
  assert.deepEqual(s.series[0].values, [90, 25]);
  assert.deepEqual(bySuite([{ name: 'B', cases: 1 }, { name: 'A', cases: 5 }], { metric: 'cases' }).labels, ['A', 'B']);
});
check('defects: severity wears its colour, status too, in a fixed order', () => {
  const s = defectsBy('severity', { rows: [{ severity: 'low' }, { severity: 'critical' }, { severity: 'critical' }, { severity: null }] });
  assert.deepEqual(s.labels, ['critical', 'low', 'unrated']);
  assert.deepEqual(s.series[0].values, [2, 1, 1]);
  assert.deepEqual(s.series[0].roles, ['critical', 'neutral', 'neutral']);
  const t = defectsBy('status', { totals: { all: 5, open: 2, reopened: 1, closed: 2, known_issue: 0 } });
  assert.deepEqual(t.labels, ['open', 'reopened', 'known issue', 'closed']);
  assert.deepEqual(t.series[0].roles, ['critical', 'warn', 'neutral', 'good']);
  assert.deepEqual(monitorsByState([{ state: 'watching' }, { state: 'incident' }, { state: 'watching' }]).series[0].values, [1, 2]);
});
check('a table: the first text column as X, every number column as a series, dates a line', () => {
  const t = parseDelimited('month,revenue,cost,note\n2026-01,10,4,a\n2026-02,12,5,b\n2026-03,9,6,c\n');
  const { spec, x, y } = tableChart(t);
  assert.equal(x, 'month');
  assert.deepEqual(y, ['revenue', 'cost']);
  assert.equal(spec.type, 'line');
  assert.equal(spec.x, 'date');
  assert.deepEqual(spec.series[0].values, [10, 12, 9]);
  const named = tableChart(t, { x: 'note', y: 'cost' });
  assert.equal(named.spec.type, 'bar');
  assert.deepEqual(named.spec.labels, ['a', 'b', 'c']);
  assert.match(tableChart(t, { y: 'nope' }).why, /no column called "nope"/);
  assert.match(tableChart(t, { y: 'note' }).why, /not a column of numbers/);
  assert.match(tableChart(parseDelimited('a,b\nx,y\n')).why, /no column of numbers/);
});
check('the caps: sixty labels and four series, and a note that says so', () => {
  const cols = 'k,a,b,c,d,e';
  const rows = Array.from({ length: 70 }, (_, i) => `r${i},1,2,3,4,5`).join('\n');
  const { spec } = tableChart(parseDelimited(`${cols}\n${rows}\n`));
  assert.equal(spec.labels.length, LABELS_MAX);
  assert.equal(spec.series.length, SERIES_MAX);
  assert.match(spec.note, /the first 60 of 70/);
  const d = describeChart(spec);
  assert.equal(d[0].name, 'a');
  assert.equal(d[0].total, 60);
});

console.log(failures ? `\n  ${failures} failure${failures === 1 ? '' : 's'}\n` : '\n  all green\n');
process.exit(failures ? 1 : 0);
