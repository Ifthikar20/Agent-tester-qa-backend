/**
 * Switches: parts of the product an operator can turn off, for everyone.
 *
 * A plan's entitlements (tenancy.js) are about a customer — how many suites,
 * whether there is a vault — and are bought. A switch is about the deployment:
 * recording misbehaving on some site, a flood of scans, origins you want
 * frozen during an incident. Nobody buys one and no organisation has its own.
 *
 * Two places turn one off, and either is enough:
 *
 *   GC_SWITCHES_OFF   this process's environment: a key, a service (`runner`
 *                     is every runner.* key), or `*` for all of them. Read at
 *                     boot, and a name nobody knows stops the process — a
 *                     typo here would leave on exactly what you meant to turn
 *                     off, silently.
 *   the token's `off` the control plane's list (its admin, and its own copy
 *                     of GC_SWITCHES_OFF). A switch flipped there reaches this
 *                     runner with the next token, within its ten minutes, and
 *                     at once for a token whose plan version has moved on.
 *
 * A token can only turn things OFF. It cannot switch on what this process's
 * environment turned off: the environment is the operator's last word.
 *
 * The catalogue is the control plane's as well (auth/tenants/switches.py), and
 * a test there reads this file and fails when the two disagree.
 */

export const SWITCHES = {
  'runner.recording':    'recording a flow',
  'runner.runs':         'running scripts and suites',
  'runner.onboarding':   'creating suites, pages and page scans',
  'runner.origins':      'allowing or removing origins',
  'runner.driving':      'opening pages and driving them from the console',
  // Off forces every run to GC_HEAL=off, whatever the deployment and the
  // organisation chose (heal.js, fixes.js), and refuses accepting a fix.
  'runner.heal':         'fixing broken steps automatically',
  // Off refuses every question and every run asked for from the Chat page;
  // the page says so instead of answering.
  'runner.chat':         'the chat assistant',
  'control.signup':      'self-service sign-up',
  'control.invitations': 'issuing and accepting invitations',
  'control.google':      'signing in with Google',
  'control.passkeys':    'signing in with a passkey',
};

const SERVICES = ['runner', 'control'];
const RUNNER = Object.keys(SWITCHES).filter((k) => k.startsWith('runner.'));

export class SwitchedOff extends Error {
  constructor(key) {
    const what = SWITCHES[key] ?? key;
    super(`${what[0].toUpperCase()}${what.slice(1)} is turned off on this deployment`);
    this.name = 'SwitchedOff';
    this.key = key;
  }
}

/** `runner.recording, control` -> the keys that are off. Throws on a name nobody knows. */
export function parseOff(value) {
  const off = new Set();
  for (const raw of String(value ?? '').split(',')) {
    const name = raw.trim();
    if (!name) continue;
    if (name === '*') for (const key of Object.keys(SWITCHES)) off.add(key);
    else if (SERVICES.includes(name)) for (const key of Object.keys(SWITCHES)) { if (key.startsWith(`${name}.`)) off.add(key); }
    else if (SWITCHES[name]) off.add(name);
    else throw new Error(`GC_SWITCHES_OFF names "${name}", which is not a switch. Known: *, ${SERVICES.join(', ')}, ${Object.keys(SWITCHES).join(', ')}`);
  }
  return off;
}

/** This process's own list, and why it could not be read, if it could not. */
export let ENV_OFF = new Set();
export let SWITCH_ERROR = null;
try { ENV_OFF = parseOff(process.env.GC_SWITCHES_OFF); } catch (err) { SWITCH_ERROR = err.message; }

/**
 * The switches as they stand for one caller: this process's list, plus the
 * token's. No claims — the laptop — is the environment alone.
 */
export function switchesFor(claims) {
  const fromToken = Array.isArray(claims?.off) ? claims.off.filter((k) => typeof k === 'string') : [];
  const off = new Set([...ENV_OFF, ...fromToken]);
  return {
    on: (key) => !off.has(key),
    /** Throw when the switch is off. */
    demand(key) {
      if (off.has(key)) throw new SwitchedOff(key);
    },
    /** The runner's switches as { key: on }, for /api/state and the socket's greeting. */
    runner: () => Object.fromEntries(RUNNER.map((key) => [key, !off.has(key)])),
  };
}
