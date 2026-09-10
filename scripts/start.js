/**
 * One command: find the built UI, say which one, then run the server.
 *
 *   npm start
 *
 * This script used to be the convenience that spanned two directories — it
 * rebuilt `web/` whenever its sources were newer than its build, so that
 * editing a component and restarting showed you the component you edited.
 * There is no `web/` to rebuild any more (docs/BOUNDARY.md): the UI is the
 * poc-qa-stack repository, it builds to its own `dist/`, and this repository
 * is POINTED at the result.
 *
 * So the staleness problem it solved is gone and a different one has taken its
 * place. `GC_WEB_DIR` is now the single thread holding the application
 * together, and every way it goes wrong is quiet:
 *
 *   unset             /app/ answers a 503 sentence, so you find out from a
 *                     browser rather than from the terminal you started
 *   a typo            an empty directory serves nothing, which looks the same
 *   a source tree     `../poc-qa-stack` rather than `../poc-qa-stack/dist`
 *                     has no index.html and 404s every route
 *
 * All three are visible before Chromium is launched, so this looks, refuses,
 * and names the fix — which is the difference between `npm start` and `npm run
 * serve`. `npm start` means "run the application", and the application has a
 * UI. `npm run serve` means "run the server", and server.js is deliberately
 * content without one: a runner driving pages for the recorder extension, or
 * for curl, does not need an app.
 *
 * It reports rather than builds, and must stay that way. A backend that can
 * build the UI is a backend that has the UI's toolchain, its dependencies and
 * its opinions back in this repository, which is the coupling the split was
 * for.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const HINT = `
  The UI is a separate repository. Build it there, point this at the result:

      cd ../poc-qa-stack && npm install && npm run build
      cd -  &&  GC_WEB_DIR=../poc-qa-stack/dist npm start

  With the sign-in, it has to be built knowing where to sign in — the address
  is baked into the bundle, so this is a build-time choice, not a runtime one:

      VITE_AUTH_URL=http://localhost:8000 npm run build

  Or run the server on its own, with the API and no app:

      npm run serve
`;

function ui() {
  const given = process.env.GC_WEB_DIR;
  if (!given) return { fatal: 'GC_WEB_DIR is not set, so there is no UI to serve.' };

  const dir = resolve(given);
  if (!existsSync(dir)) return { fatal: `GC_WEB_DIR names ${dir}, which does not exist.` };
  if (!existsSync(join(dir, 'index.html'))) {
    return { fatal: `GC_WEB_DIR names ${dir}, which has no index.html — that is a source tree or an empty directory, not a build.` };
  }
  // The same mtime /api/version reports, said once at boot: a UI built three
  // weeks ago when you expected three minutes is the kind of thing that
  // otherwise turns into an afternoon of debugging the wrong service.
  const built = statSync(join(dir, 'index.html')).mtime.toISOString().replace('T', ' ').slice(0, 16);
  return { detail: `${dir}  (built ${built})` };
}

const found = ui();
if (found.fatal) {
  console.error(`\n  ${found.fatal}\n${HINT}`);
  process.exit(1);
}
console.log(`\n  ui          ->  ${found.detail}`);
await import('../server.js');
