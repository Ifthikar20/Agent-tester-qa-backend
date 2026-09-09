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
import { readFileSync } from 'node:fs';
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
const nginx   = read('../docker/nginx.conf.template');
const compose2 = compose;   // named for the volume/mountpoint check below

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
for (const key of ['GC_AUTH_SECRET', 'DJANGO_SECRET_KEY', 'PUBLIC_URL']) {
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
 *     ~130 lines before chromium.launch, so a loop polling the UI exits on its
 *     first iteration while there is still no browser.
 *
 *     Being precise about the failure this does and does not catch: a launch
 *     that THROWS ends the process — it is a top-level await with no try/catch
 *     — and `restart: unless-stopped` crash-loops it into a 502 that the old
 *     wait would have caught. The gap is a launch that HANGS, and a runner that
 *     is up but browserless. Those are the ones that used to deploy green.
 */
const server = read('../server.js');
if (/app\.get\('\/healthz'/.test(server)) ok('/healthz exists');
else bad('/healthz exists');
// NOT an ordering assertion. /healthz is not under /api, so app.use('/api', …)
// never sees it whatever the order — checking that would pass forever without
// meaning anything. What matters is that it reports 503 while the browser is
// still starting, which is the entire reason a deploy can wait on it.
if (/browserReady \? 200 : 503/.test(server)) ok('and is 503 until the browser exists', 'so waiting on it means something');
else bad('and is 503 until the browser exists', 'a readiness probe that is always 200 proves nothing');
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
 * 10 · The class of bug that would have killed the first deploy.
 *
 *      auth/Dockerfile created /app/db and not /app/staticfiles, while compose
 *      mounted control-static there. Docker creates a missing mountpoint as
 *      ROOT; the container runs as a non-root user; collectstatic fails EACCES;
 *      `set -e` ends the deploy. This asserts the general rule rather than that
 *      one path, because the next volume added will have the same problem.
 */
const dockerfiles = { runner: read('../Dockerfile'), control: read('../auth/Dockerfile') };
const namedVolumes = new Set((compose2.match(/^volumes:\n(?:\s{2}\S+:.*\n?)+/m)?.[0] ?? '')
  .split('\n').slice(1).map((l) => l.trim().replace(/:$/, '')).filter(Boolean));
for (const [svc, body] of Object.entries({
  runner:  compose2.slice(compose2.indexOf('  runner:'),  compose2.indexOf('  control:')),
  control: compose2.slice(compose2.indexOf('  control:'), compose2.indexOf('  nginx:')),
})) {
  const df = dockerfiles[svc];
  const userAt = df.search(/^USER /m);
  for (const m of body.matchAll(/^\s+- ([a-z-]+):(\/\S+?)(?::ro)?$/gm)) {
    const [, vol, path] = m;
    if (!namedVolumes.has(vol)) continue;
    const made = [...df.matchAll(/mkdir -p ([^&\n]+)/g)].some((mk) => mk[1].split(/\s+/).includes(path));
    const madeFirst = made && df.search(new RegExp(`mkdir -p [^&\n]*${path.replace(/\//g, '\\/')}`)) < userAt;
    if (userAt === -1 || madeFirst) ok(`${svc} creates ${path} before USER`, vol);
    else bad(`${svc} creates ${path} before USER`, `${vol} would mount root-owned and the first write fails`);
  }
}

/**
 * 11 · The admin is not where a scanner looks for it.
 */
if (!/\^\/\(auth\|admin\|static\)\//.test(nginx)) ok('nginx does not proxy /admin/ to Django');
else bad('nginx does not proxy /admin/ to Django', 'a login form with no lockout, on an open port');
if (/location \^~ \/admin \{ return 404/.test(nginx)) ok('and /admin closes with a 404', 'not a 403, which confirms there is something there');
else bad('and /admin closes with a 404');
if (/\$\{GC_ADMIN_PATH\}/.test(nginx) && /NGINX_ENVSUBST_FILTER/.test(compose2)) ok('the real path comes from the environment', 'envsubst, filtered to one variable');
else bad('the real path comes from the environment', 'an unfiltered envsubst also eats $host and $http_upgrade');
if (/GC_ADMIN_PATH/.test(deploy) && /that is the path this exists to move away from/.test(deploy)) ok("and the deploy refuses 'admin'");
else bad("and the deploy refuses 'admin'");

/**
 * 12 · Authentication is not authorisation. The token's claims have to be READ
 *      somewhere, or every account that can sign in can widen the allowlist —
 *      and the allowlist is the gate the rest of the design rests on.
 */
if (/req\.user\?\.admin === true/.test(server)) ok('the allowlist reads a claim from the token');
else bad('the allowlist reads a claim from the token', 'any signed-in account could add an origin');
for (const route of ["app.post('/api/origins', staffOnly", "app.delete('/api/origins', staffOnly"]) {
  if (server.includes(route)) ok(`${route.slice(4, 30)}… is gated`);
  else bad(`${route.slice(4, 30)}… is gated`);
}
if (/'admin': bool\(admin\)/.test(read('../auth/accounts/tokens.py'))) ok('and the control plane mints it');
else bad('and the control plane mints it', 'the executor would read a claim nobody sets');

/**
 * 13 · At least one probe must prove ACCESS. Everything else in the smoke table
 *      asserts a 401, 403 or 404 — a deploy where nobody can sign in passes all
 *      of them.
 */
if (/csrftoken/.test(deploy) && /sign-in can actually start/.test(deploy)) ok('the smoke table proves sign-in can start');
else bad('the smoke table proves sign-in can start', 'a login broken by CSRF or a missing key deploys green');
if (/SMOKE_EMAIL/.test(deploy) && /SKIPPED/.test(deploy)) ok('and the full round trip is offered', 'skipped loudly, never silently');
else bad('and the full round trip is offered');
if (/showmigrations --plan/.test(deploy)) ok('and the schema is asserted, not assumed');
else bad('and the schema is asserted, not assumed', '"migrate exited 0" is a different claim');

/**
 * 14 · The runbook and the compose file must agree about what persists.
 */
for (const vol of namedVolumes) {
  if (doc.includes(vol)) ok(`DEPLOY.md knows about ${vol}`);
  else bad(`DEPLOY.md knows about ${vol}`, 'the persistence table is wrong about what survives');
}
if (!/auth-db/.test(doc)) ok('and names no volume that does not exist');
else bad('and names no volume that does not exist', 'auth-db appears nowhere in the repo');

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — no secret reaches an image layer, no placeholder or unexpanded\n'
    + '       $( ) reaches a signing key, readiness means the browser and not\n'
    + '       the port, every probe printed is a probe asserted, and every\n'
    + '       command in the runbook is one that runs.\n');
process.exit(failures ? 1 : 0);
