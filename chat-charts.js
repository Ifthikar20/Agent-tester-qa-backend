/**
 * A chart, as a description the page draws (web/src/components/Chart.vue).
 *
 * The chat's charts are specs, not pictures: `{ type, title, labels, series }`
 * shaped here from the same records the tools read — runs per day, defects by
 * severity, cases per suite — or from a table a person attached. The page
 * draws them with the one chart component every page uses, in the app's own
 * colours, so a chart under a reply reads like the chart on the dashboard.
 *
 * The rules are the dashboard's: failures carry the colour and passes stay
 * neutral (a red/green pair does not separate for a red-green colourblind
 * viewer); a status or a severity wears its status colour; anything else is
 * one hue per series, in a fixed order, at most four; a single series has
 * no legend. Labels are text a file or a page supplied, so they are capped
 * and never markup.
 */

export const SERIES_MAX = 4;
export const LABELS_MAX = 60;
const LABEL_MAX = 48;
/** What a chart can be: bars (stacked or not, upright or sideways) and lines. */
export const TYPES = Object.freeze(['bar', 'line']);
/** The roles a series or a bar can wear; the page maps each to a colour token. */
export const ROLES = Object.freeze(['pass', 'fail', 'critical', 'warn', 'good', 'neutral', 'series']);

const label = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) || '—';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** A spec, bounded: at most four series of at most sixty values, every label text. */
function spec({ type = 'bar', title, subtitle = null, labels, series, stacked = false, horizontal = false, unit = '', note = null, x = null }) {
  const cut = labels.length > LABELS_MAX;
  const keep = labels.slice(0, LABELS_MAX).map(label);
  return {
    kind: 'chart',
    type: TYPES.includes(type) ? type : 'bar',
    title: label(title), subtitle: subtitle == null ? null : label(subtitle),
    labels: keep,
    series: series.slice(0, SERIES_MAX).map((s) => ({
      name: label(s.name),
      values: keep.map((_, i) => num(s.values[i])),
      role: ROLES.includes(s.role) ? s.role : 'series',
      ...(Array.isArray(s.roles) ? { roles: keep.map((_, i) => (ROLES.includes(s.roles[i]) ? s.roles[i] : 'neutral')) } : {}),
    })),
    stacked: !!stacked, horizontal: !!horizontal, unit: String(unit ?? ''),
    ...(x ? { x } : {}),
    note: cut ? `the first ${LABELS_MAX} of ${labels.length}${note ? `; ${note}` : ''}` : note,
  };
}

const day = (t) => new Date(Number(t)).toISOString().slice(0, 10);

/** Runs per day, passed over failed — the dashboard's chart. */
export function runsPerDay(days, { title = 'Runs per day' } = {}) {
  const rows = Array.isArray(days) ? days : [];
  return spec({
    type: 'bar', stacked: true, title, subtitle: `the last ${rows.length} days`, x: 'date',
    labels: rows.map((d) => day(d.day)),
    series: [
      { name: 'Passed', values: rows.map((d) => d.passed), role: 'pass' },
      { name: 'Failed', values: rows.map((d) => d.failed), role: 'fail' },
    ],
  });
}

/** One number per suite, sideways so the names can be read: runs, the pass rate, cases, pages. */
export function bySuite(rows, { metric = 'runs', title = null } = {}) {
  const list = (Array.isArray(rows) ? rows : []).map((r) => ({ name: r.suite ?? r.name ?? r.id ?? '—', ...r }));
  const value = (r) => (metric === 'passRate' ? (r.runs ? Math.round((r.passed / r.runs) * 100) : 0) : num(r[metric]));
  const sorted = list.slice().sort((a, b) => value(b) - value(a));
  const names = { runs: 'Runs by suite', passRate: 'Pass rate by suite', cases: 'Cases by suite', pages: 'Pages by suite' };
  return spec({
    type: 'bar', horizontal: true, title: title ?? names[metric] ?? `${metric} by suite`,
    unit: metric === 'passRate' ? '%' : '',
    labels: sorted.map((r) => r.name),
    series: [{ name: names[metric] ?? metric, values: sorted.map(value), role: 'series' }],
    subtitle: sorted.length ? `${sorted.length} suite${sorted.length === 1 ? '' : 's'}` : 'no suites yet',
  });
}

const SEVERITY_ROLE = { critical: 'critical', high: 'critical', blocker: 'critical', major: 'warn', medium: 'warn', low: 'neutral', minor: 'neutral', trivial: 'neutral', unrated: 'neutral' };
const SEVERITY_ORDER = ['critical', 'blocker', 'high', 'major', 'medium', 'low', 'minor', 'trivial', 'unrated'];
const STATUS_ROLE = { open: 'critical', reopened: 'warn', known_issue: 'neutral', wont_fix: 'neutral', closed: 'good' };
const STATUS_ORDER = ['open', 'reopened', 'known_issue', 'wont_fix', 'closed'];

/** Defects counted by severity (of the rows given) or by status (from the totals). */
export function defectsBy(what, { rows = [], totals = {} } = {}) {
  if (what === 'status') {
    const keys = STATUS_ORDER.filter((k) => totals[k] != null);
    return spec({
      type: 'bar', title: 'Defects by status', subtitle: `${totals.all ?? keys.reduce((a, k) => a + num(totals[k]), 0)} in all`,
      labels: keys.map((k) => k.replace('_', ' ')),
      series: [{ name: 'Defects', values: keys.map((k) => num(totals[k])), role: 'neutral', roles: keys.map((k) => STATUS_ROLE[k] ?? 'neutral') }],
    });
  }
  const by = new Map();
  for (const r of rows) { const k = String(r.severity ?? 'unrated').toLowerCase(); by.set(k, (by.get(k) ?? 0) + 1); }
  const keys = [...by.keys()].sort((a, b) => (SEVERITY_ORDER.indexOf(a) + 1 || 99) - (SEVERITY_ORDER.indexOf(b) + 1 || 99));
  return spec({
    type: 'bar', title: 'Defects by severity', subtitle: `${rows.length} listed`,
    labels: keys,
    series: [{ name: 'Defects', values: keys.map((k) => by.get(k)), role: 'neutral', roles: keys.map((k) => SEVERITY_ROLE[k] ?? 'neutral') }],
  });
}

const STATE_ROLE = { incident: 'critical', watching: 'good', paused: 'neutral', idle: 'neutral', error: 'warn' };
/** Monitors counted by state. */
export function monitorsByState(monitors) {
  const by = new Map();
  for (const m of Array.isArray(monitors) ? monitors : []) { const k = String(m.state ?? 'unknown'); by.set(k, (by.get(k) ?? 0) + 1); }
  const keys = [...by.keys()].sort();
  return spec({
    type: 'bar', title: 'Monitors by state', subtitle: `${monitors?.length ?? 0} monitor${monitors?.length === 1 ? '' : 's'}`,
    labels: keys,
    series: [{ name: 'Monitors', values: keys.map((k) => by.get(k)), role: 'neutral', roles: keys.map((k) => STATE_ROLE[k] ?? 'neutral') }],
  });
}

const numberOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/^[$€£]/, '').replace(/[,\s]/g, '').replace(/%$/, '');
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const isDateish = (s) => /^\d{4}-\d{2}(-\d{2})?/.test(String(s)) && Number.isFinite(Date.parse(s));

/**
 * A table a person attached → a chart: `x` names the column of labels, `y`
 * the numeric columns (at most four). Neither given, the first text column
 * and every numeric column are taken. A line when the labels are dates;
 * bars otherwise. `{ spec }` or `{ why }`.
 */
export function tableChart(table, { x = null, y = null, title = null } = {}) {
  const cols = table?.columns ?? [];
  const rows = table?.rows ?? [];
  if (!cols.length || !rows.length) return { why: 'the table is empty' };
  const index = (name) => {
    if (name == null) return -1;
    if (typeof name === 'number') return name >= 0 && name < cols.length ? name : -1;
    const want = String(name).toLowerCase().trim();
    let i = cols.findIndex((c) => String(c.name).toLowerCase() === want);
    if (i < 0) i = cols.findIndex((c) => String(c.name).toLowerCase().includes(want));
    return i;
  };
  const numeric = cols.map((c, i) => i).filter((i) => cols[i].type === 'number' || rows.filter((r) => r[i] !== '').every((r) => numberOf(r[i]) !== null));
  let xi = index(x);
  if (x != null && xi < 0) return { why: `no column called "${x}" — the columns are ${cols.map((c) => c.name).join(', ')}` };
  if (xi < 0) xi = cols.findIndex((c, i) => !numeric.includes(i));
  if (xi < 0) xi = 0;
  let ys = [];
  if (y != null) {
    for (const name of Array.isArray(y) ? y : [y]) {
      const i = index(name);
      if (i < 0) return { why: `no column called "${name}" — the columns are ${cols.map((c) => c.name).join(', ')}` };
      if (!numeric.includes(i)) return { why: `"${cols[i].name}" is not a column of numbers` };
      ys.push(i);
    }
  } else ys = numeric.filter((i) => i !== xi);
  ys = [...new Set(ys)].slice(0, SERIES_MAX);
  if (!ys.length) return { why: `no column of numbers to chart — the columns are ${cols.map((c) => `${c.name} (${c.type})`).join(', ')}` };
  const labels = rows.map((r) => r[xi]);
  const dated = labels.length >= 3 && labels.every(isDateish);
  return {
    spec: spec({
      type: dated ? 'line' : 'bar', x: dated ? 'date' : null,
      title: title ?? `${ys.map((i) => cols[i].name).join(', ')} by ${cols[xi].name}`,
      subtitle: `${rows.length} row${rows.length === 1 ? '' : 's'}${table.sheet ? ` · ${table.sheet}` : ''}`,
      labels,
      series: ys.map((i) => ({ name: cols[i].name, values: rows.map((r) => numberOf(r[i]) ?? 0), role: 'series' })),
    }),
    x: cols[xi].name, y: ys.map((i) => cols[i].name),
  };
}

/** What the chart says, for a mind to repeat: each series' total and its largest label. */
export function describeChart(s) {
  return s.series.map((se) => {
    const total = se.values.reduce((a, b) => a + b, 0);
    let top = 0;
    se.values.forEach((v, i) => { if (v > se.values[top]) top = i; });
    return { name: se.name, total: Math.round(total * 100) / 100, top: s.labels[top] ?? null, topValue: se.values[top] ?? 0 };
  });
}
