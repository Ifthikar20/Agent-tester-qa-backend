/**
 * One command: build the UI if this checkout has one, then run the server.
 *
 *   npm start
 *
 * The backend and the frontend are separate projects that happen to live in one
 * repository today (docs/BOUNDARY.md). This script is the convenience that
 * spans them, and it is deliberately the ONLY place that does — the server
 * itself never looks at `web/src`, it is handed a built directory.
 *
 * So it does nothing at all in the two cases where the frontend is not this
 * script's business:
 *
 *   GC_WEB_DIR set        the UI was built and deployed somewhere else; a local
 *                         build would be work nobody is going to look at
 *   no web/ directory     a backend-only checkout, which is what the backend
 *                         repository will be
 *
 * Otherwise it compares source mtimes against the build and rebuilds only when
 * something actually changed, because the build is committed and a stale one is
 * invisible: edit a component, restart, and you are still looking at the old
 * build with no indication that anything is stale. "Why don't I see the new
 * button" is not a question anyone should have to ask their own tool.
 *
 * If Vite is not installed (a checkout with production dependencies only) it
 * says so and serves the committed build, because refusing to start would be
 * worse.
 *
 *   GC_SKIP_BUILD=1 npm start   never build, just serve what is there
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, 'web');
const CONFIG = join(WEB, 'vite.config.js');
const BUILT = join(WEB, 'dist/index.html');
const SOURCES = ['src', 'index.html', 'vite.config.js', 'package.json'].map((p) => join(WEB, p));

/** Newest mtime anywhere under these paths. */
function newest(paths) {
  let latest = 0;
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name));
    } else {
      latest = Math.max(latest, st.mtimeMs);
    }
  };
  paths.forEach(walk);
  return latest;
}

function build() {
  if (process.env.GC_WEB_DIR) return `not mine — serving ${process.env.GC_WEB_DIR}`;
  if (!existsSync(CONFIG)) return 'no frontend in this checkout — serving whatever GC_WEB_DIR points at';
  if (/^(1|true|yes)$/i.test(process.env.GC_SKIP_BUILD ?? '')) return 'skipped by GC_SKIP_BUILD';
  if (!existsSync(join(ROOT, 'node_modules/vite'))) {
    return 'vite is not installed — serving the committed build (npm install to change it)';
  }

  const built = existsSync(BUILT) ? statSync(BUILT).mtimeMs : 0;
  if (built && newest(SOURCES) <= built) return 'up to date';

  console.log('  building the UI…');
  const r = spawnSync(process.execPath,
    [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', CONFIG],
    { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

  if (r.status !== 0) {
    // A broken build must not cost you a working runner. Say what went wrong
    // and serve the last good one.
    console.error(`\n  the UI build failed — serving the previous build\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-12).map((l) => `    ${l}`).join('\n')}\n`);
    return 'FAILED — serving the previous build';
  }
  const line = (r.stdout || '').split('\n').find((l) => l.includes('built in')) ?? '';
  return `rebuilt${line ? ` (${line.trim().replace(/^.*✓\s*/, '')})` : ''}`;
}

console.log(`\n  ui          ->  ${build()}`);
await import('../server.js');
