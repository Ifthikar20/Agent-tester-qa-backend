import { sleep } from './cursor.js';
import { parseTarget, locate, aliasesFor } from './targets.js';

/** Never in the IR, never in a log, never in git. */
const secrets = {
  'secrets.QA_USER': 'qa@example.com',
  'secrets.QA_PASS': 'hunter2-but-from-a-vault',
};

const DEFAULT_ORIGIN = `http://localhost:${process.env.PORT || 3000}`;

/**
 * Which origins a plan may navigate to. Comma-separated, or `*`.
 *   ALLOWED_ORIGINS="https://staging.acme.com,https://app.acme.com" npm start
 */
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? DEFAULT_ORIGIN)
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Even under `*`, the private network stays off limits: a box that fetches
 * arbitrary internal URLs on instruction is an SSRF engine, and cloud metadata
 * endpoints live at 169.254.169.254. Naming an internal origin explicitly is
 * an opt-in; a wildcard is not.
 *
 * Known gap: this checks the hostname, not what it resolves to, so a public
 * name pointing at a private address still gets through. The real fix is
 * resolve-and-pin, or an egress firewall on the container.
 */
const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|.*\.local|.*\.internal)$/i;

export function checkUrl(url) {
  let u;
  try { u = new URL(url ?? ''); }
  catch { throw new Error('goto needs an absolute http(s) url'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`goto needs an http(s) url, got ${u.protocol}`);
  }
  if (ALLOWED_ORIGINS.includes(u.origin)) return u;
  if (ALLOWED_ORIGINS.includes('*')) {
    if (PRIVATE_HOST.test(u.hostname)) {
      throw new Error(`origin ${u.origin} is private — list it explicitly in ALLOWED_ORIGINS`);
    }
    return u;
  }
  throw new Error(`origin ${u.origin} is not allowlisted (set ALLOWED_ORIGINS)`);
}

function point(box, opts) {
  const x = box.x + (opts.leftEdge ? Math.min(14, box.width / 2) : box.width / 2);
  return [x, box.y + box.height / 2];
}

async function boxOf(el, target) {
  const b = await el.boundingBox();
  if (!b) throw new Error(`"${target}" resolved but has no box`);
  return b;
}

/** target -> locator, using the alias table for whatever origin we are on. */
function el(page, target, ctx) {
  return locate(page, parseTarget(target, aliasesFor(new URL(page.url()).origin)));
}

async function pointAt(page, target, ctx, opts = {}) {
  const node = el(page, target, ctx);
  await node.waitFor({ state: 'visible', timeout: 8000 });
  await node.scrollIntoViewIfNeeded();

  const [x, y] = point(await boxOf(node, target), opts);
  await ctx.cursor.glideTo(x, y, opts.ms);

  // The page can reflow during the glide — async content landing, a smooth
  // scroll still settling. Re-read and correct, or we click stale pixels.
  const [x2, y2] = point(await boxOf(node, target), opts);
  if (Math.hypot(x2 - ctx.cursor.x, y2 - ctx.cursor.y) > 2) await ctx.cursor.glideTo(x2, y2, 120);

  await sleep(140); // let hover settle, and let the viewer's eye catch up
  return node;
}

/**
 * The whole executable vocabulary. Five hand-written functions.
 * There is no `eval`, no `evaluate`, no raw-selector op. That absence is the
 * security model: there is structurally no path from generated text to
 * arbitrary code, whichever page the plan is pointed at.
 */
export const OPS = {
  async goto(page, step, ctx) {
    checkUrl(step.url);                       // re-checked at run time, not just at validate
    await page.goto(step.url, { waitUntil: 'domcontentloaded' });
    if (ctx.onNavigate) await ctx.onNavigate(page);
  },

  async click(page, step, ctx) {
    await pointAt(page, step.target, ctx);
    await ctx.cursor.click();
  },

  async fill(page, step, ctx) {
    await pointAt(page, step.target, ctx, { leftEdge: true });
    await ctx.cursor.click(); // focus the way a user does, not via .fill()
    const value = step.valueRef ? secrets[step.valueRef] : step.value;
    if (value === undefined) throw new Error(`No value for ${step.target}`);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(value, { delay: 42 });
  },

  async expect(page, step, ctx) {
    if (step.assert === 'urlContains') {
      await page.waitForURL((u) => u.href.includes(step.value), { timeout: 8000 });
    } else if (step.assert === 'textVisible') {
      await page.getByText(step.value, { exact: false }).first()
        .waitFor({ state: 'visible', timeout: 8000 });
    } else if (step.assert === 'valueEquals') {
      const actual = await el(page, step.target, ctx).inputValue();
      if (actual !== step.value) {
        throw new Error(
          `${step.target} is "${actual}" (${actual.length} chars), ` +
          `expected ${step.value.length} chars`
        );
      }
    } else {
      throw new Error(`Unknown assertion "${step.assert}"`);
    }
  },

  async wait(page, step) {
    await sleep(Math.min(step.ms ?? 500, 5000));
  },
};

/**
 * Validation gate. Runs between "something produced a plan" and "the browser
 * did something". With dynamic URLs the set of valid targets is no longer
 * known ahead of time, so the gate is two-layer:
 *
 *   here      — op vocabulary, origin allowlist, target GRAMMAR, no literal
 *               credentials. A target can never be a CSS or XPath string.
 *   run time  — the parsed target must actually resolve on the live page.
 *
 * The property that survives is the important one: a target is always looked
 * up through a semantic locator, never interpreted as a selector.
 */
export function validate(plan, baseOrigin = DEFAULT_ORIGIN) {
  if (!plan || !Array.isArray(plan.steps)) throw new Error('Plan has no steps');
  if (plan.steps.length > 60) throw new Error('Plan too long');

  let origin = baseOrigin;

  plan.steps.forEach((s, i) => {
    if (!OPS[s.op]) throw new Error(`Step ${i}: unknown op "${s.op}"`);

    if (s.op === 'goto') {
      try { origin = checkUrl(s.url).origin; }
      catch (e) { throw new Error(`Step ${i}: ${e.message}`); }
    }
    if ('target' in s) {
      // Walking the plan's navigation means aliases are checked against the
      // origin the step will actually run on.
      try { parseTarget(s.target, aliasesFor(origin)); }
      catch (e) { throw new Error(`Step ${i}: ${e.message}`); }
    }
    if (s.op === 'fill' && typeof s.value === 'string' && /pass|secret|token/i.test(s.value)) {
      throw new Error(`Step ${i}: literal credential — use valueRef`);
    }
  });

  return plan;
}
