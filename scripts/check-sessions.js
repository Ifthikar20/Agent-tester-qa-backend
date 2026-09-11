/**
 * A saved sign-in, so a run starts already logged in (sessions.js).
 *
 *   PORT=3100 npm run serve &          # demo mode, which serves /session-demo
 *   BASE_URL=http://localhost:3100 node scripts/check-sessions.js
 *
 * The login this exists for is the one that cannot be recorded: "Continue with
 * Google" refuses to run in an automated browser. So a person signs in once in
 * their own browser and the session is handed to the runner. This drives the
 * cookie-gated fixture at /session-demo to prove the mechanism end to end:
 *
 *   - a session captured from a signed-in context, restricted to the origins
 *     the organisation allows, opens a fresh context ALREADY signed in;
 *   - a session for an origin nobody allowed is refused, not silently kept;
 *   - an origin removed after the session was saved is dropped on load;
 *   - the session cookie is redacted the way a vault value is.
 *
 * A throwaway organisation, whose `.ghostclick/check-sess/` is removed at the
 * end, so nothing here touches a real saved session.
 */
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import * as sessions from '../sessions.js';
import { stateDir } from '../org.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ORIGIN = new URL(BASE).origin;
const OTHER = 'https://elsewhere.example';
const ORG = 'check-sess';
const VIEW = { width: 1180, height: 760 };

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };
const cleanup = () => { try { rmSync(stateDir(ORG), { recursive: true, force: true }); } catch { /* fine */ } };

cleanup();
const store = sessions.forOrg(ORG);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-dev-shm-usage'],
});

const bodyOf = async (context, path) => {
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  const text = await page.locator('body').innerText();
  await page.close();
  return text;
};

try {
  // --- the fixture really gates on the cookie ------------------------------
  console.log('\n— the fixture ————————————————————————————————————————');
  const anon = await browser.newContext({ viewport: VIEW });
  const doorText = await bodyOf(anon, '/session-demo/');
  if (/not signed in/i.test(doorText)) ok('a fresh browser lands on the door', 'no session');
  else bad('a fresh browser lands on the door', doorText.slice(0, 60) + ' — is the server in demo mode on ' + BASE + '?');
  await anon.close();

  // --- a person signs in, and we capture the session -----------------------
  console.log('\n— capture (a human signing in, once) —————————————————');
  const human = await browser.newContext({ viewport: VIEW });
  const after = await bodyOf(human, '/session-demo/login');   // sets the cookie, bounces to /session-demo/
  if (/signed in as/i.test(after)) ok('signing in reaches the protected page');
  else bad('signing in reaches the protected page', after.slice(0, 60));
  const captured = await human.storageState();
  await human.close();
  const cookieValue = captured.cookies.find((c) => c.name === 'gc_demo_sess')?.value ?? '';
  if (cookieValue) ok('the browser session has the cookie', cookieValue.slice(0, 12) + '…');
  else bad('the browser session has the cookie', JSON.stringify(captured.cookies.map((c) => c.name)));

  // --- saving it, gated by the allowlist -----------------------------------
  console.log('\n— saved, and gated by the allowlist ——————————————————');
  let refused = null;
  try { store.set(captured, [OTHER]); } catch (e) { refused = e.message; }
  if (refused && /allow the origin first/i.test(refused)) ok('a session for an un-allowed origin is refused', refused.split('.')[0]);
  else bad('a session for an un-allowed origin is refused', refused ?? 'it was saved anyway');

  const summary = store.set(captured, [ORIGIN]);
  if (summary.loaded && summary.cookies >= 1) ok('saved for an allowed origin', `${summary.cookies} cookie(s), origins ${summary.origins.join(', ')}`);
  else bad('saved for an allowed origin', JSON.stringify(summary));

  // --- loaded only for origins still allowed -------------------------------
  console.log('\n— loaded only for what is allowed now ————————————————');
  if (store.state([ORIGIN])) ok('loads while the origin is allowed');
  else bad('loads while the origin is allowed', 'state() was null');
  if (store.state([OTHER]) === null) ok('drops on load once the origin is gone', 'a removed origin is not replayed');
  else bad('drops on load once the origin is gone', 'a removed origin was still loaded');

  // --- the value is redacted ----------------------------------------------
  console.log('\n— the cookie is a secret ——————————————————————————————');
  const values = store.values();
  const line = `auth: app logged the session cookie ${cookieValue} to the console`;
  let redacted = line;
  for (const v of values) redacted = redacted.split(v).join('$SESSION');
  if (values.includes(cookieValue) && !redacted.includes(cookieValue)) ok('redaction strips the session cookie', redacted.slice(0, 52) + '…');
  else bad('redaction strips the session cookie', redacted);

  // --- THE POINT: a fresh browser opens already signed in ------------------
  console.log('\n— a run starts already signed in —————————————————————');
  const injected = await browser.newContext({ viewport: VIEW, storageState: store.state([ORIGIN]) });
  const openedAt = await bodyOf(injected, '/session-demo/');   // straight to the protected page, no login
  await injected.close();
  if (/signed in as/i.test(openedAt)) ok('the protected page opens without the login step', openedAt.split('\n')[0]);
  else bad('the protected page opens without the login step', openedAt.slice(0, 60));

  // --- and it can be forgotten --------------------------------------------
  console.log('\n— cleared ————————————————————————————————————————————');
  store.clear();
  if (store.state([ORIGIN]) === null && !store.summary().loaded) ok('clear forgets it', 'nothing loads afterwards');
  else bad('clear forgets it', 'the session survived clear()');
} finally {
  await browser.close();
  cleanup();
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — a session captured from a signed-in browser opens a fresh one already\n' +
    '       signed in, is gated by the allowlist saving AND loading, and its cookie\n' +
    '       is redacted like a vault value.\n');
process.exit(failures ? 1 : 0);
