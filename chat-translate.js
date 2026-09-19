/**
 * Test code → checks in this runner's language.
 *
 * A Playwright, Cypress, Selenium or Puppeteer test is a list of things done
 * to a page and things expected of it, and so is a check here — so most of it
 * carries across: `page.getByRole('button', { name: 'Sign in' }).click()`
 * is `click 'Sign in' : button`, `expect(page).toHaveURL(/dashboard/)` is an
 * arrival at `["/dashboard"]`. What does not carry is said, line by line,
 * with the reason: a CSS selector names nothing a person can read (a guess
 * is made from an id or a name attribute, and marked as one), a key press,
 * a checkbox or a dropdown are not in the language yet, and an absence
 * ("this must not be visible") cannot be checked.
 *
 * Nothing is executed. The code is read as text into the same IR the
 * recorder produces (vocabulary.js), written back by toFlow, and validated
 * by the same validator a saved case passes — the origin allowlist included
 * — before a person is asked whether to run it. A password typed by the
 * code becomes a vault reference ($PASSWORD) and the literal is never kept:
 * not in the check, not in the transcript, not in the reply.
 */
import { toFlow } from './flow.js';

export const FRAMEWORKS = Object.freeze(['playwright', 'cypress', 'selenium', 'puppeteer', 'flow']);
/** Checks one paste may become, and steps one check may have. */
export const CHECKS_MAX = 8;
export const STEPS_MAX = 40;
const NAME_MAX = 80;
const VALUE_MAX = 200;
const LINE_MAX = 160;

/** A value or a name the language cannot carry inside a label. */
const UNCARRIABLE = /[|;\n\r]|<<<|>>>/;
/** A field, a selector or a value that is a credential: never typed as a literal. */
const SECRETISH = /pass|secret|token|pwd|api[-_ ]?key/i;

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** A name as the language writes it: no quote that would end the label, no bar that would split it. */
const carriable = (s) => str(String(s ?? '').replace(/["|;\n\r]/g, ' '), NAME_MAX);

// ---- statements ------------------------------------------------------------------------------

const isPython = (text) => /^\s*(def \w+\(|from \w+ import |import \w+\s*$)/m.test(text) && !/[;{]\s*$/m.test(text.split('\n').slice(0, 40).join('\n'));

/**
 * The code as statements: split on `;` and on line ends outside brackets and
 * strings, comments gone. `{` and `}` are kept as their own statements so a
 * test's body can be told from the next test's.
 */
export function statements(text, { python = isPython(text) } = {}) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  // Every open brace: a block (a test's body, an arrow function's) or an
  // object literal. A block splits the statements inside it and is emitted
  // as its own '{' and '}', whatever brackets were open around it — a
  // test's body sits inside the parentheses of test(...) — so the bracket
  // depth is stacked at a block's start and restored at its end.
  const braces = [];
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const push = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  const lastWord = () => (cur.trim() || out[out.length - 1] || '').trim();
  const opensBlock = () => {
    if (python) return false;
    const before = lastWord();
    return /(?:\)|=>|\belse|\btry|\bfinally|\bdo)\s*$/.test(before) || before === '' || before === '{' || before === '}';
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += next ?? ''; i++; continue; }
      if (ch === quote) quote = null;
      if (ch === '\n' && quote !== '`') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '/' && next === '*') { const end = s.indexOf('*/', i + 2); i = end < 0 ? s.length : end + 1; continue; }
    if (!python && ch === '/' && next === '/') { const end = s.indexOf('\n', i); i = end < 0 ? s.length : end - 1; continue; }
    if (python && ch === '#') { const end = s.indexOf('\n', i); i = end < 0 ? s.length : end - 1; continue; }
    if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === '{') {
      if (opensBlock()) { push(); out.push('{'); braces.push({ block: true, depth }); depth = 0; }
      else { braces.push({ block: false }); depth++; cur += ch; }
      continue;
    }
    if (ch === '}') {
      const open = braces.pop();
      if (open?.block) { push(); out.push('}'); depth = open.depth; }
      else { depth = Math.max(0, depth - 1); cur += ch; }
      continue;
    }
    if ((ch === ';' || ch === '\n') && depth === 0) { push(); continue; }
    if (ch === '\\' && next === '\n' && python) { i++; continue; }
    cur += ch;
  }
  push();
  return out;
}

/** `a.b(c).d` → [{ name: 'a' }, { name: 'b', args: 'c' }, { name: 'd' }], splitting on dots outside brackets and strings. */
export function chain(expr) {
  const segs = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  const s = String(expr ?? '').trim();
  const flush = () => {
    const t = cur.trim();
    cur = '';
    if (!t) return;
    const m = t.match(/^([\w$]+)\s*(?:\((.*)\))?$/s);
    if (m) segs.push({ name: m[1], args: m[2] == null ? null : m[2].trim() });
    else segs.push({ name: t, args: null, raw: true });
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { cur += ch; if (ch === '\\') { cur += s[i + 1] ?? ''; i++; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === '.' && depth === 0 && !/\d$/.test(cur)) { flush(); continue; }
    cur += ch;
  }
  flush();
  return segs;
}

/** A call's arguments, split at the commas between them. */
export function splitArgs(args) {
  if (args == null || !args.trim()) return [];
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) { cur += ch; if (ch === '\\') { cur += args[i + 1] ?? ''; i++; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A string literal's text, a regex's source, or null for anything else. */
export function literal(arg) {
  const s = String(arg ?? '').trim();
  let m;
  if ((m = s.match(/^(['"`])([\s\S]*)\1$/))) {
    if (m[1] === '`' && /\$\{/.test(m[2])) return null;
    return { text: unescape(m[2]) };
  }
  if ((m = s.match(/^\/((?:\\.|[^/])+)\/([a-z]*)$/))) return { text: m[1].replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1').replace(/\.\*/g, ''), re: true };
  if ((m = s.match(/^r?(['"])([\s\S]*)\1$/))) return { text: unescape(m[2]) };
  return null;
}
const unescape = (s) => s.replace(/\\(n|t|\\|'|"|`)/g, (_, c) => ({ n: ' ', t: ' ' })[c] ?? c);
/** The `name` of an options object like `{ name: 'Sign in', exact: true }`. */
function optionName(arg) {
  const m = String(arg ?? '').match(/\bname\s*:\s*((['"`])(?:\\.|(?!\2).)*\2|\/(?:\\.|[^/])+\/[a-z]*)/);
  return m ? literal(m[1]) : null;
}

// ---- targets -------------------------------------------------------------------------------------

/** `first-name`, `firstName`, `email-input` → "First name", "Email". */
export function humanise(id) {
  const words = String(id ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.:]+/g, ' ').toLowerCase()
    .replace(/\b(input|field|txt|btn|button|link|box|control|elem|element)\b/g, '').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}
const ROLE_OF_TAG = { a: 'link', button: 'button', input: 'textbox', textarea: 'textbox', select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading', img: 'img', li: 'listitem' };
const SCOPE_OF_TAG = { nav: 'navigation', header: 'banner', footer: 'contentinfo', main: 'main', form: 'form', aside: 'complementary' };
const TYPE_NAMES = { email: 'Email', password: 'Password', search: 'Search', tel: 'Phone', url: 'URL', submit: 'Submit' };

/**
 * A CSS selector → a target, when the selector gives something a person
 * could read; `{ target, guessed }` or `{ why }`. The role comes from what
 * the step does with it: a thing typed into is a field, a thing clicked is a
 * button, a thing looked for is text.
 */
export function guessTarget(selector, verb = 'click') {
  const sel = String(selector ?? '').trim();
  let m;
  if ((m = sel.match(/^\[data-testid\s*=\s*["']?([^"'\]]+)["']?\]$/))) return { target: `testid:${m[1]}` };
  if ((m = sel.match(/^text\s*=\s*["']?(.+?)["']?$/))) return { target: `text:${m[1]}` };
  if ((m = sel.match(/^role\s*=\s*(\w+)\[name\s*=\s*["'](.+?)["']\]$/))) return { target: `${m[1]}:${m[2]}` };
  if ((m = sel.match(/^(a|button)?:(?:has-text|text|text-is)\(["'](.+?)["']\)$/))) return { target: `${m[1] === 'a' ? 'link' : m[1] === 'button' ? 'button' : 'text'}:${m[2]}` };
  if ((m = sel.match(/^\[data-(cy|test|qa)\s*=\s*["']?([^"'\]]+)["']?\]$/))) return { why: `data-${m[1]} is not data-testid, which is the one test id the runner reads` };
  if (/^\[data-testid|^\[data-test/.test(sel) === false && /xpath|^\/\/|^\(\/\//i.test(sel)) return { why: 'an XPath names nothing a person reads — write the role and name instead' };
  const fieldRole = verb === 'fill' ? 'label' : verb === 'expect' ? 'text' : 'button';
  if ((m = sel.match(/^(?:input|textarea|select)?\[type\s*=\s*["']?(\w+)["']?\]$/)) && TYPE_NAMES[m[1]]) {
    if (m[1] === 'submit') return { target: 'button:Submit', guessed: `guessed from ${sel}` };
    return { target: `${fieldRole}:${TYPE_NAMES[m[1]]}`, guessed: `guessed from ${sel}` };
  }
  if ((m = sel.match(/^(?:input|textarea|select|button|a|div|span)?#([\w-]+)$/)) || (m = sel.match(/^(?:input|textarea|select|button)?\[(?:name|id)\s*=\s*["']?([\w-]+)["']?\]$/))) {
    const name = humanise(m[1]);
    if (!name) return { why: `${sel} has no readable name` };
    return { target: `${fieldRole}:${name}`, guessed: `guessed from ${sel}` };
  }
  if ((m = sel.match(/^(button|a)\[type\s*=\s*["']?submit["']?\]$|^input\[type\s*=\s*["']?submit["']?\]$/))) return { target: 'button:Submit', guessed: `guessed from ${sel}` };
  if (/^[a-z][\w-]*$/i.test(sel) && ROLE_OF_TAG[sel]) return { why: `"${sel}" is every ${ROLE_OF_TAG[sel]} on the page — name the one you mean, as 'Sign in' : ${ROLE_OF_TAG[sel]}` };
  return { why: `the selector "${str(sel, 60)}" names nothing a person reads — the runner finds elements by role and accessible name, as 'Sign in' : button` };
}

/** `getByRole('link', { name: 'Pricing' })` and its cousins → a target string. */
function locatorFrom(seg, verb) {
  const args = splitArgs(seg.args);
  const a0 = literal(args[0]);
  switch (seg.name) {
    case 'getByRole': case 'findByRole': case 'findAllByRole': {
      const name = optionName(args[1]);
      if (!a0) return { why: 'a role that is not a literal' };
      if (!name) return SCOPE_OF_TAG[a0.text] || ['navigation', 'banner', 'contentinfo', 'main', 'form', 'complementary'].includes(a0.text) ? { scope: a0.text === 'nav' ? 'navigation' : a0.text } : { why: `${a0.text} without a name — the runner needs the accessible name too` };
      return { target: `${a0.text}:${name.text}` };
    }
    case 'getByText': case 'findByText': case 'findAllByText': return a0 ? { target: `text:${a0.text}` } : { why: 'text that is not a literal' };
    case 'getByLabel': case 'findByLabelText': return a0 ? { target: `label:${a0.text}` } : { why: 'a label that is not a literal' };
    case 'getByPlaceholder': case 'findByPlaceholderText': return a0 ? { target: `placeholder:${a0.text}` } : { why: 'a placeholder that is not a literal' };
    case 'getByTestId': case 'findByTestId': return a0 ? { target: `testid:${a0.text}` } : { why: 'a test id that is not a literal' };
    case 'getByTitle': case 'getByAltText': case 'findByTitle': case 'findByAltText': return { why: `${seg.name} — titles and alt text are not how the runner names things` };
    case 'locator': case 'get': case 'find': case '$': {
      if (!a0) return { why: 'a selector that is not a literal' };
      if (SCOPE_OF_TAG[a0.text]) return { scope: SCOPE_OF_TAG[a0.text] };
      return guessTarget(a0.text, verb);
    }
    case 'contains': {
      // cy.contains('Sign in') / cy.contains('button', 'Sign in')
      const a1 = literal(args[1]);
      if (a1 && a0) return { target: `${ROLE_OF_TAG[a0.text] ?? (/^\w+$/.test(a0.text) ? 'text' : 'text')}:${a1.text}` };
      return a0 ? { target: `text:${a0.text}` } : { why: 'text that is not a literal' };
    }
    default: return null;
  }
}

/** Selenium's `By.X, "value"` and `By.x("value")` → a target. */
function bySelenium(args, verb) {
  const joined = args.join(', ');
  let m;
  if ((m = joined.match(/By\.(ID|NAME|CSS_SELECTOR|CLASS_NAME|XPATH|LINK_TEXT|PARTIAL_LINK_TEXT|TAG_NAME)\s*,\s*((['"])(?:\\.|(?!\3).)*\3)/))) {
    const value = literal(m[2])?.text ?? '';
    return byKind(m[1].toLowerCase(), value, verb);
  }
  if ((m = joined.match(/By\.(id|name|css|cssSelector|className|xpath|linkText|partialLinkText|tagName)\s*\(\s*((['"])(?:\\.|(?!\3).)*\3)\s*\)/))) {
    const value = literal(m[2])?.text ?? '';
    return byKind(m[1].replace(/([A-Z])/g, '_$1').toLowerCase(), value, verb);
  }
  return { why: 'a locator that is not By.<kind> with a literal' };
}
function byKind(kind, value, verb) {
  switch (kind) {
    case 'id': return guessTarget(`#${value}`, verb);
    case 'name': return guessTarget(`[name="${value}"]`, verb);
    case 'css': case 'css_selector': return guessTarget(value, verb);
    case 'link_text': case 'partial_link_text': return { target: `link:${value}` };
    case 'class_name': return { why: `a class name (.${value}) names nothing a person reads` };
    case 'xpath': return { why: 'an XPath names nothing a person reads — write the role and name instead' };
    case 'tag_name': return { why: `every <${value}> on the page — name the one you mean` };
    default: return { why: `By.${kind} is not something the runner resolves` };
  }
}

// ---- one statement → steps ------------------------------------------------------------------------

const FRAMEWORK_WORDS = { playwright: 'Playwright', cypress: 'Cypress', selenium: 'Selenium', puppeteer: 'Puppeteer', flow: 'the flow language' };
const SKIP = /^(import|export|const|let|var|from|require|module\.exports|package|using|namespace|\}|\{|\)|\}\)|\]|\)\)|@\w+)/;
const KEYS = /\{(enter|tab|esc|escape|backspace|del|selectall|uparrow|downarrow|leftarrow|rightarrow|home|end|pageup|pagedown|shift|ctrl|alt|meta)\}/gi;

function clampWait(n) { return Math.min(5000, Math.max(100, Math.round((Number(n) || 0) / 100) * 100)); }
function pathOf(text) {
  const t = String(text ?? '').trim().replace(/^\*\*/, '');
  try { const u = new URL(t); return `${u.pathname}${u.search}${u.hash}`; } catch { return t.startsWith('/') || t.startsWith('#') || t.startsWith('?') ? t : `/${t.replace(/^\/+/, '')}`; }
}

/**
 * The step a statement asks for, in IR: `{ steps: [...], notes: [...] }`,
 * `{ why }` when it cannot be carried, `{ begin: name }` / `{ setup: true }`
 * / `{ end: true }` for the structure of the file, or null for a line that
 * means nothing to a runner.
 */
export function translateStatement(raw, framework) {
  const s = String(raw).trim().replace(/^await\s+/, '').replace(/^return\s+/, '').replace(/^(?:cy|page)\b\s*=\s*/, '');
  let m;
  if (!s) return null;
  // ---- structure, every framework -----------------------------------------------------------
  if ((m = s.match(/^(?:test|it|test\.only|it\.only|test\.skip|it\.skip|fit|xit)\s*\(\s*((['"`])(?:\\.|(?!\2).)*\2)/))) return { begin: literal(m[1])?.text ?? 'Check' };
  if ((m = s.match(/^(?:def|async def)\s+(test\w*)\s*\(/))) return { begin: humanise(m[1].replace(/^test_?/, '')) || m[1] };
  if ((m = s.match(/^(?:@Test\s*)?(?:public\s+)?(?:async\s+)?(?:void\s+|Task\s+)?(test\w*|should\w*)\s*\(\s*\)/))) return { begin: humanise(m[1].replace(/^test_?/, '')) || m[1] };
  if (/^(?:test\.)?(?:beforeEach|beforeAll|before)\s*\(|^def\s+(setUp|setup|setup_method)\s*\(|^@Before(Each)?\b/.test(s)) return { setup: true };
  if (/^(?:test\.)?(?:afterEach|afterAll|after)\s*\(|^def\s+(tearDown|teardown|teardown_method)\s*\(|^@After(Each)?\b/.test(s)) return { teardown: true };
  if (/^(?:test\.)?(?:describe|context)\s*\(|^class\s+\w+/.test(s)) return { describe: true };
  if (SKIP.test(s) || /^(?:driver\.(?:quit|close|implicitly_wait|maximize_window|set_window_size)|browser\.(?:close|newPage)|page\.close|cy\.(?:log|intercept|viewport|clearCookies|session)|time\.sleep\(0\))\b/.test(s)) return null;
  if (/^\w+\s*=\s*(?:webdriver|new\s+(?:webdriver|Builder|ChromeDriver|FirefoxDriver))|^(?:const|let|var)?\s*\{?\s*\w+\s*\}?\s*=\s*(?:await\s+)?(?:puppeteer|chromium|firefox|webkit)\.launch/.test(s)) return null;
  // ---- waits and time -------------------------------------------------------------------------
  if ((m = s.match(/^(?:page\.waitForTimeout|cy\.wait|driver\.sleep|time\.sleep|Thread\.sleep)\s*\(\s*(\d+(?:\.\d+)?)\s*\)/))) {
    const ms = /time\.sleep/.test(s) ? Number(m[1]) * 1000 : Number(m[1]);
    return { steps: [{ op: 'wait', ms: clampWait(ms) }] };
  }
  if (/^cy\.wait\s*\(\s*['"]@/.test(s) || /^page\.waitFor(?:LoadState|Navigation|Response|Request|Event|Function)\b|^page\.route\b|^page\.on\b/.test(s)) return null;
  if ((m = s.match(/^page\.waitForURL\s*\(\s*(.+)\)$/))) { const l = literal(splitArgs(m[1])[0]); return l ? { steps: [{ op: 'expect', assert: 'urlContains', value: pathOf(l.text) }] } : { why: 'a URL that is not a literal' }; }
  // ---- going somewhere ------------------------------------------------------------------------
  if ((m = s.match(/^(?:page\.goto|cy\.visit|driver\.get|driver\.navigate\(\)\.to|browser\.get|driver\.navigate\.to)\s*\(\s*(.+)\)$/))) {
    const l = literal(splitArgs(m[1])[0]);
    if (!l) return { why: 'an address that is not a literal — the runner needs the URL itself' };
    return { steps: [{ op: 'goto', url: l.text }] };
  }
  // ---- the URL ---------------------------------------------------------------------------------
  if ((m = s.match(/^expect\s*\(\s*page\s*\)\s*\.toHaveURL\s*\(\s*(.+)\)$/))) { const l = literal(splitArgs(m[1])[0]); return l ? { steps: [{ op: 'expect', assert: 'urlContains', value: pathOf(l.text) }] } : { why: 'a URL that is not a literal' }; }
  if ((m = s.match(/^cy\.(?:url|location)\s*\((?:\s*['"]pathname['"]\s*)?\)\s*\.should\s*\(\s*['"](?:include|contain|eq|equal|match)['"]\s*,\s*(.+)\)$/))) { const l = literal(m[1]); return l ? { steps: [{ op: 'expect', assert: 'urlContains', value: pathOf(l.text) }] } : { why: 'a URL that is not a literal' }; }
  if ((m = s.match(/(?:driver\.current_url|driver\.getCurrentUrl\(\)|page\.url\(\))/)) && (m = s.match(/((['"])(?:\\.|(?!\2).)*\2)/))) { const l = literal(m[1]); return l ? { steps: [{ op: 'expect', assert: 'urlContains', value: pathOf(l.text) }] } : null; }
  if (/expect\s*\(\s*page\s*\)\s*\.toHaveTitle|driver\.title|getTitle\(\)|page\.title\(\)|cy\.title\(\)/.test(s)) return { why: 'the page title is not something a check can see — check a heading on the page instead' };
  // ---- text on the page --------------------------------------------------------------------------
  if ((m = s.match(/(?:driver\.page_source|getPageSource\(\)|page\.content\(\)|document\.body\.(?:innerText|textContent))/)) && (m = s.match(/((['"])(?:\\.|(?!\2).)*\2)/))) { const l = literal(m[1]); return l ? { steps: [{ op: 'expect', assert: 'textVisible', value: l.text }] } : null; }
  // ---- chains: a subject, then what is done with it ------------------------------------------------
  const segs = chain(s.replace(/^(?:self\.)?/, ''));
  if (!segs.length) return null;
  const isExpect = segs[0].name === 'expect' && segs[0].args != null;
  let inner = isExpect ? chain(segs[0].args) : segs;
  const tail = isExpect ? segs.slice(1) : [];
  if (isExpect && inner[0]?.name === 'page' && inner.length === 1) return { why: `${str(s, 60)} — not something the runner checks` };
  const root = inner[0]?.name;
  if (!['page', 'cy', 'driver', 'browser', 'WebDriverWait', 'wait', 'expect'].includes(root) && !/find_element|findElement/.test(s)) return null;
  // Selenium waits: `WebDriverWait(driver, 10).until(EC.<condition>((By.X, "v")))`
  if (root === 'WebDriverWait' || (root === 'driver' && inner[1]?.name === 'wait')) {
    const found = s.match(/(?:EC|expected_conditions)\.(\w+)\s*\(\s*\((.*)\)\s*\)/) ?? s.match(/until\.(\w+)\s*\(\s*(.*)\)\s*(?:,\s*\d+)?\s*\)$/);
    if (!found) return { why: 'a wait whose condition the runner cannot read' };
    const t = bySelenium(splitArgs(found[2]), 'expect');
    if (t.why) return { why: t.why };
    return { steps: [{ op: 'expect', assert: 'textVisible', value: t.target.replace(/^\w+:/, '') }], notes: t.guessed ? [t.guessed] : [] };
  }
  // The locator: every getBy*/get/contains/find_element segment, with scope and nth.
  let target = null;
  let scope = null;
  let nth = null;
  const notes = [];
  let i = 1;
  const verbOf = (name) => (/^(fill|type|pressSequentially|send_keys|sendKeys|setValue|clear)$/.test(name) ? 'fill' : /^(should|toBeVisible|toHaveText|toContainText|toHaveValue|toBeHidden|toHaveCount|toBeEnabled|toBeDisabled|toBeChecked|toBeAttached|toHaveAttribute|toBeInViewport|toHaveClass|not)$/.test(name) ? 'expect' : 'click');
  const actionSeg = [...inner.slice(1), ...tail].find((g) => /^(click|dblclick|tap|fill|type|pressSequentially|send_keys|sendKeys|hover|check|uncheck|selectOption|select|press|clear|focus|blur|submit|scrollIntoViewIfNeeded|scrollIntoView|setInputFiles|should|trigger|rightclick|not|to[A-Z]\w*)$/.test(g.name));
  const verb = verbOf(actionSeg?.name ?? (isExpect ? 'toBeVisible' : 'click'));
  for (; i < inner.length; i++) {
    const seg = inner[i];
    if (seg.name === 'first') { nth = 1; continue; }
    if ((seg.name === 'nth' || seg.name === 'eq') && /^\d+$/.test(seg.args ?? '')) { nth = Number(seg.args) + 1; continue; }
    if (seg.name === 'last' || seg.name === 'within' || seg.name === 'filter' || seg.name === 'and' || seg.name === 'then') { if (seg.name === 'last') return { why: '.last() — the runner counts from the start; say which one, as nth2/link' }; continue; }
    if (/^(find_element|find_elements|findElement|findElements)$/.test(seg.name) || /^find_element_by_(id|name|css_selector|xpath|link_text|partial_link_text|class_name|tag_name)$/.test(seg.name)) {
      const kind = seg.name.replace(/^find_elements?_by_/, '');
      const t = kind === seg.name ? bySelenium(splitArgs(seg.args), verb) : byKind(kind, literal(splitArgs(seg.args)[0])?.text ?? '', verb);
      if (t.why) return { why: t.why };
      target = t.target; if (t.guessed) notes.push(t.guessed);
      continue;
    }
    const t = locatorFrom(seg, verb);
    if (!t) break;
    if (t.why) return { why: t.why };
    if (t.scope) { scope = t.scope; continue; }
    target = t.target; if (t.guessed) notes.push(t.guessed);
  }
  const rest = [...inner.slice(i), ...tail];
  if (target && scope) target = `${scope}/${target}`;
  if (target && nth && nth > 1) target = `nth${nth}/${target.replace(/^\w+\//, '')}`;
  const nameOf = (t) => String(t).replace(/^(?:\w+\/)?\w+:/, '');
  const unsupported = (what) => ({ why: `${what} is not in the language yet — ${target ? `'${nameOf(target)}'` : 'this step'} cannot be carried` });
  // Puppeteer: page.click('sel'), page.type('sel', 'v'), page.hover, page.waitForSelector
  if (!target && root === 'page' && rest[0] && /^(click|type|hover|waitForSelector|focus|select|tap)$/.test(rest[0].name)) {
    const a = splitArgs(rest[0].args);
    const sel = literal(a[0]);
    if (!sel) return { why: 'a selector that is not a literal' };
    const t = guessTarget(sel.text, rest[0].name === 'type' ? 'fill' : rest[0].name === 'waitForSelector' ? 'expect' : 'click');
    if (t.why) return { why: t.why };
    target = t.target; if (t.guessed) notes.push(t.guessed);
    if (rest[0].name === 'type') { const v = literal(a[1]); return v ? fillStep(target, v.text, notes) : { why: 'a value that is not a literal' }; }
    if (rest[0].name === 'waitForSelector') return { steps: [{ op: 'expect', assert: 'textVisible', value: nameOf(target) }], notes };
    if (rest[0].name === 'select') return unsupported('choosing from a dropdown');
    return { steps: [{ op: rest[0].name === 'hover' ? 'hover' : 'click', target }], notes };
  }
  if (!target) return rest.length || isExpect ? { why: `${str(s, 70)} — the runner could not find what this names` } : null;
  // What is done with it.
  const negated = rest.some((g) => g.name === 'not');
  for (const g of rest) {
    const a = splitArgs(g.args);
    switch (g.name) {
      case 'click': case 'tap': return { steps: [{ op: 'click', target }], notes };
      case 'hover': return { steps: [{ op: 'hover', target }], notes };
      case 'dblclick': case 'rightclick': return unsupported('a double or right click');
      case 'fill': case 'type': case 'pressSequentially': case 'send_keys': case 'sendKeys': case 'setValue': {
        const v = literal(a[0]);
        if (!v) return { why: 'a value that is not a literal' };
        const keys = v.text.match(KEYS) ?? (/Keys\.\w+/.test(a.join(',')) ? ['a key'] : []);
        const text = v.text.replace(KEYS, '').trim();
        const out = text ? fillStep(target, text, notes) : { why: `${g.name}: only a key press, which is not in the language yet` };
        if (keys.length && out.steps) out.notes = [...(out.notes ?? []), `the key press (${keys.join(', ')}) was left out — click the button instead`];
        return out;
      }
      case 'clear': case 'focus': case 'blur': continue;
      case 'check': case 'uncheck': return unsupported('ticking a checkbox');
      case 'selectOption': case 'select': return unsupported('choosing from a dropdown');
      case 'press': return unsupported('a key press');
      case 'submit': return unsupported('submitting a form by itself — click its button');
      case 'setInputFiles': case 'attachFile': case 'selectFile': return unsupported('uploading a file');
      case 'scrollIntoViewIfNeeded': case 'scrollIntoView': return { steps: [{ op: 'scroll', target }], notes };
      case 'trigger': return unsupported(`a "${literal(a[0])?.text ?? ''}" event`);
      case 'toBeVisible': case 'toBeAttached': case 'toBeInViewport':
        if (negated) return { why: 'an absence ("must not be visible") cannot be checked yet' };
        return { steps: [{ op: 'expect', assert: 'textVisible', value: nameOf(target) }], notes };
      case 'toBeHidden': return { why: 'an absence ("must be hidden") cannot be checked yet' };
      case 'toHaveText': case 'toContainText': {
        const v = literal(a[0]);
        if (!v) return { why: 'text that is not a literal' };
        if (negated) return { why: 'an absence of text cannot be checked yet' };
        return { steps: [{ op: 'expect', assert: 'textVisible', value: v.text }], notes };
      }
      case 'toHaveValue': {
        const v = literal(a[0]);
        if (!v) return { why: 'a value that is not a literal' };
        return { steps: [{ op: 'expect', assert: 'valueEquals', target, value: v.text }], notes };
      }
      case 'toBeEnabled': case 'toBeDisabled': case 'toBeChecked': case 'toHaveCount': case 'toHaveAttribute': case 'toHaveClass': case 'toBeEmpty': case 'toBeFocused': case 'toHaveCSS': case 'toHaveId':
        return { why: `${g.name} — only presence, text, a typed value and the URL can be checked` };
      case 'should': case 'and': {
        const what = literal(a[0])?.text ?? '';
        const v = literal(a[1]);
        if (/^(be\.visible|exist|be\.enabled)$/.test(what)) return { steps: [{ op: 'expect', assert: 'textVisible', value: nameOf(target) }], notes };
        if (/^(have\.text|contain|contain\.text|include\.text|have\.contain)$/.test(what)) return v ? { steps: [{ op: 'expect', assert: 'textVisible', value: v.text }], notes } : { why: 'text that is not a literal' };
        if (/^have\.value$/.test(what)) return v ? { steps: [{ op: 'expect', assert: 'valueEquals', target, value: v.text }], notes } : { why: 'a value that is not a literal' };
        if (/^not\./.test(what)) return { why: `an absence (${what}) cannot be checked yet` };
        return { why: `should('${what}') — only presence, text, a typed value and the URL can be checked` };
      }
      case 'contains': { const v = literal(a[0]); return v ? { steps: [{ op: 'expect', assert: 'textVisible', value: v.text }], notes } : { why: 'text that is not a literal' }; }
      case 'not': continue;
      default: continue;
    }
  }
  if (isExpect) return { why: `${str(s, 70)} — only presence, text, a typed value and the URL can be checked` };
  // A bare locator with nothing done to it (`cy.get('x')`) is not a step.
  return null;
}

/** A fill, with a credential turned into a vault reference so the literal is never kept. */
function fillStep(target, text, notes) {
  if (text.length > VALUE_MAX) return { why: 'a value longer than the language carries' };
  if (SECRETISH.test(target) || SECRETISH.test(text)) {
    const key = String(target).replace(/^(?:\w+\/)?\w+:/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'SECRET';
    return { steps: [{ op: 'fill', target, valueRef: `secrets.${key}` }], notes: [...notes, `typed from the vault as $${key} — set it under Origins & vault; the value in the code was not kept`] };
  }
  if (UNCARRIABLE.test(text)) return { why: 'a value the language cannot carry (a line break, a bar or a semicolon)' };
  return { steps: [{ op: 'fill', target, value: text }], notes };
}

// ---- the whole file -------------------------------------------------------------------------------

/** A source line, as it may be echoed: bounded, and with any typed value masked when it looks like a credential. */
function echo(line) {
  let s = str(line, LINE_MAX);
  if (SECRETISH.test(s)) s = s.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '$1…$1');
  return s;
}

/**
 * Code → `{ framework, checks, dropped, skipped }`. Each check is
 * `{ name, steps, notes, dropped }`; `dropped` lines carry the reason. Steps
 * before the first test (a beforeEach) are prepended to every test. A file
 * in the flow language is one check, taken as it is.
 */
export function translate(text, { framework = null, name = 'pasted code' } = {}) {
  const src = String(text ?? '');
  const fw = framework ?? detectFramework(src);
  if (!fw) return { framework: null, checks: [], dropped: [], skipped: 0, why: 'not a test the runner recognises — Playwright, Cypress, Selenium, Puppeteer or its own flow language' };
  if (fw === 'flow') {
    const title = src.match(/^%%\s*suite\s+"?(.+?)"?\s*$/m)?.[1];
    return { framework: 'flow', checks: [{ name: carriable(title ?? name) || 'Imported check', flow: src.slice(0, 4000), steps: null, notes: [], dropped: [] }], dropped: [], skipped: 0 };
  }
  const setup = { steps: [], notes: [] };
  const checks = [];
  const dropped = [];
  let skipped = 0;
  let cur = null;         // the check being read
  let inSetup = false;
  let teardown = false;
  let depth = 0;
  let openAt = null;      // the depth the current block opened at
  const target = () => (inSetup ? setup : cur);
  for (const st of statements(src)) {
    if (st === '{') { depth++; continue; }
    if (st === '}') { depth--; if (openAt != null && depth < openAt) { cur = null; inSetup = false; teardown = false; openAt = null; } continue; }
    let r;
    try { r = translateStatement(st, fw); } catch (err) { r = { why: `could not be read: ${err.message}` }; }
    if (!r) { skipped++; continue; }
    if (r.describe) continue;
    if (r.begin) { cur = { name: carriable(r.begin) || `Check ${checks.length + 1}`, steps: [], notes: [], dropped: [] }; checks.push(cur); inSetup = false; teardown = false; openAt = depth + 1; continue; }
    if (r.setup) { inSetup = true; teardown = false; cur = null; openAt = depth + 1; continue; }
    if (r.teardown) { teardown = true; inSetup = false; cur = null; openAt = depth + 1; continue; }
    if (teardown) { skipped++; continue; }
    const into = target();
    if (r.why) {
      const line = { line: echo(st), why: r.why };
      if (into) into.dropped.push(line); else dropped.push(line);
      continue;
    }
    if (!into) {
      // A step outside any test: a script with no test() at all is one check.
      cur = { name: carriable(name) || 'Imported check', steps: [], notes: [], dropped: [] };
      checks.push(cur);
      openAt = depth;
      cur.steps.push(...r.steps); cur.notes.push(...(r.notes ?? []));
      continue;
    }
    into.steps.push(...r.steps);
    into.notes.push(...(r.notes ?? []));
  }
  for (const c of checks) {
    if (setup.steps.length) { c.steps = [...setup.steps, ...c.steps]; c.notes = [...setup.notes, ...c.notes]; }
    c.notes = [...new Set(c.notes)];
  }
  return { framework: fw, checks: checks.slice(0, CHECKS_MAX), extra: Math.max(0, checks.length - CHECKS_MAX), dropped, skipped };
}
/** The test framework a piece of code is written for, from its own idioms; null when it is not test code. */
export function detectFramework(text) {
  const s = String(text ?? '');
  if (/^\s*(%%\s*suite\b|testcase\s+(TD|TB|LR|RL|BT)\b|flowchart\s+(TD|TB|LR|RL|BT)\b)/m.test(s) && /\(\(".*"\)\)/.test(s)) return 'flow';
  if (/\bcy\.(visit|get|contains|findBy\w+|url|wait|intercept)\s*\(/.test(s)) return 'cypress';
  if (/\bpage\.(goto|getBy\w+|locator|fill|click|waitForSelector|waitForURL)\s*\(|@playwright\/test|from ['"]@playwright\/test['"]/.test(s) && /\bexpect\s*\(|getBy\w+\s*\(|@playwright/.test(s)) return 'playwright';
  if (/\bpage\.(goto|click|type|waitForSelector|\$eval|\$\$eval|\$)\s*\(|puppeteer/.test(s)) return 'puppeteer';
  if (/\bdriver\.(get|find_element|findElement|current_url|getCurrentUrl|page_source|getPageSource|title)\b|\bBy\.(ID|NAME|CSS_SELECTOR|XPATH|LINK_TEXT|PARTIAL_LINK_TEXT|id|name|cssSelector|xpath|linkText|partialLinkText)\b|webdriver/.test(s)) return 'selenium';
  return null;
}

/**
 * A translated check → the flow document and its verdict: `{ ok, flow, steps }`
 * or `{ ok: false, why }`. `base` completes a relative address; `checkFlow`
 * is the caller's validator (server.js checkFlowFor), the one a saved case
 * passes, which is where the origin allowlist has its say.
 */
export function compileCheck(check, { suiteName = 'Imported', base = null, checkFlow }) {
  if (check.flow != null) {
    // The language itself: validated as it is, then written back so it is kept the way it will be read.
    try {
      const plan = checkFlow(check.flow);
      const flow = toFlow({ suite: plan.suite, steps: plan.steps });
      return { ok: true, flow, steps: plan.steps };
    } catch (err) { return { ok: false, why: `refused by the validator: ${err.message}` }; }
  }
  let steps = (check.steps ?? []).map((s) => ({ ...s }));
  if (!steps.length) return { ok: false, why: 'no steps the runner can carry' };
  if (steps.length > STEPS_MAX) return { ok: false, why: `more than ${STEPS_MAX} steps` };
  const first = steps.findIndex((s) => s.op === 'goto');
  if (first < 0) return { ok: false, why: base ? 'no address to open — the code never visits a page' : 'no address to open — the code never visits a page, and no suite was named to take one from' };
  if (first > 0) steps = [...steps.slice(first), ...steps.slice(0, first)];
  for (const s of steps) {
    if (s.op !== 'goto') continue;
    if (/^https?:\/\//i.test(s.url)) continue;
    if (!base) return { ok: false, why: `starts at the relative address ${s.url} — say which suite it belongs to, and its origin completes it` };
    try { s.url = new URL(s.url, base).href; } catch { return { ok: false, why: `${s.url} is not an address` }; }
  }
  if (!steps.some((s) => s.op === 'expect')) steps.push({ op: 'expect', assert: 'status', value: 200 });
  let flow;
  try { flow = toFlow({ suite: `${carriable(suiteName)} · ${check.name}`, steps }); } catch (err) { return { ok: false, why: `cannot be written: ${err.message}` }; }
  let plan;
  try { plan = checkFlow(flow); } catch (err) { return { ok: false, why: `refused by the validator: ${err.message}` }; }
  return { ok: true, flow, steps: plan.steps };
}

/** The origin a check opens first, for choosing the suite it belongs to. */
export function originOfCheck(check, base = null) {
  const g = (check.steps ?? []).find((s) => s.op === 'goto');
  if (!g) return null;
  try { return new URL(g.url, base ?? undefined).origin; } catch { return null; }
}

export const frameworkWord = (fw) => FRAMEWORK_WORDS[fw] ?? fw;
