/**
 * Run history.
 *
 * A dashboard of invented numbers is worse than no dashboard, so every finished
 * run is appended here and the page reads from it. Machine-local and gitignored,
 * like the rest of `.ghostclick/` — this is a record of what happened on your
 * machine, not project data.
 *
 * One history PER ORGANISATION, in `.ghostclick/<org>/runs.json` (docs/AUTH.md
 * §10). It is also where two of the plan's numbers are counted from: how many
 * runs the organisation has made today (`runs.per_day`) and how far back its
 * history is kept (`history.retention_days`). Both are read from THIS file,
 * never from anything the client sent — a limit counted from a number the UI
 * reports would be a limit the UI sets.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './org.js';
import { showAction, showTarget } from './vocabulary.js';

const CAP = 500;                       // enough for a fortnight of honest use
const FIXES_KEPT = 20;                 // a run's fixes, as the history keeps them
const DAY_MS = 86_400_000;

/** The model's why for a failed step, as the history keeps it: its words cut short, like a fix's reason. */
const whyKept = (why) => ({
  failure: typeof why.failure === 'string' ? why.failure : 'unknown',
  reason: String(why.reason ?? '').slice(0, 300),
  advice: why.advice ? String(why.advice).slice(0, 200) : null,
  confidence: typeof why.confidence === 'number' ? why.confidence : null,
});
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/**
 * What a step was doing, as a line of the case language — without the value
 * it typed or compared, which may have come from the vault.
 *
 * Kept with a failed run because the sentence a failure leaves is not always
 * about anything: Playwright says "locator.waitFor: Timeout 8000ms exceeded."
 * of every wait that runs out, and a defect filed by the sentence alone would
 * put a missing receipt and a missing price under one number (defects.js).
 */
export function doing(step) {
  if (!step) return null;
  switch (step.assert ?? step.op) {
    case 'goto': return `open ${step.url}`;
    case 'urlContains': return `arrive at '${step.value}'`;
    case 'fill': return `fill ${showTarget(step.target)}`;
    case 'valueEquals': return `check ${showTarget(step.target)}`;
    default:
      try { return showAction(step); } catch { return step.op ?? null; }
  }
}

const histories = new Map();

/** The history of one organisation, the same object for every caller. */
export function forOrg(org) {
  const have = histories.get(org);
  if (have) return have;

  const STORE = join(stateDir(org), 'runs.json');
  let all = [];
  try { all = JSON.parse(readFileSync(STORE, 'utf8')).runs ?? []; } catch { /* first run */ }

  function persist() {
    try {
      mkdirSync(stateDir(org), { recursive: true });
      writeFileSync(STORE, JSON.stringify({ runs: all }, null, 2));
    } catch { /* read-only checkout: the session still has its history in memory */ }
  }

  const store = {
    org,

    /**
     * @param {{suite:string, suiteId?:string, caseId?:string, caseName?:string, url:string, ms:number, results:Array, steps?:Array, draft?:boolean}} run
     *   `draft` is a case a model drafted and nobody has accepted (chat-plan.js):
     *   kept, and counted by today() against the plan, but absent from every
     *   total the dashboard shows and never folded into a defect (defects.js).
     */
    record({ suite, suiteId, caseId, caseName, url, ms, results, steps, draft = false }) {
      const failed = results.filter((r) => !r.ok);
      const fixes = results.flatMap((r) => r.fixes ?? []);
      const entry = {
        at: Date.now(),
        suite: suite || 'Untitled',
        // A run started from the console belongs to no suite. Recording that
        // honestly is what lets the dashboard say "5 ad-hoc runs" instead of
        // filing them under whichever suite happened to be open.
        suiteId: suiteId ?? null,
        caseId: caseId ?? null,
        caseName: caseName ?? null,
        url: url || '',
        ms,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        ok: failed.length === 0,
        // What the run fixed on its way (heal.js): a pass that needed three
        // fixes is not the same news as a clean one. The count is exact; the
        // list is the first twenty, with a model's reason cut short.
        fixed: fixes.length,
        fixes: fixes.slice(0, FIXES_KEPT).map((f) => ({ ...f, reason: f.reason == null ? null : String(f.reason).slice(0, 200) })),
        // Just the first failure. A run stops at the first one anyway.
        error: failed[0]?.error?.split('\n')[0]?.slice(0, 240) ?? null,
        step: failed[0] ? failed[0].i : null,
        // The model's why, for a failure no fix may change (ops.js
        // explainFailure) — only when there is one, so every other row is the
        // row it always was.
        ...(failed[0]?.why ? { why: whyKept(failed[0].why) } : {}),
        // And what that step was doing, since the sentence does not always say
        // (defects.js reads it as part of a defect's identity).
        target: failed[0] ? doing(steps?.[failed[0].i])?.slice(0, 240) ?? null : null,
        ...(draft ? { draft: true } : {}),
      };
      all.push(entry);
      if (all.length > CAP) all = all.slice(-CAP);
      persist();
      return entry;
    },

    list: () => all.slice(),

    /**
     * How many runs today, by this machine's calendar — the same day the
     * dashboard's buckets use, so the number the plan counts against is the
     * number the page shows.
     */
    today: (now = Date.now()) => all.filter((r) => r.at >= startOfDay(now)).length,

    /**
     * Forget runs older than `days`. Null is unlimited and forgets nothing.
     * Returns how many were dropped; the file is rewritten only when
     * something was.
     */
    prune(days, now = Date.now()) {
      if (days === null || days === undefined) return 0;
      const since = now - Number(days) * DAY_MS;
      const kept = all.filter((r) => r.at >= since);
      const dropped = all.length - kept.length;
      if (dropped) { all = kept; persist(); }
      return dropped;
    },

    /**
     * Everything the dashboard needs, computed once here rather than in the page.
     *
     * @param suiteId when given, only that suite's runs — so a suite page and the
     *   overall dashboard are the same view over a different slice, not two
     *   implementations that will disagree by next week.
     */
    summary(days = 14, suiteId = null) {
      // A draft's attempts are a model trying a case out, not the project's
      // record: they stay out of every number here (today() still counts them).
      const runs = (suiteId ? all.filter((r) => r.suiteId === suiteId) : all).filter((r) => !r.draft);
      const now = Date.now();
      const since = now - (days - 1) * DAY_MS;

      // Every day in the window, including the empty ones — a gap is information.
      const buckets = new Map();
      for (let i = 0; i < days; i++) {
        const day = startOfDay(since + i * DAY_MS);
        buckets.set(day, { day, passed: 0, failed: 0 });
      }
      for (const r of runs) {
        const b = buckets.get(startOfDay(r.at));
        if (b) b[r.ok ? 'passed' : 'failed']++;
      }

      // One row per suite, newest first, so the table answers "what is red today".
      const bySuite = new Map();
      for (const r of runs) {
        const s = bySuite.get(r.suite) ?? { suite: r.suite, suiteId: r.suiteId ?? null, runs: 0, passed: 0, last: null };
        s.runs++;
        if (r.ok) s.passed++;
        if (!s.last || r.at > s.last.at) s.last = r;
        bySuite.set(r.suite, s);
      }

      const recent = runs.filter((r) => r.at >= now - 7 * DAY_MS);
      const durations = recent.map((r) => r.ms).sort((a, b) => a - b);

      return {
        days: [...buckets.values()],
        suites: [...bySuite.values()].sort((a, b) => b.last.at - a.last.at),
        totals: {
          runs: runs.length,
          week: recent.length,
          passRate: recent.length ? recent.filter((r) => r.ok).length / recent.length : null,
          medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
          suites: bySuite.size,
        },
        // A run recorded before fixes existed made none; copies, so the
        // default is never written back into the history.
        latest: runs.slice(-12).reverse().map((r) => ({ fixed: 0, fixes: [], ...r })),
      };
    },
  };
  histories.set(org, store);
  return store;
}
