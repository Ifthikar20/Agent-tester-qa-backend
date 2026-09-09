/**
 * How far the driven browser may reach (docs/AUTH.md §11).
 *
 * The origin allowlist gates NAVIGATION. It says nothing about what an
 * allowed page then fetches, and the page runs inside this process's network
 * namespace: a page at an allowed origin can `fetch('http://169.254.169.254/
 * latest/meta-data/')` and read the instance's credentials, or reach a
 * service on the container network by its bare name. So every request the
 * browser makes is inspected here, and one bound for an address this process
 * should not be a proxy to is aborted [browser-side-1] [transport-4].
 *
 * Two halves, deliberately:
 *
 *   the rule       isPrivateAddress() and blockedName() are pure — a literal
 *                  address or a hostname in, a verdict out — so the whole
 *                  matrix can be checked without a network
 *   the resolver   blocked() looks the name up with dns.lookup first, so
 *                  a public hostname that resolves to a private address
 *                  (DNS rebinding) is caught as the address it really is
 *
 * Aborted, not refused with a page: the browser sees a failed request, the
 * runner logs which one and why, and the run fails on it like any other
 * broken fetch.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Container names on the compose networks. A page must not reach them by name. */
export const BARE_HOSTS = new Set(['control', 'runner', 'redis', 'postgres', 'caddy']);

/** Is this literal IPv4 or IPv6 address one the browser must not reach? */
export function isPrivateAddress(address) {
  const a = String(address ?? '').trim().replace(/^\[|\]$/g, '');
  const family = isIP(a);
  if (family === 4) return isPrivateV4(a);
  if (family === 6) return isPrivateV6(a);
  return false;
}

function isPrivateV4(a) {
  const [o1, o2] = a.split('.').map(Number);
  return o1 === 0                                    // this network
    || o1 === 127                                    // loopback
    || o1 === 10                                     // RFC 1918
    || (o1 === 172 && o2 >= 16 && o2 <= 31)          // RFC 1918
    || (o1 === 192 && o2 === 168)                    // RFC 1918
    || (o1 === 169 && o2 === 254)                    // link-local, including IMDS
    || (o1 === 100 && o2 >= 64 && o2 <= 127);        // CGNAT; cloud metadata lives here too
}

function isPrivateV6(a) {
  const lower = a.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // unique local
  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms carry a v4 verdict.
  const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

/**
 * A hostname that is refused on its NAME, before any lookup: loopback by
 * name, the compose services, and the two suffixes that only ever mean
 * "inside this network".
 */
export function blockedName(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (BARE_HOSTS.has(h)) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  return false;
}

/**
 * Should a request to `url` be aborted? Answers a reason, or null.
 *
 * Resolution happens every time rather than being cached: the point of
 * looking up is that the answer can change, and a cache would hand a
 * rebinding attack exactly the window it wants.
 */
export async function blocked(url, resolve = lookup) {
  let u;
  try { u = new URL(url); } catch { return 'unreadable url'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateAddress(host) ? `${host} is a private address` : null;
  if (blockedName(host)) return `${host} is not reachable from here`;
  let answers;
  try { answers = await resolve(host, { all: true }); } catch { return `${host} does not resolve`; }
  const hit = answers.find((r) => isPrivateAddress(r.address));
  return hit ? `${host} resolves to ${hit.address}, a private address` : null;
}
