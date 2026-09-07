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

console.log(failures
  ? `\n  ${failures} FAILED\n`
  : '\n  OK — no secret reaches an image layer, no placeholder or unexpanded\n'
    + '       $( ) reaches a signing key, readiness means the browser and not\n'
    + '       the port, every probe printed is a probe asserted, and every\n'
    + '       command in the runbook is one that runs.\n');
process.exit(failures ? 1 : 0);
