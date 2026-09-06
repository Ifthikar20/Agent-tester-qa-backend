import { sleep } from './cursor.js';
import { parseTarget, locate, aliasesFor, discover } from './targets.js';
import * as origins from './origins.js';
import * as vault from './secrets.js';

const DEFAULT_ORIGIN = `http://localhost:${process.env.PORT || 3000}`;

/**
 * The gate in front of every navigation. The list is managed at runtime by a
 * person (see origins.js) — a plan can only ever be checked against it.
 *
 * Known gap: this checks the hostname, not what it resolves to, so a public
 * name pointing at a private address still gets through. The real fix is
 * resolve-and-pin, or an egress firewall on the container.
 */
export function checkUrl(url) {
  let u;
  try { u = new URL(url ?? ''); }
  catch { throw new Error('goto needs an absolute http(s) url'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`goto needs an http(s) url, got ${u.protocol}`);
  }
  if (origins.has(u.origin)) {
    // A wildcard is a blunt instrument, so it still does not reach the private
    // network — an internal origin has to be named on purpose.
    if (!origins.list().includes(u.origin) && origins.PRIVATE_HOST.test(u.hostname)) {
      throw new Error(`origin ${u.origin} is private — allow it by name, not by wildcard`);
    }
    return u;
  }
  throw new Error(`origin ${u.origin} is not allowed yet — allow it in the Page panel`);
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

/**
 * Did we end up anywhere near where the human clicked?
 *
 * The recorded point is NOT how the element is found — resolving it by name is
 * what survives a layout change. But it is evidence, and it is the only thing
 * that catches a target which resolves cleanly to the wrong element: the name
 * matched, one node came back, and it sits nowhere near where you pointed.
 */
function drift(at, box, viewport) {
  if (!at || !viewport) return null;
  // Scale for a different window than the one it was recorded in.
  const sx = viewport.width / (at.vw || viewport.width);
  const sy = viewport.height / (at.vh || viewport.height);
  const px = at.x * sx, py = at.y * sy;
  const inside = px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
  if (inside) return null;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  return { px: Math.round(px), py: Math.round(py), cx: Math.round(cx), cy: Math.round(cy),
           dist: Math.round(Math.hypot(cx - px, cy - py)) };
}

async function pointAt(page, target, ctx, opts = {}) {
  const node = el(page, target, ctx);
  await node.waitFor({ state: 'visible', timeout: 8000 });
  await node.scrollIntoViewIfNeeded();

  const box0 = await boxOf(node, target);
  const d = drift(opts.at, box0, page.viewportSize());
  if (d && ctx.emit) {
    ctx.emit({ t: 'log', level: 'warn',
      msg: `${target}: recorded at ${d.px},${d.py} but resolves to ${d.cx},${d.cy} — ${d.dist}px away. ` +
           `Fine if the layout moved; suspicious if it did not.` });
  }

  const [x, y] = point(box0, opts);
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

    // A goto to the URL already on screen does NOT reload — Chrome treats it as
    // a same-document navigation. So without this a run inherits whatever the
    // last one left behind: the flow passes because the app happened to still
    // be logged in, and fails on a machine that starts cold. performance
    // .timeOrigin only changes when a real document loads, so it is the honest
    // test for whether one did.
    const before = await page.evaluate(() => performance.timeOrigin).catch(() => null);
    await page.goto(step.url, { waitUntil: 'domcontentloaded' });
    const after = await page.evaluate(() => performance.timeOrigin).catch(() => null);
    if (before !== null && after === before) {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    if (ctx.onNavigate) await ctx.onNavigate(page);

    // Loading a URL is not the same as being where you were. In an SPA the path
    // is often decorative — pushed with history.pushState and never read on load
    // — so the entry URL of a recording made mid-session hands you the login
    // screen. Without this the run limps on and times out several steps later on
    // an element that was never going to be there.
    if (step.entry?.length) {
      const here = (await discover(page).catch(() => [])).map((t) => t.target);
      const found = step.entry.filter((t) => here.includes(t)).length;
      if (found / step.entry.length < 0.5) {
        throw new Error(
          `This recording starts part-way through a session. ${step.url} loads a ` +
          `different page than the one it was recorded on — ` +
          `${found} of ${step.entry.length} expected elements are here.\n` +
          `  expected: ${step.entry.slice(0, 6).join(', ')}\n` +
          `  found:    ${here.slice(0, 6).join(', ') || '(nothing interactive)'}\n` +
          `Record again from a URL that reaches this screen on its own — usually ` +
          `the login — so the flow can get itself back here.`
        );
      }
    }
  },

  async click(page, step, ctx) {
    await pointAt(page, step.target, ctx, { at: step.at });
    await ctx.cursor.click();
  },

  async fill(page, step, ctx) {
    await pointAt(page, step.target, ctx, { leftEdge: true, at: step.at });
    await ctx.cursor.click(); // focus the way a user does, not via .fill()
    const value = step.valueRef ? vault.get(step.valueRef) : step.value;
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
