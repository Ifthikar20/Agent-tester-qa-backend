/**
 * Suggested fixes: what a run fixed on its way, kept so a person can make it
 * permanent.
 *
 * A fix (heal.js) lets ONE run past a difference between the page and the
 * recording. Most of them say nothing about the case — a cookie banner that
 * happened to be up, an element that happened to be slow — and those are
 * reported with the run and forgotten. Three kinds are different, because the
 * recording itself is now out of date and every future run would need the same
 * fix again:
 *
 *   same_field     label:Email is placeholder:Email now
 *   used_element   the model named the renamed control, and the guards agreed
 *   opened_menu    the option is behind a list the recording never opened
 *   moved          the element is where it was, in name, but not in place: its
 *                  recorded position (`%% at`) is out of date
 *
 * For a saved case those become SUGGESTIONS: stored here, shown to the
 * organisation, and applied to the case only when a person accepts one. Nothing
 * here ever edits a case on its own.
 *
 * One store PER ORGANISATION, `.ghostclick/<org>/fixes.json`, memoised like the
 * allowlist and the vault so every caller in the process sees one state, capped
 * like the run history. Machine-local, like the rest of `.ghostclick/`: a
 * suggestion is about what happened on this runner, and the case it would
 * change is the shared thing, in `suites/<org>/`.
 *
 * The organisation's opt-in to model fixes lives beside it, in
 * `.ghostclick/<org>/heal.json` — `{ "ai": false }` until an owner or admin
 * says otherwise (server.js decides who may).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stateDir } from './org.js';
import { parseFlow, flatten, toFlow, parseAction, showAction } from './flow.js';
import { atOf } from './heal.js';

const CAP = 500;
const now = () => new Date().toISOString();
const newId = () => `fx_${randomBytes(6).toString('hex')}`;

/** The states a suggestion can be in. `stale` is a case that moved on without it. */
export const STATUSES = ['pending', 'accepted', 'rejected', 'stale'];

/** The kinds that are about the recording rather than about one run. */
export const SAVED_KINDS = new Set(['same_field', 'used_element', 'opened_menu', 'moved']);

/**
 * Whether a fix changes anything a case holds: a new target, a click to
 * insert, or — for `moved` only — a position to record. A suggestion that
 * changes nothing could only ever answer Accept with "changes nothing".
 */
export function changesCase(fix) {
  return Boolean(fix?.to || fix?.insert || (fix?.kind === 'moved' && atOf(fix.at)));
}

/** The only ops a fix is ever made on (heal.js AI_OPS, and every rule). */
const FIXED_OPS = new Set(['click', 'fill', 'hover']);

export class NoSuchFix extends Error {
  constructor(id) { super(`No fix "${id}"`); this.name = 'NoSuchFix'; }
}

/**
 * The case no longer has the step the fix was made for. The 409 the route
 * answers is the whole of what the UI needs; `why` is for a person reading it.
 */
export class StaleFix extends Error {
  constructor(why) { super('stale'); this.name = 'StaleFix'; this.why = why; }
}

// ---------------------------------------------------------------- the case

/**
 * `%% via 2 301 http://a -> 200 http://b` -> step index -> hops.
 *
 * toFlow writes where each click actually went, but parseFlow does not read it
 * back — it is evidence, and the executor has no use for it. A rewrite that
 * went through parseFlow alone would therefore drop every `%% via` a recording
 * carries, so they are read here and put back on their steps, and toFlow writes
 * them out again at whatever index the step has now.
 */
function viaMarks(text) {
  const marks = new Map();
  for (const raw of String(text).split('\n')) {
    const m = raw.trim().match(/^%%\s*via\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const hops = m[2].split(' -> ').map((hop) => {
      const h = hop.match(/^(\S+)\s+(.+)$/);
      return h ? { status: h[1] === '?' ? null : Number(h[1]), url: h[2] } : null;
    });
    if (hops.every(Boolean)) marks.set(Number(m[1]), hops);
  }
  return marks;
}

/** A flow, as the steps the runner runs — with the `%% via` evidence on them too. */
function readPlan(flow) {
  const plan = flatten(parseFlow(String(flow)));
  const via = viaMarks(flow);
  plan.steps.forEach((s, i) => { if (via.has(i)) s.via = via.get(i); });
  return plan;
}

/** JSON with sorted keys, so two steps compare by what they say and not by the order it was said in. */
function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const lineOf = (step) => { try { return showAction(step); } catch { return null; } };

/**
 * Which of the identical lines step `i` is: 0 for the first `click 'Next' :
 * button` in the case, 1 for the second. An index and a line are not enough
 * to find a step in a wizard that says Next, Next, Next — a person who adds a
 * wait at the top has moved every Next down one, and the fix meant for the
 * third would land on the second with nothing to say it was wrong.
 */
export function occurrenceOf(steps, i) {
  const line = lineOf(steps?.[i]);
  if (line === null || line === undefined) return null;
  let n = 0;
  for (let j = 0; j < i; j++) if (lineOf(steps[j]) === line) n++;
  return n;
}

/**
 * A case's flow with one fix written into it.
 *
 * The step at `fix.step` must still be the step the fix was made for — the same
 * op, written the same way — or the fix is stale: the case was edited since, and
 * a target swapped into whatever step now sits at that index would be a change
 * nobody reviewed. Then `to` replaces its target and `insert` goes in as a click
 * before it, and the whole plan is written back with toFlow.
 *
 * And checked, because toFlow re-draws the graph rather than editing text: the
 * new flow is parsed again and must give exactly the steps intended — every
 * other step unchanged, the `%% entry` still on the goto, every `%% at` and
 * `%% via` still on the step it described (so after an insertion each one after
 * it has moved up by one). A flow that cannot come back that way — a case that
 * forks, say, whose branches flatten into one plan — is refused rather than
 * saved in a shape nobody wrote.
 *
 * @returns {{flow: string, steps: number, index: number}} `index` is where the fixed step is now.
 */
export function applyFix(flow, fix) {
  let plan;
  try { plan = readPlan(flow); } catch (err) { throw new StaleFix(`the case no longer parses: ${err.message}`); }
  const i = fix?.step;
  const was = Number.isInteger(i) ? plan.steps[i] : undefined;
  if (!was) throw new StaleFix(`the case has no step ${i} any more`);
  if (!FIXED_OPS.has(was.op) || was.op !== fix.op || lineOf(was) !== fix.from) {
    throw new StaleFix(`step ${i} is now "${lineOf(was) ?? was.op}", not "${fix.from}"`);
  }
  if (Number.isInteger(fix.occurrence) && occurrenceOf(plan.steps, i) !== fix.occurrence) {
    throw new StaleFix(`step ${i} reads "${fix.from}", but it is not the one the fix was made for — the case has another like it above`);
  }
  if (!changesCase(fix)) throw new Error('This fix changes nothing in the case');

  const steps = plan.steps.map((s) => ({ ...s }));
  if (fix.to) steps[i] = { ...steps[i], target: String(fix.to) };
  // A position is written onto the step itself, so toFlow puts its `%% at`
  // line out at whatever index the step has — the same way every other mark
  // travels — and the read-back below proves no other step's line moved.
  if (fix.kind === 'moved' && atOf(fix.at)) steps[i] = { ...steps[i], at: atOf(fix.at) };
  let inserted = 0;
  if (fix.insert) {
    let extra = null;
    try { extra = parseAction(String(fix.insert)); } catch { /* reported below */ }
    if (extra?.op !== 'click' || !extra.target) throw new Error(`The step to insert does not read as a click: ${fix.insert}`);
    steps.splice(i, 0, extra);
    inserted = 1;
  }

  // A position alone is one line of the case, and it is edited as one line.
  // toFlow re-draws the whole graph: on a case stored the older way —
  // `flowchart TD`, edges chained on one line — "Update recorded position"
  // also rewrote the header and split every edge, which the read-back below
  // cannot see (the steps are the same) and a person reviewing the case can.
  // The text edit is held to the same read-back; toFlow is the fallback.
  if (fix.kind === 'moved' && !fix.to && !fix.insert) {
    const edited = withAtLine(flow, i, steps[i].at);
    let same = null;
    try { same = edited === null ? null : readPlan(edited); } catch { /* fall back to toFlow */ }
    if (same && canon(same.steps) === canon(steps) && same.suite === plan.suite) {
      return { flow: edited, steps: steps.length, index: i };
    }
  }

  const text = toFlow({ suite: plan.suite, steps });
  let back = null;
  try { back = readPlan(text); } catch { /* reported below */ }
  if (!back || canon(back.steps) !== canon(steps) || back.suite !== plan.suite) {
    throw new Error('This case cannot be rewritten with the fix without changing other steps (a case that forks, perhaps) — apply it by hand');
  }
  return { flow: text, steps: steps.length, index: i + inserted };
}

/**
 * The flow text with step `i`'s `%% at` line saying `at`, in the words toFlow
 * writes it — the line replaced where it stands (its indentation kept), or,
 * for a step that had none, added after the last `%% at` line (or at the end).
 * Null when the text has that step's line more than once: which one a person
 * meant is not for a rewrite to guess.
 */
function withAtLine(flow, i, at) {
  if (!at) return null;
  const mark = `%% at ${i} ${at.x},${at.y} ${at.w}x${at.h} in ${at.vw}x${at.vh}`;
  const lines = String(flow).split('\n');
  const atIndex = (l) => { const m = l.trim().match(/^%%\s*at\s+(\d+)\s/); return m ? Number(m[1]) : null; };
  const mine = lines.flatMap((l, k) => (atIndex(l) === i ? [k] : []));
  if (mine.length > 1) return null;
  if (mine.length === 1) {
    const k = mine[0];
    lines[k] = `${lines[k].match(/^\s*/)[0]}${mark}`;
    return lines.join('\n');
  }
  const last = lines.reduce((found, l, k) => (atIndex(l) !== null ? k : found), -1);
  if (last >= 0) {
    lines.splice(last + 1, 0, `${lines[last].match(/^\s*/)[0]}${mark}`);
  } else {
    // At the end, before a final newline if the text has one.
    const end = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    lines.splice(end, 0, mark);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------- the store

/** The fields of the backend/UI contract a stored fix keeps, trimmed to sensible lengths. */
function fixFields(fix) {
  const str = (v, max) => (v == null ? null : String(v).slice(0, max));
  return {
    kind: String(fix.kind), tier: fix.tier === 'ai' ? 'ai' : 'rule',
    step: Number(fix.step), op: String(fix.op),
    from: String(fix.from ?? ''), to: str(fix.to, 400), insert: str(fix.insert, 400),
    ...(fix.kind === 'moved' ? { at: atOf(fix.at) } : {}),
    note: String(fix.note ?? '').slice(0, 400),
    reason: fix.tier === 'ai' ? str(fix.reason, 300) : null,
    confidence: fix.tier === 'ai' && Number.isFinite(fix.confidence) ? fix.confidence : null,
    ...(Number.isInteger(fix.occurrence) ? { occurrence: fix.occurrence } : {}),
  };
}

const keyOf = (s) => JSON.stringify([s.suiteId, s.caseId, s.step, s.from, s.to, s.insert, s.kind]);

/**
 * A suggestion store over one file. `forOrg` is the one the server uses; a
 * check opens one on a scratch file.
 */
export function openStore(file) {
  let all = [];
  try { all = JSON.parse(readFileSync(file, 'utf8')).fixes ?? []; } catch { /* first fix */ }

  function persist() {
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify({ fixes: all }, null, 2));
    } catch { /* read-only checkout: the suggestions still work for this session */ }
  }

  /**
   * Over the cap, what goes first is what nobody is waiting on: the oldest
   * accepted, rejected and stale ones, and only then the oldest pending.
   */
  function trim() {
    if (all.length <= CAP) return;
    const byAge = [...all].sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt)));
    const drop = new Set([...byAge.filter((s) => s.status !== 'pending'), ...byAge.filter((s) => s.status === 'pending')]
      .slice(0, all.length - CAP));
    all = all.filter((s) => !drop.has(s));
  }

  const copy = (s) => ({ ...s, saved: true });
  const find = (id) => all.find((s) => s.id === id) ?? null;

  const store = {
    file,

    /**
     * Newest sighting first. `all` is every status. Two sightings in the same
     * millisecond — the fixes of one step — keep the later-made one first,
     * which is why the sort starts from the store reversed: it is stable.
     */
    list(status = 'pending') {
      return [...all].reverse().filter((s) => status === 'all' || s.status === status)
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .map(copy);
    },

    pending: () => all.filter((s) => s.status === 'pending').length,

    get(id) {
      const s = find(id);
      if (!s) throw new NoSuchFix(id);
      return copy(s);
    },

    /**
     * A fix from a run of a saved case: a new suggestion, or the same one seen
     * again. "The same" is the same case, step, recorded line, replacement,
     * insertion and kind — so a fix that recurs on every run is one suggestion
     * whose `seen` climbs, not a new row a night.
     *
     * Seen again, a rejected suggestion stays rejected: a person said no, and a
     * run is not a reason to ask twice. Anything else is pending again — a
     * stale one whose step has come back, or an accepted one whose case has
     * lost it since.
     */
    suggest(fix, { suiteId, caseId, caseName, occurrence }) {
      // `occurrence` (occurrenceOf, from the plan the run used) is what tells
      // one of several identical steps from the others at accept time.
      const fields = fixFields(Number.isInteger(occurrence) ? { ...fix, occurrence } : fix);
      const at = now();
      const probe = { ...fields, suiteId, caseId };
      let s = all.find((x) => keyOf(x) === keyOf(probe));
      if (s) {
        Object.assign(s, { note: fields.note, tier: fields.tier, reason: fields.reason, confidence: fields.confidence });
        // A position is not part of what makes two sightings the same (keyOf):
        // a layout that settles a pixel differently each run is one suggestion,
        // and it offers the latest place the element was seen. Not once it is
        // rejected: what a person said no to is what stays on record, and a
        // later accept through the API must not write a position nobody saw.
        if (fields.kind === 'moved' && s.status !== 'rejected') s.at = fields.at;
        s.caseName = caseName ?? s.caseName;
        s.lastSeenAt = at;
        s.seen = (s.seen ?? 1) + 1;
        if (s.status !== 'rejected') s.status = 'pending';
      } else {
        s = { ...fields, saved: true, id: newId(), status: 'pending', suiteId, caseId, caseName: caseName ?? null,
          createdAt: at, lastSeenAt: at, seen: 1 };
        all.push(s);
        trim();
      }
      persist();
      return copy(s);
    },

    /**
     * Write the fix into its case, through `suites.updateCase` — which runs
     * `check` over the new flow, so a case is never saved in a shape the runner
     * would refuse.
     *
     * A case that has moved on is marked stale and StaleFix is thrown; so is a
     * case or suite that is gone. After an accept, the organisation's other
     * pending suggestions for the SAME case are looked at again: one whose step
     * sat after an inserted click is moved up by one, and one that no longer
     * applies at all is marked stale — so the pending count means something.
     *
     * @param suites the organisation's suites store (suites.js)
     * @param check  flow -> plan, the validator the case routes use
     */
    accept(id, { suites, check }) {
      const s = find(id);
      if (!s) throw new NoSuchFix(id);
      if (s.status === 'accepted') throw new Error('This fix has already been accepted');
      const stale = (why) => {
        s.status = 'stale';
        persist();
        return new StaleFix(why);
      };
      let kase = null;
      try { kase = suites.get(s.suiteId).cases.find((c) => c.id === s.caseId) ?? null; } catch { /* no such suite */ }
      if (!kase) throw stale('the case is gone');
      let out;
      const oldFlow = kase.flow;
      try { out = applyFix(oldFlow, s); } catch (err) {
        if (err instanceof StaleFix) throw stale(err.why);
        throw err;
      }
      const saved = suites.updateCase(s.suiteId, s.caseId, { flow: out.flow }, check);
      s.status = 'accepted';
      s.lastSeenAt = now();

      // The case's other pending suggestions, carried across the edit by
      // INDEX, never by searching for their line: each must fit the flow as it
      // was, then moves down one if the click went in at or above it, and must
      // fit the new flow there. Searching first was how a rename meant for the
      // second of two identical Next steps landed on the first.
      const insertedAt = s.insert ? s.step : null;
      let newSteps = null;
      try { newSteps = readPlan(saved.flow).steps; } catch { /* then nothing fits, below */ }
      const fits = (flow, other, step, occurrence) => {
        try { applyFix(flow, { ...other, step, occurrence }); return true; } catch (err) { return !(err instanceof StaleFix) && changesCase(other); }
      };
      for (const other of all) {
        if (other === s || other.status !== 'pending' || other.suiteId !== s.suiteId || other.caseId !== s.caseId) continue;
        const known = Number.isInteger(other.occurrence);
        if (!fits(oldFlow, other, other.step, known ? other.occurrence : undefined)) { other.status = 'stale'; continue; }
        const step = other.step + (insertedAt !== null && other.step >= insertedAt ? 1 : 0);
        const occurrence = known && newSteps ? occurrenceOf(newSteps, step) : undefined;
        if (newSteps && fits(saved.flow, other, step, occurrence)) {
          other.step = step;
          if (known) other.occurrence = occurrence;
        } else {
          other.status = 'stale';
        }
      }
      persist();
      return {
        fix: copy(s),
        case: { suiteId: s.suiteId, caseId: s.caseId, flow: saved.flow, steps: saved.steps },
      };
    },

    reject(id) {
      const s = find(id);
      if (!s) throw new NoSuchFix(id);
      s.status = 'rejected';
      persist();
      return copy(s);
    },
  };
  return store;
}

const stores = new Map();

/** The suggestions of one organisation, the same object for every caller. */
export function forOrg(org) {
  const have = stores.get(org);
  if (have) return have;
  const store = { org, ...openStore(join(stateDir(org), 'fixes.json')) };
  stores.set(org, store);
  return store;
}

// ------------------------------------------------------------ the setting

/**
 * Whether an organisation lets a model look at its pages, over one file.
 *
 * Off until someone says otherwise, and "someone" is decided by the caller
 * (owner or admin, server.js). A page snapshot leaving the machine is a
 * decision the organisation makes about its own data; the deployment can offer
 * it (GC_HEAL=ai with a key) but cannot make it for them.
 */
export function openSetting(file) {
  // Two consents, two questions: `ai` is "may a model fix our broken steps"
  // (a single recorded step, under a human accept); `plan` is "may a model
  // read our pages to draft test cases" (chat-plan.js: whole scripts, from a
  // page's own words). Each off until an owner or admin says otherwise; a
  // file written before `plan` existed reads as plan off.
  let ai = false;
  let plan = false;
  try {
    const read = JSON.parse(readFileSync(file, 'utf8'));
    ai = read.ai === true;
    plan = read.plan === true;
  } catch { /* the defaults */ }
  return {
    file,
    get: () => ({ ai, plan }),
    set(patch) {
      if (typeof patch?.ai !== 'boolean' && typeof patch?.plan !== 'boolean') throw new Error('ai or plan must be true or false');
      if (typeof patch.ai === 'boolean') ai = patch.ai;
      if (typeof patch.plan === 'boolean') plan = patch.plan;
      try {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify({ ai, plan }, null, 2));
      } catch { /* read-only checkout: the setting holds for this session */ }
      return { ai, plan };
    },
  };
}

const settings = new Map();

/** The heal setting of one organisation, the same object for every caller. */
export function settingFor(org) {
  const have = settings.get(org);
  if (have) return have;
  const setting = { org, ...openSetting(join(stateDir(org), 'heal.json')) };
  settings.set(org, setting);
  return setting;
}
