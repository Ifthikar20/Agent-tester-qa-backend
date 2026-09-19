import { sleep } from './cursor.js';
import { parseTarget, locate, aliasesFor, discover, withoutIcons, LANDMARKS, ROLES } from './targets.js';
import { OP_NAMES, checkAction, showTarget } from './vocabulary.js';
import { PRIVATE_HOST, forOrg as originsOf } from './origins.js';
import { forOrg as vaultOf } from './secrets.js';
import { LOCAL } from './org.js';
import {
  modeOf, FIXED, fixFor, clickLine, dismissible, dismissButton, safeButton, LISTED, OPENERS, OPENER_TEST,
  OPENER_TRIES, OPENER_WAIT, POPUPS, FIELD_FORMS, FIELD_ROLES, FIELD_REACH, AI_OPS, MIN_CONFIDENCE, AI_REACH,
  WAIT_LONGER_MS, OP_ROLES, REF, checkDecision, gatherReport, composeReport, refLine, grammarOf,
  CONSENT, NEVER, HARMFUL, harmAdded, OPENER_REACH, ROLE_FAMILIES, redactSecrets, redactionsFor, lineHeader,
  LAYOUT_REACH, MOVED_MIN, RESOLVER_WAIT_MS, THINKING, refsIn, traceEntry, scrubUrls, maskPath,
} from './heal.js';

const DEFAULT_ORIGIN = `http://localhost:${process.env.PORT || 3000}`;

/**
 * How patient to be.
 *
 * TIMEOUT is how long a step waits for its target. SETTLE is how still the page
 * has to be before the next step starts — not a fixed delay, which is either
 * too short for a slow route or wasted on a fast one, but a quiet period the
 * page must actually go quiet for.
 *
 *   GC_TIMEOUT_MS=20000 npm start     a slow app
 *   GC_SETTLE_MS=600    npm start     an app that renders in stages
 *
 * Raising these fixes a race. It cannot fix a target that names something the
 * page does not have — a wrong name is wrong for as long as you care to wait,
 * which is why `pointAt` says which of the two it is instead of leaving you to
 * guess by turning the numbers up.
 */
const TIMEOUT = Number(process.env.GC_TIMEOUT_MS) || 8000;
const SETTLE = Number(process.env.GC_SETTLE_MS) || 250;

/**
 * How much of a replay is performance.
 *
 * TIMEOUT and SETTLE are about the page: how long to wait for it, how still it
 * must be. This is about the VIEWER. A run is streamed to a canvas at roughly
 * ten frames a second, so a pointer that teleports and a press with no duration
 * are simply not visible — the glides, the pause before a click and the typing
 * delay all exist so a person can follow what is happening.
 *
 * None of it is waiting for the page, and it adds up: about two thirds of a
 * second on every click step, plus 42ms per character typed. Worth every bit of
 * it when you are watching; pure cost when you are not.
 *
 *   GC_PACE_MS=0    npm start        as fast as the page allows
 *   GC_PACE_MS=250  npm start        brisk, still followable
 *
 * A run can also carry its own `pace`, so the same server can do both without
 * a restart.
 *
 * Parsed by hand rather than with `Number(...) || 420`, because that idiom
 * reads 0 as absent — and 0 is the entire point of this one.
 */
export const PACE = paceOf(process.env.GC_PACE_MS, 420);

export function paceOf(raw, fallback = 420) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 5000) : fallback;
}

/**
 * Each performance delay as a fraction of one pace unit.
 *
 * These were literals — 294, 140, 120, 140, 70, 42 — and every one of them is
 * an exact fraction of the 420ms glide they were tuned against. Naming the
 * relationship changes nothing at the default (the check asserts exactly that)
 * and makes the whole performance move with a single number.
 */
const APPROACH = 0.7;        // 294ms  entering the target's box
const AIM = 1 / 3;           // 140ms  settling to the aim point
const CORRECT = 1 / 3.5;     // 120ms  re-aiming after a reflow
const LINGER = 1 / 3;        // 140ms  letting hover settle, and the eye catch up
const PRESS = 1 / 6;         //  70ms  holding the button down
const KEYSTROKE = 1 / 10;    //  42ms  between characters
const DWELL = 1 / 1.4;       // 300ms  a hover with no duration of its own

/** One delay, at this run's pace. At pace 0 they are all zero. */
const beat = (pace, fraction) => Math.round(pace * fraction);

/**
 * Every performance delay at a given pace.
 *
 * Exported, and used by the code below rather than sitting beside it, so that
 * `check:pace` pins the numbers that actually run. A table a check agrees with
 * and the executor ignores would be worse than no table.
 */
export const performanceAt = (pace) => ({
  approach: beat(pace, APPROACH),
  aim: beat(pace, AIM),
  correct: beat(pace, CORRECT),
  linger: beat(pace, LINGER),
  press: beat(pace, PRESS),
  keystroke: beat(pace, KEYSTROKE),
  dwell: beat(pace, DWELL),
});
/**
 * How long to keep watching after a step gives up, purely to say WHY.
 *
 * This is paid on every failing step, so it is deliberately short. Something
 * that arrives within a couple of seconds of the deadline is the race worth
 * naming; something that takes another ten was never a timing problem you
 * would have solved by nudging the number.
 */
const GRACE = Number(process.env.GC_GRACE_MS) || 2500;
const SETTLE_CAP = Math.max(SETTLE * 8, 3000);

/**
 * Wait for the page to stop changing.
 *
 * A click on a real app starts a route change, a fetch and a re-render, and
 * the next step used to begin 120ms later regardless. This waits for a genuine
 * quiet period — no DOM mutations for SETTLE ms — and gives up at SETTLE_CAP so
 * an animation that never stops cannot stall a run.
 *
 * Every failure here is ignored on purpose: the page navigating out from under
 * the evaluation is the normal case, not an error.
 */
async function settle(page, ms = SETTLE) {
  if (ms <= 0) return;
  await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_CAP }).catch(() => {});
  await page.evaluate(({ quiet, cap }) => new Promise((done) => {
    let timer = setTimeout(done, quiet);
    const stop = setTimeout(() => { obs.disconnect(); done(); }, cap);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { clearTimeout(stop); obs.disconnect(); done(); }, quiet);
    });
    obs.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
  }), { quiet: ms, cap: SETTLE_CAP }).catch(() => {});
}

/**
 * The gate in front of every navigation. The list is managed at runtime by a
 * person (see origins.js) — a plan can only ever be checked against it.
 *
 * WHICH list is the calling organisation's, handed in by whoever holds the
 * token (docs/AUTH.md §10): a plan is checked against the allowlist of the
 * organisation that will run it, never against a process-wide one. The
 * default is the `local` organisation's, which is the laptop and the checks
 * that drive it with no token at all.
 *
 * Known gap: this checks the hostname, not what it resolves to, so a public
 * name pointing at a private address still gets through. The real fix is
 * resolve-and-pin, or an egress firewall on the container.
 */
export function checkUrl(url, origins = originsOf(LOCAL)) {
  let u;
  try { u = new URL(url ?? ''); }
  catch { throw new Error('goto needs an absolute http(s) url'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`goto needs an http(s) url, got ${u.protocol}`);
  }
  if (origins.has(u.origin)) {
    // A wildcard is a blunt instrument, so it still does not reach the private
    // network — an internal origin has to be named on purpose.
    if (!origins.list().includes(u.origin) && PRIVATE_HOST.test(u.hostname)) {
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

async function boxOf(el, target, timeout) {
  // `timeout` only when a position check held the press (placed): an element
  // that went away while the model answered fails the step in a second, not
  // after Playwright's thirty. Every other caller waits exactly as it did.
  const b = await (timeout ? el.boundingBox({ timeout }) : el.boundingBox());
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

const nameOfTarget = (t) => t.slice(t.indexOf(':') + 1);

/** A readable prefix, ending on a whole word. */
const shorten = (s, max) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, ''));

/** `menuitem:Catch harmful AI answers …` and `link:Catch harmful AI answers`. */
function nearby(target, here) {
  const name = nameOfTarget(target).toLowerCase().slice(0, 40);
  if (name.length < 4) return [];
  return here
    .filter((t) => t !== target)
    .filter((t) => {
      const other = nameOfTarget(t).toLowerCase();
      return other.startsWith(name.slice(0, 20)) || name.startsWith(other.slice(0, 20));
    })
    .slice(0, 4);
}

/**
 * Is this target a name the page still has, only mangled?
 *
 * Two mistakes produced exactly that, and both came from the recorder rather
 * than from the page changing:
 *
 *  - the name was CUT to a fixed length, so an exact lookup could never match;
 *  - the name was taken from RENDERED text, so `text-transform: uppercase`
 *    made it SHOUT while the accessible name did not.
 *
 * Both are fixed at the source now, but a script recorded before that stays
 * broken — the fix changes what gets written, not what is already written. So
 * when the live page has a name this one is a case-insensitive prefix of, say
 * so and hand back the target that would work, ready to paste.
 */
function repaired(target, here) {
  const want = nameOfTarget(target);
  const kind = target.slice(0, target.indexOf(':'));
  if (want.length < 12) return null;

  const hit = here.find((t) => {
    const real = nameOfTarget(t);
    return real.length > want.length && real.toLowerCase().startsWith(want.toLowerCase());
  });
  if (!hit) return null;

  const real = nameOfTarget(hit);
  const cut = real.length > want.length;
  const shouted = want !== real.slice(0, want.length);

  // Offer the shortest thing that still identifies it. A `text:` target matches
  // on a substring, so a readable prefix is both enough and what the recorder
  // produces now. Trimmed at a word boundary, not a sentence one — "vs." and
  // "e.g." are not the ends of sentences, and cutting there reads as a bug.
  const short = shorten(real, 72);
  const suggestion = short.length < real.length && short.length > 11
    ? `text:${short}`
    : `${kind}:${real}`;

  return { real, cut, shouted, suggestion };
}

/**
 * The controls on this page that open a list of options.
 *
 * An option is only in the page while its list is open, so an option that
 * never became visible usually belongs to a list nobody opened. Naming the
 * page's dropdowns turns a search into a choice between them.
 */
async function dropdowns(page, limit = 4) {
  const found = [];
  const all = await page.locator('[aria-haspopup="listbox"], [role="combobox"]').all().catch(() => []);
  for (const one of all.slice(0, 12)) {
    if (found.length >= limit) break;
    // The first line of its aria snapshot is the control itself, quoted the
    // way discover() reads it: `- button "California"`.
    let line = (await one.ariaSnapshot().catch(() => '')).split('\n')[0].replace(/^\s*-\s+/, '');
    if (line.startsWith("'")) line = line.slice(1, line.lastIndexOf("'")).replace(/''/g, "'");
    const m = line.match(/^([a-z]+)\s+"((?:[^"\\]|\\.)*)"/);
    if (m) found.push(`${m[1]}:${m[2].replace(/\\(.)/g, '$1')}`);
  }
  return found;
}

/**
 * On a failure, the frame the target is in — origin and path (heal.js
 * maskPath) — when the page has it and the target cannot: a symbol, so it
 * never reaches a JSON body or a log line. And on a failure the rules have
 * said everything about: no fix is tried for it, and the model is not asked
 * why (explainFailure), because the rule's words are already the answer.
 */
const IN_FRAME = Symbol('in-frame');
const EXPLAINED = Symbol('explained');

/**
 * The frame the target resolves in, when it is on the page but not OF it:
 * the first child frame where it is one visible element, as its origin and
 * path (maskPath). Null when no child frame has it, or the page has none.
 *
 * A sign-in button another site draws — Google's /gsi/button, Microsoft's
 * signinbutton — is the usual case. The recorder saw the press and wrote the
 * button's name, and the name is right; but a target names elements of the
 * page, and a locator on the page never reaches into a frame. No fix can
 * change that, and no amount of waiting: so it is worth a look in every
 * frame before saying "nothing like it is here", which would be false.
 */
async function frameHolding(page, target) {
  let frames;
  try { frames = page.frames().filter((f) => f !== page.mainFrame()); } catch { return null; }
  if (!frames.length) return null;
  let t;
  try { t = parseTarget(target, aliasesFor(new URL(page.url()).origin)); } catch { return null; }
  for (const frame of frames.slice(0, 8)) {
    const node = locate(frame, t);
    if ((await node.count().catch(() => 0)) < 1) continue;
    if (!(await node.first().isVisible().catch(() => false))) continue;
    return maskPath(frame.url()) ?? 'another site';
  }
  return null;
}

/**
 * Throw the reason a target never became visible — or only did late.
 *
 * Always throws. Its own function so the fixes below can have the failure
 * worked out BEFORE they touch the page, and throw exactly it if they do not
 * work: defect numbers fingerprint this text, and an opener left in a
 * different state must not change a word of it.
 */
async function explainMissing(page, target, late, opts) {
  if (late !== null) {
    const waited = opts.timeout ?? TIMEOUT;
    throw new Error(
      `"${target}" was not visible within ${waited}ms, but it appeared ${late}ms later.\n` +
      `  This is a timing problem, not a naming one — the element is correct.\n` +
      `  Give it longer:   GC_TIMEOUT_MS=${Math.ceil((waited + late) / 1000) * 1000} npm start\n` +
      `  Or let the page settle first, with a step before it:  wait ${Math.ceil(late / 100) * 100}ms`
    );
  }

  const frame = await frameHolding(page, target);
  if (frame) {
    // It is right there — inside a frame another site draws, which is not
    // the page. "Nothing like it is here" would be false, and every fix,
    // every wait and every rename is beside the point.
    const err = new Error(
      `"${target}" never became visible — it is on the page, but inside a frame loaded from ${frame}, ` +
      `and a step cannot reach inside a frame.\n` +
      `  A sign-in button another site draws is the usual case: the recorder saw the press, and no replay can make it.\n` +
      `  Remove the step, or record the flow without it — no fix can make it pass.`
    );
    err[IN_FRAME] = frame;
    throw err;
  }

  const here = (await discover(page).catch(() => [])).map((t) => t.target);
  const fix = repaired(target, here);
  if (fix) {
    // Not "it vanished" — it is right there under a name this one is a
    // mangled version of. Say which mangling, and give the replacement.
    const why = [fix.cut && 'cut short', fix.shouted && 'in the wrong case'].filter(Boolean).join(' and ');
    throw new Error(
      `"${target}" never became visible — but the page has that element, ` +
      `under a name this one is ${why}.\n` +
      `  on the page:  ${fix.real.slice(0, 96)}${fix.real.length > 96 ? '…' : ''}\n` +
      `  use instead:  ${fix.suggestion}\n` +
      `  Recordings made before this was fixed keep the old name — re-record the step, ` +
      `or paste the line above over it.`
    );
  }

  const near = nearby(target, here);
  // An option lives in a list, and a list nobody opened has no options at
  // all — so "nothing like it is here" is true, and the wrong thing to say.
  const option = !near.length && /(^|\/)option:/.test(target);
  const lists = option ? await dropdowns(page) : [];
  throw new Error(
    `"${target}" never became visible — and it did not turn up in the ` +
    `${(((opts.timeout ?? TIMEOUT) + GRACE) / 1000).toFixed(1)}s this waited, so waiting longer will not help.` +
    (near.length
      ? `\n  The page does have: ${near.join(', ')}.` +
        `\n  If yours lives in a menu, put a hover step before it:` +
        `\n    home -->|hover 'Use Cases' : link; click '…' : menuitem| home`
      : option
        ? `\n  An option is only on the page while its list is open, and nothing opened it.` +
          (lists.length
            ? `\n  The dropdowns here: ${lists.join(', ')} — click the one it belongs to in the step before.`
            : `\n  Click the control that opens its list in the step before.`) +
          `\n  Recordings made before this was fixed lost that click — re-record the step, or add the click by hand.`
        : `\n  Nothing with a similar name is on the page right now.` +
          `\n  ${here.length} targets are — open "Targets on this page" to see them.`)
  );
}

// ------------------------------------------------------------------ fixes
//
// Everything from here to pointAt runs only when ctx.heal says 'safe' or 'ai'
// (heal.js says what that promises, and what it never does). With it off none
// of it is reached, which is how "off" stays byte-for-byte what it was.

/**
 * Marks a failure a fix may still answer — the target never showed ('missing'),
 * or something is on top of it ('covered') — without changing a word of it.
 * A symbol, so it never reaches a JSON body or a log line.
 */
const HEALABLE = Symbol('healable');
const healable = (err, kind) => { err[HEALABLE] = kind; return err; };

/**
 * The fixes one step has made so far, by context.
 *
 * A fix is only REPORTED once its step has passed. A layer dismissed on the way
 * to a step that then fails anyway was an attempt, and attempts go to the log —
 * a suggestion to change a case built from a step that did not work would be a
 * suggestion nobody should accept. Keyed by the context rather than carried on
 * a copy of it, because the context is shared state: markNav writes to it.
 */
const pending = new WeakMap();

/**
 * Page text with the run's secrets taken out (heal.js redactionsFor).
 *
 * A fix note, a log line and the "covered by …" message all quote the page —
 * a dialog's heading, a button's name — and a page is free to print a session
 * token or an echoed password in exactly those places. None of them goes
 * through server.js's redact() on its way to the socket, and a note is written
 * to fixes.json, so they are redacted here, where they are made.
 */
const hide = (ctx, s) => (s == null ? s : redactSecrets(s, redactionsFor(ctx?.heal)));

/**
 * One entry of the step's trace (heal.js traceEntry), for ctx.heal.onTrace —
 * made the way a log line is made: the run's secrets out (hide), and the
 * values of URL parameters too, because a trace quotes addresses. Never with
 * fixes off, which says exactly what it always said; and a watcher that throws
 * is the watcher's problem, never the step's.
 */
const plain = (ctx, s) => (s == null ? null : scrubUrls(hide(ctx, String(s))));
function trace(ctx, kind, text, extra = {}) {
  if (modeOf(ctx) === 'off' || typeof ctx.heal?.onTrace !== 'function') return;
  const entry = traceEntry(kind, plain(ctx, text), { ...extra, detail: plain(ctx, extra.detail) });
  if (!entry) return;
  try { ctx.heal.onTrace(entry); } catch { /* nothing a display does may change the step */ }
}

/**
 * A fix took effect: say so now, report it when the step passes.
 *
 * `to` and `insert` are lines of the test itself — the script shows them, and
 * Accept writes them into the case — so they are never redacted. Redacting
 * them turned `button:Add Widget Pro` into `nth1/button:Add $SECRET Pro`, a
 * target that matches nothing. A vault or saved-session value must still never
 * be written into a test: a fix that would carry one counts for this run and
 * is not offered as a change.
 */
function applied(ctx, fix, msg) {
  // No message: the caller has already said what happened in its own words (a
  // position that moved is information, not a "fixed:" line).
  if (msg != null) ctx.emit?.({ t: 'log', level: 'info', msg: `${FIXED} ${hide(ctx, msg)}` });
  const secrets = Array.isArray(ctx?.heal?.secretValues) ? ctx.heal.secretValues : [];
  const carries = (s) => s != null && redactSecrets(s, secrets) !== s;
  const unsafe = carries(fix.to) || carries(fix.insert);
  const note = `${hide(ctx, fix.note)}${unsafe ? ' (not offered as a change: it would write a secret into the test)' : ''}`;
  pending.get(ctx)?.push({
    ...fix,
    note,
    to: unsafe ? null : fix.to,
    insert: unsafe ? null : fix.insert,
    reason: hide(ctx, fix.reason),
  });
  // What was done, on the step's trace. A position that moved did nothing to
  // the page, and the check that found it has said so there already.
  if (fix.kind !== 'moved') trace(ctx, 'did', note, { tier: fix.tier === 'ai' ? 'ai' : 'rule' });
}

/** Are two element handles the same node? */
const sameNode = (page, a, b) => page.evaluate(([x, y]) => x === y, [a, b]).catch(() => false);

/**
 * The contexts with a `step.thinking` sequence open: a model call has started
 * and its `done` has not been sent yet.
 *
 * `done` is the one phase that must ALWAYS arrive — a UI that shows "Working out
 * what changed…" until it does would otherwise say so forever after a refusal,
 * a timeout or a throw. So it is sent by whoever finishes last (consult, the
 * position check, and healing() around both, whatever happened), and this set
 * is what makes sending it twice harmless: only an open sequence is closed.
 */
const thinkingOpen = new WeakSet();

/**
 * One `step.thinking` phase, handed to ctx.heal.onThinking. The text is one of
 * heal.js THINKING's fixed phrases — never page text, never a value, never the
 * model's words — and a watcher that throws is the watcher's problem.
 */
function think(ctx, phase, text) {
  if (phase === 'done') {
    if (!thinkingOpen.has(ctx)) return;
    thinkingOpen.delete(ctx);
  } else {
    thinkingOpen.add(ctx);
  }
  try {
    ctx.heal?.onThinking?.(phase, phase === 'done' ? THINKING.done : (text ?? THINKING[phase]));
  } catch { /* nothing a display does may change the step */ }
}

/**
 * The contexts in the middle of a model's move (consult). A step retried with
 * the model's target has been judged already — region, distance, role — so the
 * position check below does not ask the model about it a second time; the
 * retry behaves exactly as a step did before any of this existed.
 */
const retrying = new WeakSet();

/**
 * The step each context last put a question to the model about (spend). A
 * step that already has the model's answer — a consult, a position check — is
 * not asked again why it failed (explainFailure): that answer is on its trace.
 */
const consulted = new WeakMap();

/**
 * The shortest target in the grammar that names exactly this element.
 *
 * Tried in order: each candidate inside the recorded landmark (the scope is
 * kept whenever it still says the same thing), then on its own; and only when
 * every candidate is ambiguous, the first role candidate counted in DOM order —
 * `nth2/button:Add to cart` — which is what targets.js resolves nthN against.
 * Null when nothing in the grammar reaches it: then it cannot be written into a
 * case, and a fix that cannot be written down is not made.
 */
async function expressible(page, handle, candidates, landmark) {
  const indexIn = async (target) => {
    let handles = [];
    try { handles = await locate(page, parseTarget(target)).elementHandles(); } catch { return { k: -1, n: 0 }; }
    try {
      for (let k = 0; k < handles.length; k++) {
        if (await sameNode(page, handles[k], handle)) return { k, n: handles.length };
      }
      return { k: -1, n: handles.length };
    } finally {
      for (const h of handles) await h.dispose().catch(() => {});
    }
  };
  const ambiguous = [];
  for (const target of candidates) {
    if (landmark) {
      const scoped = await indexIn(`${landmark}/${target}`);
      if (scoped.n === 1 && scoped.k === 0) return `${landmark}/${target}`;
    }
    const plain = await indexIn(target);
    if (plain.n === 1 && plain.k === 0) return target;
    if (plain.k >= 0 && ROLES.has(target.slice(0, target.indexOf(':')))) ambiguous.push([target, plain.k]);
  }
  const [target, k] = ambiguous[0] ?? [];
  return target ? `nth${k + 1}/${target}` : null;
}

/**
 * What is on top at the pixel a step is about to press, when it is not the
 * target.
 *
 * Runs IN the page, as a fixed function of the page's own DOM — nothing in it
 * comes from a plan, so it is no more a way in than settle() is.
 *
 * Null when nothing is in the way, and also when what is in the way is the
 * target's own business: its label (a floating label drawn over its input is
 * how half the form libraries do it, and a press there focuses the input), a
 * child, or an ancestor the press reaches anyway. Today's run presses all of
 * those and works; a safe fix that broke them would not be one.
 *
 * Otherwise it describes the LAYER the hit belongs to, in enough detail to
 * judge it — deliberately not from an aria snapshot, which prints what has been
 * typed into fields, passwords included. The words are read from text nodes,
 * never from a field, so no value is among them.
 *
 * Read through open shadow roots and CSS generated content, because a page
 * uses both: a consent manager drawn inside a web component is otherwise "a
 * div with no buttons", and an error printed by `::before` or inside a
 * component's shadow root was invisible to innerText — which is how a failed
 * save under a Welcome heading was closed and passed. Button labels are kept
 * apart from the words (heal.js dismissible says why).
 *
 * `button`, when given, is an element the caller wants to know is ON this
 * layer: the model's dismiss_blocker has to name a button of the layer that
 * covers the target, not any close button anywhere.
 */
function layerAt(target, { x, y, button = null }) {
  // One step up, crossing out of a shadow root to its host.
  const up = (e) => e.parentElement ?? (e.parentNode instanceof ShadowRoot ? e.parentNode.host : null);
  const holds = (outer, inner) => { for (let e = inner; e; e = up(e)) if (e === outer) return true; return false; };
  // The deepest element at a point, through open shadow roots.
  const deepAt = (px, py) => {
    let e = document.elementFromPoint(px, py);
    while (e?.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  };
  const hit = deepAt(x, y);
  if (!hit || hit === target || holds(target, hit) || holds(hit, target)) return null;
  if (hit.closest('label')?.control === target) return null;

  const MODAL = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
  const FIELDS = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), ' +
    'textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], ' +
    '[role="combobox"], [role="checkbox"], [role="radio"], [role="spinbutton"]';
  const ALERTS = '[role="alert"], [aria-live="assertive"]';
  const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  // querySelectorAll, and the same inside every open shadow root below.
  const deepAll = (root, sel) => {
    const out = [...root.querySelectorAll(sel)];
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) out.push(...deepAll(e.shadowRoot, sel));
    return out;
  };
  const deepIn = (e, sel) => [...(e.matches?.(sel) ? [e] : []), ...deepAll(e, sel), ...(e.shadowRoot ? deepAll(e.shadowRoot, sel) : [])];
  const byId = (e, id) => e.getRootNode()?.getElementById?.(id) ?? document.getElementById(id);
  const nameOf = (e) => {
    const by = e.getAttribute('aria-labelledby');
    return squash(e.getAttribute('aria-label') ||
      (by ? by.split(/\s+/).map((id) => byId(e, id)?.textContent ?? '').join(' ') : ''));
  };
  const hasButton = (e) => deepIn(e, BUTTONS).some(shown);
  // What a layer says outside its buttons and fields: text nodes, generated
  // content, and shadow content, skipping anything not displayed.
  const wordsOf = (root) => {
    const parts = [];
    const generated = (e, which) => {
      const m = getComputedStyle(e, which).content.match(/^"((?:[^"\\]|\\.)*)"$/s);
      if (m) parts.push(m[1].replace(/\\(.)/g, '$1'));
    };
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) { parts.push(n.nodeValue); return; }
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName) || n.matches(BUTTONS) || n.matches(FIELDS)) return;
        const style = getComputedStyle(n);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        generated(n, '::before');
        if (n.shadowRoot) for (const c of n.shadowRoot.childNodes) walk(c);
        for (const c of n.childNodes) walk(c);
        generated(n, '::after');
      }
    };
    walk(root);
    return squash(parts.join(' '));
  };

  // Which layer. Walk up from the hit, never as far as anything that also
  // holds the target — that is the page, not something over it. Of the
  // positioned (or modal) ancestors on the way, the innermost one with a button
  // on it: a dropdown in a sticky header is the dropdown, not the header and
  // everything the header says. A layer with no button at all is usually a
  // bare backdrop, and its dialog is its sibling; take that when there is one.
  const positioned = [];
  let top = hit;
  for (let e = hit; e && e !== document.body && e !== document.documentElement; e = up(e)) {
    if (holds(e, target)) break;
    top = e;
    if (/^(fixed|sticky|absolute)$/.test(getComputedStyle(e).position) || e.matches(MODAL)) positioned.push(e);
  }
  let layer = positioned.find(hasButton) ?? positioned[positioned.length - 1] ?? top;
  if (!hasButton(layer)) {
    const modals = deepAll(document, MODAL).filter((d) => shown(d) && !holds(d, target));
    if (modals.length === 1) layer = modals[0];
  }

  const dialog = layer.matches(MODAL) ? layer : deepIn(layer, MODAL)[0] ?? null;
  const heading = deepIn(dialog ?? layer, 'h1, h2, h3, h4, [role="heading"]')[0];
  const name = nameOf(layer) || (dialog ? nameOf(dialog) : '') || squash(heading?.textContent);
  const role = (dialog ?? layer).getAttribute('role') || (dialog ?? layer).tagName.toLowerCase();
  // An alert anywhere on the layer, or around it, is what the page wants seen.
  let alert = null;
  for (let e = layer; e && !alert; e = up(e)) if (e.matches(ALERTS)) alert = 'alert';
  if (!alert && deepIn(layer, ALERTS).some(shown)) alert = 'alert';
  if (!alert && [layer, ...deepIn(layer, '[role="alertdialog"]')].some((e) => e.getAttribute('role') === 'alertdialog' && shown(e))) {
    alert = 'alertdialog';
  }
  const buttons = deepIn(layer, BUTTONS).filter(shown).slice(0, 24).map((b) => {
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const on = deepAt(cx, cy);
    return {
      name: nameOf(b) || squash(b.textContent) || squash(b.value) || squash(b.title),
      x: cx, y: cy, onTop: Boolean(on && (on === b || holds(b, on))),
    };
  });
  return {
    what: `${role}${name ? ` "${name.slice(0, 60)}"` : ''}`,
    name,
    text: wordsOf(layer).slice(0, 2000),
    fields: deepIn(layer, FIELDS).filter(shown).length,
    buttons,
    alert,
    holds: button ? holds(layer, button) : null,
  };
}

/**
 * Would a press on the target reach it? Null if so; the layer in the way if not.
 *
 * Playwright's trial click is the question asked properly — it waits for the
 * element to be stable and hit-tests the point, and does nothing else: no
 * press, no move, so a hover menu is not opened by asking. It is asked about
 * the pixel the cursor will really press (the left edge, for a fill), not the
 * centre. Any other reason the trial fails — disabled, still animating — is not
 * this fix's business: the step goes on and does what it does today.
 */
async function coveredBy(node, opts, button = null) {
  const box = await node.boundingBox().catch(() => null);
  if (!box) return null;
  const [x, y] = point(box, opts);
  try {
    await node.click({ trial: true, timeout: 1000, position: { x: x - box.x, y: y - box.y } });
    return null;
  } catch (err) {
    if (!/intercepts pointer events/.test(err.message ?? '')) return null;
  }
  const now = await node.boundingBox().catch(() => null) ?? box;   // the trial may have scrolled
  return node.evaluate(layerAt, { x: point(now, opts)[0], y: point(now, opts)[1], button }).catch(() => null);
}

/** How long a dismissed layer has to stay gone before the press it cleared the way for. */
const GONE_FOR = 300;

/**
 * Get a harmless layer out of the way of a click or a fill — once.
 *
 * Today the press lands on the banner and the step is marked passed; the case
 * fails two steps later with "did not navigate", the words a dead button
 * produces. That is the worst kind of failure, because it points at the app.
 *
 * So: a layer that reads as a cookie notice, a newsletter or an announcement,
 * with no field on it and nothing that reads as an error or a question, is
 * dismissed by its reject button, or failing that its close button — never by
 * anything that agrees (heal.js). Anything else in the way stops the step,
 * naming it. That is a change from today, and the right one: the step it stops
 * was going to press the layer and report success.
 */
async function uncover(page, node, target, ctx, opts) {
  const layer = await coveredBy(node, opts);
  if (!layer) return null;
  trace(ctx, 'saw', `${showTarget(target)} is covered by ${layer.what}`);

  const verdict = dismissible(layer);
  const consent = CONSENT.test(`${layer.name}\n${layer.text}`);
  // Only a button a press would actually reach — one under another layer is
  // not a way out of this one.
  const choice = verdict.ok ? dismissButton(layer.buttons.filter((b) => b.onTop).map((b) => b.name), { consent }) : null;
  if (!choice) {
    const names = layer.buttons.map((b) => b.name).filter(Boolean).slice(0, 4);
    trace(ctx, 'rule', `Not closed, because ${!verdict.ok ? verdict.why
      : consent ? 'a cookie or consent notice is only answered with its reject button, and it has none'
        : 'none of its buttons is a safe way out'}`, { tier: 'rule', ok: false });
    throw healable(new Error(hide(ctx,
      `"${target}" is covered by ${layer.what}, and it was not dismissed, because ` +
      (!verdict.ok
        ? `${verdict.why}.`
        : consent
          ? `a cookie or consent notice is only ever answered with its reject button, and it has none${names.length ? ` (${names.join(', ')})` : ''}.`
          : `none of its buttons is a safe way out${names.length ? ` (${names.join(', ')})` : ''}.`) +
      `\n  A press here would land on that layer, not on the target — so the step stops instead of reporting a press that missed.` +
      `\n  Fixes dismiss only a cookie notice, a newsletter or an announcement, and only by its reject or close button.`
    )), 'covered');
  }

  const button = layer.buttons.find((b) => b.onTop && b.name === choice);
  const perf = performanceAt(ctx.pace ?? PACE);
  // Pressed with the cursor like every other press, so the feed shows it.
  await ctx.cursor.glideTo(button.x, button.y, perf.approach);
  await ctx.cursor.click(perf.press);
  const pressedAt = Date.now();
  applied(ctx, fixFor(ctx, opts.step, opts.op, { kind: 'closed_popup', note: `Closed the ${layer.what} with '${choice}'` }),
    `"${target}" was covered by ${layer.what} — pressed "${choice}" to dismiss it.`);
  await settle(page);

  const still = await coveredBy(node, opts);
  if (still) {
    trace(ctx, 'saw', `It is still covered, by ${still.what}`);
    throw healable(new Error(hide(ctx,
      `"${target}" is still covered, by ${still.what}, after pressing "${choice}" on ${layer.what}.` +
      `\n  A fix dismisses one layer per step; whatever is left is in the way of the target.`
    )), 'covered');
  }
  await node.scrollIntoViewIfNeeded();
  return { what: layer.what, choice, pressedAt };
}

/**
 * A dismissed layer that came back.
 *
 * Asked once more just before the press, and no sooner than GONE_FOR after the
 * dismissal: a consent script that re-inserts its banner 160ms later would
 * otherwise catch the press while the step reports a fix — and the case fails
 * a step later with "did not navigate", the misleading failure uncover exists
 * to prevent.
 */
async function stillUncovered(node, target, ctx, opts, dismissed) {
  const wait = GONE_FOR - (Date.now() - dismissed.pressedAt);
  if (wait > 0) await sleep(wait);
  const back = await coveredBy(node, opts);
  if (back) {
    trace(ctx, 'saw', `${back.what} came back after "${dismissed.choice}" was pressed, and covers it again`);
    throw healable(new Error(hide(ctx,
      `"${target}" is covered again, by ${back.what}, after pressing "${dismissed.choice}" on ${dismissed.what} — it came back.` +
      `\n  A fix dismisses one layer per step; a layer that returns is in the way of the target.`
    )), 'covered');
  }
}

/**
 * An opener, as the page describes it: is it a link, is it shut, what is it
 * called — and the role and name a target would reach it by, so the click the
 * recording lost can be offered back as a step.
 */
function openerFacts(e) {
  const role = e.getAttribute('role');
  const by = e.getAttribute('aria-labelledby');
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const label = squash(e.getAttribute('aria-label') ||
    (by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : ''));
  const name = (label || squash(e.textContent) || squash(e.getAttribute('placeholder'))).slice(0, 60);
  const tag = e.tagName.toLowerCase();
  const implicit = tag === 'button' ? 'button' : tag === 'select' ? 'combobox'
    : tag === 'input' && ['button', 'submit', 'reset'].includes(e.type) ? 'button' : null;
  return {
    link: role === 'link' || (!role && e.matches('a[href], area[href]')),
    collapsed: e.getAttribute('aria-expanded') === 'false',
    what: `${role || tag}${name ? ` "${name}"` : ''}`,
    role: role || implicit,
    name: label || (tag === 'select' ? '' : squash(e.textContent)),
  };
}

/**
 * Press an opener with the cursor. The trial first, so a control under a layer
 * is skipped rather than pressed through it — except when shutting one again,
 * where an open list commonly makes the rest of the page ignore the pointer
 * and the press that closes it is SUPPOSED to land outside.
 */
async function press(handle, ctx, trial = true) {
  if (trial) {
    try { await handle.click({ trial: true, timeout: 1000 }); } catch { return false; }
  }
  const box = await handle.boundingBox().catch(() => null);
  if (!box) return false;
  const perf = performanceAt(ctx.pace ?? PACE);
  await ctx.cursor.glideTo(box.x + box.width / 2, box.y + box.height / 2, perf.approach);
  await ctx.cursor.click(perf.press);
  return true;
}

/** Poll until a locator is exactly one visible element, for up to `ms`. */
async function soleVisible(locator, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if ((await locator.count().catch(() => 0)) === 1 && (await locator.isVisible().catch(() => false))) return true;
    if (Date.now() >= end) return false;
    await sleep(50);
  }
}

/**
 * Put back an opener that did not hold the target. True once it is shut:
 * not expanded, and no more popups showing than before it was pressed.
 *
 * Escape first. A list that ignores Escape — select.html's does — still says
 * aria-expanded="true", and then the opener is pressed again, which toggles it.
 * Pressing a SHUT opener would open it, so the second press only happens while
 * it still says it is open. Then a wait, because a list can outlive its close
 * for an exit animation (select.html removes its 120ms later).
 */
async function shut(page, handle, ctx, before) {
  const expanded = async () => (await handle.getAttribute('aria-expanded').catch(() => null)) === 'true';
  const until = async (ms, done) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await done()) return true;
      if (Date.now() >= end) return false;
      await sleep(40);
    }
  };
  await page.keyboard.press('Escape').catch(() => {});
  // Most lists shut on Escape in the same task; give the rest a moment before
  // deciding it was ignored, or the second press re-opens what was closing.
  if (!(await until(150, async () => !(await expanded())))) await press(handle, ctx, false);
  return until(OPENER_WAIT, async () =>
    !(await expanded()) && (await page.locator(POPUPS).count().catch(() => 0)) <= before);
}

/**
 * The target lives in a list nobody opened: open it.
 *
 * An option is only in the page while its list is open, and a recording can
 * lose the click that opened it (select.html's State list opens on the press,
 * and the click the recorder listened for never came). The recorded target is
 * kept EXACTLY — this finds the list it is in, it never looks for something
 * like it.
 *
 * The openers are taken ONCE, as element handles, before anything is pressed.
 * A positional list re-read after each try shifts under you as openers change
 * state: in the experiment, once the first one had been opened and shut, the
 * second was never tried at all.
 */
async function revealHidden(page, target, node, ctx, opts) {
  let t;
  try { t = parseTarget(target, aliasesFor(new URL(page.url()).origin)); } catch { return null; }
  const listed = t.kind === 'role' && LISTED.has(t.role);
  const loose = t.kind === 'text' || (t.kind === 'role' && t.role === 'link');
  if (!listed && !loose) return null;

  const handles = await page.locator(OPENERS).elementHandles().catch(() => []);
  try {
    const openers = [];
    for (const handle of handles) {
      if (!(await handle.isVisible().catch(() => false))) continue;
      const facts = await handle.evaluate(openerFacts).catch(() => null);
      const box = await handle.boundingBox().catch(() => null);
      // Never a link: pressing one to see what it opens leaves the page.
      if (!facts || facts.link || !box) continue;
      // Never a control whose name says it DOES something. A split button —
      // "Publish ▾", "Delete ▾" — has aria-haspopup and performs its action
      // on the press; a review of this rule watched "Publish" pressed twice
      // (the look, then the shut) while it hunted for a removed link.
      if (NEVER.test(facts.name) || HARMFUL.test(facts.name)) continue;
      openers.push({ handle, box, ...facts });
    }
    // A text or link target is not obviously in a list at all. Only worth the
    // presses when something on the page visibly says it is shut.
    if (!listed && !openers.some((o) => o.collapsed)) return null;
    // Nearest the recorded press first — the list you opened was under your
    // pointer. drift() is null inside the box, which is as near as it gets.
    const view = page.viewportSize();
    const away = (o) => (opts.at ? drift(opts.at, o.box, view)?.dist ?? 0 : 0);
    openers.sort((a, b) => away(a) - away(b));

    // With no recorded point there is nothing to tell one list from another,
    // and a same-named option in the WRONG list (billing instead of shipping)
    // is a false pass. So every candidate is opened and shut again first, and
    // the rule goes on only when exactly one of them shows the target —
    // select.html has two lists, and only the State one holds Texas.
    let only = null;
    if (!opts.at) {
      const showing = [];
      for (const opener of openers.slice(0, OPENER_TRIES)) {
        const before = await page.locator(POPUPS).count().catch(() => 0);
        if (!(await press(opener.handle, ctx))) continue;
        if (await soleVisible(node, OPENER_WAIT)) showing.push(opener);
        if (!(await shut(page, opener.handle, ctx, before))) return null;
      }
      if (showing.length !== 1) return null;
      only = showing[0];
    }

    for (const opener of only ? [only] : openers.slice(0, OPENER_TRIES)) {
      const before = await page.locator(POPUPS).count().catch(() => 0);
      // Named before it is pressed: an opener that shows its value changes
      // its name the moment an option is chosen.
      const named = opener.role && opener.name
        ? await expressible(page, opener.handle, [`${opener.role}:${opener.name}`], null) : null;
      if (!(await press(opener.handle, ctx))) continue;
      // The target turned up — and, when the recording says where it was
      // pressed, it turned up THERE. An option is what was pressed, so it is
      // the option that has to be near the point, not the opener.
      const there = async () => {
        if (!opts.at) return true;
        const box = await node.boundingBox().catch(() => null);
        const d = box && drift(opts.at, box, view);
        return Boolean(box) && !(d && d.dist > OPENER_REACH);
      };
      if (await soleVisible(node, OPENER_WAIT) && await there()) {
        applied(ctx, fixFor(ctx, opts.step, opts.op, {
          kind: 'opened_menu', insert: named ? clickLine(named) : null,
          note: `Opened ${opener.what} first — ${showTarget(target)} is only on the page while its list is open`,
        }), `"${target}" is in a list that was not open — pressed ${opener.what} to open it first.`);
        return node;
      }
      // A page that cannot be put back is not one to go on pressing things on.
      if (!(await shut(page, opener.handle, ctx, before))) break;
    }
    return null;
  } finally {
    for (const handle of handles) await handle.dispose().catch(() => {});
  }
}

/**
 * label:Email is gone, and exactly one placeholder:Email is where it was.
 *
 * A redesign that drops a visible label for a placeholder has not changed the
 * field — the NAME is the same, only the way the page attaches it moved. So the
 * same name is tried as a label, a placeholder and a textbox, searchbox or
 * combobox, with the recorded landmark or nth scope kept as it is. Never a
 * different name, never a looser match: one visible element or nothing, and
 * when the recording says where the press was, within FIELD_REACH of it.
 */
async function sameNameField(page, target, ctx, opts) {
  let t;
  try { t = parseTarget(target, aliasesFor(new URL(page.url()).origin)); } catch { return null; }
  const kind = t.kind === 'role' ? (FIELD_FORMS.includes(t.role) ? t.role : null)
    : (t.kind === 'label' || t.kind === 'placeholder' ? t.kind : null);
  if (!kind) return null;
  // With neither a recorded point nor a recorded region, "the same name" is all
  // there is — and a login form that lost its email label would fill the
  // footer's newsletter placeholder:Email, subscribing the test account, and
  // pass. Hand-written and extension-recorded flows have no point; they get no
  // same_field unless the target names a region.
  if (!opts.at && !t.scope) return null;

  for (const other of FIELD_FORMS) {
    if (other === kind) continue;
    const alt = other === 'label' || other === 'placeholder'
      ? { kind: other, name: t.name, scope: t.scope }
      : { kind: 'role', role: other, name: t.name, scope: t.scope };
    const locator = locate(page, alt);
    if ((await locator.count().catch(() => 0)) !== 1 || !(await locator.isVisible().catch(() => false))) continue;
    // A vault value goes only into a password field. Typed into anything else
    // that happens to carry the name — a search box, a comment box — it is
    // echoed, sent, or kept by a page that was never meant to see it.
    if (opts.step?.valueRef &&
        !(await locator.evaluate((e) => e instanceof HTMLInputElement && e.type === 'password').catch(() => false))) continue;
    if (opts.at) {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      const box = await locator.boundingBox().catch(() => null);
      const d = box && drift(opts.at, box, page.viewportSize());
      if (!box || (d && d.dist > FIELD_REACH)) continue;
    }
    const written = `${t.scope ? `${t.scope}/` : ''}${other}:${t.name}`;
    applied(ctx, fixFor(ctx, opts.step, opts.op, {
      kind: 'same_field', to: written,
      note: `${showTarget(target)} is now ${showTarget(written)} — the same name on the same field`,
    }), `"${target}" is not on the page, but ${written} is — the same name, one field. Filled that.`);
    return locator;
  }
  return null;
}

/**
 * The target did not become visible in time.
 *
 * With fixes off this throws why, as it always has. With them (heal.js) there
 * are three ways it may still be found — it arrived during the grace period, it
 * is the same field under another form, it is in a list nobody opened — and the
 * step carries on with the locator returned. None of them renames anything.
 * When none works, the failure is the one worked out before any of them ran.
 */
async function missing(page, target, node, ctx, opts) {
  // "waiting for getByRole(…) to be visible" is true and useless. What the
  // page DOES offer is the thing that tells you why — most often a menu that
  // was open while you recorded and is shut now.
  /**
   * Was it late, or was it never coming?
   *
   * These are the two failures that look identical from the outside, and
   * guessing between them is how an afternoon goes: you raise the timeout,
   * wait longer for the same failure, and conclude the tool is broken. So
   * keep watching a little past the deadline. If the element turns up, this
   * IS a timing problem and the fix is a number. If it does not, no amount of
   * waiting was ever going to help and the message should not imply otherwise.
   */
  const t0 = Date.now();
  const late = await node.waitFor({ state: 'visible', timeout: GRACE })
    .then(() => Date.now() - t0).catch(() => null);
  const mode = modeOf(ctx);
  if (late !== null && mode !== 'off') {
    // It is here now, and it is the element the recording named: nothing is
    // left to fix but the wait, and the wait is over. Still said, because a
    // step that needs its grace on every run wants a bigger number.
    const waited = opts.timeout ?? TIMEOUT;
    applied(ctx, fixFor(ctx, opts.step, opts.op, {
      kind: 'waited', note: `${showTarget(target)} appeared ${late}ms after the ${waited}ms wait, so the step waited for it`,
    }), `"${target}" was not visible within ${waited}ms, but it appeared ${late}ms later — carried on with it. ` +
        `GC_TIMEOUT_MS=${Math.ceil((waited + late) / 1000) * 1000} would not need the grace.`);
    return node;
  }

  let failure;
  try { await explainMissing(page, target, late, opts); } catch (err) { failure = err; }
  if (mode === 'off') throw failure;

  trace(ctx, 'saw', `${showTarget(target)} did not appear in the ${(((opts.timeout ?? TIMEOUT) + GRACE) / 1000).toFixed(1)}s it was waited for`);
  if (failure[IN_FRAME]) {
    // Not healable: a target names elements of the page, so no move — not a
    // rename, not a wait, not a layer closed — can reach it. Nothing on the
    // page is pressed to look for it, and the model is not asked: the rule
    // has said all there is to say, in the failure's own words.
    trace(ctx, 'rule', `No fix can reach it: it is inside a frame loaded from ${failure[IN_FRAME]}, which a target cannot name`,
      { tier: 'rule', ok: false });
    failure[EXPLAINED] = true;
    throw failure;
  }
  const found = (opts.op === 'fill' && await sameNameField(page, target, ctx, opts)) ||
    await revealHidden(page, target, node, ctx, opts);
  if (!found) {
    trace(ctx, 'rule', opts.op === 'fill'
      ? 'No safe fix applies: it was not just late, no field near where it was recorded has the same name, and rules never use a different name'
      : 'No safe fix applies: it was not just late, and rules never use a different name', { tier: 'rule', ok: false });
    throw healable(failure, 'missing');
  }
  return found;
}

/**
 * Does this element sit in a pinned HEADER — a fixed or sticky strip drawn
 * wherever the viewport is? Runs in the page. Crosses out of open shadow roots
 * to their hosts; a closed one simply ends the walk.
 *
 * "Anything fixed" was the first version, and it was wrong twice over. A modal
 * is fixed: a Continue inside a fixed "Payment failed" alertdialog, 634px from
 * the recorded Continue, was logged as "(a pinned header)" and offered as the
 * recorded position — so the warning that was the only sign of a broken
 * checkout went quiet, and accepting the suggestion made it quiet for good. And
 * an app shell (`#app { position: fixed; inset: 0 }`, common in SPAs) is
 * fixed: every element on such a page has a fixed ancestor, so every far drift
 * skipped both the warning and the model.
 *
 * So: nothing inside a dialog, an alert or anything modal counts, however it is
 * positioned; and a fixed or sticky ancestor counts only when it is a strip —
 * no taller than a third of the window or so. A shell, an overlay or a sidebar
 * the height of the screen is not a header, and a far element in one is
 * unexplained like any other.
 */
function pinnedOnScreen(e) {
  const tall = innerHeight * 0.35;
  let strip = false;
  for (let n = e; n && n.nodeType === Node.ELEMENT_NODE;
    n = n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null)) {
    const role = n.getAttribute('role');
    if (role === 'dialog' || role === 'alertdialog' || role === 'alert' || n.getAttribute('aria-modal') === 'true' ||
      (n.tagName === 'DIALOG' && n.open)) return false;
    const position = getComputedStyle(n).position;
    if ((position === 'fixed' || position === 'sticky') && n.getBoundingClientRect().height <= tall) strip = true;
  }
  return strip;
}

/**
 * The elements the step's name matches, ignoring an `nthN` ordinal, measured
 * against the recorded point. Runs in the page, over the locator's elements:
 * how many there are, and whether any OTHER than `me` is nearer the recorded
 * point than `me` is (or sits right under it).
 *
 * `count()` on the step's own locator cannot say this for `nth1/link:Docs` —
 * that locator is `.nth(0)`, and its count is always 1 — which let a Docs twin
 * in a fixed header pass as "the only match, and pinned" at any distance.
 */
function twinsAround(els, [me, px, py, dist]) {
  let nearer = false;
  for (const e of els) {
    if (e === me) continue;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const under = px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
    if (under || Math.round(Math.hypot(r.left + r.width / 2 - px, r.top + r.height / 2 - py)) < dist) nearer = true;
  }
  return { count: els.length, nearer };
}

/** Is the element inside something that announces itself — a toast, a status line? Runs in the page. */
function inLiveRegion(e) {
  const up = (n) => n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  for (let n = e; n; n = up(n)) {
    if (/^(status|alert|log|marquee|timer)$/.test(n.getAttribute('role') ?? '')) return true;
    if (/^(polite|assertive)$/.test(n.getAttribute('aria-live') ?? '')) return true;
  }
  return false;
}

/**
 * The cookie or consent layer an element sits on, as the page says it: the
 * role (or tag) of the nearest fixed or sticky container, region, dialog or
 * aside around it whose name or words read as consent — or null. Runs in the
 * page; `words` is heal.js CONSENT as [source, flags].
 *
 * The words are the layer's own text outside its links and controls, so a
 * sticky site header with a "Privacy" link in its nav is not a consent layer.
 */
function consentLayer(e, [source, flags]) {
  const re = new RegExp(source, flags);
  const up = (n) => n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const CONTROLS = 'a, button, input, select, textarea, [role="button"], [role="link"]';
  const LAYER_ROLES = /^(region|dialog|alertdialog|complementary|banner|contentinfo)$/;
  for (let n = up(e); n && n !== document.body && n !== document.documentElement; n = up(n)) {
    const role = n.getAttribute('role');
    const position = getComputedStyle(n).position;
    if (!(position === 'fixed' || position === 'sticky' || LAYER_ROLES.test(role ?? '') || /^(DIALOG|ASIDE)$/.test(n.tagName))) continue;
    const by = n.getAttribute('aria-labelledby');
    const name = `${n.getAttribute('aria-label') ?? ''} ${by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : ''}`;
    const parts = [];
    const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t && parts.join(' ').length < 2000; t = walker.nextNode()) {
      const holder = t.parentElement?.closest(CONTROLS);
      if (!holder || !n.contains(holder)) parts.push(t.nodeValue);
    }
    if (re.test(name) || re.test(parts.join(' '))) return role || n.tagName.toLowerCase();
  }
  return null;
}

/** The drift warning, word for word as a run without fixes says it. */
const driftWarning = (target, d) => `${target}: recorded at ${d.px},${d.py} but resolves to ${d.cx},${d.cy} — ${d.dist}px away. ` +
  `Fine if the layout moved; suspicious if it did not.`;

/**
 * The target resolved, but not where the person clicked (heal.js LAYOUT_REACH
 * says why this is asked at all). Fixes on only; returns what pointAt goes on
 * with — the same element and box, or, when the model named the recorded
 * element and every guard agreed, that element instead.
 *
 * What it may NOT do is the whole design: a step that passes today passes
 * here. Every answer that is not a clear, guarded yes — a refusal, not_present,
 * low confidence, a timeout, a throw — carries on with the element the name
 * found, saying exactly the warning it said before, plus that the model could
 * not confirm it. Measured only once drift() has found a distance, so a step
 * that lands where it was recorded pays nothing.
 */
async function placed(page, target, node, box, d, ctx, opts) {
  const as = { node, box, target };
  // Unchanged words — but through hide() here, where every line beside it is:
  // a target whose name carries a vault value must not print it in the one
  // line of the check that was not redacted. Off never comes here.
  const warn = () => ctx.emit?.({ t: 'log', level: 'warn', msg: hide(ctx, driftWarning(target, d)) });
  const view = page.viewportSize();
  const handle = await node.elementHandle({ timeout: 1000 }).catch(() => null);
  let recorded = { scope: null, name: '' };
  try { recorded = parseTarget(target, aliasesFor(new URL(page.url()).origin)); } catch { /* an alias that no longer parses */ }
  // The name without its ordinal: `nth1/link:Docs` is judged against every
  // Docs link, never against the one `.nth(0)` it picked.
  const base = NTH_SCOPE.test(recorded.scope ?? '') ? locate(page, { ...recorded, scope: null }) : node;
  const twins = handle
    ? await base.evaluateAll(twinsAround, [handle, d.px, d.py, d.dist]).catch(() => ({ count: 0, nearer: true }))
    : { count: 0, nearer: true };
  const unique = twins.count === 1;
  const sticky = handle ? await handle.evaluate(pinnedOnScreen).catch(() => false) : false;
  // Where it is now, in the shape a recorded `at` has: the centre, which a
  // replay would find inside the box, and the window it was measured in.
  const now = { x: d.cx, y: d.cy, w: box.width, h: box.height, vw: view?.width, vh: view?.height };
  const movedNote = (tail) => `${showTarget(target)} is now at ${d.cx},${d.cy}, ${d.dist}px from where it was recorded${tail}`;

  // A layout that moved, by rule — unless another element of the same name is
  // nearer the point the person pressed. Then the name found a twin, and "it
  // is only 120px away" is exactly what a wrong twin beside the right one
  // looks like: accepting that suggestion would put the recorded point inside
  // the wrong element, and drift() would never say a word about it again.
  if (!twins.nearer && (d.dist <= LAYOUT_REACH || (unique && sticky))) {
    await handle?.dispose().catch(() => {});
    say(ctx, `${target} moved from ${d.px},${d.py} to ${d.cx},${d.cy} — the layout shifted${sticky ? ' (a pinned header)' : ''}`);
    // On the trace from MOVED_MIN only, like the suggestion: a font loading is
    // not something a reader of the run needs a line for.
    if (d.dist >= MOVED_MIN) {
      trace(ctx, 'saw', `${showTarget(target)} is ${d.dist}px from where it was recorded — the layout shifted${sticky ? ' (a pinned header)' : ''}`, { tier: 'rule' });
    }
    // Not for a step a rule already had to find (a same-name field, an option
    // in an opened list): that fix changes the step's line, and a second
    // suggestion made from the old line would only ever go stale beside it.
    if (d.dist >= MOVED_MIN && !opts.rescued) {
      applied(ctx, fixFor(ctx, opts.step, opts.op, {
        kind: 'moved', at: now, note: movedNote(sticky ? ' — it sits in a pinned header' : ' — the layout shifted'),
      }), null);
    }
    return as;
  }

  // Far, and nothing explains it. Only mode ai asks, only with a model and a
  // call left, and never about an element a rule already had to find for this
  // step: that step has taken its one fix.
  const heal = ctx.heal;
  trace(ctx, 'saw', `${showTarget(target)} matched ${d.dist}px from where it was recorded` +
    (twins.nearer ? ', and another element of the same name is nearer that point' : ''));
  if (modeOf(ctx) !== 'ai' || opts.rescued || typeof heal.resolver?.decide !== 'function' || !(heal.budget?.aiCalls > 0)) {
    await handle?.dispose().catch(() => {});
    warn();
    trace(ctx, 'note', modeOf(ctx) === 'ai' && !opts.rescued && typeof heal.resolver?.decide === 'function'
      ? 'Pressed as recorded: no AI calls were left in this run to check it is the element you recorded'
      : 'Pressed as recorded: nothing has confirmed it is the element you recorded');
    return as;
  }
  const couldNot = (why = null) => {
    warn();
    if (why) say(ctx, `AI move use_element not used: ${why}`, 'warn');
    say(ctx, `AI couldn't confirm ${target} is the element you recorded`, 'warn');
    if (why) trace(ctx, 'checked', `Not used: ${why}`, { ok: false });
    trace(ctx, 'note', 'Pressed as recorded: the AI could not confirm it is the element you recorded');
    return as;
  };
  if (!handle) return couldNot();

  // The whole check — reading the page, finding refs, and the answer — lives
  // inside the resolver's own timeout, so a step is never held longer.
  const deadline = Date.now() + waitOf(heal.resolver);
  const confirmed = (decision, report, block) => {
    if (!decision || decision.move !== 'use_element' || decision.confidence < MIN_CONFIDENCE || decision.ref !== report.resolved) return false;
    // A confirm is held to the guards that do not depend on a point: a
    // same-named Continue inside a "Payment failed" alertdialog, or an Accept
    // on a cookie bar, is not "the element you recorded" because a model said
    // so. The press is the one it was going to be anyway; only the words and
    // the suggestion are refused.
    if (block) { couldNot(block); return true; }
    trace(ctx, 'checked', 'Passed the checks: it is not inside an alert, a dialog it was not recorded in, or a consent layer', { ok: true });
    say(ctx, `AI confirmed ${target} is the element you recorded — the layout moved`);
    applied(ctx, fixFor(ctx, opts.step, opts.op, {
      kind: 'moved', tier: 'ai', at: now, note: movedNote(' — the model confirmed it is the element recorded'),
      reason: decision.reason, confidence: decision.confidence,
    }), null);
    trace(ctx, 'did', 'Pressed it as recorded: only the layout had moved', { tier: 'ai' });
    return true;
  };

  let rerouted = false;
  let deferred = false;
  try {
    const report = await readFor(page, opts.step, ctx, NOT_FAILED, { handle, d, deadline }).catch(() => null);
    // Not in what the model would be shown, or the reading used the time up:
    // there is nothing to ask in time, and no call is spent on it.
    if (!report || deadline - Date.now() < MIN_CALL_MS) return couldNot();
    // Read now, before anything is pressed: after the press the element may
    // have gone (a toast, a navigation), and a confirm still has to pass these.
    const block = await layerGuard(page, handle, recorded, recordedName(recorded));
    const live = await handle.evaluate(inLiveRegion).catch(() => false);
    const answer = spend(ctx, report, Math.max(0, deadline - Date.now()));

    // Only an answer naming ANOTHER element could change what is pressed, and
    // there is none to name when no other element of this name exists and
    // nothing is under the recorded point. Then holding the press for the
    // answer buys nothing and costs a step that passes today: an Undo in a
    // toast that closes after 2.5s was gone by the time a 3s answer came, and
    // the step failed. So it is pressed now, as today, and the answer — a
    // confirm, or not — is said once the step is over (healing, settleLater).
    // A live region (a toast, a status line) never waits either.
    if ((live || (twins.count <= 1 && !report.under)) && pending.has(ctx) && !later.has(ctx)) {
      deferred = true;
      later.set(ctx, async (passed) => {
        try {
          // A step that failed after the press: today's warning, which is what
          // it said before, and nothing about an answer nobody waits for.
          if (!passed) { warn(); return; }
          const { decision, why } = await answer;
          if (why) say(ctx, why, 'warn');
          if (confirmed(decision, report, block)) return;
          // Another element named, when there was none to reroute to: said as
          // the refusal it is, so the log does not read as a model that agreed.
          const other = decision?.move === 'use_element' && decision.confidence >= MIN_CONFIDENCE;
          couldNot(other ? 'nothing else of this name is on the page and no control is under the recorded point, so the press was not held for it' : null);
        } finally {
          think(ctx, 'done');
        }
      });
      return as;
    }

    const { decision, why } = await answer;
    if (why) say(ctx, why, 'warn');
    as.held = true;
    // The menu here is two moves. Anything else is not a yes.
    if (!decision || decision.move !== 'use_element' || decision.confidence < MIN_CONFIDENCE) return couldNot();
    if (confirmed(decision, report, block)) return as;

    // Another element: the one the person pressed, the model says, and the
    // name found a twin. It is held to every use_element guard, and to one
    // more — it must be NEARER the recorded point than what the name found.
    // "Somewhere else" is not evidence; "where you clicked" is.
    let hit;
    try { hit = await refElement(page, decision, report); } catch (err) {
      return couldNot(err instanceof Refused ? err.message : 'the element could not be read');
    }
    try {
      const to = await vetElement(opts.op, page, opts.step, hit);
      const hitBox = await hit.handle.boundingBox().catch(() => null) ?? refuse('the element has no box');
      const off = drift(opts.step.at, hitBox, page.viewportSize());
      if (off && off.dist >= d.dist) {
        refuse(`the element is ${off.dist}px from the recorded point, no nearer than ${target} at ${d.dist}px`);
      }
      think(ctx, 'checking');
      const next = locate(page, parseTarget(to));
      await next.scrollIntoViewIfNeeded({ timeout: 1000 });
      if (opts.hitTest) {
        const layer = await coveredBy(next, opts);
        if (layer) refuse(`${to} is covered by ${layer.what}`);
      }
      const nextBox = await next.boundingBox().catch(() => null) ?? refuse(`${to} has no box`);
      trace(ctx, 'checked', `Passed the checks: ${[...hit.passed, `nearer where it was recorded than ${showTarget(target)}`].join(' · ')}`, { ok: true });
      applied(ctx, fixFor(ctx, opts.step, opts.op, {
        kind: 'used_element', tier: 'ai', to,
        note: `Used ${showTarget(to)} in place of ${showTarget(target)}, which resolved ${d.dist}px from the recorded point`,
        reason: decision.reason, confidence: decision.confidence,
      }), `"${target}" resolved ${d.dist}px from where it was recorded — the model named ${to}, nearer the recorded point, which passed the guards.`);
      rerouted = true;
      return { node: next, box: nextBox, target: to, held: true };
    } catch (err) {
      // Put the page back the way the step found it: the guards scrolled the
      // other element into view, and the press is still the original's.
      await node.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      as.box = await node.boundingBox().catch(() => null) ?? box;
      return couldNot(err instanceof Refused ? err.message : 'the element could not be used');
    } finally {
      await hit.handle.dispose().catch(() => {});
    }
  } finally {
    await handle.dispose().catch(() => {});
    // A move being acted on stays "checking" until the step is over, and a
    // deferred answer is "deciding" until it is said; healing() ends both.
    // Every other ending is the end of the thinking now.
    if (!rerouted && !deferred) think(ctx, 'done');
  }
}

/** The ordinal scope of a target, `nth2`, as targets.js reads it. */
const NTH_SCOPE = /^nth\d+$/;

/** What a position check tells the model about the step, which has not failed. */
const NOT_FAILED = 'none: the step has not failed. Its target resolved, far from the recorded point.';

/** Under this much of the resolver's time left, a position check does not start a call. */
const MIN_CALL_MS = 500;

/** How long pointAt re-reads a box after a position check held the press for an answer. */
const HELD_REREAD_MS = 1000;

/** How long a model call may take: the resolver's own timeout, or the backstop. */
const waitOf = (resolver) => (Number(resolver?.timeoutMs) > 0 ? Number(resolver.timeoutMs) : RESOLVER_WAIT_MS);

/**
 * A position check whose answer is said after the step (placed). One per
 * context; healing() settles it — with whether the step passed — before it
 * hands the step's fixes on, so a confirm's fix still belongs to the step.
 */
const later = new WeakMap();

async function settleLater(ctx, passed) {
  const settle = later.get(ctx);
  if (!settle) return;
  later.delete(ctx);
  try { await settle(passed); } catch { /* nothing said after a step may change it */ }
}

/**
 * The guards on the layer an element sits in, shared by every use_element
 * (vetElement) and a position check's confirm: never an element inside an
 * alert or an alertdialog, never into a dialog the recording was not in, and
 * never an agreeing button on a cookie or consent layer the recording was not
 * scoped to. The refusal, in words, or null.
 *
 * The consent guard is the one dismiss_blocker always had and use_element did
 * not: a cookie bar with no role (or role=region) is not a dialog, and "Accept"
 * was already the recorded name, so harmAdded had nothing to object to — a
 * model naming the bar's Accept as "the one under the recorded point" pressed it.
 */
async function layerGuard(page, handle, recorded, name) {
  const modal = await handle.evaluate(modalAround).catch(() => 'unknown');
  if (modal === 'alert' || modal === 'alertdialog' || modal === 'unknown') {
    return `the element is inside an ${modal === 'unknown' ? 'unreadable container' : modal}`;
  }
  if (modal === 'dialog' && recorded?.scope !== 'dialog') return 'the element is inside a dialog, and the recorded one was not';
  if (NEVER.test(name) || HARMFUL.test(name)) {
    const consent = await handle.evaluate(consentLayer, [CONSENT.source, CONSENT.flags]).catch(() => 'unknown');
    if (consent && consent !== recorded?.scope) {
      return `"${name}" is on a cookie or consent layer, and a consent layer is never agreed to`;
    }
  }
  return null;
}

async function pointAt(page, target, ctx, opts = {}) {
  let node = el(page, target, ctx);
  let rescued = false;
  try {
    await node.waitFor({ state: 'visible', timeout: opts.timeout ?? TIMEOUT });
  } catch {
    node = await missing(page, target, node, ctx, opts);
    rescued = true;
  }
  await node.scrollIntoViewIfNeeded();

  // Visible is not the same as reachable: the press lands on whatever is on
  // top at that pixel. A cookie banner over a form catches the typing and the
  // click while both steps report success, and the case fails later in the
  // words a dead button produces. With fixes on, ask before pressing.
  const dismissed = opts.hitTest && modeOf(ctx) !== 'off' ? await uncover(page, node, target, ctx, opts) : null;

  let box0 = await boxOf(node, target);
  const d = drift(opts.at, box0, page.viewportSize());
  let held = false;
  if (d && modeOf(ctx) !== 'off' && opts.step && !retrying.has(ctx)) {
    // With fixes on, a miss is told apart from a moved layout (placed, above).
    ({ node, box: box0, target, held = false } = await placed(page, target, node, box0, d, ctx, { ...opts, rescued }));
  } else if (d && ctx.emit) {
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
  const pace = paceOf(opts.ms, ctx.pace ?? PACE);
  const perf = performanceAt(pace);
  if (outside) {
    const ex = Math.min(Math.max(ctx.cursor.x, box0.x + inset), box0.x + box0.width - inset);
    const ey = Math.min(Math.max(ctx.cursor.y, box0.y + inset), box0.y + box0.height - inset);
    await ctx.cursor.glideTo(ex, ey, perf.approach);
  }
  await ctx.cursor.glideTo(x, y, outside ? perf.aim : pace);

  // The page can reflow during the glide — async content landing, a smooth
  // scroll still settling. Re-read and correct, or we click stale pixels.
  //
  // This one runs at pace 0 too, as a plain move: it is not decoration, it is
  // the difference between clicking the element and clicking where it used to
  // be.
  const [x2, y2] = point(await boxOf(node, target, held ? HELD_REREAD_MS : undefined), opts);
  if (Math.hypot(x2 - ctx.cursor.x, y2 - ctx.cursor.y) > 2) {
    await ctx.cursor.glideTo(x2, y2, perf.correct);
  }

  const linger = perf.linger;          // let hover settle, and the eye catch up
  if (linger > 0) await sleep(linger);
  if (dismissed) await stillUncovered(node, target, ctx, opts, dismissed);
  return node;
}

// -------------------------------------------------------------- the model
//
// Only in mode 'ai', only for click, fill and hover, and only after the rules
// above could not help. The model (resolver.js) picks ONE move; everything
// below is the code that decides whether the move is allowed and then makes it.
// Nothing the model says is trusted: its ref must be in the snapshot it was
// shown, must resolve to one visible element, and must pass the same kind of
// checks a person reviewing the fix would make — same region, near the point,
// a role this op can act on, a way out that does not agree to anything.

/** A move the guards would not make. Its message is for the log, never the step. */
class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

const say = (ctx, msg, level = 'info') => ctx.emit?.({ t: 'log', level, msg: hide(ctx, msg) });

/**
 * The ref the snapshot just taken gives one element, or null.
 *
 * Only a LOOKUP per ref — `aria-ref=` answers from the most recent ai snapshot
 * and never takes one — so the refs stay the refs the report carries. Lines
 * that name what the step's target names are tried first, so a large page is
 * not walked end to end to find a link called Docs.
 */
async function refFor(page, snapshot, handle, name, deadline = null) {
  const want = String(name ?? '').toLowerCase();
  const lines = String(snapshot ?? '').split('\n').map(lineHeader).filter(Boolean);
  const once = new Set([...refsIn(snapshot)].filter(([, n]) => n === 1).map(([r]) => r));
  const refs = [];
  for (const named of [true, false]) {
    for (const h of lines) {
      if (want && (h.name.toLowerCase().includes(want)) !== named) continue;
      if (!want && !named) continue;
      for (const m of h.attrs.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)) if (once.has(m[1]) && !refs.includes(m[1])) refs.push(m[1]);
    }
  }
  for (const ref of refs.slice(0, 80)) {
    // A position check's time is the resolver's timeout, reading included.
    if (deadline && Date.now() >= deadline) return null;
    const other = await page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 250 }).catch(() => null);
    if (!other) continue;
    const same = await sameNode(page, other, handle);
    await other.dispose().catch(() => {});
    if (same) return ref;
  }
  return null;
}

/**
 * Ask the model about a step that failed, within the run's budget. The answer,
 * checked for shape, with the report it was given — or null, having said why.
 * readFor() reads the page, spend() makes the call.
 *
 * The wait is capped at the resolver's own timeout and a little more. The real
 * resolver never waits longer than that itself; this is for one that would.
 *
 * The position check (placed) does not come through here: it calls readFor
 * with `moved` — `{ handle, d, deadline }`, the element the name resolved to,
 * how far it is from the recorded point, and when its time is up — and spend
 * with what is left of that time, because it may press before the answer
 * comes. Its report is the failure report — the same snapshot, the same
 * redaction — plus that element's ref and the distance; and a budget that has
 * run out is not said, because the step it is about has not failed.
 */
async function ask(page, step, ctx, err) {
  const report = await readFor(page, step, ctx, err);
  if (!report) return null;
  const { decision, why } = await spend(ctx, report, waitOf(ctx.heal.resolver) + 2000);
  if (why) say(ctx, why, 'warn');
  return decision ? { decision, report } : null;
}

/**
 * The report a model call would be given, having said `reading` — or null,
 * with no call spent. For the position check (`moved`), also null when the
 * resolved element's ref is not in the snapshot (one cut to its cap), in which
 * case `reading` is followed straight by `done`: the page was read, and there
 * was nothing in it to ask about.
 */
async function readFor(page, step, ctx, err, moved = null, { explain = false } = {}) {
  const heal = ctx.heal;
  if (typeof heal.resolver?.decide !== 'function') return null;
  if (!(heal.budget?.aiCalls > 0)) {
    if (!moved) {
      say(ctx, 'AI: unknown - no AI calls left in this run', 'warn');
      trace(ctx, 'note', 'No AI calls left in this run, so the AI was not asked');
    }
    return null;
  }
  think(ctx, 'reading');
  // What is under the recorded point now, taken before the snapshot (a handle
  // is not a snapshot, so the refs survive it). A snapshot carries no
  // positions: without this the model is told where the name's element is and
  // cannot know which other element sits where the person clicked.
  const under = moved
    ? await page.evaluateHandle(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      // A control, or nothing: a paragraph under the point is not something a
      // reroute could name, and "something is there" is what holds a press.
      return hit?.closest('a[href], button, input, select, textarea, summary, label, [role], [tabindex]') ?? null;
    }, { x: moved.d.px, y: moved.d.py }).then((h) => h.asElement()).catch(() => null)
    : null;
  let raw;
  let resolved = null;
  let point = null;
  try {
    raw = await gatherReport(page, step, ctx, err);
    // Every report lists the frames inside the page: for an explanation
    // (explainFailure) the evidence that a step was recorded in one of them,
    // and for a fix the reason the model must not name anything in one — the
    // snapshot shows a frame's contents, and a target can never reach them.
    Object.assign(raw, { frames: framesIn(page), ...(explain ? { kind: 'explain' } : {}) });
    if (moved) {
      let name = '';
      try { name = parseTarget(step.target).name ?? ''; } catch { /* an alias: no name to look for first */ }
      resolved = await refFor(page, raw.snapshot, moved.handle, name, moved.deadline);
      // Not in what the model would be shown (a snapshot cut to its cap): there
      // is nothing to ask about, and no call is spent on it.
      if (!resolved) return null;
      point = under ? await refFor(page, raw.snapshot, under, name, moved.deadline) : null;
      if (point === resolved) point = null;
      Object.assign(raw, {
        kind: 'moved',
        resolved: { ref: resolved, cx: moved.d.cx, cy: moved.d.cy, dist: moved.d.dist, under: point },
      });
    }
  } finally {
    await under?.dispose().catch(() => {});
  }
  // `under` is the report's own: whether anything a reroute could name sits
  // under the recorded point (placed decides from it whether to hold the press).
  const report = { ...composeReport(raw, redactionsFor(heal)), kind: moved ? 'moved' : explain ? 'explain' : 'failed', resolved, under: point };
  if (moved && !report.refs.has(resolved)) return null;
  return report;
}

/**
 * One model call on a report readFor made: the budget spent and `deciding` said
 * NOW, synchronously, and a promise of `{ decision, why }` that never rejects —
 * `why` being what to log when there is no decision (a timeout, a throw, an
 * answer of the wrong shape). Waits at most `limit` ms.
 */
function spend(ctx, report, limit) {
  const heal = ctx.heal;
  heal.budget.aiCalls -= 1;
  consulted.set(ctx, heal.step);
  think(ctx, 'deciding', { moved: THINKING.position, explain: THINKING.explaining }[report.kind] ?? THINKING.deciding);
  trace(ctx, 'asked', ASKED[report.kind] ?? ASKED.failed, { tier: 'ai' });
  let timer = null;
  let timedOut = false;
  return Promise.race([
    // Caught on its own: a decide() that rejects after the race is over must
    // not become an unhandled rejection that takes the process down.
    Promise.resolve().then(() => heal.resolver.decide(report)).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(null); }, limit); }),
  ]).catch(() => null).then((answer) => {
    clearTimeout(timer);
    if (!answer) {
      const why = timedOut ? 'Timeout' : heal.resolver.unavailable ?? 'no answer';
      trace(ctx, 'note', `No answer from the AI (${why})`);
      return { decision: null, why: `AI unavailable: ${why}` };
    }
    // An answer whose fields throw when read is an answer of the wrong shape,
    // not an exception that replaces the step's own error.
    let decision = null;
    try { decision = checkDecision(answer); } catch { /* reported below */ }
    if (!decision) {
      trace(ctx, 'note', 'The AI’s answer could not be read, so nothing was done with it');
      return { decision: null, why: 'AI unavailable: InvalidDecision' };
    }
    heard(ctx, decision, report);
    return { decision, why: null };
  });
}

/** What a model call is sent with, in words, by the kind of question it is. */
const ASKED = {
  failed: 'Asked the AI what changed, sending the page’s structure with typed values and secrets removed',
  moved: 'Asked the AI whether it is the element you recorded, sending the page’s structure with typed values and secrets removed',
  explain: 'Asked the AI why it failed, sending the page’s structure with typed values and secrets removed',
};

/**
 * What the model said, on the step's trace: the facts it noticed, what it
 * ruled out, and its decision — or, asked why a step failed, its answer and
 * the one thing a tester could change. Its own words, redacted like every
 * entry; whether anything is done with a move is for the guards, after.
 */
function heard(ctx, d, report) {
  for (const fact of d.noticed ?? []) trace(ctx, 'noticed', fact, { tier: 'ai' });
  for (const other of d.ruled_out ?? []) trace(ctx, 'ruled_out', other, { tier: 'ai' });
  if (report.kind === 'explain') {
    trace(ctx, 'why', d.reason || 'The AI gave no reason', { tier: 'ai', confidence: d.confidence, failure: d.failure });
  } else {
    trace(ctx, 'decided', decidedText(d, report), {
      tier: 'ai', detail: d.reason, confidence: d.confidence, ...(d.move === 'not_present' ? { failure: d.failure } : {}),
    });
    if (d.move !== 'not_present' && d.confidence < MIN_CONFIDENCE) {
      trace(ctx, 'checked', `Not acted on: ${Math.round(d.confidence * 100)}% sure is under the ${Math.round(MIN_CONFIDENCE * 100)}% a move needs`, { ok: false });
    }
  }
  if (d.advice && (report.kind === 'explain' || d.move === 'not_present')) trace(ctx, 'advice', d.advice, { tier: 'ai' });
}

/** A model's move in words, naming the element its ref points at in the snapshot it was shown. */
function decidedText(d, report) {
  const line = d.ref ? refLine(report.snapshot, d.ref) : null;
  const named = line ? `${line.role}${line.name ? ` "${line.name}"` : ''}` : null;
  if (report.kind === 'moved') {
    if (d.move !== 'use_element') return 'It could not say this is the element you recorded';
    return d.ref === report.resolved
      ? 'It is the element you recorded; only the layout moved'
      : `The element you recorded is ${named ?? 'another one'}, nearer where you clicked`;
  }
  return {
    wait_longer: 'Wait longer: it is still on its way',
    dismiss_blocker: `Close what is in the way, with ${named ?? 'its close button'}`,
    reveal: `Open ${named ?? 'the list it is in'} first`,
    use_element: `Use ${named ?? 'another element'} instead: the same control, renamed`,
    not_present: 'It is not on the page to use',
  }[d.move];
}

/**
 * The element a move names, resolved NOW — before anything else can take an ai
 * snapshot, because `aria-ref=` answers from the most recent one only.
 */
async function refElement(page, d, report) {
  if (!REF.test(d.ref) || !report.refs.has(d.ref)) refuse(`ref "${d.ref}" is not in the snapshot that was sent`);
  if (!refLine(report.snapshot, d.ref)) refuse(`ref ${d.ref} is not on exactly one line of the snapshot`);
  const locator = page.locator(`aria-ref=${d.ref}`);
  if ((await locator.count().catch(() => 0)) !== 1 || !(await locator.isVisible().catch(() => false))) {
    refuse(`ref ${d.ref} is not exactly one visible element`);
  }
  const handle = await locator.elementHandle({ timeout: 1000 }).catch(() => null) ?? refuse(`ref ${d.ref} went away`);
  // The frame is the element's to say, never the ref's: after a navigation in
  // the same tab every main-frame ref carries an f prefix too (e4, then f1e4,
  // then f2e4), and reading the prefix refused every move on such a page.
  if ((await handle.ownerFrame().catch(() => null)) !== page.mainFrame()) {
    await handle.dispose().catch(() => {});
    refuse('the element is inside a frame, which a target cannot name');
  }
  // normalize() BEFORE anything is pressed: after a click it bakes in
  // whatever the click changed, a toggle's new name included.
  const normalized = String(await locator.normalize().catch(() => ''));
  // The role and name every guard judges come from the ELEMENT, never from the
  // report: snapshot text is the page's to write, and a button NAMED
  // `Close" [ref=e5]` once made "Accept all" (the real e5) pass for a close
  // button. The element's own snapshot is its first line. It is taken last,
  // because it retires the ai snapshot's refs — from here on only the handle
  // reaches the element.
  const own = lineHeader(String(await locator.ariaSnapshot({ timeout: 1000 }).catch(() => '')).split('\n')[0]);
  if (!own) {
    await handle.dispose().catch(() => {});
    refuse(`ref ${d.ref} has no role of its own`);
  }
  return { handle, normalized, role: own.role, name: own.name };
}

/** The candidates a target may be written from: the element's own role and name, then normalize(). */
function candidatesFor(hit) {
  return [...new Set([...(ROLES.has(hit.role) && hit.name ? [`${hit.role}:${hit.name}`] : []), ...grammarOf(hit.normalized)])];
}

/** The recorded target's role family, for a rename with no point to check it by; fields count as one kind. */
function recordedFamily(t, op) {
  if (t.kind === 'role') return ROLE_FAMILIES[t.role] ?? t.role;
  return op === 'fill' && (t.kind === 'label' || t.kind === 'placeholder') ? 'field' : null;
}

/**
 * The dialog-like thing an element sits in, as the page says: 'alert' or
 * 'alertdialog' or 'dialog', or null. Through shadow roots, like layerAt.
 */
function modalAround(e) {
  const up = (n) => n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  for (let n = up(e); n; n = up(n)) {
    const role = n.getAttribute('role');
    if (role === 'alert' || n.getAttribute('aria-live') === 'assertive') return 'alert';
    if (role === 'alertdialog') return 'alertdialog';
    if (role === 'dialog' || n.getAttribute('aria-modal') === 'true' || (n.tagName === 'DIALOG' && n.open)) return 'dialog';
  }
  return null;
}

/** The name a recorded target says, for comparing purposes: its name, or nothing for an alias. */
const recordedName = (t) => (t && typeof t.name === 'string' ? t.name : '');

/**
 * use_element: the same control, renamed. Allowed only for an element this op
 * can act on, inside the recorded landmark, near the recorded point, and — when
 * the recording says no point — in the same role family. Never for a vault
 * value, never into a dialog the recording was not in, and never onto a name
 * that does something the recorded one did not (heal.js harmAdded). Then the
 * step runs again on a copy with the new target, so cursor, drift and settle
 * behave exactly as for any step.
 */
async function useElement(op, page, step, ctx, d, report, insert = null) {
  const hit = await refElement(page, d, report);
  try {
    const to = await vetElement(op, page, step, hit);
    trace(ctx, 'checked', `Passed the checks: ${hit.passed.join(' · ')}`, { ok: true });
    await ACT[op](page, { ...step, target: to }, ctx);
    applied(ctx, fixFor(ctx, step, op, {
      kind: insert ? 'opened_menu' : 'used_element', tier: 'ai', to, insert,
      note: insert
        ? `Opened the list with ${insert.replace(/^click /, '')}, then used ${showTarget(to)} in place of ${showTarget(step.target)}`
        : `Used ${showTarget(to)} in place of ${showTarget(step.target)}`,
      reason: d.reason, confidence: d.confidence,
    }), `"${step.target}" was not usable — the model named ${to}, which passed the guards.`);
  } finally {
    await hit.handle.dispose().catch(() => {});
  }
}

/**
 * Every use_element guard, for an element the model named (refElement), and
 * the target it is written as — or a Refused saying which guard it failed.
 * Shared by the failure consult (useElement) and the position check (placed),
 * so a twin under the recorded point is held to exactly what a rename is.
 * Leaves the element scrolled into view when the step has a recorded point.
 */
async function vetElement(op, page, step, hit) {
  // The one thing a rename must never carry is a secret: the field it was
  // recorded for is gone, and "the same place" is not proof the new one is
  // a password field — a help search box at that spot receives the password
  // on input and passes the run.
  if (step.valueRef) refuse('a vault value is only ever typed into the field it was recorded for');
  if (!OP_ROLES[op].has(hit.role)) refuse(`a ${hit.role} is not something a ${op} acts on`);
  // What it passed, in words, left on `hit.passed` for the step's trace: a
  // reader sees which checks stood between the model's answer and the press.
  const passed = [`a ${hit.role}, which a ${op} acts on`];
  let recorded;
  try { recorded = parseTarget(step.target, aliasesFor(new URL(page.url()).origin)); } catch { refuse('the recorded target does not parse'); }
  const harm = harmAdded(recordedName(recorded), hit.name);
  if (harm) refuse(`"${hit.name}" says "${harm}", and the recorded step did not — that is a different action, not a rename`);
  passed.push('its name adds no word that acts');
  const landmark = LANDMARKS.has(recorded.scope) ? recorded.scope : null;
  if (landmark) {
    const region = await page.getByRole(landmark).first().elementHandle({ timeout: 1000 }).catch(() => null);
    const inside = region ? await page.evaluate(([r, e]) => r.contains(e), [region, hit.handle]).catch(() => false) : false;
    await region?.dispose().catch(() => {});
    if (!inside) refuse(`the element is outside the recorded ${landmark} landmark`);
    passed.push(`inside the recorded ${landmark} landmark`);
  }
  // A same-named button inside a dialog is the dialog's button. "Continue"
  // in a "Payment failed" alertdialog sat 30px from the page's own Continue
  // and passed every other guard, carrying the run past the failure. And an
  // Accept on a cookie bar is the bar's (layerGuard).
  const layered = await layerGuard(page, hit.handle, recorded, hit.name);
  if (layered) refuse(layered);
  passed.push('not in an alert, a consent layer or a dialog it was not recorded in');
  if (step.at) {
    await hit.handle.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    const box = await hit.handle.boundingBox().catch(() => null) ?? refuse('the element has no box');
    const off = drift(step.at, box, page.viewportSize());
    if (off && off.dist > AI_REACH) refuse(`the element is ${off.dist}px from the recorded point, more than ${AI_REACH}px`);
    passed.push(off ? `${off.dist}px from where it was recorded (at most ${AI_REACH}px)` : 'where it was recorded');
  } else {
    // No point to measure: a landmark says which region, not which control,
    // so the kind of control has to stay the same either way.
    const was = recordedFamily(recorded, op);
    const now = op === 'fill' && FIELD_ROLES.has(hit.role) ? 'field' : ROLE_FAMILIES[hit.role] ?? hit.role;
    if (!was || was !== now) refuse(`with no recorded point the kind of control has to stay ${was ?? 'the same'}, and this is a ${hit.role}`);
    passed.push('the same kind of control as recorded');
  }
  const to = await expressible(page, hit.handle, candidatesFor(hit), landmark)
    ?? refuse('the element cannot be written as a target — a frame, or CSS only');
  hit.passed = passed;
  return to;
}

/**
 * dismiss_blocker: the model may judge a layer harmless that does not SAY
 * cookie or newsletter. That is all it may relax. It applies only to a step
 * something is ON TOP of, and only to a button of THAT layer — the layer the
 * hit test finds over the target now, not any labelled section that happens to
 * hold a "Close account" or a "Reject request". The button is still a reject
 * or a close (a reject alone on a consent layer) and never anything that
 * agrees; the layer is still one with no alert, no field and nothing that
 * reads as an error, a payment or a question.
 */
async function dismissBlocker(op, page, step, ctx, d, report, err) {
  if (err?.[HEALABLE] !== 'covered') refuse('nothing is on top of the target, and dismiss_blocker is only for a step something covers');
  const hit = await refElement(page, d, report);
  try {
    if (hit.role !== 'button') refuse(`a ${hit.role} is not a button`);
    const node = el(page, step.target, ctx);
    const layer = await coveredBy(node, { at: step.at, leftEdge: op === 'fill' }, hit.handle)
      ?? refuse('the target is not covered by anything now');
    if (!layer.holds) refuse(`"${hit.name}" is not on the ${layer.what} that covers the target`);
    if (!safeButton(hit.name, { consent: CONSENT.test(`${layer.name}\n${layer.text}`) })) {
      refuse(`"${hit.name}" is not a reject or close button, or it agrees to something`);
    }
    const verdict = dismissible(layer, { wording: false });
    if (!verdict.ok) refuse(`the ${layer.what} may not be dismissed, because ${verdict.why}`);
    trace(ctx, 'checked', `Passed the checks: "${hit.name}" is a reject or close button on the ${layer.what} covering the target, and that layer reads as harmless`, { ok: true });
    if (!(await press(hit.handle, ctx))) refuse(`"${hit.name}" cannot be pressed where it is`);
    say(ctx, `${FIXED} pressed "${hit.name}" on the ${layer.what}, as the model suggested.`);
    await settle(page);

    await ACT[op](page, step, ctx);
    applied(ctx, fixFor(ctx, step, op, {
      kind: 'closed_popup', tier: 'ai', note: `Closed the ${layer.what} with '${hit.name}'`,
      reason: d.reason, confidence: d.confidence,
    }), `"${step.target}" could be reached once the ${layer.what} was closed.`);
  } finally {
    await hit.handle.dispose().catch(() => {});
  }
}

/**
 * reveal: the target is in a closed list and the model named the opener. The
 * opener rules are the rules' own — a combobox, a popup button or something
 * collapsed, never a link. If the recorded target shows, the step runs as
 * recorded; if something else shows in its place, one more question is allowed
 * about the opened page, and its answer must be a use_element that passes every
 * use_element guard. Otherwise the opener is shut again.
 */
async function reveal(op, page, step, ctx, d, report, err) {
  const hit = await refElement(page, d, report);
  let before = null;
  try {
    if (hit.role === 'link') refuse('a link is a navigation, never an opener');
    if (NEVER.test(hit.name) || HARMFUL.test(hit.name)) refuse(`"${hit.name}" says it does something when pressed, so it is not pressed to look`);
    const opener = await hit.handle.evaluate((e, test) => e.matches(test) &&
      !(e.getAttribute('role') === 'link' || (!e.getAttribute('role') && e.matches('a[href], area[href]'))), OPENER_TEST)
      .catch(() => false);
    if (!opener) refuse('the element is not a combobox, a popup button or anything collapsed');
    const named = await expressible(page, hit.handle, candidatesFor(hit), null)
      ?? refuse('the opener cannot be written as a target');
    const insert = clickLine(named);
    trace(ctx, 'checked', `Passed the checks: ${showTarget(named)} opens a list, is not a link, and says nothing that acts`, { ok: true });

    before = await page.locator(POPUPS).count().catch(() => 0);
    if (!(await press(hit.handle, ctx))) { before = null; refuse(`${named} cannot be pressed where it is`); }
    say(ctx, `${FIXED} pressed ${named} to open its list, as the model suggested.`);

    if (await soleVisible(el(page, step.target, ctx), OPENER_WAIT)) {
      await ACT[op](page, step, ctx);
      applied(ctx, fixFor(ctx, step, op, {
        kind: 'opened_menu', tier: 'ai', insert,
        note: `Opened the list with ${showTarget(named)} first — ${showTarget(step.target)} is only on the page while it is open`,
        reason: d.reason, confidence: d.confidence,
      }), `"${step.target}" is in a list that was not open — ${named} opened it.`);
      return;
    }

    // Open, and the recorded target is still not there: one more look, at the
    // page as it is now. ask() spends the budget and says why when it cannot.
    const again = await ask(page, step, ctx, err);
    if (!again) refuse(`"${step.target}" did not appear once the list was open`);
    const { decision: d2, report: r2 } = again;
    if (d2.move !== 'use_element' || d2.confidence < MIN_CONFIDENCE) {
      say(ctx, `AI: ${d2.failure} - ${d2.reason || d2.move}`);
      refuse(`"${step.target}" did not appear once the list was open, and the second answer was ${d2.move}`);
    }
    await useElement(op, page, step, ctx, d2, r2, insert);
    before = null;                                   // it worked; the list stays as the step left it
  } catch (e) {
    if (before !== null) await shut(page, hit.handle, ctx, before).catch(() => false);
    throw e;
  } finally {
    await hit.handle.dispose().catch(() => {});
  }
}

/**
 * A step the rules could not fix, put to the model. Returns when a move worked;
 * otherwise throws the step's ORIGINAL error, unchanged — defect numbers
 * fingerprint it, and a model's opinion must not move a failure to another
 * defect — having logged the model's verdict and, when a guard refused, why.
 */
async function consult(op, page, step, ctx, err) {
  try {
    await consultOnce(op, page, step, ctx, err);
  } finally {
    // Whatever happened — a move that worked, a refusal, not_present, no
    // answer, no budget — the thinking that was started is over.
    think(ctx, 'done');
  }
}

async function consultOnce(op, page, step, ctx, err) {
  // Anything ask() throws (a page gone mid-snapshot) is not the step's error:
  // the step's own failure is what is thrown, always.
  const asked = await ask(page, step, ctx, err).catch(() => null);
  if (!asked) throw err;
  const { decision: d, report } = asked;
  const verdict = `AI: ${d.failure} - ${d.reason || d.move}`;
  if (d.move === 'not_present' || d.confidence < MIN_CONFIDENCE) {
    say(ctx, d.move === 'not_present' ? verdict : `${verdict} (confidence ${d.confidence}, not acted on)`);
    throw err;
  }
  think(ctx, 'checking');
  retrying.add(ctx);
  try {
    if (d.move === 'wait_longer') {
      await ACT[op](page, { ...step, timeout: WAIT_LONGER_MS }, ctx);
      applied(ctx, fixFor(ctx, step, op, {
        kind: 'waited', tier: 'ai', note: `Waited up to ${WAIT_LONGER_MS / 1000}s for ${showTarget(step.target)}`,
        reason: d.reason, confidence: d.confidence,
      }), `"${step.target}" turned up within ${WAIT_LONGER_MS}ms.`);
    } else if (d.move === 'use_element') {
      await useElement(op, page, step, ctx, d, report);
    } else if (d.move === 'dismiss_blocker') {
      await dismissBlocker(op, page, step, ctx, d, report, err);
    } else {
      await reveal(op, page, step, ctx, d, report, err);
    }
  } catch (e) {
    say(ctx, verdict);
    say(ctx, `AI move ${d.move} not used: ${e instanceof Refused ? e.message : 'the step still failed after it'}`, 'warn');
    trace(ctx, 'checked', e instanceof Refused ? `Not used: ${e.message}` : 'Tried, and the step still failed after it', { ok: false });
    throw err;
  } finally {
    retrying.delete(ctx);
  }
}

/**
 * One step with fixes around it. Off is the plain call and nothing else. With
 * fixes on, the step's fixes are collected while it runs and handed to
 * ctx.heal.onFix only once it has passed, in the order they were made.
 */
async function healing(op, page, step, ctx) {
  const mode = modeOf(ctx);
  if (mode === 'off') return ACT[op](page, step, ctx);
  const fixes = [];
  pending.set(ctx, fixes);
  try {
    try {
      await ACT[op](page, step, ctx);
    } catch (err) {
      // A position check whose answer was left for after the step: the step
      // failed, so it says today's warning now — before any consult speaks.
      await settleLater(ctx, false);
      if (mode !== 'ai' || !err?.[HEALABLE] || !AI_OPS.has(op)) throw err;
      await consult(op, page, step, ctx, err);
    }
    // The step passed: its position check, if one was left waiting, is said
    // now — while the step's fixes are still being collected.
    await settleLater(ctx, true);
  } finally {
    await settleLater(ctx, false);
    pending.delete(ctx);
    // A model's move acted on inside the step (placed, when the model named
    // the element under the recorded point) is "checking" until here.
    think(ctx, 'done');
  }
  for (const fix of fixes) ctx.heal.onFix?.(fix);
}

/**
 * Where the frames inside the page come from, for an explanation — a step
 * recorded in one cannot pass against the page. Each as its origin and path
 * only (heal.js maskPath): no query, no fragment, no token-like segment.
 */
function framesIn(page) {
  try {
    return [...new Set(page.frames().filter((f) => f !== page.mainFrame()).map((f) => maskPath(f.url())).filter(Boolean))].slice(0, 8);
  } catch { return []; }
}

/** Why a failure is only explained, by the op that failed: each is a step no fix may change. */
const UNFIXABLE = {
  expect: 'Checks are never changed by fixes, so the AI was only asked why this one failed',
  goto: 'Opening a page is never changed by fixes, so the AI was only asked why it failed',
  scroll: 'A scroll is never changed by fixes, so the AI was only asked why it failed',
  wait: 'A wait is never changed by fixes, so the AI was only asked why it failed',
};

/**
 * Why a step failed, from the model, when no fix may change it: a check, a
 * page load, a scroll or a wait — never healed, by design — or a click, fill
 * or hover whose failure no move mends. The answer goes in the log and on the
 * step's trace, and nowhere else: nothing is pressed or retried, and the step's
 * error stays the step's error, because defect numbers fingerprint it.
 *
 * Only in mode ai, with a model and a call left, and once a step — a step the
 * model has already answered for is not asked again. The run loop calls this
 * after a step has failed and before it says so. Never throws.
 *
 * @returns {Promise<{failure: string, reason: string, advice: string, confidence: number}|null>}
 */
export async function explainFailure(page, step, ctx, err) {
  if (modeOf(ctx) !== 'ai') return null;
  const heal = ctx.heal;
  if (typeof heal.resolver?.decide !== 'function' || consulted.get(ctx) === heal.step) return null;
  if (!(heal.budget?.aiCalls > 0)) {
    trace(ctx, 'note', 'No AI calls left in this run, so the AI was not asked why it failed');
    return null;
  }
  // A failure the rules have said everything about — a target inside a frame
  // (missing) — is not put to the model: its own words already say why, and
  // what to do, and a call would only say them again with less certainty.
  if (err?.[EXPLAINED]) {
    trace(ctx, 'note', 'The rules said why in full, so the AI was not asked');
    return null;
  }
  trace(ctx, 'note', UNFIXABLE[step?.op] ?? 'No fix applies to this failure, so the AI was only asked why it failed');
  try {
    const report = await readFor(page, step, ctx, err, null, { explain: true });
    if (!report) return null;
    const { decision, why } = await spend(ctx, report, waitOf(heal.resolver) + 2000);
    if (why) say(ctx, why, 'warn');
    if (!decision) return null;
    say(ctx, `AI: ${decision.failure} - ${decision.reason || 'no reason given'}`);
    return {
      failure: decision.failure,
      reason: plain(ctx, decision.reason) ?? '',
      advice: plain(ctx, decision.advice) ?? '',
      confidence: decision.confidence,
    };
  } catch {
    return null;
  } finally {
    think(ctx, 'done');
  }
}

/**
 * The three ops that point at something, as they run. OPS below puts fixes
 * around them; the model's retries call these directly, so a retry can use the
 * rules but never asks the model again by itself.
 */
const ACT = {
  /**
   * Be somewhere, without clicking.
   *
   * A dropdown that opens on hover has no existence of its own — its items are
   * only in the page while the pointer is on the thing that opens them. Without
   * a way to say "go here and stay", such a menu is simply not expressible.
   */
  async hover(page, step, ctx) {
    await pointAt(page, step.target, ctx, { at: step.at, timeout: step.timeout, step, op: 'hover' });
    // An authored `hover ... 500ms` is intent and is never scaled; only the
    // default is part of the performance.
    await sleep(Math.min(step.ms ?? performanceAt(ctx.pace ?? PACE).dwell, 5000));
  },

  async click(page, step, ctx) {
    await pointAt(page, step.target, ctx, { at: step.at, timeout: step.timeout, hitTest: true, step, op: 'click' });
    markNav(ctx);                 // anything after this must be a NEW navigation
    await ctx.cursor.click(performanceAt(ctx.pace ?? PACE).press);
    // A click starts a route change, a fetch and a re-render. Begin the next
    // step when the page has stopped moving, not a fixed moment later.
    await settle(page, step.settle);
  },

  async fill(page, step, ctx) {
    // step.timeout is honoured like click's: no recorded step carries one, and
    // a fix that waits longer needs a fill to be able to.
    await pointAt(page, step.target, ctx, { leftEdge: true, at: step.at, timeout: step.timeout, hitTest: true, step, op: 'fill' });
    const perf = performanceAt(ctx.pace ?? PACE);
    await ctx.cursor.click(perf.press); // focus the way a user does, not via .fill()
    // The vault is the organisation's (docs/AUTH.md §10), handed in with the
    // context, and whether the plan may open it at all is that wrapper's
    // question, not this step's.
    const value = step.valueRef ? (ctx.vault ?? vaultOf(LOCAL)).get(step.valueRef) : step.value;
    if (value === undefined) throw new Error(`No value for ${step.target}`);
    await page.keyboard.press('ControlOrMeta+A');
    // Per character, so this is the largest single cost in a form-heavy case:
    // twenty characters is another 840ms at the default.
    await page.keyboard.type(value, { delay: perf.keystroke });
    await settle(page, step.settle);      // type-ahead, validation, a live filter
  },

  /** A checkbox, a switch or a radio, put in the asked-for state: see setChecked. */
  async tick(page, step, ctx) { await setChecked(page, step, ctx, true); },
  async untick(page, step, ctx) { await setChecked(page, step, ctx, false); },

  /**
   * An option in a dropdown, by the words on it.
   *
   * A native <select> is set through the browser, after the words are matched
   * here — Playwright's own matcher waits its whole timeout to say "no such
   * option", and the list of what IS there is the useful sentence. A combobox
   * of the page's own has no options until it is open, so it is opened the
   * way a person opens it and the option is pressed by name.
   */
  async choose(page, step, ctx) {
    await pointAt(page, step.target, ctx, { at: step.at, timeout: step.timeout, hitTest: true, step, op: 'click' });
    const value = step.valueRef ? (ctx.vault ?? vaultOf(LOCAL)).get(step.valueRef) : step.value;
    if (value === undefined) throw new Error(`No value for ${step.target}`);
    const box = el(page, step.target, ctx);
    const perf = performanceAt(ctx.pace ?? PACE);
    const native = await box.evaluate((n) => n.tagName === 'SELECT').catch(() => false);
    if (native) {
      const options = await box.evaluate((n) => [...n.options].map((o) => ({ label: (o.label || o.textContent || '').trim(), value: o.value })));
      const want = String(value);
      const hit = options.find((o) => o.label === want)
        ?? options.find((o) => o.label.toLowerCase() === want.toLowerCase())
        ?? options.find((o) => o.value === want);
      if (!hit) {
        throw new Error(`"${want}" is not an option of ${step.target} — it offers ${options.slice(0, 12).map((o) => `"${o.label}"`).join(', ') || 'nothing'}`);
      }
      await box.selectOption({ value: hit.value }, { timeout: step.timeout ?? TIMEOUT });
    } else {
      await ctx.cursor.click(perf.press);
      await settle(page, step.settle);
      const option = `option:${value}`;
      await pointAt(page, option, ctx, { timeout: step.timeout, hitTest: true, step: { ...step, target: option }, op: 'click' });
      await ctx.cursor.click(perf.press);
    }
    await settle(page, step.settle);
    ctx.emit?.({ t: 'log', level: 'info', msg: `chose "${value}" in ${step.target}` });
  },

  /**
   * A key, on a named control or wherever the focus is. Focus is taken the
   * way a person takes it — a click at the field's edge — and Enter may
   * submit, so the navigation mark is set as a click sets it.
   */
  async press(page, step, ctx) {
    if (step.target) {
      await pointAt(page, step.target, ctx, { leftEdge: true, at: step.at, timeout: step.timeout, hitTest: true, step, op: 'fill' });
      await ctx.cursor.click(performanceAt(ctx.pace ?? PACE).press);
    }
    markNav(ctx);
    await page.keyboard.press(step.key);
    await settle(page, step.settle);
  },
};

/**
 * A checkbox, a switch or a radio, put in a state. The click is only made
 * when the state differs — a click on a box already ticked would untick it,
 * and a test that toggles is a different test every other run. The state is
 * read back afterwards, so a control the page refused to change is a failure
 * with the state in it, not a pass.
 */
async function setChecked(page, step, ctx, want) {
  await pointAt(page, step.target, ctx, { at: step.at, timeout: step.timeout, hitTest: true, step, op: 'click' });
  const box = el(page, step.target, ctx);
  let before;
  try { before = await box.isChecked({ timeout: step.timeout ?? TIMEOUT }); }
  catch (e) { throw new Error(`${step.target} is not a checkbox, a switch or a radio: ${String(e.message).split('\n')[0]}`); }
  if (before !== want) {
    await ctx.cursor.click(performanceAt(ctx.pace ?? PACE).press);
    await settle(page, step.settle);
  }
  const after = await box.isChecked({ timeout: step.timeout ?? TIMEOUT });
  if (after !== want) throw new Error(`${step.target} is still ${after ? 'ticked' : 'unticked'} after the click`);
  ctx.emit?.({ t: 'log', level: 'info', msg: `${want ? 'ticked' : 'unticked'} ${step.target}${before === want ? ' (it already was)' : ''}` });
}

/**
 * The running half of the vocabulary — one hand-written function per verb.
 * There is no `eval`, no `evaluate`, no raw-selector op. That absence is the
 * security model: there is structurally no path from generated text to
 * arbitrary code, whichever page the plan is pointed at.
 *
 * The writing half — how each verb is spelled, written back, drawn and gated —
 * is vocabulary.js. The two are checked against each other below.
 */
export const OPS = {
  async goto(page, step, ctx) {
    checkUrl(step.url, ctx.origins ?? originsOf(LOCAL));   // re-checked at run time, not just at validate
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
      if (landed !== new URL(step.url).origin && !(ctx.origins ?? originsOf(LOCAL)).has(landed)) {
        ctx.emit?.({ t: 'needs.origin', origin: landed, url: page.url(), redirected: true });
        ctx.emit?.({
          t: 'log', level: 'warn',
          msg: `${step.url} redirected to ${landed}, which is not allowed. ` +
               `A recording made here starts from the URL you asked for, so it ` +
               `replays the redirect — allow ${landed} only if you want to point ` +
               `at it directly.`,
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
      // discover() lists names without icon-font glyphs; an entry recorded
      // before it did still has them. Compare the two without icons, or every
      // older recording on an icon-font site would read as the wrong page.
      const plain = (t) => withoutIcons(t).toLowerCase();
      const seenHere = new Set(here.map(plain));
      const found = step.entry.filter((t) => seenHere.has(plain(t))).length;
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

  /** See ACT.hover. With fixes on (ctx.heal), the rules and the model may help it along. */
  async hover(page, step, ctx) {
    await healing('hover', page, step, ctx);
  },

  async click(page, step, ctx) {
    await healing('click', page, step, ctx);
  },

  async fill(page, step, ctx) {
    await healing('fill', page, step, ctx);
  },

  /** The four that point at a control the same way — the rules may help them along, the model is not asked (heal.js AI_OPS). */
  async tick(page, step, ctx) {
    await healing('tick', page, step, ctx);
  },

  async untick(page, step, ctx) {
    await healing('untick', page, step, ctx);
  },

  async choose(page, step, ctx) {
    await healing('choose', page, step, ctx);
  },

  async press(page, step, ctx) {
    await healing('press', page, step, ctx);
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
      const deadline = Date.now() + (step.timeout ?? TIMEOUT);
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
        .waitFor({ state: 'visible', timeout: step.timeout ?? TIMEOUT });
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
      await el(page, step.target, ctx).scrollIntoViewIfNeeded({ timeout: step.timeout ?? TIMEOUT });
    }
    await sleep(180);          // let sticky headers settle and the eye catch up
    ctx.emit?.({ t: 'log', level: 'info', msg: `scrolled to ${step.to ?? step.target}` });
  },

  async wait(page, step) {
    await sleep(Math.min(step.ms ?? 500, 5000));
  },
};

/**
 * A verb is only finished when both halves exist.
 *
 * Written-but-not-runnable used to fail at the moment the step executed, deep
 * in a run; runnable-but-not-written was worse — `showOp` returned null for it
 * and the step vanished from the script silently. Both are now a refusal to
 * start, naming the verb, before anything opens a browser.
 */
for (const name of OP_NAMES) {
  if (!OPS[name]) {
    throw new Error(`vocabulary.js declares "${name}" but ops.js has no runner for it`);
  }
}
for (const name of Object.keys(OPS)) {
  if (!OP_NAMES.includes(name)) {
    throw new Error(`ops.js runs "${name}" but vocabulary.js does not declare it`);
  }
}

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
export function validate(plan, { origins = originsOf(LOCAL), baseOrigin = DEFAULT_ORIGIN } = {}) {
  if (!plan || !Array.isArray(plan.steps)) throw new Error('Plan has no steps');
  if (plan.steps.length > 60) throw new Error('Plan too long');

  let origin = baseOrigin;

  plan.steps.forEach((s, i) => {
    // Shape first, from the one table that defines it.
    const why = checkAction(s);
    if (why !== true) throw new Error(`Step ${i}: ${why}`);

    if (s.op === 'goto') {
      try { origin = checkUrl(s.url, origins).origin; }
      catch (e) {
        // Re-wrap for context, but carry the origin through — the UI turns it
        // into an Allow button, and a plain string cannot be pressed.
        const err = new Error(`Step ${i}: ${e.message}`);
        if (e.origin) { err.origin = e.origin; err.url = e.url; }
        throw err;
      }
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

  /**
   * Whether this plan says for itself where it runs, and where.
   *
   * The allowlist is only consulted for a `goto`, so a plan that opens with a
   * `click` never meets it at all — there is no URL here to check. That is not
   * a plan that runs nowhere; it runs on whatever page is already open, which
   * under tenancy can be another organisation's. Only the caller knows whose
   * page that is, so the fact is REPORTED rather than assumed away, and
   * server.js refuses an unanchored plan whose open page the caller may not
   * drive (docs/AUTH.md §11).
   */
  plan.navigates = plan.steps[0]?.op === 'goto';
  plan.origin = plan.navigates ? origin : null;

  return plan;
}
