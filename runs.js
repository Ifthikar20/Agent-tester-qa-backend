/**
 * Run history.
 *
 * A dashboard of invented numbers is worse than no dashboard, so every finished
 * run is appended here and the page reads from it. Machine-local and gitignored,
 * like the rest of `.ghostclick/` — this is a record of what happened on your
 * machine, not project data.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STORE = fileURLToPath(new URL('./.ghostclick/runs.json', import.meta.url));
const CAP = 500;                       // enough for a fortnight of honest use

function load() {
  try { return JSON.parse(readFileSync(STORE, 'utf8')).runs ?? []; } catch { return []; }
}

let runs = load();

function persist() {
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify({ runs }, null, 2));
  } catch { /* read-only checkout: the session still has its history in memory */ }
}

/** @param {{suite:string, url:string, ms:number, results:Array}} run */
export function record({ suite, url, ms, results }) {
  const failed = results.filter((r) => !r.ok);
  const entry = {
    at: Date.now(),
    suite: suite || 'Untitled',
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
  runs.push(entry);
  if (runs.length > CAP) runs = runs.slice(-CAP);
  persist();
  return entry;
}

export const list = () => runs.slice();

/** Everything the dashboard needs, computed once here rather than in the page. */
export function summary(days = 14) {
  const now = Date.now();
  const dayMs = 86_400_000;
  const since = now - (days - 1) * dayMs;
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // Every day in the window, including the empty ones — a gap is information.
  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const day = startOfDay(since + i * dayMs);
    buckets.set(day, { day, passed: 0, failed: 0 });
  }
  for (const r of runs) {
    const b = buckets.get(startOfDay(r.at));
    if (b) b[r.ok ? 'passed' : 'failed']++;
  }

  // One row per suite, newest first, so the table answers "what is red today".
  const bySuite = new Map();
  for (const r of runs) {
    const s = bySuite.get(r.suite) ?? { suite: r.suite, runs: 0, passed: 0, last: null };
    s.runs++;
    if (r.ok) s.passed++;
    if (!s.last || r.at > s.last.at) s.last = r;
    bySuite.set(r.suite, s);
  }

  const recent = runs.filter((r) => r.at >= now - 7 * dayMs);
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
}
