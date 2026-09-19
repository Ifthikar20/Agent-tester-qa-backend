/**
 * Schedules — a suite run, or the monitored pages opened again, on a cadence
 * and with nobody at the console.
 *
 * A monitor watches the page that is open; a run happens when somebody
 * presses Run. Both are live-only until something opens pages and starts
 * runs on its own, and this is that something. A schedule is one line of
 * cron (`0 9 * * 1-5`) and what to do when it comes round:
 *
 *   suite   run every case of a suite, the way the Run suite button does —
 *           the same lock, the same allowlist, the same history, with the
 *           run marked as scheduled so the dashboard can tell it from a
 *           person's;
 *   sweep   open every page this organisation has a monitor on, one after
 *           another, and let the monitors arm and measure — so an element
 *           that changed while nobody was looking is found within a sweep
 *           of it, not the next time somebody happens by.
 *
 * The engine is one per process and ticks every half minute. A schedule
 * fires when its next time has passed and the browser is free; when a run
 * or a recording holds the browser it waits, tick by tick, until the next
 * slot has come round too — then the missed slot is recorded as missed and
 * it takes the new one. Nothing is ever run twice for one slot, and nothing
 * queues up: a runner that was down for a day runs each schedule once when
 * it comes back, not twenty-four times.
 *
 * Per organisation, in `.ghostclick/<org>/schedules.json`, the same shape as
 * monitors.json: read once, kept in memory, written whole. The organisations
 * with a file are found at boot, so their schedules run whether or not
 * anyone has signed in since.
 *
 * Pure where it can be — the cron arithmetic, the store, the engine's tick
 * — so a check can drive it with a fake clock and no browser. What a fire
 * actually does (the suite run, the sweep) is the server's, handed in.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { LOCAL, assertOrg, isOrg, stateDir } from './org.js';

export const SCHEDULES_MAX = 20;
export const NAME_MAX = 80;
export const KINDS = ['suite', 'sweep'];
/** How often the engine looks; a schedule's minute is honoured within this. */
export const TICK_MS = 30_000;
/** A first look shortly after boot, so a schedule missed while down runs soon rather than in half a minute. */
export const FIRST_TICK_MS = 5000;

export class NoSuchSchedule extends Error {
  constructor(id) { super(`no schedule ${id}`); this.name = 'NoSuchSchedule'; this.status = 404; }
}
export class BadSchedule extends Error {
  constructor(msg) { super(msg); this.name = 'BadSchedule'; this.status = 400; }
}
/** Thrown by a fire that could not start because the browser is held: the engine waits, it does not fail. */
export class Deferred extends Error {
  constructor(why) { super(why); this.name = 'Deferred'; }
}

// ------------------------------------------------------------------- cron

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
];

function num(token, field) {
  const t = String(token).toLowerCase();
  if (field.names) {
    const i = field.names.indexOf(t.slice(0, 3));
    if (i >= 0 && t.length === 3) return field.base + i;
  }
  if (!/^\d+$/.test(t)) throw new BadSchedule(`cron: "${token}" is not a ${field.name}`);
  const n = Number(t);
  if (n < field.min || n > field.max) throw new BadSchedule(`cron: ${field.name} ${n} is outside ${field.min}-${field.max}`);
  return n;
}

/** One field → the set of values it names. `*`, a number, a name, a list, a range, a step, or those combined. */
function parseField(text, field) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) throw new BadSchedule(`cron: cannot read "${part}" as a ${field.name}`);
    const [, range, stepText] = m;
    const step = stepText ? Number(stepText) : 1;
    if (!(step >= 1)) throw new BadSchedule(`cron: a step must be 1 or more, not "${stepText}"`);
    let lo;
    let hi;
    if (range === '*') { lo = field.min; hi = field.max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = num(a, field); hi = num(b, field);
      if (hi < lo) throw new BadSchedule(`cron: the range ${range} runs backwards`);
    } else {
      lo = num(range, field);
      hi = stepText ? field.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  // Sunday is 0 and 7: both are written, one is kept.
  if (field.name === 'day of week' && out.has(7)) { out.delete(7); out.add(0); }
  return out;
}

/**
 * Five fields, as cron has always written them, into the sets that match.
 * A day is matched the way Vixie cron matches it: when both the day of the
 * month and the day of the week are restricted, either is enough.
 */
export function parseCron(text) {
  const parts = String(text ?? '').trim().split(/\s+/);
  if (parts.length !== 5 || !parts[0]) throw new BadSchedule('cron: five fields — minute hour day month weekday');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { text: parts.join(' '), minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

/** The first minute after `fromMs` the expression names, in the runner's own time zone; null when none within a year. */
export function nextAfter(cron, fromMs, { horizonDays = 366 } = {}) {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const t = new Date(fromMs);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const end = fromMs + horizonDays * 86_400_000;
  let guard = 0;
  while (t.getTime() <= end && guard++ < 1_000_000) {
    if (!c.month.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
    const domOk = c.dom.has(t.getDate());
    const dowOk = c.dow.has(t.getDay());
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : (domOk || dowOk);
    if (!dayOk) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
    return t.getTime();
  }
  return null;
}

const two = (n) => String(n).padStart(2, '0');
/** A cron line in words, for the shapes people write; anything else is shown as it is. */
export function describeCron(text) {
  let c;
  try { c = parseCron(text); } catch { return String(text ?? ''); }
  const [m, h, dom, mon, dow] = c.text.split(' ');
  const at = (hh, mm) => `${two(hh)}:${two(mm)}`;
  if (dom === '*' && mon === '*') {
    if (h === '*' && m === '*') return 'every minute';
    if (h === '*' && /^\*\/\d+$/.test(m)) return `every ${m.slice(2)} minutes`;
    if (h === '*' && /^\d+$/.test(m)) return `hourly at :${two(m)}`;
    if (/^\*\/\d+$/.test(h) && /^\d+$/.test(m)) return `every ${h.slice(2)} hours at :${two(m)}`;
    if (/^\d+$/.test(h) && /^\d+$/.test(m)) {
      if (dow === '*') return `daily at ${at(h, m)}`;
      if (dow === '1-5') return `weekdays at ${at(h, m)}`;
      if (dow === '0,6' || dow === '6,0') return `weekends at ${at(h, m)}`;
      const days = [...c.dow].sort().map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1));
      return `${days.join(', ')} at ${at(h, m)}`;
    }
  }
  return `cron ${c.text}`;
}

// ------------------------------------------------------------------ store

const now = () => Date.now();
const newId = () => `sc-${crypto.randomBytes(6).toString('hex')}`;
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What a schedule looks like to a caller: its fields, never the claims it fires under. */
export function publicSchedule(s) {
  const { claims, ...rest } = s;
  return { ...rest, cron: s.cron, describe: describeCron(s.cron) };
}

class ScheduleBook {
  constructor(org) {
    this.org = org;
    this.dir = stateDir(org);
    this.file = join(this.dir, 'schedules.json');
    this.schedules = new Map();
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const x of Array.isArray(s.schedules) ? s.schedules : []) if (x && x.id && KINDS.includes(x.kind)) this.schedules.set(x.id, x);
    } catch (err) {
      const bad = `${this.file}.corrupt-${now()}`;
      try { renameSync(this.file, bad); } catch { /* nothing to move */ }
      console.error(`  schedules: ${this.org}'s schedules.json did not parse (${err.message}); moved to ${bad}`);
    }
  }
  writeNow() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const body = JSON.stringify({ version: 1, savedAt: now(), schedules: [...this.schedules.values()] }, null, 2);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`  schedules: could not write ${this.file}: ${err.message}`);
    }
  }

  list(suiteId = null) {
    const all = [...this.schedules.values()].sort((a, b) => a.createdAt - b.createdAt);
    return (suiteId ? all.filter((s) => s.suiteId === suiteId) : all).map(publicSchedule);
  }
  get(id) {
    const s = this.schedules.get(String(id));
    if (!s) throw new NoSuchSchedule(id);
    return s;
  }

  /**
   * A new schedule. `claims` is what the creating request acted under (the
   * organisation's plan and switches), kept so a fire can act under the
   * same; null on an ungated runner.
   */
  create({ kind, suiteId = null, cron, name = '', claims = null, by = null } = {}, { clock = now } = {}) {
    if (!KINDS.includes(kind)) throw new BadSchedule(`kind must be one of ${KINDS.join(', ')}`);
    if (kind === 'suite' && !suiteId) throw new BadSchedule('a suite schedule names the suite to run');
    if (this.schedules.size >= SCHEDULES_MAX) throw new BadSchedule(`at most ${SCHEDULES_MAX} schedules`);
    const parsed = parseCron(cron);
    const t = clock();
    const s = {
      id: newId(), kind, suiteId: kind === 'suite' ? String(suiteId) : null,
      name: str(name, NAME_MAX) || (kind === 'suite' ? 'Run the suite' : 'Sweep the monitored pages'),
      cron: parsed.text, enabled: true, createdAt: t, by: by ? str(by, 120) : null,
      nextAt: nextAfter(parsed, t), lastRunAt: null, lastOutcome: null, waitingSince: null, missed: 0, fired: 0,
      claims: claims ? { org: claims.org, plan: claims.plan ?? null, ent: claims.ent ?? null, ent_v: claims.ent_v ?? null, off: claims.off ?? null } : null,
    };
    this.schedules.set(s.id, s);
    this.writeNow();
    return publicSchedule(s);
  }

  update(id, { cron, enabled, name } = {}, { clock = now } = {}) {
    const s = this.get(id);
    if (cron !== undefined) { const parsed = parseCron(cron); s.cron = parsed.text; s.nextAt = nextAfter(parsed, clock()); s.waitingSince = null; }
    if (enabled !== undefined) {
      s.enabled = enabled === true;
      if (s.enabled) { s.nextAt = nextAfter(s.cron, clock()); s.waitingSince = null; }
    }
    if (name !== undefined) s.name = str(name, NAME_MAX) || s.name;
    this.writeNow();
    return publicSchedule(s);
  }

  remove(id) {
    const s = this.get(id);
    this.schedules.delete(s.id);
    this.writeNow();
    return publicSchedule(s);
  }

  /** The schedules whose time has come, oldest due first. */
  due(t) {
    return [...this.schedules.values()].filter((s) => s.enabled && s.nextAt != null && s.nextAt <= t).sort((a, b) => a.nextAt - b.nextAt);
  }
}

const books = new Map();
/** The organisation's schedules, the same object for every caller. */
export function forOrg(org) {
  assertOrg(org);
  let b = books.get(org);
  if (!b) { b = new ScheduleBook(org); books.set(org, b); }
  return b;
}

/** Every organisation with a schedules file on disk — the ones the engine must know about before anyone signs in. */
export function orgsWithSchedules() {
  const root = dirname(stateDir(LOCAL));
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  return names.filter((n) => isOrg(n) && existsSync(join(root, n, 'schedules.json')));
}

// ----------------------------------------------------------------- engine

/**
 * The tick. `fire(org, schedule)` is the server's: it runs the suite or
 * sweeps the pages and resolves to the outcome to keep — or throws Deferred
 * when the browser is not free, in which case the schedule waits for the
 * next tick. `busy()` short-circuits that: no fire is attempted while a run
 * or a recording is under way.
 */
export class Scheduler {
  constructor({ fire, busy = () => false, clock = now, orgs = orgsWithSchedules, book = forOrg, emit = () => {}, log = console } = {}) {
    this.fire = fire;
    this.busy = busy;
    this.clock = clock;
    this.orgs = orgs;
    this.book = book;
    this.emit = emit;
    this.log = log;
    this.timer = null;
    this.firing = false;
    this.known = new Set();
  }

  start() {
    for (const org of this.orgs()) this.known.add(org);
    const arm = (ms) => { this.timer = setTimeout(() => { this.tick().catch((e) => this.log.error(`  schedules: ${e.message}`)).finally(() => { if (this.timer) arm(TICK_MS); }); }, ms); this.timer.unref?.(); };
    arm(FIRST_TICK_MS);
    return this;
  }
  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  /** An organisation seen after boot (one that just made its first schedule). */
  watch(org) { this.known.add(org); }

  async tick() {
    if (this.firing) return { fired: 0, skipped: 'firing' };
    const t = this.clock();
    let fired = 0;
    for (const org of [...this.known]) {
      const book = this.book(org);
      for (const s of book.due(t)) {
        // The slot after the due one has come round too: the due one was missed.
        const following = nextAfter(s.cron, s.nextAt);
        if (following != null && following <= t && s.waitingSince != null) {
          s.missed++;
          s.lastOutcome = { at: t, ok: false, missed: true, error: 'the runner was busy for the whole slot' };
          s.nextAt = nextAfter(s.cron, t);
          s.waitingSince = null;
          book.writeNow();
          this.emit(org, { t: 'schedule.fired', schedule: publicSchedule(s) });
          continue;
        }
        if (this.busy()) { if (s.waitingSince == null) { s.waitingSince = t; book.writeNow(); } continue; }
        this.firing = true;
        try {
          const outcome = await this.fire(org, s);
          s.fired++;
          s.lastRunAt = t;
          s.lastOutcome = { at: t, ...outcome };
          s.nextAt = nextAfter(s.cron, this.clock());
          s.waitingSince = null;
          fired++;
          this.emit(org, { t: 'schedule.fired', schedule: publicSchedule(s) });
        } catch (err) {
          if (err instanceof Deferred) { if (s.waitingSince == null) s.waitingSince = t; }
          else {
            s.lastRunAt = t;
            s.lastOutcome = { at: t, ok: false, error: String(err.message ?? err).slice(0, 300) };
            s.nextAt = nextAfter(s.cron, this.clock());
            s.waitingSince = null;
            this.emit(org, { t: 'schedule.fired', schedule: publicSchedule(s) });
          }
        } finally {
          this.firing = false;
          book.writeNow();
        }
      }
    }
    return { fired };
  }

  /** Fire one schedule now, by hand, whatever its time — the Run now button. */
  async runNow(org, id) {
    const book = this.book(org);
    const s = book.get(id);
    if (this.firing) throw new Deferred('a schedule is already firing');
    if (this.busy()) throw new Deferred('the runner is busy');
    this.firing = true;
    const t = this.clock();
    try {
      const outcome = await this.fire(org, s);
      s.fired++;
      s.lastRunAt = t;
      s.lastOutcome = { at: t, byHand: true, ...outcome };
      return publicSchedule(s);
    } catch (err) {
      if (err instanceof Deferred) throw err;
      s.lastRunAt = t;
      s.lastOutcome = { at: t, byHand: true, ok: false, error: String(err.message ?? err).slice(0, 300) };
      return publicSchedule(s);
    } finally {
      this.firing = false;
      book.writeNow();
      this.emit(org, { t: 'schedule.fired', schedule: publicSchedule(s) });
    }
  }
}
