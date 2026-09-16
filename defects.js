/**
 * Defects: numbered, filed by the runner, triaged by people.
 *
 * Run history answers "what happened". This answers "what is broken", and
 * gives each answer a number a person can say out loud and paste into a
 * ticket: DEF-2609-007 is the seventh distinct failure first seen in
 * September 2026.
 *
 * Nobody files a defect. Every run is folded in here: a failure joins the
 * defect it has been before or is filed as a new one, a pass closes every
 * open defect that took its case down, and a failure that comes back after
 * that reopens its defect under the same number. Filing, closing and
 * reopening are the application's, and each lands in the defect's activity
 * as ghostclick's.
 *
 * People triage. An owner or admin may assign a defect, overrule the severity
 * the runner worked out, or park it as a known issue or won't-fix — the only
 * three things a person writes, each recorded with who wrote it. A parked
 * defect that starts passing is closed like any other: the decision was about
 * a failure that has stopped happening, so if it comes back it comes back
 * reopened, for someone to look at again, rather than hidden under last
 * month's "won't fix".
 *
 * WHAT MAKES TWO FAILURES ONE DEFECT. A run records only its first failure,
 * because a run stops there, so a defect is that sentence, about the step that
 * failed, on the site it happened on. Grouping by what failed rather than by
 * the case is the point: one broken selector takes down four cases, and four
 * rows saying the same thing is a list, not a diagnosis. The step is part of
 * it because a sentence is not always about anything — Playwright says
 * "locator.waitFor: Timeout 8000ms exceeded." of every wait that runs out, and
 * a missing receipt and a missing price are two defects. The site is part of
 * it because the same failure on two sites is two problems. How long something
 * waited is not, because "did not turn up in the 10.5s this waited" and
 * "…10.4s…" are the same wait running out.
 *
 * WHY A REGISTRY. Defects used to be recomputed from run history on every
 * read, which was honest and could not number anything: history is capped and
 * pruned, so a number derived from it would move as old runs fell off the end.
 * This keeps what a number needs — above all each month's counter, so a
 * number is never handed out twice — and is brought up to date from history
 * after every run and before every read, so it cannot drift from what ran.
 *
 * One registry per organisation, `.ghostclick/<org>/defects.json`, beside the
 * history it is read out of. Machine-local and gitignored, like the rest.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './org.js';

const DAY_MS = 86_400_000;
const CAP = 1000;            // defects kept; past it, the longest-closed go first
const MAX_CASES = 50;
const MAX_SUITES = 20;
const MAX_ACTIVITY = 60;

export const PREFIX = 'DEF';
/** Worst first. The runner picks from the first three; trivial is only ever a person's call. */
export const SEVERITIES = ['critical', 'major', 'minor', 'trivial'];
/** What a person may park a failing defect as. */
export const RESOLUTIONS = ['known_issue', 'wont_fix'];
const TRIAGE_FIELDS = ['assignee', 'severity', 'resolution'];

export class NoSuchDefect extends Error {
  constructor(id) { super(`No defect "${id}"`); this.name = 'NoSuchDefect'; }
}
export class BadTriage extends Error {
  constructor(message) { super(message); this.name = 'BadTriage'; }
}

// ---------------------------------------------------------------- the number

/** `2609` for September 2026. UTC, so a number does not depend on where the runner is. */
export function monthOf(t) {
  const d = new Date(t);
  return `${String(d.getUTCFullYear() % 100).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Three digits, and more once a month has seen a thousand — never truncated. */
export const formatId = (month, n) => `${PREFIX}-${month}-${String(n).padStart(3, '0')}`;

/**
 * Any way a person might type a number, as the number: DEF-2609-007,
 * def-2609-7, 2609-007, #2609-7 and 2609007 are all DEF-2609-007. Null for
 * anything that is not one.
 */
export function canonicalId(input) {
  const m = String(input ?? '').trim().match(/^#?(?:def[-_\s]*)?(\d{2})(0[1-9]|1[0-2])[-_\s]*(\d{1,6})$/i);
  if (!m || Number(m[3]) === 0) return null;
  return formatId(`${m[1]}${m[2]}`, Number(m[3]));
}

// ---------------------------------------------------------------- the identity

/** The parts of a failure's sentence that change between two sightings of it, taken out. */
export const normalize = (error) => String(error ?? '')
  .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|secs?|seconds?|mins?|minutes?)\b/gi, '#')
  .replace(/\s+/g, ' ')
  .trim();

export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch { return ''; }
}

/**
 * One defect's identity: the site, the sentence without its timings, and the
 * step that failed (runs.js `doing`) — empty for a run recorded before runs
 * named it.
 */
export const fingerprint = (run) => createHash('sha256')
  .update(`${originOf(run.url)}\n${normalize(run.error)}\n${run.target ?? ''}`)
  .digest('hex').slice(0, 16);

/**
 * A case as history knows it: its id, or — for a script run from the console,
 * which has none — where it started.
 */
const caseKey = (r) => r.caseId ?? `${r.suite}:${r.caseName ?? r.url}`;

/** A suite's case is recorded as "Suite · Case"; a console run has only the one name. */
function suiteNameOf(r) {
  const tail = r.caseName ? ` · ${r.caseName}` : '';
  return tail && r.suite?.endsWith(tail) ? r.suite.slice(0, -tail.length) : (r.suite || 'Untitled');
}
const whereOf = (r) => r.caseName ?? suiteNameOf(r);

// ---------------------------------------------------------------- the verdicts

/**
 * The severity the runner works out, from what it knows rather than a guess:
 * critical when the case could not get past its first step, or three or more
 * cases have gone down with it; major when two have, or it has come back after
 * being fixed; minor otherwise.
 */
export function autoSeverity(d) {
  if (d.step === 0 || d.cases.length >= 3) return 'critical';
  if (d.cases.length === 2 || d.reopened > 0) return 'major';
  return 'minor';
}

/** The first of these that is true: closed, parked (known_issue, wont_fix), reopened, open. */
export function statusOf(d) {
  if (d.closedAt) return 'closed';
  if (d.triage.resolution) return d.triage.resolution;
  return d.reopened > 0 ? 'reopened' : 'open';
}

/** What a caller is shown. The fingerprints stay in here: they are how failures are matched, not facts about them. */
function view(d) {
  return {
    id: d.id,
    title: d.title,
    target: d.target ?? null,
    origin: d.origin,
    url: d.url,
    step: d.step,
    firstSeen: d.firstSeen,
    lastSeen: d.lastSeen,
    hits: d.hits,
    reopened: d.reopened,
    closedAt: d.closedAt,
    cases: d.cases.map((c) => ({ ...c })),
    suites: d.suites.map((s) => ({ ...s })),
    status: statusOf(d),
    severity: d.triage.severity ?? autoSeverity(d),
    autoSeverity: autoSeverity(d),
    severityBy: d.triage.severity ? 'person' : 'ghostclick',
    assignee: d.triage.assignee ? { ...d.triage.assignee } : null,
    reporter: 'ghostclick',
    updatedAt: d.updatedAt,
  };
}

const clip = (v, n) => ((typeof v === 'string' || typeof v === 'number') ? String(v).trim().slice(0, n) : '') || null;

/**
 * {id, email, name}: a member of the organisation, as the control plane lists
 * them — or only a name, where there is no control plane to have members.
 */
function assigneeOf(v) {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadTriage('assignee is {id, email, name}, or null for nobody');
  const a = { id: clip(v.id, 64), email: clip(v.email, 254), name: clip(v.name, 120) };
  if (!a.email && !a.name) throw new BadTriage('an assignee needs an email or a name');
  if (a.email && !/^[^\s@]+@[^\s@]+$/.test(a.email)) throw new BadTriage(`"${a.email}" is not an email address`);
  return a;
}
const sameAssignee = (a, b) => ['id', 'email', 'name'].every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));

// ---------------------------------------------------------------- the registry

const registries = new Map();

/** The registry of one organisation, the same object for every caller. */
export function forOrg(org) {
  let store = registries.get(org);
  if (!store) {
    store = open(org);
    registries.set(org, store);
  }
  return store;
}

/**
 * A registry read from disk and not memoised: what forOrg keeps, and how a
 * check proves that a restart keeps every number.
 */
export function open(org) {
  const STORE = join(stateDir(org), 'defects.json');
  let state = { counters: {}, seen: { at: 0, ties: 0 }, defects: [] };
  try {
    const saved = JSON.parse(readFileSync(STORE, 'utf8'));
    state = { counters: saved.counters ?? {}, seen: saved.seen ?? { at: 0, ties: 0 }, defects: saved.defects ?? [] };
  } catch (err) {
    // There and unreadable is moved aside, never written over: its counters
    // are the only record of which numbers have been spent.
    if (err.code !== 'ENOENT') {
      try { renameSync(STORE, `${STORE}.unreadable-${Date.now()}`); } catch { /* leave it where it is */ }
    }
  }

  // Every fingerprint a defect has answered to, including the ones it was
  // filed under before it knew its step (see adopt).
  let byFp = new Map();
  let byId = new Map();
  const index = () => {
    byFp = new Map();
    for (const d of state.defects) for (const key of [d.fp, ...(d.aliases ?? [])]) byFp.set(key, d);
    byId = new Map(state.defects.map((d) => [d.id, d]));
  };
  index();

  function persist() {
    try {
      mkdirSync(stateDir(org), { recursive: true });
      const text = JSON.stringify({ version: 1, ...state }, null, 2);
      // Whole or not at all: a half-written file would lose the counters.
      const tmp = `${STORE}.tmp`;
      writeFileSync(tmp, text);
      try { renameSync(tmp, STORE); } catch {
        writeFileSync(STORE, text);
        rmSync(tmp, { force: true });
      }
    } catch { /* read-only checkout: the numbers hold for as long as this process does */ }
  }

  const find = (id) => {
    const d = byId.get(canonicalId(id) ?? String(id ?? ''));
    if (!d) throw new NoSuchDefect(id);
    return d;
  };

  const note = (d, ev) => {
    d.activity.push(ev);
    // The first entry is the filing, and is kept whatever else is trimmed.
    if (d.activity.length > MAX_ACTIVITY) d.activity.splice(1, d.activity.length - MAX_ACTIVITY);
    d.updatedAt = Math.max(d.updatedAt, ev.at);
  };

  function file(r, fp) {
    const month = monthOf(r.at);
    const n = (state.counters[month] ?? 0) + 1;
    state.counters[month] = n;
    const d = {
      id: formatId(month, n), fp, aliases: [], title: r.error, target: r.target ?? null,
      origin: originOf(r.url), url: r.url || '', step: r.step ?? null,
      firstSeen: r.at, lastSeen: r.at, hits: 0, reopened: 0, closedAt: null,
      cases: [], suites: [],
      triage: { assignee: null, severity: null, resolution: null },
      activity: [], updatedAt: r.at,
    };
    note(d, {
      at: r.at, by: null, kind: 'filed',
      text: `${whereOf(r)} failed${r.step == null ? '' : ` at step ${r.step + 1}`}${r.target ? `: ${r.target}` : ''}`,
    });
    state.defects.push(d);
    byFp.set(fp, d);
    byId.set(d.id, d);
    return d;
  }

  /**
   * Runs recorded before a run said which step failed have no step to match
   * on, so their defect was filed by the sentence alone. The first run that
   * names its step and says the same thing on the same site takes that defect
   * over, number and all — so upgrading does not file every standing failure
   * a second time — and only the first: a defect that already knows its step
   * is some other step's.
   */
  function adopt(r, fp) {
    const d = byFp.get(fingerprint({ ...r, target: null }));
    if (!d || d.target) return null;
    d.aliases = [...(d.aliases ?? []), d.fp];
    d.fp = fp;
    d.target = r.target;
    byFp.set(fp, d);
    return d;
  }

  /** One run, into the registry. Whatever a person would want to be told is appended to `changes`. */
  function fold(r, changes) {
    if (r.ok) {
      // Any affected case passing since the failure was last seen closes it:
      // nobody has to remember to.
      const key = caseKey(r);
      for (const d of state.defects) {
        if (d.closedAt || r.at <= d.lastSeen || !d.cases.some((c) => c.key === key)) continue;
        const parked = d.triage.resolution;
        d.closedAt = r.at;
        d.triage.resolution = null;
        note(d, {
          at: r.at, by: null, kind: 'closed',
          text: `${whereOf(r)} passed${parked ? `, so it is no longer ${parked === 'wont_fix' ? "won't fix" : 'a known issue'}` : ''}`,
        });
        changes.push({ kind: 'closed', id: d.id, title: d.title });
      }
      return;
    }
    if (!r.error) return;

    const fp = fingerprint(r);
    let d = byFp.get(fp) ?? (r.target ? adopt(r, fp) : null);
    if (!d) {
      d = file(r, fp);
      changes.push({ kind: 'filed', id: d.id, title: d.title });
    } else if (d.closedAt && r.at > d.closedAt) {
      d.closedAt = null;
      d.reopened++;
      note(d, { at: r.at, by: null, kind: 'reopened', text: `${whereOf(r)} failed again` });
      changes.push({ kind: 'reopened', id: d.id, title: d.title });
    }

    d.hits++;
    // The newest wording and the newest step: "waited 10.4s" rather than the 10.5s of a week ago.
    if (r.at >= d.lastSeen) {
      Object.assign(d, { lastSeen: r.at, title: r.error, step: r.step ?? null, url: r.url || d.url, target: r.target ?? d.target ?? null });
    }
    d.updatedAt = Math.max(d.updatedAt, r.at);

    const key = caseKey(r);
    const known = d.cases.find((c) => c.key === key);
    if (known) Object.assign(known, { name: r.caseName ?? known.name, suite: suiteNameOf(r) });
    else if (d.cases.length < MAX_CASES) {
      d.cases.push({ key, id: r.caseId ?? null, name: r.caseName ?? null, suiteId: r.suiteId ?? null, suite: suiteNameOf(r) });
    }
    const suite = { id: r.suiteId ?? null, name: suiteNameOf(r) };
    const same = d.suites.find((s) => (s.id ?? `name:${s.name}`) === (suite.id ?? `name:${suite.name}`));
    if (same) same.name = suite.name;
    else if (d.suites.length < MAX_SUITES) d.suites.push(suite);
  }

  return {
    org,

    /**
     * Fold in every run not folded in yet, oldest first. Safe to call as often
     * as you like, because a run is folded exactly once: `seen` is the time of
     * the last run folded and how many runs share that millisecond, since two
     * cases can finish inside one.
     *
     * @returns {{kind: 'filed'|'reopened'|'closed', id: string, title: string}[]}
     */
    sync(runs) {
      const sorted = runs.filter((r) => Number.isFinite(r?.at)).sort((a, b) => a.at - b.at);
      const changes = [];
      const { at: seenAt, ties: seenTies } = state.seen;
      let tie = 0;
      let folded = 0;
      for (const r of sorted) {
        if (r.at < seenAt) continue;
        if (r.at === seenAt && tie++ < seenTies) continue;
        fold(r, changes);
        folded++;
      }
      if (folded) {
        const last = sorted[sorted.length - 1].at;
        state.seen = { at: last, ties: sorted.filter((r) => r.at === last).length };
        persist();
      }
      return changes;
    },

    /** Every defect kept, most recently seen first. */
    list: () => state.defects.map(view).sort((a, b) => b.lastSeen - a.lastSeen),

    /** One defect, with its activity, by any spelling canonicalId accepts. */
    get(id) {
      const d = find(id);
      return { ...view(d), activity: d.activity.map((e) => ({ ...e })) };
    },

    /** The defect a failed run was filed under, or null — so history can link to the number. */
    idFor(run) {
      if (!run || run.ok || !run.error) return null;
      return byFp.get(fingerprint(run))?.id ?? null;
    },

    /** The failed runs in `runs` that are this defect, newest first. */
    runsOf(id, runs, limit = 25) {
      const d = find(id);
      const keys = new Set([d.fp, ...(d.aliases ?? [])]);
      return runs.filter((r) => !r.ok && r.error && keys.has(fingerprint(r))).slice(-limit).reverse();
    },

    totals() {
      const t = { all: 0, open: 0, reopened: 0, known_issue: 0, wont_fix: 0, closed: 0, unassigned: 0 };
      for (const d of state.defects) {
        const s = statusOf(d);
        t.all++;
        t[s]++;
        if ((s === 'open' || s === 'reopened') && !d.triage.assignee) t.unassigned++;
      }
      return t;
    },

    /**
     * A person's change to the fields that are theirs. Only the keys sent are
     * changed, null puts one back to the runner's own answer, and nothing is
     * written unless every key is valid. `by` is who, from the token.
     */
    triage(id, patch, by, now = Date.now()) {
      const d = find(id);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new BadTriage('send the fields to change: assignee, severity or resolution');
      }
      const unknown = Object.keys(patch).filter((k) => !TRIAGE_FIELDS.includes(k));
      if (unknown.length) {
        throw new BadTriage(`${unknown.join(', ')} cannot be changed: assignee, severity and resolution are a person's, the rest is what the runner saw`);
      }
      const next = { ...d.triage };
      const changed = [];
      if ('severity' in patch) {
        const v = patch.severity;
        if (v !== null && !SEVERITIES.includes(v)) throw new BadTriage(`severity is one of ${SEVERITIES.join(', ')}, or null for the runner's own`);
        if (v !== next.severity) { changed.push({ kind: 'severity', from: next.severity, to: v }); next.severity = v; }
      }
      if ('resolution' in patch) {
        const v = patch.resolution;
        if (v !== null && !RESOLUTIONS.includes(v)) throw new BadTriage(`resolution is ${RESOLUTIONS.join(' or ')}, or null to track it again`);
        if (v !== null && d.closedAt) throw new BadTriage(`${d.id} is passing again, so there is nothing to park`);
        if (v !== next.resolution) { changed.push({ kind: 'resolution', from: next.resolution, to: v }); next.resolution = v; }
      }
      if ('assignee' in patch) {
        const v = assigneeOf(patch.assignee);
        if (!sameAssignee(v, next.assignee)) { changed.push({ kind: 'assignee', from: next.assignee, to: v }); next.assignee = v; }
      }
      if (changed.length) {
        d.triage = next;
        for (const c of changed) note(d, { at: now, by, ...c });
        persist();
      }
      return { ...view(d), activity: d.activity.map((e) => ({ ...e })) };
    },

    /**
     * Forget closed defects the plan no longer keeps — `history.retention_days`,
     * the number run history is pruned to — and the longest-closed past the
     * cap. An open defect is kept however old it is, because it is still true.
     * The counters are never pruned: a number, once spent, stays spent.
     */
    prune(days, now = Date.now()) {
      const before = state.defects.length;
      if (days !== null && days !== undefined) {
        const since = now - Number(days) * DAY_MS;
        state.defects = state.defects.filter((d) => !d.closedAt || d.closedAt >= since);
      }
      if (state.defects.length > CAP) {
        const drop = new Set(state.defects.filter((d) => d.closedAt)
          .sort((a, b) => a.closedAt - b.closedAt)
          .slice(0, state.defects.length - CAP));
        state.defects = state.defects.filter((d) => !drop.has(d));
      }
      const dropped = before - state.defects.length;
      if (dropped) {
        index();
        persist();
      }
      return dropped;
    },

    path: () => STORE,
  };
}
