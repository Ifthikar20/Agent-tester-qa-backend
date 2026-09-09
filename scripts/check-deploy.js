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
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

let failures = 0;
const ok = (l, d = '') => console.log(`  ✓  ${l.padEnd(50)} ${d}`);
const bad = (l, d = '') => { failures++; console.log(`  ✕  ${l.padEnd(50)} ${d}`); };

const example = read('../.env.prod.example');
const compose = read('../docker/docker-compose.prod.yml');
const deploy  = read('../scripts/deploy.sh');
const doc     = read('../docs/DEPLOY.md');
const dockerignore = read('../.dockerignore');

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
for (const key of ['GC_AUTH_SECRET', 'DJANGO_SECRET_KEY', 'PUBLIC_URL', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD']) {
  const uses = [...compose.matchAll(new RegExp(`\\$\\{${key}([^}]*)\\}`, 'g'))].map((m) => m[1]);
  if (!uses.length) bad(`${key} is used by compose`, 'not referenced at all');
  else if (uses.every((u) => u.startsWith(':?'))) ok(`${key} is required, not defaulted`, `${uses.length} use${uses.length > 1 ? 's' : ''}`);
  else bad(`${key} is required, not defaulted`, `${uses.filter((u) => !u.startsWith(':?')).length} use(s) have no :? guard`);
}

/**
 * 3 · A placeholder must be refused. CHANGE_ME_48_RANDOM_BYTES is 25
 *     characters of nothing, and every length check in the deploy passes it.
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
 *     probe is decoration, and the /api/recording 403 is the only thing
 *     closing an endpoint server.js exempts from the bearer gate by design.
 */
const probes = [...deploy.matchAll(/^probe (\S+)\s+(\d{3})/gm)].map((m) => `${m[1]} ${m[2]}`);
if (probes.length >= 5) ok('all smoke probes are asserted', `${probes.length} of them`);
else bad('all smoke probes are asserted', `only ${probes.length} — some are printed but not checked`);
if (probes.some((p) => p.startsWith('/api/recording 403'))) ok('including the extension hand-off being shut');
else bad('including the extension hand-off being shut', 'an nginx edit could reopen it and deploy green');
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
const caddy = read('../docker/Caddyfile');
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

if (/respond \/api\/recording "[^"]*" 403/.test(runnerHandle)) ok('the extension hand-off is shut at the edge', 'refused inside the runner handle, ahead of its proxy');
else bad('the extension hand-off is shut at the edge', 'the refusal is not inside the handle that proxies /api/');
if (/\n\thandle \{\n[\s\S]*reverse_proxy runner:3000/.test(caddy)) ok('and the runner is the bare fallback handle', 'a handle with no matcher always sorts last');
else bad('and the runner is the bare fallback handle');

// A socket ticket rides in the query string. The access log must not keep it.
const logBlock = /log \{([\s\S]*?)\n\t\}/.exec(caddy)?.[1] ?? '';
if (/request>uri query \{[\s\S]*?delete ticket/.test(logBlock)) ok('the access log deletes the ticket parameter');
else bad('the access log deletes the ticket parameter', 'a ticket in a log is a ticket');
if (/request>headers>Authorization delete/.test(logBlock) && /request>headers>Cookie delete/.test(logBlock)) ok('and never logs a credential header');
else bad('and never logs a credential header');
if (/^\tadmin off/m.test(caddy) || /^\s*admin off/m.test(caddy)) ok('the Caddy admin API is off');
else bad('the Caddy admin API is off', 'it can rewrite the running config');

/**
 * 11 · Compose: two networks and which side of the line each service is on.
 *      The runner — and the Chromium it drives — has no route to the control
 *      plane or the stores; the stores have no route to the internet.
 */
console.log('\n— the networks —————————————————————————————————————————');
const service = (name) => {
  // A service's block runs to the next service, or to the top-level
  // `volumes:` that closes the file.
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]+:|^[a-z]+:)`, 'm').exec(compose);
  return m ? m[1] : '';
};
const nets = (name) => /networks: \[([^\]]*)\]/.exec(service(name))?.[1].split(',').map((s) => s.trim()) ?? [];
if (/^networks:\n  edge:\n  data:\n    internal: true/m.test(compose)) ok('edge and data networks exist, data is internal');
else bad('edge and data networks exist, data is internal', 'the stores could reach the internet, or be reached');
const expected = { caddy: ['edge'], runner: ['edge'], control: ['edge', 'data'], postgres: ['data'], redis: ['data'] };
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
if (/--requirepass \\"\$\$REDIS_PASSWORD\\"/.test(service('redis'))) ok('redis requires a password', '"internal network" is about routing, not who is on it');
else bad('redis requires a password');
if (/scram-sha-256/.test(service('postgres')) && /POSTGRES_HOST_AUTH_METHOD: scram-sha-256/.test(service('postgres'))) ok('postgres authenticates with scram-sha-256');
else bad('postgres authenticates with scram-sha-256');
if (/DATABASE_URL: postgres:\/\/ghostclick:\$\{POSTGRES_PASSWORD/.test(service('control')) && /GC_REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD/.test(service('control'))) ok('the control plane is given both stores by URL');
else bad('the control plane is given both stores by URL', 'it would fall back to SQLite and LocMemCache — and refuse to start');
if (!/^\s+DJANGO_ALLOWED_HOSTS:/m.test(compose) && /GC_PUBLIC_URL: \$\{PUBLIC_URL:\?/.test(service('control'))) ok('hosts are derived from PUBLIC_URL, not set separately');
else bad('hosts are derived from PUBLIC_URL, not set separately', 'two values that have to agree');
if (/--forwarded-allow-ips", "\*"/.test(read('../auth/Dockerfile'))) ok('gunicorn trusts X-Forwarded-* from the edge', "--forwarded-allow-ips='*'; only the edge can reach it");
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
if (!/nginx -s reload/.test(deploy)) ok('and nothing reloads an edge that resolves per request');
else bad('and nothing reloads an edge that resolves per request');
if (/--resolve "\\?\$HOST:\\?\$PORT:127\.0\.0\.1"/.test(deploy) && !/http:\/\/localhost\/healthz/.test(deploy)) ok('every probe goes through the edge with the public host', 'localhost is an empty page from Caddy and a 400 from Django');
else bad('every probe goes through the edge with the public host');
if (probes.some((p) => p.startsWith('/admin/ 403'))) ok('including the admin being behind the allowlist');
else bad('including the admin being behind the allowlist');
if (!/^DJANGO_ALLOWED_HOSTS=/m.test(example) && /^POSTGRES_PASSWORD=CHANGE_ME/m.test(example) && /^REDIS_PASSWORD=CHANGE_ME/m.test(example)) ok('.env.prod.example matches', 'no hosts line; both passwords as placeholders');
else bad('.env.prod.example matches');

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — no secret reaches an image layer, no placeholder or unexpanded\n'
    + '       $( ) reaches a signing key, readiness means the browser and not\n'
    + '       the port, every probe printed is a probe asserted, every command\n'
    + '       in the runbook is one that runs, the runner has no route to the\n'
    + '       control plane, and the edge keeps cookies, tickets and the admin\n'
    + '       where they belong.\n');
process.exit(failures ? 1 : 0);
