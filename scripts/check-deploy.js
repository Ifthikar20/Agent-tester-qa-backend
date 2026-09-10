/**
 * The deployment story, checked as text rather than by deploying.
 *
 *   node scripts/check-deploy.js        (no server, no AWS, no docker needed)
 *
 * Every failure below has the same shape: a deployment that comes up, answers,
 * passes its own smoke checks, and is wrong. Those are the ones worth a check,
 * because the loud failures announce themselves.
 *
 * The one that motivated this file: docs/DEPLOY.md told you to write
 *
 *     GC_AUTH_SECRET=$(node -e "...randomBytes(48)...")
 *
 * into .env.prod. Compose reads that file as data and does no substitution, so
 * the literal 74-character string became the signing key. It passed the length
 * guard, both services read the same value, every token verified, and the
 * deploy was completely healthy — with a key published verbatim in a public
 * repository. Nothing anywhere reported a problem.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Normalised to LF: a checkout with core.autocrlf on has CRLF in the working
// tree, and every `\n` anchor below would otherwise miss on Windows while
// the same files pass everywhere else.
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };

const example = read('../.env.prod.example');
const compose = read('../docker/docker-compose.prod.yml');
const deploy  = read('../scripts/deploy.sh');
const doc     = read('../docs/DEPLOY.md');
const dockerignore = read('../.dockerignore');
const runnerImage = read('../Dockerfile');
const controlImage = read('../auth/Dockerfile');
const requirements = read('../auth/requirements.txt');
const workflow = read('../.github/workflows/check.yml');
const awsUp = read('../scripts/aws-up.sh');
const bootstrap = read('../scripts/bootstrap-ec2.sh');
const gc = read('../scripts/gc');
const caddy = read('../docker/Caddyfile');

/**
 * 1 · No runbook anywhere may show command substitution as the CONTENT of an
 *     env file. This is the original bug, and it is invisible once made.
 */
const envBlocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
  .filter((b) => /^[A-Z_]+=/m.test(b));
const substituted = envBlocks.filter((b) => /^[A-Z_]+=.*\$\(/m.test(b));
if (!substituted.length) ok('the runbook never writes $( ) into an env file');
else bad('the runbook never writes $( ) into an env file', substituted[0].trim().split('\n')[0].slice(0, 58));

if (!/^[A-Z_]+=.*\$\(/m.test(example)) ok('nor does .env.prod.example');
else bad('nor does .env.prod.example');

// and the deploy refuses one, so a hand-written file is caught too
if (/\\\$\(/.test(deploy) && /that is a command, not a value/.test(deploy)) ok('and the deploy refuses one on the host');
else bad('and the deploy refuses one on the host', 'nothing catches a hand-edited .env.prod');

/**
 * 2 · Every value the stack cannot start correctly without must be REQUIRED in
 *     compose, not defaulted. PUBLIC_URL is the subtle one: it is a build
 *     argument that decides whether the shipped UI has a sign-in at all, so an
 *     empty value ships a login-less app and a 401-free deploy looks fine.
 */
for (const key of ['GC_SIGNING_KEY', 'GC_AUTH_PUBLIC_KEYS', 'GC_MFA_KEY', 'DJANGO_SECRET_KEY', 'PUBLIC_URL', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD']) {
  const uses = [...compose.matchAll(new RegExp(`\\$\\{${key}([^}]*)\\}`, 'g'))].map((m) => m[1]);
  if (!uses.length) bad(`${key} is used by compose`, 'not referenced at all');
  else if (uses.every((u) => u.startsWith(':?'))) ok(`${key} is required, not defaulted`, `${uses.length} use${uses.length > 1 ? 's' : ''}`);
  else bad(`${key} is required, not defaulted`, `${uses.filter((u) => !u.startsWith(':?')).length} use(s) have no :? guard`);
}

/**
 * 2b · The two halves of the signing key go to two different containers, and
 *      never the other way round. A runner handed the private key is a runner
 *      that can mint; a runner still handed GC_AUTH_SECRET is one that refuses
 *      to boot — and the compose file is where both would be typed.
 */
const runnerEnv = /^  runner:\n([\s\S]*?)(?=^  [a-z]+:|^[a-z]+:)/m.exec(compose)?.[1] ?? '';
const controlEnv = /^  control:\n([\s\S]*?)(?=^  [a-z]+:|^[a-z]+:)/m.exec(compose)?.[1] ?? '';
if (/GC_AUTH_PUBLIC_KEYS:/.test(runnerEnv) && !/GC_SIGNING_KEY/.test(runnerEnv)) ok('the runner is given public keys and no private one');
else bad('the runner is given public keys and no private one', 'a runner that can sign is a runner that can authorise itself');
if (/GC_SIGNING_KEY:/.test(controlEnv)) ok('and the control plane is given the private key');
else bad('and the control plane is given the private key');
// The second-factor key (docs/AUTH.md §12): the control plane's alone, and
// the deploy refuses a file without one, because the settings module would
// refuse to start and the deploy would look like a crashed container.
if (/GC_MFA_KEY:/.test(controlEnv) && !/GC_MFA_KEY/.test(runnerEnv)) ok('the second-factor key reaches the control plane only');
else bad('the second-factor key reaches the control plane only', 'TOTP secrets are encrypted with it; the runner has no business holding it');
if (/GC_MFA_KEY=/.test(deploy) && /mfa_key/.test(deploy)) ok('and the deploy refuses a .env.prod without one', 'naming manage.py mfa_key');
else bad('and the deploy refuses a .env.prod without one');
if (/^GC_MFA_KEY=CHANGE_ME/m.test(example)) ok('.env.prod.example names it as a placeholder');
else bad('.env.prod.example names it as a placeholder');
// Turnstile: the secret is the control plane's alone; the public site key
// reaches both, because the runner's CSP has to admit the widget's host
// exactly when the control plane will ask for the widget.
if (/GC_TURNSTILE_SECRET:/.test(controlEnv) && !/GC_TURNSTILE_SECRET/.test(runnerEnv)) ok('the Turnstile secret reaches the control plane only');
else bad('the Turnstile secret reaches the control plane only');
if (/GC_TURNSTILE_SITE_KEY:/.test(controlEnv) && /GC_TURNSTILE_SITE_KEY:/.test(runnerEnv)) ok('and the site key reaches both', 'one .env.prod line, two readers');
else bad('and the site key reaches both', 'the CSP and the page would disagree about the widget');
// Google: the client secret is the control plane's alone. The runner never
// talks to Google, and a secret in a container that holds a browser other
// people drive is a secret one page away from leaving.
if (/GOOGLE_CLIENT_SECRET:/.test(controlEnv) && !/GOOGLE_/.test(runnerEnv)) ok('the Google client reaches the control plane only');
else bad('the Google client reaches the control plane only', 'the runner has no business holding it');
if (/^# GOOGLE_CLIENT_ID=/m.test(example) && /^# GOOGLE_CLIENT_SECRET=/m.test(example) && /accounts\/google\/login\/callback\//.test(example)) ok('.env.prod.example names both halves and the redirect URI');
else bad('.env.prod.example names both halves and the redirect URI', 'an operator would have to guess the callback path');
if (/GC_EXTENSION_ORIGINS:/.test(controlEnv) && /GC_EXTENSION_ORIGINS:/.test(runnerEnv)) ok('the extension origins reach both services', 'CSRF on the control plane, CORS on the runner, one line');
else bad('the extension origins reach both services', 'the two would disagree about which extension is the operator’s');
if (/^# GC_EXTENSION_ORIGINS=chrome-extension:\/\//m.test(example)) ok('.env.prod.example shows the shape', 'chrome-extension://<id>');
else bad('.env.prod.example shows the shape');
if (/GC_SIGNUP_MODE: \$\{GC_SIGNUP_MODE:-invite\}/.test(controlEnv)) ok('sign-up is by invitation unless .env.prod says otherwise');
else bad('sign-up is by invitation unless .env.prod says otherwise', 'an open sign-up page on a public host by default');
if (/probe \/_allauth\/browser\/v1\/auth\/session +401/.test(deploy)) ok('the smoke check reaches allauth through the edge');
else bad('the smoke check reaches allauth through the edge', 'a mis-routed /_allauth/ would deploy green with no sign-in');
if (!/GC_AUTH_SECRET/.test(compose)) ok('and GC_AUTH_SECRET is gone from compose', 'the runner refuses to boot with it');
else bad('and GC_AUTH_SECRET is gone from compose', 'the runner refuses to boot with it present');
if (/GC_AUTH_SECRET=/.test(deploy) && /Remove the line/.test(deploy)) ok('and the deploy refuses a .env.prod that still sets it');
else bad('and the deploy refuses a .env.prod that still sets it');
if (/GC_AUTH_PUBLIC_KEYS=.*PRIVATE KEY/.test(deploy)) ok('and a private key in the public set');
else bad('and a private key in the public set');
if (!/GC_AUTH_SECRET/.test(example) && /^GC_SIGNING_KEY=/m.test(example) && /^GC_AUTH_PUBLIC_KEYS=/m.test(example)) ok('.env.prod.example names both halves and not the old secret');
else bad('.env.prod.example names both halves and not the old secret');

/**
 * 3 · A placeholder must be refused. CHANGE_ME_PRIVATE_PEM_FROM_signing_key is
 *     a line of nothing, and every marker check in the deploy passes it.
 */
const placeholders = [...example.matchAll(/^([A-Z_]+)=CHANGE_ME/gm)].map((m) => m[1]);
if (placeholders.length >= 3) ok('the example file uses CHANGE_ME placeholders', placeholders.join(', '));
else bad('the example file uses CHANGE_ME placeholders', `only ${placeholders.length}`);
if (/CHANGE_ME/.test(deploy) && /Refusing to deploy|still has CHANGE_ME/.test(deploy)) ok('and the deploy refuses them');
else bad('and the deploy refuses them', 'a copied example file would deploy');

/**
 * 4 · Readiness must prove the BROWSER, not the port. express starts listening
 *     ~100 lines before chromium.launch, so a loop polling the UI exits on its
 *     first iteration against a runner whose browser failed to start.
 */
const server = read('../server.js');
if (/app\.get\('\/healthz'/.test(server)) ok('/healthz exists');
else bad('/healthz exists');
if (server.indexOf("app.get('/healthz'") < server.indexOf("app.use('/api'")) ok('and is outside the /api gate', 'a deploy can read it with no token');
else bad('and is outside the /api gate');
if (/browserReady = true/.test(server)) ok('and only says ok once there is a page');
else bad('and only says ok once there is a page');
if (/healthz/.test(deploy) && /"browser":true/.test(deploy)) ok('and the deploy waits on browser:true', 'not on the UI answering');
else bad('and the deploy waits on browser:true', 'the wait proves only that the port is open');

/**
 * 5 · Everything the smoke table prints must also be asserted. An unasserted
 *     probe is decoration. POST /api/recording is under the runner's gate
 *     (docs/AUTH.md §11): a 401 is the proof, a 200 is an open hand-off,
 *     and a 403 would be the edge's old refusal back — which the extension,
 *     now handed a token through the control plane, can never get past.
 */
const probes = [...deploy.matchAll(/^probe (\S+)\s+(\d{3})/gm)].map((m) => `${m[1]} ${m[2]}`);
if (probes.length >= 5) ok('all smoke probes are asserted', `${probes.length} of them`);
else bad('all smoke probes are asserted', `only ${probes.length} — some are printed but not checked`);
if (probes.some((p) => p.startsWith('/api/recording 401'))) ok('including the extension hand-off being gated', '401 from the runner');
else bad('including the extension hand-off being gated', 'a 200 is an open hand-off; a 403 is the edge shutting the extension out');
if (/probe \/api\/recording 401/.test(awsUp)) ok('and aws-up.sh probes for the same', 'the two runbooks agree');
else bad('and aws-up.sh probes for the same');
if (probes.some((p) => p.startsWith('/api/state 401'))) ok('including the API being gated');
else bad('including the API being gated');

/**
 * 6 · Nothing secret may enter a build context. The context is the repo root,
 *     which on the host is the directory holding .env.prod, the PEM and the
 *     vault — and `COPY . .` would put all three in a layer.
 */
for (const pattern of ['.env', '*.pem', '.ghostclick/', 'node_modules/', '.git/']) {
  if (dockerignore.split('\n').some((l) => l.trim() === pattern)) ok(`the build context excludes ${pattern}`);
  else bad(`the build context excludes ${pattern}`, 'it would land in an image layer');
}
const authIgnore = read('../auth/.dockerignore');
if (/db\.sqlite3/.test(authIgnore)) ok('and the control plane excludes db.sqlite3', 'real accounts, real password hashes');
else bad('and the control plane excludes db.sqlite3');

/**
 * 7 · Excluding .git costs the version stamp unless the sha arrives another
 *     way. A /api/version that quietly reports null is worse than none.
 */
if (/ARG GC_GIT_SHA/.test(read('../Dockerfile')) && /GC_GIT_SHA/.test(server)) ok('and the commit still reaches /api/version', 'via the build arg');
else bad('and the commit still reaches /api/version', 'excluding .git silently broke the version stamp');

/**
 * 8 · Every documented compose command must work. Without --env-file, compose
 *     cannot interpolate the :? guards and exits 1 before doing anything — for
 *     `logs` and `ps` too, which need no variables at all.
 */
const longhand = [...doc.matchAll(/^.*docker compose -f docker\/docker-compose\.prod\.yml(?! --env-file).*$/gm)];
if (!longhand.length) ok('every documented compose command works', 'they go through scripts/gc');
else bad('every documented compose command works', `${longhand.length} would exit 1: ${longhand[0][0].trim().slice(0, 40)}`);

/**
 * 9 · Rollback must not detach HEAD: the next deploy's branch lookup would
 *     resolve to the literal string "HEAD".
 */
if (!/git checkout <previous-good-sha>/.test(doc)) ok('the rollback recipe does not detach HEAD');
else bad('the rollback recipe does not detach HEAD', 'it breaks the NEXT deploy');
if (/rollback\)/.test(deploy) && /last_deploy_prior/.test(deploy)) ok('and rollback is a subcommand', 'with the sha recorded before the deploy');
else bad('and rollback is a subcommand', 'recovery is prose');

/**
 * 10 · The edge is Caddy, configured from the one URL, and it does the four
 *      things docs/AUTH.md §1 gives it: header hygiene, exact routing, the
 *      admin allowlist, and a log that cannot hold a credential.
 */
console.log('\n— the edge ————————————————————————————————————————————');
if (!existsSync(new URL('../docker/nginx.conf', import.meta.url))) ok('nginx.conf is gone', 'one edge, not two');
else bad('nginx.conf is gone', 'two edge configs is one that is not deployed');
if (/^\{\$GC_PUBLIC_URL\} \{/m.test(caddy)) ok('the site address is {$GC_PUBLIC_URL}', 'https gets a certificate; http still works');
else bad('the site address is {$GC_PUBLIC_URL}', 'a second copy of the hostname to keep in sync');

// The runner never authenticates by cookie, so it must never receive one.
const runnerBlock = /reverse_proxy runner:3000 \{([\s\S]*?)\n\t\t\}/.exec(caddy)?.[1] ?? '';
if (/header_up -Cookie/.test(runnerBlock)) ok('Cookie is stripped on the way to the runner');
else bad('Cookie is stripped on the way to the runner', 'a session cookie reaches the process holding the browser');

// Overwritten, not appended: a client-supplied X-Forwarded-* must not survive.
for (const upstream of ['control:8000', 'runner:3000']) {
  const block = new RegExp(`reverse_proxy ${upstream} \\{([\\s\\S]*?)\\n\\t\\t\\}`).exec(caddy)?.[1] ?? '';
  const sets = ['X-Forwarded-For', 'X-Forwarded-Proto', 'X-Forwarded-Host'].filter((h) => new RegExp(`header_up ${h} \\{`).test(block));
  if (sets.length === 3) ok(`X-Forwarded-* are overwritten for ${upstream}`);
  else bad(`X-Forwarded-* are overwritten for ${upstream}`, `only ${sets.join(', ') || 'none'}`);
}

if (/@https protocol https/.test(caddy) && /header @https Strict-Transport-Security "max-age=63072000; includeSubDomains"/.test(caddy)) {
  ok('HSTS on https sites only', 'two years, subdomains included');
} else bad('HSTS on https sites only', 'TLS at the edge alone can be stripped on first contact');

// Exact routes. /accounts/* wholesale would expose allauth's csrf-exempt
// One Tap endpoint; only the Google callback is let through.
const controlMatch = /@control path ([^\n]+)/.exec(caddy)?.[1]?.trim().split(/\s+/) ?? [];
const wanted = ['/auth/*', '/_allauth/*', '/accounts/google/login/callback/', '/admin/*'];
const missing = wanted.filter((p) => !controlMatch.includes(p));
if (!missing.length && !controlMatch.includes('/accounts/*')) ok('the control plane is routed by exact prefix', controlMatch.join(' '));
else bad('the control plane is routed by exact prefix', missing.length ? `missing ${missing.join(' ')}` : '/accounts/* is routed wholesale');
if (/handle_path \/static\/\* \{/.test(caddy) && /file_server/.test(caddy)) ok('and /static/* is served from the collected volume', 'Django does not serve it with DEBUG off');
else bad('and /static/* is served from the collected volume', 'the admin has no CSS');

// Caddy re-sorts handle blocks by matcher, so a refusal must live INSIDE
// the handle whose upstream it guards — where `respond` runs before
// `reverse_proxy` by directive order — never as a sibling that happens to be
// written first.
// A top-level handle block is `\thandle … {` down to the next `\t}` at that
// indentation; the one that proxies to `marker` is the one under test.
const handleOf = (marker) => [...caddy.matchAll(/^\thandle(?: [^\n{]*)? \{\n([\s\S]*?)\n\t\}/gm)]
  .map((m) => m[1]).find((b) => b.includes(marker)) ?? '';
const controlHandle = handleOf('reverse_proxy control:8000');
const runnerHandle = handleOf('reverse_proxy runner:3000');
if (/not remote_ip \{\$GC_ADMIN_CIDRS/.test(controlHandle) && /respond @admin_outside "[^"]*" 403/.test(controlHandle)) ok('/admin/ is allowed only from GC_ADMIN_CIDRS', 'refused inside the control-plane handle, ahead of its proxy');
else bad('/admin/ is allowed only from GC_ADMIN_CIDRS', 'the refusal is not inside the handle that proxies /admin/');
if (/\{\$GC_ADMIN_CIDRS:192\.0\.2\.1\/32\}/.test(caddy)) ok('and the default admits nobody', 'TEST-NET-1');
else bad('and the default admits nobody', 'an operator who has not chosen has opened the admin');

if (!/respond \/api\/recording/.test(caddy)) ok('the edge no longer refuses /api/recording', 'the runner gates it; the extension is handed a token');
else bad('the edge no longer refuses /api/recording', 'the extension could never hand off through this edge');
if (/\n\thandle \{\n[\s\S]*reverse_proxy runner:3000/.test(caddy)) ok('and the runner is the bare fallback handle', 'a handle with no matcher always sorts last');
else bad('and the runner is the bare fallback handle');

// A socket ticket rides in the query string. The access log must not keep it.
const logBlock = /log \{([\s\S]*?)\n\t\}/.exec(caddy)?.[1] ?? '';
/**
 * Every parameter a mail or a socket can carry, named in the filter — and
 * every credential the deployment puts in a URL carried as a PARAMETER, so
 * the filter can reach it.
 *
 * `delete ticket` alone was not the rule it looked like: the invitation link
 * is `?token=` (seven days, single-use, grants a Membership) and the
 * password-reset link was a PATH segment (one hour, single-use, account
 * takeover) that no query filter can touch. Both were written verbatim into
 * `request>uri` in a JSON access log on a shared volume [ops-supply-4].
 */
const CARRIED = ['ticket', 't', 'token', 'key'];
const missed = CARRIED.filter((p) => !new RegExp(`request>uri query \\{[\\s\\S]*?delete ${p}\\b`).test(logBlock));
if (!missed.length) ok('the access log deletes every parameter a link can carry', CARRIED.join(', '));
else bad('the access log deletes every parameter a link can carry', `${missed.join(', ')} would be logged in full`);
// And the settings module has to keep putting them where the filter looks.
const settingsPy = read('../auth/config/settings.py');
const inPath = /reset_password_from_key.*reset-password\/\{\{key\}\}/.test(settingsPy);
if (!inPath && /reset_password_from_key.*reset-password\?key=\{\{key\}\}/.test(settingsPy)) ok('and the reset key is a parameter, not a path segment', 'so `delete key` reaches it');
else bad('and the reset key is a parameter, not a path segment', 'a one-hour takeover credential in request>uri');
if (/request>headers>Authorization delete/.test(logBlock) && /request>headers>Cookie delete/.test(logBlock)) ok('and never logs a credential header');
else bad('and never logs a credential header');
if (/^\tadmin off/m.test(caddy) || /^\s*admin off/m.test(caddy)) ok('the Caddy admin API is off');
else bad('the Caddy admin API is off', 'it can rewrite the running config');

/**
 * 11 · Compose: three networks and which side of each line a service is on.
 *      The runner — and the Chromium it drives — has no route to the control
 *      plane or the stores; the stores have no route to the internet.
 *
 *      The PROPERTY is asserted first and the membership map second, because
 *      the map alone could not fail: `{caddy: [edge], runner: [edge],
 *      control: [edge, data]}` was satisfied BY the layout that put the
 *      runner and the control plane on one bridge, where Docker's DNS
 *      resolves `control` and port 8000 is open — so this section printed a
 *      green "the runner has no route to the control plane" for exactly the
 *      configuration that gave it one.
 */
console.log('\n— the networks —————————————————————————————————————————');
const service = (name) => {
  // A service's block runs to the next service, or to the top-level
  // `volumes:` that closes the file.
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]+:|^[a-z]+:)`, 'm').exec(compose);
  return m ? m[1] : '';
};
const nets = (name) => /networks: \[([^\]]*)\]/.exec(service(name))?.[1].split(',').map((s) => s.trim()) ?? [];
if (/^networks:\n  edge:\n  front:\n  data:\n    internal: true/m.test(compose)) ok('edge, front and data networks exist, data is internal');
else bad('edge, front and data networks exist, data is internal', 'the stores could reach the internet, or be reached');
// The rule itself, as a property of whatever the file says: no network the
// runner is on may be one the control plane or a store is on. A shared
// bridge is bidirectional, so sharing one IS the route.
const shared = nets('runner').filter((n) => ['control', 'postgres', 'redis'].some((s) => nets(s).includes(n)));
if (nets('runner').length && !shared.length) ok('the runner shares no network with control, postgres or redis', `runner: ${nets('runner').join(', ')}`);
else bad('the runner shares no network with control, postgres or redis', shared.length ? `both are on "${shared.join('", "')}"` : 'the runner is on no network at all');
// And caddy can still reach both, or the edge answers 502 for everything.
if (nets('caddy').some((n) => nets('runner').includes(n)) && nets('caddy').some((n) => nets('control').includes(n))) ok('and caddy reaches both of them');
else bad('and caddy reaches both of them', `caddy: ${nets('caddy').join(', ')}`);
const expected = { caddy: ['edge', 'front'], runner: ['edge'], control: ['front', 'data'], postgres: ['data'], redis: ['data'] };
for (const [name, want] of Object.entries(expected)) {
  const got = nets(name);
  if (got.length === want.length && want.every((n) => got.includes(n))) ok(`${name} is on ${want.join(' + ')} only`);
  else bad(`${name} is on ${want.join(' + ')} only`, `got ${got.join(', ') || 'nothing'}`);
}
if (!/^  nginx:/m.test(compose) && /^  caddy:/m.test(compose)) ok('the edge service is caddy');
else bad('the edge service is caddy');
for (const name of Object.keys(expected)) {
  if (/cap_drop: \[ALL\]/.test(service(name))) ok(`${name} drops every capability`);
  else bad(`${name} drops every capability`);
}
// A password, and NOT in argv: `--requirepass <value>` on the command line
// is the plaintext in /proc/<pid>/cmdline and in `ps aux`, readable by every
// local user — including the deploy user, who is kept out of the docker
// group and out of .env.prod precisely so they cannot read secrets
// [ops-supply-1].
if (/requirepass %s/.test(service('redis')) && /redis-server \/tmp\/redis\.conf/.test(service('redis'))) ok('redis requires a password', 'from a config file it writes itself');
else bad('redis requires a password');
// Comment lines dropped first: this file explains the trap it closes, and
// the explanation names the flag.
const redisRuns = service('redis').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
if (!/--requirepass/.test(redisRuns)) ok('and the password is not in its command line', 'not in /proc/<pid>/cmdline, not in ps');
else bad('and the password is not in its command line', 'every local user on the host can read it');
if (/scram-sha-256/.test(service('postgres')) && /POSTGRES_HOST_AUTH_METHOD: scram-sha-256/.test(service('postgres'))) ok('postgres authenticates with scram-sha-256');
else bad('postgres authenticates with scram-sha-256');
if (/DATABASE_URL: postgres:\/\/ghostclick:\$\{POSTGRES_PASSWORD/.test(service('control')) && /GC_REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD/.test(service('control'))) ok('the control plane is given both stores by URL');
else bad('the control plane is given both stores by URL', 'it would fall back to SQLite and LocMemCache — and refuse to start');
if (!/^\s+DJANGO_ALLOWED_HOSTS:/m.test(compose) && /GC_PUBLIC_URL: \$\{PUBLIC_URL:\?/.test(service('control'))) ok('hosts are derived from PUBLIC_URL, not set separately');
else bad('hosts are derived from PUBLIC_URL, not set separately', 'two values that have to agree');
// The schedule (docs/AUTH.md §12): a second container from the control
// image running the housekeeping loop, with the control plane's
// environment, on the data network only.
if (/^  scheduler:\n/m.test(compose) && /"manage\.py", "housekeeping"/.test(service('scheduler')) && /image: ghostclick-control/.test(service('scheduler'))) ok('a scheduler runs manage.py housekeeping from the control image');
else bad('a scheduler runs manage.py housekeeping from the control image', 'sessions, stale addresses and the audit log would only be purged by a deploy');
if (/<<: \*control-env/.test(service('scheduler')) && /environment: &control-env/.test(service('control'))) ok('with the control plane’s own environment', 'one anchor, so the two cannot drift');
else bad('with the control plane’s own environment');
// Minus the two keys. §12 says the Ed25519 private key is in the control
// plane's environment ONLY, and inheriting the anchor whole put it in a
// second container for a process that neither mints nor decrypts anything.
if (/GC_SIGNING_KEY: ''/.test(service('scheduler')) && /GC_MFA_KEY: ''/.test(service('scheduler')) && /GC_NO_MINT: '1'/.test(service('scheduler'))) ok('minus the signing and second-factor keys', 'GC_NO_MINT=1 says why the boot refusal does not apply');
else bad('minus the signing and second-factor keys', 'the private key would be in two containers');
if (nets('scheduler').join() === 'data' && /cap_drop: \[ALL\]/.test(service('scheduler'))) ok('on the data network only, every capability dropped');
else bad('on the data network only, every capability dropped', nets('scheduler').join(', '));
if (/--forwarded-allow-ips", "\*"/.test(controlImage)) ok('gunicorn trusts X-Forwarded-* from the edge', "--forwarded-allow-ips='*'; only the edge can reach it");
else bad('gunicorn trusts X-Forwarded-* from the edge', 'the scheme is stripped and every cookie is set insecure');
if (/headers=\{'Host': urlsplit\(os\.environ\['GC_PUBLIC_URL'\]\)\.hostname\}/.test(service('control'))) ok('the control healthcheck sends the public Host', 'ALLOWED_HOSTS is exactly that host now');
else bad('the control healthcheck sends the public Host', '"localhost" is a 400 and the service never becomes healthy');

/**
 * 12 · The deploy's new refusals, and the things it does after migrate.
 */
console.log('\n— the deploy ———————————————————————————————————————————');
if (/DJANGO_ALLOWED_HOSTS=/.test(deploy) && /is refused/.test(deploy)) ok("the deploy refuses DJANGO_ALLOWED_HOSTS ('*' included)");
else bad("the deploy refuses DJANGO_ALLOWED_HOSTS ('*' included)");
if (/GC_TOKEN_TTL/.test(deploy) && /-gt 600/.test(deploy)) ok('and a GC_TOKEN_TTL over 600');
else bad('and a GC_TOKEN_TTL over 600', 'a leaked token would be worth more than ten minutes');
if (/SCHEME" = http \]/.test(deploy) && /NOT Secure/.test(deploy)) ok('and says loudly when PUBLIC_URL is http://');
else bad('and says loudly when PUBLIC_URL is http://');
if (/POSTGRES_PASSWORD REDIS_PASSWORD/.test(deploy) && /URL-safe/.test(deploy)) ok('and requires URL-safe store passwords', "a '@' in one reads as an address");
else bad('and requires URL-safe store passwords');
const validateAt = deploy.indexOf('caddy caddy validate --config /etc/caddy/Caddyfile');
const upAt = deploy.indexOf('up -d --build');
if (validateAt > 0 && validateAt < upAt) ok('the edge validates its own config before the build', 'a Caddyfile mistake stops the deploy with Caddy’s message');
else bad('the edge validates its own config before the build', 'it would surface as a restart loop blamed on the runner');
const migrateAt = deploy.indexOf('manage.py migrate');
const clearAt = deploy.indexOf('manage.py clearsessions');
if (migrateAt > 0 && clearAt > migrateAt) ok('clearsessions runs after migrate');
else bad('clearsessions runs after migrate', 'expired session rows are only removed by this');
if (deploy.indexOf('manage.py purge_auth_events') > migrateAt) ok('and so does the audit-log purge');
else bad('and so does the audit-log purge', 'rows past ninety days stay until the scheduler happens to run');
// IMDSv2 with a hop limit of 1 (docs/AUTH.md §11): required by the deploy,
// not only set by the bring-up script — a box made by hand, or one whose
// options were changed since, would otherwise deploy green with a browser
// one request away from instance credentials.
if (/169\.254\.169\.254\/latest\/meta-data\//.test(deploy) && /IMDSv1 is ENABLED/.test(deploy) && /http-put-response-hop-limit 1/.test(deploy)) ok('the deploy refuses a box where IMDSv1 is still on');
else bad('the deploy refuses a box where IMDSv1 is still on', 'aws-up.sh sets it; a box made by hand may not have it');
const hopAt = deploy.indexOf('latest/api/token');
if (hopAt > upAt && /THE RUNNER CAN REACH INSTANCE CREDENTIALS/.test(deploy) && /exec -T runner node -e/.test(deploy)) ok('and proves the hop limit from inside the runner', 'a PUT for a token must fail one NAT hop away');
else bad('and proves the hop limit from inside the runner');
if (/modify-instance-metadata-options --instance-id "\$ID"/.test(awsUp) && /http-put-response-hop-limit 1/.test(awsUp)) ok('aws-up.sh re-asserts it on a reused instance');
else bad('aws-up.sh re-asserts it on a reused instance');
// The deploy user, the docker group, and the root-owned key file
// (docs/AUTH.md §12 [ops-supply-1]).
if (/id -nG \| grep -qw docker/.test(deploy) && /gpasswd -d/.test(deploy)) ok('the deploy refuses a deploy user in the docker group');
else bad('the deploy refuses a deploy user in the docker group', 'the group is root with no log');
if (/stat -c '%U:%a' \.env\.prod/.test(deploy) && /root:600/.test(deploy)) ok('and a .env.prod that is not root:600');
else bad('and a .env.prod that is not root:600', 'the signing key would be readable by whatever runs as the deploy user');
if (!/\bgrep [^\n]*\.env\.prod\b/.test(deploy.slice(deploy.indexOf('# ---- the refusals'), deploy.indexOf('ok_disk=')))) ok('and reads the file through sudo -n cat, never directly', 'envfile(); values never leave the box');
else bad('and reads the file through sudo -n cat, never directly', 'a root-owned file cannot be grepped by the deploy user');
if (/sudo -n GC_GIT_SHA=[^\n]*\/usr\/local\/sbin\/gc/.test(gc) && /docker compose -f docker\/docker-compose\.prod\.yml --env-file \.env\.prod/.test(gc)) ok('scripts/gc runs compose as root through sudo', 'GC_GIT_SHA passed by name');
else bad('scripts/gc runs compose as root through sudo');
/**
 * The sudo TARGET must not be a file the invoker can write.
 *
 * /opt/ghostclick is chowned to the deploy user so that `git pull` works, so
 * a rule naming /opt/ghostclick/scripts/gc named a file that user owns:
 * append one line, run `sudo -n scripts/gc`, read the signing key. The
 * target is a root-owned shim the bootstrap writes before the clone exists.
 */
for (const [name, text] of [['bootstrap-ec2.sh', bootstrap], ['aws-up.sh', awsUp]]) {
  if (/NOPASSWD:SETENV: \/usr\/local\/sbin\/gc/.test(text) && /NOPASSWD: \/usr\/bin\/cat \/opt\/ghostclick\/\.env\.prod/.test(text) && /visudo -cf/.test(text)) ok(`${name} writes the sudoers line and checks it`);
  else bad(`${name} writes the sudoers line and checks it`);
  if (/chown root:root \/usr\/local\/sbin\/gc/.test(text) && /chmod 755 \/usr\/local\/sbin\/gc/.test(text)) ok('and its sudo target is root-owned, outside the checkout');
  else bad('and its sudo target is root-owned, outside the checkout', 'the deploy user could edit what it runs as root');
  if (/NOPASSWD: ALL/.test(text)) ok('and reports the cloud image’s blanket grant', 'until it is gone the two rules narrow nothing');
  else bad('and reports the cloud image’s blanket grant');
  // Code lines only: the comment that says "NOT usermod -aG docker" is the point.
  if (!text.split('\n').some((l) => !/^\s*#/.test(l) && /usermod -aG docker/.test(l))) ok('and does not put the user in the docker group');
  else bad('and does not put the user in the docker group', 'the group is root with no log');
}
/**
 * And every `sudo -n cat` of it names the SAME absolute path the sudoers
 * rule does. sudo matches arguments literally — no canonicalisation — so
 * `sudo -n cat .env.prod` is compared as ".env.prod" against
 * "/opt/ghostclick/.env.prod" and refused: on a host carrying only these two
 * rules the deploy died with "cannot read .env.prod" and the rule correctly
 * in place. It appeared to work only under the blanket grant above.
 */
const catsRelative = [['deploy.sh', deploy], ['docs/DEPLOY.md', doc]]
  .filter(([, text]) => /sudo -n(?: \/usr\/bin)? cat (?!\/|"\$)/.test(text) || /sudo cat \.env\.prod/.test(text));
if (!catsRelative.length) ok('every sudo read of .env.prod uses an absolute path', 'sudo matches arguments literally');
else bad('every sudo read of .env.prod uses an absolute path', `${catsRelative.map(([n]) => n).join(', ')} would be refused by the rule that permits it`);
if (/install -m 600 -o root -g root \.env\.prod\.new \.env\.prod/.test(awsUp) && !/\bsg docker\b/.test(awsUp)) ok('aws-up.sh installs .env.prod root-owned and runs the stack through gc');
else bad('aws-up.sh installs .env.prod root-owned and runs the stack through gc');
if (/HTTP_CIDR=\$\{HTTP_CIDR:-\}/.test(awsUp) && /set HTTP_CIDR to who may reach the app/.test(awsUp) && !/HTTP_CIDR:-0\.0\.0\.0\/0/.test(awsUp)) ok('aws-up.sh requires an explicit HTTP_CIDR', 'the internet is typed, never defaulted');
else bad('aws-up.sh requires an explicit HTTP_CIDR', 'port 80 open to the world by omission');
if (!/nginx -s reload/.test(deploy)) ok('and nothing reloads an edge that resolves per request');
else bad('and nothing reloads an edge that resolves per request');
if (/--resolve "\\?\$HOST:\\?\$PORT:127\.0\.0\.1"/.test(deploy) && !/http:\/\/localhost\/healthz/.test(deploy)) ok('every probe goes through the edge with the public host', 'localhost is an empty page from Caddy and a 400 from Django');
else bad('every probe goes through the edge with the public host');
if (probes.some((p) => p.startsWith('/admin/ 403'))) ok('including the admin being behind the allowlist');
else bad('including the admin being behind the allowlist');
if (!/^DJANGO_ALLOWED_HOSTS=/m.test(example) && /^POSTGRES_PASSWORD=CHANGE_ME/m.test(example) && /^REDIS_PASSWORD=CHANGE_ME/m.test(example)) ok('.env.prod.example matches', 'no hosts line; both passwords as placeholders');
else bad('.env.prod.example matches');

/**
 * 13 · Supply chain (docs/AUTH.md §12 [ops-supply-3]): what the images are
 *      built from is pinned to the byte, what they install is hashed, no
 *      package's install hook runs as the build, and CI audits both sets
 *      with a token that can only read.
 */
console.log('\n— the supply chain ————————————————————————————————————');
const digest = /@sha256:[0-9a-f]{64}\b/;
const froms = [...runnerImage.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
if (froms.length === 2 && froms.every((f) => digest.test(f))) ok('both runner stages are pinned by digest', froms.map((f) => f.split('@')[0]).join(', '));
else bad('both runner stages are pinned by digest', froms.join(', '));
const controlFrom = /^FROM (\S+)/m.exec(controlImage)?.[1] ?? '';
if (digest.test(controlFrom)) ok('and the control image', controlFrom.split('@')[0]);
else bad('and the control image', controlFrom);
const pulled = [...compose.matchAll(/^    image: (\S+)/gm)].map((m) => m[1]).filter((i) => i !== 'ghostclick-control');
if (pulled.length === 3 && pulled.every((i) => digest.test(i))) ok('and every image compose pulls', pulled.map((i) => i.split('@')[0]).join(', '));
else bad('and every image compose pulls', pulled.join(', '));
const playwrightDigest = froms.find((f) => f.startsWith('mcr.microsoft.com/playwright'))?.split('@')[1];
if (playwrightDigest && workflow.includes(`mcr.microsoft.com/playwright:v1.63.0-noble@${playwrightDigest}`)) ok('CI runs inside the same playwright image, digest and all');
else bad('CI runs inside the same playwright image, digest and all', 'the browser CI tests is not the browser production runs');
if (/npm ci --omit=dev --ignore-scripts/.test(runnerImage) && /npm ci --ignore-scripts/.test(runnerImage)) ok('npm ci runs with --ignore-scripts in both stages', 'and --omit=dev for the runner');
else bad('npm ci runs with --ignore-scripts in both stages', 'an install hook is registry code running as the build');
if (/pip install [^\n]*--require-hashes -r requirements\.txt/.test(controlImage) && !/pip install [^\n]* gunicorn/.test(controlImage)) ok('pip installs with --require-hashes and nothing unhashed', 'gunicorn is pinned in requirements.in');
else bad('pip installs with --require-hashes and nothing unhashed');
/**
 * PER REQUIREMENT, not in aggregate.
 *
 * `hashed >= pins` compared two totals, so a file where thirty-two packages
 * lost their hashes and one kept four hundred would have passed. It also
 * under-counted: the name pattern excluded the comma in
 * `django-allauth[headless,mfa,socialaccount]==`, so the one package whose
 * extras the spec names by hand was the one pin the check never looked at.
 *
 * pip-compile writes one block per requirement, each starting at column 0.
 */
const blocks = requirements.split(/\n(?=[^\s#])/).filter((b) => /^[^\s=]+==/.test(b));
const unhashed = blocks.filter((b) => !/--hash=sha256:[0-9a-f]{64}/.test(b)).map((b) => /^([^\s=]+)==/.exec(b)[1]);
const hashes = (requirements.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length;
if (!unhashed.length && blocks.length >= 20 && /^gunicorn==/m.test(requirements)) ok('every requirement is pinned WITH a hash, gunicorn included', `${blocks.length} packages, ${hashes} hashes`);
else bad('every requirement is pinned WITH a hash, gunicorn included', unhashed.length ? `no hash for ${unhashed.join(', ')}` : `${blocks.length} pins`);
if (blocks.some((b) => /^django-allauth\[/.test(b))) ok('and the extras this design names are pinned like the rest', 'django-allauth[headless,mfa,socialaccount]');
else bad('and the extras this design names are pinned like the rest');
if (existsSync(new URL('../auth/requirements.in', import.meta.url)) && /GENERATED by pip-compile/.test(requirements)) ok('and is generated from requirements.in', 'the file a person edits');
else bad('and is generated from requirements.in');
if (/^permissions:\n  contents: read/m.test(workflow)) ok('the workflow token can only read', 'permissions: contents: read');
else bad('the workflow token can only read', 'a compromised action could write to the repository');
if (/pip-audit --require-hashes -r auth\/requirements\.txt/.test(workflow)) ok('CI audits the Python set', 'pip-audit, hashes required');
else bad('CI audits the Python set');
if (/npm run check:audit/.test(workflow) && /"check:audit": "npm audit --omit=dev --audit-level=high"/.test(read('../package.json'))) ok('and the production npm set', 'npm audit --omit=dev --audit-level=high');
else bad('and the production npm set');
if (/for image in ghostclick-runner:ci ghostclick-control:ci/.test(workflow) && /db\.sqlite3/.test(workflow) && /\.pem/.test(workflow)) ok('and asks both images for secrets they must not hold', 'env files, the vault, PEMs, the account database');
else bad('and asks both images for secrets they must not hold', 'the control image was never asked');

/**
 * Every named-volume mountpoint is created in the image before its USER line.
 *
 * Docker creates a missing mountpoint as ROOT. Both application containers run
 * as a non-root user, so a volume mounted at a path the image never made
 * arrives root-owned and the first write to it fails with EACCES — which, in a
 * deploy that runs under `set -e`, is a dead deploy at whichever step happened
 * to write there first. That is exactly how `control-static` killed the first
 * deploy: collectstatic could not write into /app/staticfiles.
 *
 * The rule is asserted generally rather than for that one path, because the
 * next volume somebody adds will have the same problem and nobody will
 * remember this paragraph.
 */
console.log('\n— volumes land somewhere writable ——————————————————————');
{
  const images = { runner: read('../Dockerfile'), control: read('../auth/Dockerfile') };
  const volumesBlock = /^volumes:\n(?:\s{2}\S+:.*\n?)+/m.exec(compose)?.[0] ?? '';
  const named = new Set(volumesBlock.split('\n').slice(1)
    .map((l) => l.trim().replace(/:$/, '')).filter(Boolean));

  // Slice each service by the next top-level service key, so adding a service
  // does not silently take another's mounts with it.
  const heads = [...compose.matchAll(/^ {2}([a-z-]+):$/gm)];
  for (const [i, h] of heads.entries()) {
    const svc = h[1];
    if (!(svc in images)) continue;                       // only the ones we build
    const body = compose.slice(h.index, heads[i + 1]?.index ?? compose.length);
    const df = images[svc];
    const userAt = df.search(/^USER /m);
    for (const m of body.matchAll(/^\s+- ([a-z-]+):(\/\S+?)(?::ro)?$/gm)) {
      const [, vol, path] = m;
      if (!named.has(vol)) continue;                      // a bind mount owns itself
      const madeAt = df.search(new RegExp(`mkdir -p [^&\n]*${path.replace(/\//g, '\\/')}(\\s|$)`, 'm'));
      if (userAt === -1 || (madeAt !== -1 && madeAt < userAt)) ok(`${svc} creates ${path} before USER`, vol);
      else bad(`${svc} creates ${path} before USER`, `${vol} mounts root-owned and the first write fails`);
    }
  }
}

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — no secret reaches an image layer, no placeholder or unexpanded\n'
    + '       $( ) reaches a signing key, the private half reaches only the\n'
    + '       control plane, readiness means the browser and not\n'
    + '       the port, every probe printed is a probe asserted, every command\n'
    + '       in the runbook is one that runs, the runner has no route to the\n'
    + '       control plane, the edge keeps cookies, tickets and the admin\n'
    + '       where they belong, the key file is root’s and the daemon is\n'
    + '       reached through sudo, the schedule runs, and every image and\n'
    + '       package is pinned to the byte.\n');
process.exit(failures ? 1 : 0);
