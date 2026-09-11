/**
 * Import, inspect or forget a saved sign-in (sessions.js), from the terminal.
 *
 *   node scripts/session.js import <storageState.json> [--org <slug>]
 *   node scripts/session.js status                     [--org <slug>]
 *   node scripts/session.js clear                      [--org <slug>]
 *
 * A saved sign-in lets a run start already logged in, for the logins that
 * cannot be recorded and replayed — "Continue with Google" foremost, which
 * refuses to run in an automated browser at all. A person signs in ONCE in
 * their own browser, exports the session as a Playwright storageState, and this
 * hands it to the runner.
 *
 * Capturing it: log into the app in a normal browser, then export its
 * storageState. `npx playwright open --save-storage=session.json <url>` does it
 * for a login that works in a Playwright browser (a passkey, or a staging
 * password) — but NOT for "Continue with Google", which that browser is blocked
 * from, so for a Google login the session has to come from your real browser
 * (the recorder extension, or a cookie export). Either way the file is the same
 * shape, and this only keeps the cookies for an origin you have already allowed.
 *
 * The file it writes, `.ghostclick/<org>/session.json`, holds a live
 * credential. It is gitignored with the rest of `.ghostclick/`, and it is the
 * one file in there worth guarding like a password.
 */
import { readFileSync } from 'node:fs';
import * as sessions from '../sessions.js';
import * as origins from '../origins.js';
import { LOCAL, isOrg } from '../org.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const orgAt = argv.indexOf('--org');
const org = orgAt >= 0 ? argv[orgAt + 1] : LOCAL;
const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

if (!isOrg(org)) die(`Not an organisation slug: ${JSON.stringify(org)} (lowercase letters, digits and hyphens).`);

const when = (epoch) => (epoch ? new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 16) : 'when the browser closes (session cookie)');

function show(summary) {
  if (!summary.loaded) return console.log(`  no saved sign-in for ${org}.`);
  console.log(`  saved sign-in for ${org}:`);
  console.log(`    origins   ${summary.origins.join(', ') || '(none)'}`);
  console.log(`    cookies   ${summary.cookies}${summary.names.length ? ` (${summary.names.join(', ')})` : ''}`);
  console.log(`    expires   ${when(summary.expires)}`);
  console.log(`    file      ${sessions.forOrg(org).path()}`);
}

const store = sessions.forOrg(org);

if (cmd === 'status') {
  show(store.summary());
} else if (cmd === 'clear') {
  store.clear();
  console.log(`\n  cleared the saved sign-in for ${org}.\n`);
} else if (cmd === 'import') {
  if (!file) die('import needs a file: node scripts/session.js import <storageState.json> [--org <slug>]');
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { die(`could not read ${file} as JSON: ${e.message}`); }
  if (!Array.isArray(state?.cookies) && !Array.isArray(state?.origins)) {
    die('that file is not a Playwright storageState — it has no "cookies" or "origins" array.\n'
      + '  Produce one with `npx playwright open --save-storage=session.json <url>`, or export it from your browser.');
  }
  const allowed = origins.forOrg(org).list();
  try {
    console.log('');
    show(store.set(state, allowed));
    console.log('\n  The next page the runner opens for this organisation starts signed in.\n');
  } catch (e) { die(e.message); }
} else {
  console.log(`
  Manage a saved sign-in, so a run can start already logged in.

    node scripts/session.js import <storageState.json> [--org <slug>]
    node scripts/session.js status                     [--org <slug>]
    node scripts/session.js clear                      [--org <slug>]

  Only cookies for an origin you have already allowed are kept. Default org: ${LOCAL}.
`);
  process.exit(cmd ? 1 : 0);
}
