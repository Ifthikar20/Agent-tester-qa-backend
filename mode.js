/**
 * Which mode this runner is in, decided once, from the environment.
 *
 * Auth is OFF unless GC_AUTH_PUBLIC_KEYS names at least one key, and that is
 * a deliberate default for a tool whose normal shape is one person, one
 * laptop, one localhost port. Set, every /api route and the socket require a
 * token the control plane signed with the matching private key. Nothing
 * here is edited to turn production behaviour on; it is switched by
 * configuration (docs/AUTH.md §0).
 *
 * Read from one module rather than from process.env in three, because the
 * pieces that depend on the mode — the gate in server.js, the demo fixtures,
 * the origin seed — have to agree, and three readings of an env var are
 * three places to disagree.
 */
import { parseKeys } from './auth.js';

const flag = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));

/** The public key set, or an empty map. KEY_ERROR says why, if it could not be read. */
export let PUBLIC_KEYS = new Map();
export let KEY_ERROR = null;
try { PUBLIC_KEYS = parseKeys(process.env.GC_AUTH_PUBLIC_KEYS); } catch (err) { KEY_ERROR = err.message; }

export const AUTH_ON = PUBLIC_KEYS.size > 0;

/**
 * The bundled demo apps and the /go/* redirect fixtures.
 *
 * Served when auth is off — that is the laptop, and the checks drive them —
 * or when an operator says GC_DEMO=1 on purpose. Not otherwise: a gated
 * runner on a public address has no business serving a set of pages whose
 * job is to be driven, or seeding its own origin as drivable
 * [browser-side-6].
 */
export const DEMO = !AUTH_ON || flag(process.env.GC_DEMO);

/** The origin the UI is served from, as the browser sees it. */
export const WEB_ORIGIN = (process.env.GC_WEB_ORIGIN ?? '').replace(/\/+$/, '');

/**
 * Where the UI signs in, when that is not this origin — the laptop case,
 * where the control plane is on another port. Added to the CSP's connect-src
 * so the browser lets the UI reach it; empty in production, where the edge
 * puts both behind one origin and 'self' already covers it. The runner never
 * calls this address itself.
 */
export const AUTH_ORIGIN = (process.env.GC_AUTH_ORIGIN ?? '').replace(/\/+$/, '');
