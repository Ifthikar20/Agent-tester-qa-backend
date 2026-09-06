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
  // The origin travels ON the error, so a caller can offer the one button that
  // unblocks this instead of printing a sentence and stopping. The old text
  // pointed at a "Page panel" that no longer exists under that name.
  const err = new Error(`origin ${u.origin} is not allowed yet`);
  err.origin = u.origin;
  err.url = u.href;
  throw err;
}

/**
 * The navigation the page is actually showing.
 *
 * A click returns as soon as the event is dispatched; the response that carries
 * the redirect chain arrives afterwards. Asserting immediately therefore read
 * the PREVIOUS navigation and cheerfully reported "0 redirects" about a link
 * that took two.
 *
 * So wait for the chain to catch up with the address bar. The hash is ignored
 * when comparing: a same-document route change loads nothing, so the chain that
 * belongs to it is the one from the document it happened in.
 */
async function landed(page, ctx, timeout = 8000) {
  const deadline = Date.now() + timeout;
  const since = ctx.navMark ?? -1;
  const sameDocument = (a, b) => {
    try {
      const x = new URL(a), y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
    } catch { return a === b; }
  };

  for (;;) {
    const n = ctx.nav?.summary();
    // Newer than the action this assertion follows. Comparing URLs alone was
    // not enough: a click that has not committed yet leaves the address bar on
    // the old page, so the old chain matched and answered about the wrong one.
    if (n?.hops.length && n.seq > since) return n;
    if (Date.now() > deadline) {
      // Nothing new arrived. If we are still in the document the last chain
      // describes, that IS the answer — a hash route change loads nothing, so
      // no navigation was ever coming.
      if (n?.hops.length && sameDocument(n.url, page.url())) return n;
      throw new Error(
        n?.hops.length
          ? `nothing navigated after the previous step — still at ${page.url()}`
          : 'nothing has navigated yet, so there is no redirect chain to check');
    }
    await sleep(100);
  }
}

/** Remember where the navigation counter was, so `landed` can want a newer one. */
const markNav = (ctx) => { ctx.navMark = ctx.nav?.seq ?? -1; };

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

/** `menuitem:Catch harmful AI answers …` and `link:Catch harmful AI answers`. */
function nearby(target, here) {
  const name = target.slice(target.indexOf(':') + 1).toLowerCase().slice(0, 40);
  if (name.length < 4) return [];
  return here
    .filter((t) => t !== target)
    .filter((t) => {
      const other = t.slice(t.indexOf(':') + 1).toLowerCase();
      return other.startsWith(name.slice(0, 20)) || name.startsWith(other.slice(0, 20));
    })
    .slice(0, 4);
}

async function pointAt(page, target, ctx, opts = {}) {
  const node = el(page, target, ctx);
  try {
    await node.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    // "waiting for getByRole(…) to be visible" is true and useless. What the
    // page DOES offer is the thing that tells you why — most often a menu that
    // was open while you recorded and is shut now.
    const here = (await discover(page).catch(() => [])).map((t) => t.target);
    const near = nearby(target, here);
    throw new Error(
      `"${target}" never became visible.` +
      (near.length
        ? `\n  The page does have: ${near.join(', ')}.` +
          `\n  If yours lives in a menu, put a hover step before it:` +
          `\n    home -->|hover 'Use Cases' : link; click '…' : menuitem| home`
        : `\n  Nothing with a similar name is on the page right now.` +
          `\n  ${here.length} targets are — open "Targets on this page" to see them.`)
    );
  }
  await node.scrollIntoViewIfNeeded();

  const box0 = await boxOf(node, target);
  const d = drift(opts.at, box0, page.viewportSize());
  if (d && ctx.emit) {
    ctx.emit({ t: 'log', level: 'warn',
      msg: `${target}: recorded at ${d.px},${d.py} but resolves to ${d.cx},${d.cy} — ${d.dist}px away. ` +
           `Fine if the layout moved; suspicious if it did not.` });
  }

  const [x, y] = point(box0, opts);

  // Enter the box at the point nearest the cursor, THEN settle to the aim
  // point. A straight line from a menu trigger to an item below it cuts the
  // corner and leaves the region that keeps the menu open — the menu shuts
  // mid-glide and the element we were travelling to stops existing. Two short
  // legs stay inside, and it reads as an approach rather than a lunge.
  const inset = 4;
  const outside =
    ctx.cursor.x < box0.x || ctx.cursor.x > box0.x + box0.width ||
    ctx.cursor.y < box0.y || ctx.cursor.y > box0.y + box0.height;
  if (outside) {
    const ex = Math.min(Math.max(ctx.cursor.x, box0.x + inset), box0.x + box0.width - inset);
    const ey = Math.min(Math.max(ctx.cursor.y, box0.y + inset), box0.y + box0.height - inset);
    await ctx.cursor.glideTo(ex, ey, Math.round((opts.ms ?? 420) * 0.7));
  }
  await ctx.cursor.glideTo(x, y, outside ? 140 : opts.ms);

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
    markNav(ctx);

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

    // Where did we actually land?
    //
    // You allow `strix.ai`; the site redirects to `https://www.strix.ai`. That
    // is a different origin — different host, often a different scheme too — so
    // the browser goes there quite legitimately and everything looks fine, right
    // up until a recording made here refuses to replay because its entry URL
    // names an origin nobody approved. Say it now, at the moment it happens,
    // rather than three steps into a run tomorrow.
    //
    // It is not auto-allowed. Following a redirect is the browser's business;
    // trusting where it ends up is a person's.
    try {
      const landed = new URL(page.url()).origin;
      if (landed !== new URL(step.url).origin && !origins.has(landed)) {
        ctx.emit?.({ t: 'needs.origin', origin: landed, url: page.url(), redirected: true });
        ctx.emit?.({
          t: 'log', level: 'error',
          msg: `${step.url} redirected to ${landed}, which is not allowed. ` +
               `Anything recorded here will not replay until you allow it.`,
        });
      }
    } catch { /* not a parseable URL; nothing to compare */ }

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

  /**
   * Be somewhere, without clicking.
   *
   * A dropdown that opens on hover has no existence of its own — its items are
   * only in the page while the pointer is on the thing that opens them. Without
   * a way to say "go here and stay", such a menu is simply not expressible.
   */
  async hover(page, step, ctx) {
    await pointAt(page, step.target, ctx, { at: step.at });
    await sleep(Math.min(step.ms ?? 300, 5000));
  },

  async click(page, step, ctx) {
    await pointAt(page, step.target, ctx, { at: step.at });
    markNav(ctx);                 // anything after this must be a NEW navigation
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
      // Poll the URL rather than waitForURL.
      //
      // waitForURL waits for a NAVIGATION, and then for a load state — by
      // default `load`. Neither assumption survives contact with a real site:
      //
      //   - A hash change or a pushState is not a navigation, so on an SPA the
      //     URL is already right while waitForURL is still waiting for one.
      //   - `load` waits for every image, font and third-party tag. On a
      //     marketing page that is routinely more than eight seconds, and the
      //     assertion fails with "Timeout exceeded" about a URL that was
      //     correct the whole time.
      //
      // The assertion is "the URL contains this". Ask exactly that.
      const deadline = Date.now() + (step.timeout ?? 8000);
      let seen = page.url();
      while (!seen.includes(step.value)) {
        if (Date.now() > deadline) {
          // Say what IS true. "Timeout 8000ms exceeded" sends you to read the
          // wrong three files; the current URL usually names the real problem
          // in one line.
          const same = seen === (step.from ?? seen);
          throw new Error(
            `expected the URL to contain "${step.value}", but it is "${seen}"` +
            (same ? ' — the step before this one did not navigate anywhere' : '')
          );
        }
        await sleep(100);
        seen = page.url();
      }
    } else if (step.assert === 'status' || step.assert === 'redirects' || step.assert === 'via') {
      // What the last navigation actually did.
      //
      // A URL assertion passes on a friendly 404 and on a link that 301'd
      // through a path nobody maintains any more. These are the questions the
      // final URL cannot answer, so they are asked separately.
      const n = await landed(page, ctx);
      const trail = () => `\n  ${n.hops.map((h) => `${h.status ?? '?'}  ${h.url}`).join('\n  ')}`;

      if (step.assert === 'status') {
        if (n.status !== Number(step.value)) {
          throw new Error(`expected HTTP ${step.value}, got ${n.status} at ${n.url}${trail()}`);
        }
      } else if (step.assert === 'redirects') {
        if (n.redirects !== Number(step.value)) {
          throw new Error(
            `expected ${step.value} redirect${Number(step.value) === 1 ? '' : 's'}, ` +
            `got ${n.redirects}${trail()}`);
        }
      } else {
        if (!n.hops.some((h) => h.url.includes(step.value))) {
          throw new Error(`the redirect chain never passed through "${step.value}"${trail()}`);
        }
      }
    } else if (step.assert === 'atTop') {
      const y = await page.evaluate(() => window.scrollY);
      if (y > 8) throw new Error(`expected to be at the top of the page, but it is scrolled to ${Math.round(y)}px`);
    } else if (step.assert === 'textVisible') {
      // Intersect with the visible set BEFORE taking .first().
      //
      // getByText returns DOM order, and a hidden <label> or a screen-reader
      // string routinely comes first. Waiting on that one times out while the
      // words are plainly on screen somewhere else — the assertion reports the
      // page is broken when it is the query that is. The question is "is this
      // text visible anywhere", so ask that.
      //
      // `.and(locator('*:visible'))` rather than `.filter({ visible: true })`:
      // same result, and it works back to the Playwright floor in package.json.
      await page.getByText(step.value, { exact: false }).and(page.locator('*:visible')).first()
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

  /**
   * Move the page, on purpose.
   *
   * Every other op scrolls as a side effect — pointAt brings its target into
   * view before clicking — but that is not the same as scrolling being
   * expressible. A footer link you never reach, a lazy-loaded section, a page
   * that only reveals its pricing table once you are past the fold: none of
   * those are testable if the only way to move is to click something.
   *
   * Semantic, not pixels. `scroll to 'Docs' : link` survives a viewport change;
   * `scroll to 900px` does not, and would put the recording back in the
   * coordinate business the rest of this deliberately avoids. `top` and
   * `bottom` are the two positions that mean the same thing at any size.
   */
  async scroll(page, step, ctx) {
    if (step.to === 'top' || step.to === 'bottom') {
      await page.evaluate(
        (where) => window.scrollTo({ top: where === 'top' ? 0 : document.body.scrollHeight, behavior: 'instant' }),
        step.to,
      );
    } else {
      await el(page, step.target, ctx).scrollIntoViewIfNeeded({ timeout: 8000 });
    }
    await sleep(180);          // let sticky headers settle and the eye catch up
    ctx.emit?.({ t: 'log', level: 'info', msg: `scrolled to ${step.to ?? step.target}` });
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
      catch (e) {
        // Re-wrap for context, but carry the origin through — the UI turns it
        // into an Allow button, and a plain string cannot be pressed.
        const err = new Error(`Step ${i}: ${e.message}`);
        if (e.origin) { err.origin = e.origin; err.url = e.url; }
        throw err;
      }
    }
    if (s.op === 'scroll' && !s.target && s.to !== 'top' && s.to !== 'bottom') {
      throw new Error(`Step ${i}: scroll needs a target, or "top"/"bottom"`);
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
