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

const CAP = 500;                       // enough for a fortnight of honest use
const DAY_MS = 86_400_000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

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

    /** @param {{suite:string, suiteId?:string, caseId?:string, caseName?:string, url:string, ms:number, results:Array}} run */
    record({ suite, suiteId, caseId, caseName, url, ms, results }) {
      const failed = results.filter((r) => !r.ok);
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
        // Just the first failure. A run stops at the first one anyway.
        error: failed[0]?.error?.split('\n')[0]?.slice(0, 240) ?? null,
        step: failed[0] ? failed[0].i : null,
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
     * The same failure, however many runs hit it.
     *
     * A run records only its FIRST failure, because a run stops there — so a
     * defect is that sentence, and the interesting questions are how often it
     * has happened and whether it is still happening. Grouping by the message
     * rather than by the case is deliberate: one broken selector usually
     * breaks several cases, and seeing that as one defect with four cases
     * attached is the whole point of the page.
     *
     * `open` means the affected case has not passed since it last failed. It
     * is a cheap signal and an honest one — nobody has to remember to close
     * anything.
     */
    defects(days = 14) {
      const since = Date.now() - days * DAY_MS;
      const runs = all.filter((r) => r.at >= since);

      // When each case last passed, so a defect can say whether it is still live.
      const lastPass = new Map();
      for (const r of runs) {
        if (!r.ok) continue;
        const k = r.caseId ?? `${r.suite}:${r.caseName ?? r.url}`;
        if (!lastPass.has(k) || r.at > lastPass.get(k)) lastPass.set(k, r.at);
      }

      const by = new Map();
      for (const r of runs) {
        if (r.ok || !r.error) continue;
        const d = by.get(r.error) ?? {
          error: r.error, hits: 0, first: r.at, last: r.at, step: r.step, cases: [], suites: [],
        };
        d.hits++;
        d.first = Math.min(d.first, r.at);
        if (r.at >= d.last) { d.last = r.at; d.step = r.step; }
        const name = r.caseName ?? '(ad-hoc script)';
        if (!d.cases.some((c) => c.name === name)) {
          d.cases.push({ name, id: r.caseId ?? null, key: r.caseId ?? `${r.suite}:${name}` });
        }
        if (!d.suites.includes(r.suite)) d.suites.push(r.suite);
        by.set(r.error, d);
      }

      const list = [...by.values()].map((d) => ({
        ...d,
        // Still open if NO affected case has passed since this last failed.
        open: !d.cases.some((c) => (lastPass.get(c.key) ?? 0) > d.last),
      }));

      list.sort((a, b) => Number(b.open) - Number(a.open) || b.last - a.last);
      return {
        defects: list,
        totals: { all: list.length, open: list.filter((d) => d.open).length, days },
      };
    },

    /**
     * Everything the dashboard needs, computed once here rather than in the page.
     *
     * @param suiteId when given, only that suite's runs — so a suite page and the
     *   overall dashboard are the same view over a different slice, not two
     *   implementations that will disagree by next week.
     */
    summary(days = 14, suiteId = null) {
      const runs = suiteId ? all.filter((r) => r.suiteId === suiteId) : all;
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
        latest: runs.slice(-12).reverse(),
      };
    },
  };
  histories.set(org, store);
  return store;
}
