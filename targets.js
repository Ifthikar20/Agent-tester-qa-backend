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
export const ALIASES = {
  'http://localhost:3000': {
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
  const raw = aliases[target] ?? target;

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

  if (ROLES.has(kind)) return { kind: 'role', role: kind, name: arg, source: target };
  if (kind in STRATEGIES) return { kind, name: arg, source: target };
  throw new Error(`Unknown target strategy "${kind}" in "${target}"`);
}

/** Parsed target -> Playwright locator. */
export function locate(page, t) {
  if (t.kind === 'role') return page.getByRole(t.role, { name: t.name, exact: true });
  return STRATEGIES[t.kind](page, t.name);
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
