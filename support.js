/**
 * Help & support: the request a person sends from the top bar, and the switch
 * it turns on.
 *
 * Pressing "Request support" does two things at once. It records what the
 * person wrote — topic, message, the page they were on — and it ENABLES
 * SUPPORT ACCESS for their organisation: a flag that says "someone here has
 * asked for help and is happy to be looked at", which whoever operates the
 * runner reads from GET /api/support and the runner prints as it happens.
 * The organisation turns it off again from the same button. Nothing else is
 * granted by it: the flag is a statement, not a token, and no route in this
 * process reads it to allow anything. Wiring it to a ticketing or
 * remote-assistance service is where a deployment plugs in.
 *
 * One file per organisation, `.ghostclick/<org>/support.json`, in runs.js's
 * shape: read once, kept in memory, written whole. The latest fifty requests
 * are kept; support that needs more than that has a ticketing system.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './org.js';

export const TOPICS = ['question', 'bug', 'access', 'billing', 'other'];
export const TOPIC_MAX = 120;
export const MESSAGE_MAX = 2000;
const PAGE_MAX = 300;
const BY_MAX = 200;
const KEEP = 50;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

const stores = new Map();

/** The support state of one organisation, the same object for every caller. */
export function forOrg(org) {
  const have = stores.get(org);
  if (have) return have;

  const FILE = join(stateDir(org), 'support.json');
  let data = { access: { enabled: false, since: null, by: null }, requests: [] };
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'));
    data = {
      access: { enabled: !!s.access?.enabled, since: s.access?.since ?? null, by: s.access?.by ?? null },
      requests: Array.isArray(s.requests) ? s.requests : [],
    };
  } catch { /* nobody has asked yet */ }

  function persist() {
    try {
      mkdirSync(stateDir(org), { recursive: true });
      writeFileSync(FILE, JSON.stringify(data, null, 2));
    } catch { /* read-only checkout: the request still stands in memory */ }
  }

  const store = {
    org,
    file: FILE,
    /** What the top bar and support staff read. */
    state() {
      return {
        enabled: data.access.enabled, since: data.access.since, by: data.access.by,
        requests: data.requests.length, latest: data.requests[0] ?? null,
      };
    },
    list() { return data.requests.slice(); },
    /**
     * Record a request and switch support access on. A message is the one
     * thing required: a request with nothing in it is a button that was
     * pressed, not a question that was asked.
     */
    request({ topic, message, page, by } = {}) {
      const t = str(topic, TOPIC_MAX).toLowerCase();
      const m = str(message, MESSAGE_MAX);
      if (!m) { const e = new Error('Say what you need help with'); e.status = 400; throw e; }
      const r = {
        id: `r_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`, at: Date.now(),
        topic: TOPICS.includes(t) ? t : 'other', message: m, page: str(page, PAGE_MAX) || null, by: str(by, BY_MAX) || null,
      };
      data.requests.unshift(r);
      if (data.requests.length > KEEP) data.requests.length = KEEP;
      if (!data.access.enabled) data.access = { enabled: true, since: r.at, by: r.by };
      persist();
      return r;
    },
    /** Support access off; the requests stay, as history. */
    disable() {
      data.access = { enabled: false, since: null, by: null };
      persist();
      return store.state();
    },
  };
  stores.set(org, store);
  return store;
}
