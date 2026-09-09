/**
 * Socket tickets (docs/AUTH.md §9).
 *
 * A browser cannot set headers when it opens a WebSocket, so whatever proves
 * who is connecting has to ride in the URL — and a URL is what access logs,
 * referrers and browser history keep. The executor token must therefore
 * never be that thing [ops-supply-4]. Instead the UI trades its token, over a
 * Bearer header, for a ticket: 32 random bytes, good for thirty seconds,
 * usable once, bound to the claims of the token that bought it. A ticket
 * that leaks into a log is either already spent or about to be nothing.
 *
 * In memory, in this process. There is one runner, and a ticket that did not
 * survive a restart is a ticket the UI simply asks for again.
 */
import { randomBytes } from 'node:crypto';

export const TTL_MS = 30_000;
/** Outstanding tickets per subject. A page reconnecting in a loop cannot fill the map. */
export const MAX_PER_SUB = 5;

const outstanding = new Map();   // ticket -> { claims, expires }

function sweep(now) {
  for (const [t, row] of outstanding) if (row.expires <= now) outstanding.delete(t);
}

export class TooManyTickets extends Error {
  constructor(sub) { super(`${MAX_PER_SUB} tickets are already outstanding for ${sub}`); this.name = 'TooManyTickets'; }
}

/**
 * Issue a ticket for `claims`. Throws TooManyTickets past the per-sub cap.
 * @returns {{ ticket: string, expiresIn: number }}
 */
export function issue(claims, now = Date.now()) {
  sweep(now);
  const sub = String(claims?.sub ?? '');
  let held = 0;
  for (const row of outstanding.values()) if (String(row.claims?.sub ?? '') === sub) held++;
  if (held >= MAX_PER_SUB) throw new TooManyTickets(sub);
  const ticket = randomBytes(32).toString('base64url');
  outstanding.set(ticket, { claims, expires: now + TTL_MS });
  return { ticket, expiresIn: TTL_MS / 1000 };
}

/**
 * Spend a ticket: the claims it was bound to, or null. Deleted on the way
 * out whether it was good or stale, so a second presentation is nothing.
 */
export function redeem(ticket, now = Date.now()) {
  sweep(now);
  const row = outstanding.get(String(ticket ?? ''));
  if (!row) return null;
  outstanding.delete(String(ticket));
  return row.expires > now ? row.claims : null;
}

/** For the checks: how many are live right now. */
export const count = () => { sweep(Date.now()); return outstanding.size; };
