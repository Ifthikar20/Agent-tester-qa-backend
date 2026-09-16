/**
 * The mock mind: the chat, answered by rules.
 *
 * Monitoring has a mock compiler (monitor-rules.js compileMock) so that a
 * deployment with no key still watches elements. This is the same bargain for
 * the same reason, and it runs in three places:
 *
 *   no key           every deployment can ask its runner questions
 *   budget spent     the day's model calls are gone, the chat is not
 *   the check        scripts/check-chat-request.js drives the whole path —
 *                    the stores, the tools, the sentences — with no network
 *
 * It is regular expressions over the same tools the model drives, in one
 * ordered table: the first intent that matches answers. That is the honest
 * shape of it. It does not understand anything; it recognises about fifteen
 * things a person asks a QA runner and reads the answer out of the store,
 * which covers most of what gets asked and says so plainly when it does not.
 *
 * Every number in every sentence comes from a tool result — never from the
 * question, never from a count done here — so the rules and the model cite the
 * same figures, and a sentence is wrong only if the store is.
 *
 * `offers` are the buttons underneath: a follow-up already written, so
 * "which one?" is answered by pressing rather than by typing it out again.
 */
import { when } from './chat-tools.js';

/** What the engine puts in front of an answer the model was meant to write. */
export const unavailableNote = (reason) => `(The model was unavailable — ${reason}; answered by rules.)`;

const FALLBACK = 'I can answer about defects, runs, suites, saved cases and monitoring, and run a saved case. Try "how many defects do we have" or "test the contact us page".';

// ---- refusals ------------------------------------------------------------------------------
/**
 * The runner's decision, in the runner's words. Each refusal has a different
 * answer, so each gets its own sentence rather than one apologetic template.
 */
function refusalWords(r) {
  switch (r?.refused) {
    case 'entitlement': return `the ${r.plan ?? 'current'} plan does not allow this (${r.limit})`;
    case 'runner_busy': return 'another organisation is driving the runner right now';
    case 'switched_off': return `${r.switch} is turned off on this deployment`;
    case 'needs_origin': return `${r.origin} is not allowed yet — allow it under Origins & vault`;
    case 'busy': return 'a run is in progress';
    default: return String(r?.error ?? 'it could not do that');
  }
}
const refusalSentence = (r) => `The runner refused: ${refusalWords(r)}`;

/** A refusal stops the intent it happened in: nothing is retried around it. */
class Refused extends Error {
  constructor(refused) { super(refusalWords(refused)); this.name = 'Refused'; this.refused = refused; }
}

// ---- small shapers ---------------------------------------------------------------------------
/** "the contact us" → "contact us": an article inside quotation marks reads like a mistake. */
const strip = (s) => String(s ?? '').trim().replace(/^(the|a|an|our|my)\s+/i, '').replace(/[?.!,]+$/, '').trim();
const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : 'n/a');
const ms = (v) => (typeof v === 'number' ? `${v} ms` : 'n/a');
const lines = (...xs) => xs.flat().filter(Boolean).join('\n');

/** A run history row, from the two halves it arrives in. */
const zip = (facts, unsafe) => (facts ?? []).map((f, i) => ({ ...f, ...(unsafe?.[i] ?? {}) }));

/** Where a run stopped: what the step was doing when the history kept it, else which step, else nothing. */
const where = (target, step) => (target ? ` at ${target}` : Number.isInteger(step) ? ` at step ${step + 1}` : '');

/** What a run did, in the sentence both the run intents end with. */
function outcome(r) {
  const f = r.facts ?? {};
  const u = r.unsafe ?? {};
  return `I ran "${f.caseName}" from ${f.suite}: ${f.ok ? 'passed' : 'failed'} ${f.passed}/${f.total} steps${u.error ? `. It stopped${where(u.target, f.step)}: ${u.error}` : ''}${f.defect ? ` (filed as ${f.defect})` : ''}.`;
}

// ---- the intents ---------------------------------------------------------------------------------
const CONFIRM = /^(yes|yes,? (do it|please|go ahead)|go ahead|do it|confirm|ok(ay)?)\b/;
const DEFECT_NUMBER = /\b(def-?)?\d{4}-?\d{1,6}\b/;
const TEST_VERB = /\b(test|run|check|try|verify)\b/;
const TEST_SOMETHING = /^(can you |could you |please |would you )?(test|run|check|try|verify|re-?run)\b (.+?)( page| case| test| again)?[?.!]*$/;
const PAGE_CHECK = /^run the (.+) page check/;

/**
 * In order, and the first one that answers wins. An intent that returns null
 * did not recognise the question and the next one gets it.
 */
const INTENTS = [
  // 1 · yes
  async ({ q, executed }) => {
    if (!CONFIRM.test(q)) return null;
    if (!executed) return { text: 'Nothing is waiting for a yes.' };
    if (executed.refused) return { text: refusalSentence(executed.refused) };
    const r = executed.result ?? {};
    if (executed.kind === 'scan_page') {
      return { text: `Scanned "${r.page}": ${r.targets ?? 0} targets and ${r.linked ?? 0} links.` };
    }
    if (executed.kind === 'quickstart') {
      const head = `Made the suite "${r.name}" from ${r.url} and ran its first check`;
      if (executed.ok === false) return { text: `${head}: failed ${r.passed ?? 0}/${r.total ?? 0}${r.error ? ` — stopped${where(r.target, r.step)}: ${r.error}` : ''}.` };
      return { text: `${head}: passed ${r.passed ?? 0}/${r.total ?? 0}.` };
    }
    return { text: 'Nothing is waiting for a yes.' };
  },

  // 2 · a defect by its number
  async ({ q, T, byName, ago }) => {
    const m = q.match(DEFECT_NUMBER);
    if (!m || !byName.defect) return null;
    const r = await T('defect', { id: m[0] });
    if (r.error) return { text: `I could not read "${m[0]}" as a defect number — they look like DEF-2609-007.` };
    const f = r.facts;
    const u = r.unsafe;
    const names = (u.cases ?? []).filter(Boolean).join(', ');
    return { text: `${f.id} · ${f.severity} · ${f.status}: "${u.title}". Seen ${f.hits} time(s), first ${ago(f.firstSeen)}, last ${ago(f.lastSeen)}; ${f.cases} case(s): ${names}.` };
  },

  // 3 · what is broken
  async ({ q, T, byName, ago }) => {
    if (!/\bdefects?\b|\bbroken\b|\bfailing\b/.test(q)) return null;
    if (!byName.defects) return { text: 'This runner does not file defects; ask about runs instead.' };
    const r = await T('defects', { status: 'open', limit: 25 });
    const t = r.facts.totals;
    if (!t.all) return { text: 'No defects have been filed: nothing has failed.' };
    const head = `You have ${t.open} open defect(s)${t.reopened ? ` (${t.reopened} reopened)` : ''}, ${t.closed} closed — ${t.all} in all.`;
    // The count is the runner's (facts), the title is the recorded sentence
    // (unsafe): the two halves carry a `cases` each and they mean different
    // things, so neither is merged over the other.
    const rows = r.facts.rows.slice(0, 3);
    // A runner that derives defects from history rather than filing them has
    // neither a number nor a severity to say: the sentence starts at the title.
    return { text: lines(head, rows.map((d, i) => `${[d.id, d.severity].filter(Boolean).map((x) => `${x} · `).join('')}${r.unsafe.rows[i]?.title} — ${d.cases} case(s), last ${ago(d.lastSeen)}`)) };
  },

  // 4 · the latest run, and the latest scan
  async ({ q, T, ago }) => {
    if (!/\b(latest|last|recent|newest|previous)\b/.test(q) || !/\b(scan|scans|run|runs|test|tests|check|checks|result|results)\b/.test(q)) return null;
    const h = await T('run_history', { limit: 5 });
    const runs = zip(h.facts.latest, h.unsafe.latest);
    if (!runs.length) return { text: 'No runs have been recorded yet.' };
    const [first, ...rest] = runs;
    const head = `The latest run was ${first.suite}${first.caseName ? ` · ${first.caseName}` : ''}, ${ago(first.at)}: ${first.ok ? 'passed' : 'failed'} ${first.passed}/${first.total} steps${first.error ? ` — stopped${where(first.target, first.step)}: ${first.error}` : ''}${first.defect ? ` (${first.defect})` : ''}.`;
    const before = rest.slice(0, 4).map((r) => `${r.suite}${r.caseName ? ` · ${r.caseName}` : ''} ${ago(r.at)} ${r.ok ? 'passed' : 'failed'} ${r.passed}/${r.total}`);
    const s = await T('pages_scanned', { limit: 3 });
    const page = zip(s.facts.pages, s.unsafe.pages)[0];
    const scanned = page && page.scannedAt
      ? `Pages scanned most recently: ${page.name} (${page.suite}) ${ago(Date.parse(page.scannedAt))}.`
      : 'No page has been scanned yet.';
    return { text: lines(head, before.length ? `Before that: ${before.join('; ')}.` : null, scanned) };
  },

  // 5 · how it has been going
  async ({ q, T }) => {
    if (!/how many runs|pass rate|this week|today|history|summary/.test(q)) return null;
    const h = await T('run_history', { limit: 1 });
    const t = h.facts.totals;
    const days = h.facts.days ?? [];
    const today = days[days.length - 1] ?? { passed: 0, failed: 0 };
    return { text: `${t.runs} runs in ${days.length} days, ${t.week} this week, pass rate ${pct(t.passRate)}, median ${ms(t.medianMs)}; ${t.suites} suites. Today: ${today.passed} passed, ${today.failed} failed.` };
  },

  // 6 · the monitors
  async ({ q, T, ago }) => {
    if (!/\bmonitor|incident|watch/.test(q)) return null;
    const r = await T('monitoring', {});
    const c = r.facts.counts ?? { monitors: 0, open: 0 };
    const labels = new Map((r.unsafe?.monitors ?? []).map((m) => [m.id, m.label]));
    const incidents = zip(r.facts.incidents, r.unsafe?.incidents).slice(0, 3)
      .map((i) => `${i.id} on ${labels.get(i.monitorId) ?? i.monitorId}, opened ${ago(i.openedAt)}${i.explanation ? `: ${i.explanation}` : ''}`);
    return { text: lines(`${c.monitors} monitor(s), ${c.open} open incident(s).`, incidents) };
  },

  // 7 · what the runner is doing
  async ({ q, T }) => {
    if (!/what('s| is) open|which page|driving|runner (state|status)|busy/.test(q)) return null;
    const r = await T('runner_state', {});
    const f = r.facts ?? {};
    const d = f.driving ?? {};
    const who = d.mine ? 'the browser is yours' : d.held ? `${d.org} is driving` : 'nobody is driving';
    const head = `The runner has ${f.url ?? 'nothing'} open${f.running ? ' and a run in progress' : ''}; ${who}.`;
    const extra = [];
    if (f.plan) extra.push(`The plan is ${f.plan}`);
    const usage = Object.entries(f.usage ?? {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
    if (usage.length) extra.push(`used so far: ${usage.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    return { text: lines(head, extra.length ? `${extra.join('; ')}.` : null) };
  },

  // 8 · what is being tested
  async ({ q, T }) => {
    if (!/\b(suites?|projects?)\b/.test(q) || TEST_VERB.test(q)) return null;
    const r = await T('suites', {});
    const rows = zip(r.facts.suites, r.unsafe.suites);
    if (!rows.length) return { text: 'There are no suites yet. Give me a URL and I can quickstart one.' };
    return { text: `${rows.length} suite(s): ${rows.slice(0, 12).map((s) => `${s.name} (${s.pages} pages, ${s.cases} cases, ${s.origin})`).join(', ')}.` };
  },

  // 9 · which cases exist
  async ({ q, T }) => {
    const m = q.match(/\b(?:cases?|tests?|scripts?)\b.*\b(?:for|on|about|of|in)\b (.+)/);
    if (!m && !/(what|which) (test )?cases/.test(q)) return null;
    const x = m ? strip(m[1]) : null;
    let rows = null;
    if (x) {
      rows = (await T('find', { query: x, kind: 'case', limit: 8 })).unsafe.matches;
      if (!rows.length) return { text: `No saved case mentions "${x}".` };
    }
    // With nothing named, the answer is every case the organisation has —
    // which means walking the suites rather than scoring a query.
    const all = rows ?? await everyCase(T);
    if (!all.length) return { text: 'There are no saved cases yet.' };
    return { text: lines(`${all.length} saved case(s)${x ? ` for "${x}"` : ''}:`, all.slice(0, 12).map((c) => `${c.suite} · ${c.name} (${c.steps} steps)`)) };
  },

  // 10 · test the X
  async ({ q, T }) => {
    if (PAGE_CHECK.test(q)) return null;          // that is the next intent's sentence
    const m = q.match(TEST_SOMETHING);
    if (!m) return null;
    const x = strip(m[3]);
    if (!x) return null;
    const r = await T('find', { query: x, limit: 8 });
    const rows = r.unsafe.matches;
    const cases = rows.filter((row) => row.kind === 'case');
    const pages = rows.filter((row) => row.kind === 'page');
    const best = cases[0];
    // Clear enough to act on: a good match, and well ahead of the next one.
    // Anything less is a question, because running the wrong test is worse
    // than asking.
    if (best && best.score >= 0.5 && (!cases[1] || best.score - cases[1].score >= 0.2)) {
      return { text: outcome(await T('run_case', { suiteId: best.suiteId, caseId: best.id })) };
    }
    if (best && best.score >= 0.5 && cases[1]) {
      const [a, b] = cases;
      return {
        text: `Two cases match "${x}": ${a.name} and ${b.name} — which one?`,
        offers: [
          { label: `Test ${a.name}`, text: `test the ${a.name} case` },
          { label: `Test ${b.name}`, text: `test the ${b.name} case` },
        ],
      };
    }
    const page = pages[0];
    if (page) {
      const offers = [{ label: `Run the ${page.name} page check`, text: `run the ${page.name} page check` }];
      if (page.url) offers.push({ label: `Quickstart ${page.url}`, text: `quickstart ${page.url}` });
      return { text: `I could not find a saved case for "${x}". There is a page "${page.name}" in ${page.suite}: I can run its expectations as a one-off check, or you can record a case for it.`, offers };
    }
    return { text: `I could not find a saved case or a page called "${x}". Give me a URL and I can quickstart a suite for it.` };
  },

  // 11 · run a page's expectations, once
  async ({ q, T }) => {
    const m = q.match(PAGE_CHECK);
    if (!m) return null;
    const x = strip(m[1]);
    const r = await T('find', { query: x, kind: 'page', limit: 8 });
    const page = r.unsafe.matches[0];
    if (!page) return { text: `I could not find a page called "${x}".` };
    const run = await T('run_page_check', { suiteId: page.suiteId, pageId: page.id });
    return { text: `${outcome(run).replace(/\.$/, '')} (one-off check, not saved as a case).` };
  },

  // 12 · scan a page (a proposal)
  async ({ q, T }) => {
    if (!/\bscan\b/.test(q)) return null;
    const x = strip(q.replace(/^.*?\bscan\b/, '').replace(/\bpages?\b/g, '').trim());
    const r = await T('find', { query: x || q, kind: 'page', limit: 8 });
    const page = r.unsafe.matches[0];
    if (!page) return { text: `I could not find a page called "${x}" to scan.` };
    await T('scan_page', { suiteId: page.suiteId, pageId: page.id });
    return { text: `Scanning "${page.name}" drives the browser and rewrites the page's targets. Say yes to go ahead.` };
  },

  // 13 · quickstart a suite from a URL (a proposal)
  async ({ q, raw, T }) => {
    if (!/\bquickstart\b|\bonboard/.test(q) && !/https?:\/\//.test(raw)) return null;
    const m = raw.match(/https?:\/\/\S+/);
    if (!m) return { text: 'Give me a URL and I can quickstart a suite for it.' };
    const url = m[0].replace(/[).,]+$/, '');
    const p = await T('quickstart', { url });
    if (p.error) return { text: p.error };
    return { text: `Quickstart would create a suite for ${url}, open it, record its targets and run the first check. Say yes to go ahead.` };
  },
];

/** Every case in every suite, for "which cases do we have" with nothing named. */
async function everyCase(T) {
  const s = await T('suites', {});
  const out = [];
  for (const row of s.facts.suites) {
    const one = await T('suite', { suiteId: row.id });
    const suite = one.unsafe.name;
    const steps = new Map(one.facts.cases.map((c) => [c.id, c.steps]));
    for (const c of one.unsafe.cases) out.push({ suite, name: c.name, steps: steps.get(c.id) ?? 0 });
  }
  return out;
}

/**
 * One turn, answered by rules.
 *
 * @param text      what the person typed
 * @param byName    the tools (chat-tools.js makeTools) — `run` gives the
 *                  result object rather than the string the model gets
 * @param executed  the proposal a person confirmed since the last turn:
 *                  `{ kind, args, ok, result?, refused? }`, or null
 * @param confirmed the same thing under the engine's other name for it
 * @param propose   the pending-action store, taken so the rules take exactly
 *                  what the engine hands the model — the tools already hold
 *                  it, so nothing here proposes anything by itself
 * @returns {Promise<{text: string, offers?: {label: string, text: string}[]}>}
 */
export async function answerMock({ text, byName, executed = null, confirmed = null, propose, now = Date.now }) {
  const raw = String(text ?? '').trim();
  const q = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const at = typeof now === 'function' ? now() : Number(now) || Date.now();
  const ctx = {
    q, raw, byName, propose, at,
    executed: executed ?? confirmed,
    ago: (t) => when(t, at),
    /** One tool call; a refusal ends the intent rather than being worked around. */
    T: async (name, args = {}) => {
      const tool = byName?.[name];
      if (!tool) throw new Refused({ refused: 'error', error: `this runner has no ${name}` });
      const r = await tool.run(args);
      if (r.refused) throw new Refused(r.refused);
      return r;
    },
  };
  try {
    for (const intent of INTENTS) {
      const out = await intent(ctx);
      if (out) return out;
    }
  } catch (err) {
    return { text: refusalSentence(err instanceof Refused ? err.refused : { refused: 'error', error: err.message }) };
  }
  return { text: FALLBACK };
}
