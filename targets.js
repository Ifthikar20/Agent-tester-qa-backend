/**
 * Target resolution.
 *
 * A target is NEVER interpreted as a selector. It is parsed into one of a
 * fixed set of semantic locator strategies and looked up. There is no CSS
 * strategy, no XPath strategy, and no evaluate — which is what lets a
 * generated plan name targets on a page nobody hand-wrote a registry for.
 *
 *   button:Sign in        role shorthand  -> getByRole('button', {name})
 *   textbox:Email         role shorthand
 *   label:Username        -> getByLabel
 *   text:Profile saved    -> getByText
 *   placeholder:Search    -> getByPlaceholder
 *   testid:save-btn       -> getByTestId
 *   auth.email            an alias, which resolves to one of the above
 *
 * A target may be SCOPED with a `<scope>/` prefix:
 *
 *   navigation/link:Pricing   the Pricing link inside the nav
 *   contentinfo/link:Pricing  the one in the footer
 *   nth2/link:Pricing         the second one on the page, wherever it is
 *
 * This exists because real sites put the same link in the header and the
 * footer, and a recorder with nothing but role+name has to either guess or
 * drop the click. Dropping it is worse: you demonstrate eight steps and get a
 * script with three, and the first thing you learn is that the tool lies.
 *
 * The landmark scopes are ARIA landmarks — still semantics, still resolved
 * against the accessibility tree, still no selector. `nthN` is the last resort
 * and is the one fragile form here: it survives a restyle but not a reorder,
 * so it is proposed only after every semantic option has failed, and it is
 * visible in the script so you can see you have one.
 */

/** ARIA roles usable as a target prefix. Anything else is not a role. */
export const ROLES = new Set([
  'alert', 'banner', 'button', 'cell', 'checkbox', 'columnheader', 'combobox',
  'dialog', 'form', 'grid', 'gridcell', 'heading', 'img', 'link', 'list',
  'listbox', 'listitem', 'main', 'menu', 'menuitem', 'navigation', 'option',
  'progressbar', 'radio', 'region', 'row', 'rowheader', 'searchbox', 'slider',
  'spinbutton', 'status', 'switch', 'tab', 'table', 'tabpanel', 'textbox',
  'tooltip', 'tree', 'treeitem',
]);

/**
 * Landmark roles usable as a scope. These are the regions a page divides
 * itself into, and they are what tells the header's "Pricing" from the
 * footer's without either of them needing a test id.
 */
export const LANDMARKS = new Set([
  'banner', 'navigation', 'main', 'contentinfo', 'complementary', 'form',
  'region', 'search',
]);

const NTH = /^nth(\d+)$/;

const STRATEGIES = {
  // exact: a target names one element. Substring matching would make
  // `button:Add Widget` also match "Add Widget Pro" and resolve to two nodes.
  label:       (p, arg) => p.getByLabel(arg, { exact: true }),
  text:        (p, arg) => p.getByText(arg, { exact: false }),
  placeholder: (p, arg) => p.getByPlaceholder(arg),
  testid:      (p, arg) => p.getByTestId(arg),
};

/**
 * Optional per-origin aliases. Values are target strings in the grammar
 * above, never functions — so an alias table stays data and cannot smuggle
 * in a selector or a callback.
 */
const OWN_ORIGIN = `http://localhost:${process.env.PORT || 3000}`;

export const ALIASES = {
  // Keyed by the origin the demo apps are actually served from, so running on
  // another port does not quietly strand them.
  [OWN_ORIGIN]: {
    'auth.email':          'label:Email',
    'auth.password':       'label:Password',
    'auth.submit':         'button:Sign in',
    'nav.settings':        'link:Settings',
    'settings.profileTab': 'button:Profile',
    'profile.username':    'label:Username',
    'profile.save':        'button:Save changes',
  },
};

export const aliasesFor = (origin) => ALIASES[origin] ?? {};

/**
 * target string -> {kind, role?, name} or throw. Pure, so validate() can run
 * it before the browser has done anything.
 */
export function parseTarget(target, aliases = {}) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('Empty target');
  let raw = aliases[target] ?? target;

  // A scope prefix, if there is one. Split on the FIRST slash and only when
  // what precedes it is a landmark or an ordinal — so a name containing a
  // slash ("text:and/or") is still just a name.
  let scope = null;
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const head = raw.slice(0, slash);
    if (LANDMARKS.has(head) || NTH.test(head)) {
      scope = head;
      raw = raw.slice(slash + 1);
    }
  }

  const i = raw.indexOf(':');
  if (i < 1 || i === raw.length - 1) {
    throw new Error(
      `Bad target "${target}" — expected <role|label|text|placeholder|testid>:<name>` +
      (aliases[target] ? ' (from alias)' : '')
    );
  }
  const kind = raw.slice(0, i).trim();
  const arg = raw.slice(i + 1).trim();
  if (!arg) throw new Error(`Bad target "${target}" — empty name`);

  if (ROLES.has(kind)) return { kind: 'role', role: kind, name: arg, scope, source: target };
  if (kind in STRATEGIES) return { kind, name: arg, scope, source: target };
  throw new Error(`Unknown target strategy "${kind}" in "${target}"`);
}

/** Parsed target -> Playwright locator. */
export function locate(page, t) {
  const base = t.kind === 'role'
    ? page.getByRole(t.role, { name: t.name, exact: true })
    : STRATEGIES[t.kind](page, t.name);

  if (!t.scope) return base;

  const nth = NTH.exec(t.scope);
  if (nth) return base.nth(Number(nth[1]) - 1);          // 1-based, as written

  // Scoped to a landmark. `.first()` on the landmark because a page may
  // legitimately have several navs; the element's own landmark is the one the
  // proposer measured, and taking the first keeps resolution deterministic.
  const region = page.getByRole(t.scope).first();
  return t.kind === 'role'
    ? region.getByRole(t.role, { name: t.name, exact: true })
    : STRATEGIES[t.kind](region, t.name);
}

export const resolve = (page, target, aliases) => locate(page, parseTarget(target, aliases));

/**
 * What can this page be told to do? Reads Playwright's aria snapshot, which
 * is the same accessibility model getByRole queries — so everything listed
 * here is guaranteed to resolve. This is how a URL nobody wrote a registry
 * for becomes scriptable.
 */
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'tab', 'option', 'switch', 'slider', 'spinbutton', 'menuitem',
]);

export async function discover(page, limit = 80) {
  const snap = await page.locator('body').ariaSnapshot();
  const seen = new Map();

  for (const line of snap.split('\n')) {
    // "- button "Sign in"" / "- textbox "Email":" — role then quoted name.
    const m = line.match(/^\s*-\s+([a-z]+)\s+"((?:[^"\\]|\\.)*)"/);
    if (!m) continue;
    const [, role, name] = m;
    if (!INTERACTIVE.has(role)) continue;
    const target = `${role}:${name.replace(/\\(.)/g, '$1')}`;
    if (!seen.has(target)) seen.set(target, { target, role, name });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/**
 * The same-origin links on this page, as candidate pages.
 *
 * Onboarding a real app means naming its pages, and typing paths by hand is the
 * friction that ends with one page onboarded and the rest never done. The app
 * already lists its own routes — in its nav — so read them.
 *
 * Locators and getAttribute, not evaluate: this stays inside the same rule as
 * everything else, that the runner never executes page-supplied script. Foreign
 * origins are dropped here rather than offered and refused later, because a
 * suite covers one origin.
 */
export async function links(page, limit = 30) {
  const base = new URL(page.url());
  const anchors = (await page.locator('a[href]').all()).slice(0, 80);
  const found = new Map();

  for (const a of anchors) {
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.origin !== base.origin) continue;

    const path = `${u.pathname}${u.search}${u.hash}`;
    if (found.has(path)) continue;
    const name = (await a.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 60);
    found.set(path, { path, name: name || path });
    if (found.size >= limit) break;
  }
  return [...found.values()];
}
