# The line between the frontend and the backend

They are going to be two repositories. Today they are two directories in one,
which is exactly the arrangement where a boundary quietly stops existing — an
import that reaches one directory up costs nothing and works forever, right up
until the directory above is a different repository.

So the boundary is not a convention. It is four rules, and
`npm run check:boundary` fails if any of them is broken.

```
        ghostclick-web (repo)                 ghostclick (repo)
   ┌───────────────────────────┐        ┌───────────────────────────┐
   │  web/                     │        │  server.js, ops.js, …     │
   │    src/         the app   │        │  public/     pages to drive
   │    src/lang/    a copy    │        │  suites/     saved suites │
   │    dist/        the build │        │  scripts/    the checks   │
   │    package.json           │        │  package.json             │
   └───────────┬───────────────┘        └────────────┬──────────────┘
               │                                     │
               │  builds to its own dist/            │  is POINTED at a dist/
               │──────────────► GC_WEB_DIR ◄─────────┘
               │
               │  HTTP  /api/*      ─────────►  VITE_API_URL  (default: same origin)
               │  WebSocket /ws     ─────────►  derived from the same base
               │                                          ▲
               │  HTTP  /auth/*  ──► VITE_AUTH_URL        │ Bearer token
               ▼                                          │
   ┌───────────────────────────┐                          │
   │  auth/   (repo)           │ ── mints a signed ───────┘
   │    Django: users, SSO,    │    10-minute token
   │    admin. Nothing else.   │
   └───────────────────────────┘
```

Three projects, one repository. The frontend and the control plane are both
reached over HTTP and neither shares a file with the runner — which is what
makes each of the three a `git mv` rather than a refactor.

## The four rules

**1. The frontend reads nothing outside `web/`.**
Every relative import under `web/src` resolves inside `web/`; every Vite alias
does too. `@lang` used to resolve to the backend's `vocabulary.js`, which meant
the frontend could not build without the backend's *source* sitting beside it.

**2. The frontend writes nothing outside `web/`.**
`build.outDir` is `web/dist`. It used to be `public/app` — the frontend's build
config reaching into the backend's static root, which meant the frontend could
not build without the backend's *tree* to write into.

**3. The backend never names the frontend's source.**
No module the server loads mentions `web/` except the built directory. The one
sanctioned exception is `scripts/start.js`, which is the convenience that spans
both projects, is not imported by the server, and does nothing when `web/` is
absent.

**4. The control plane shares no files with either.**
Nothing under `auth/` reads the runner's tree — not `suites/`, not
`.ghostclick/`, not `public/` — and nothing the runner or the UI loads is a file
from `auth/`. They are joined by one signed token and one HTTP call. The check
distinguishes a **URL** from a **file path** on purpose: `/auth/login` in the UI
is the boundary working, not a breach of it.

This one is not about builds. The control plane's temptation is to reach *into*
the runner — to read the suites, to decide whether an origin is allowed — and
two services with an opinion about the same rule is how a hard gate becomes
advisory.

**5. The UI is a directory the backend is pointed at.**
`GC_WEB_DIR` names a built UI; the default is the sibling `web/dist`. The check
proves this by starting a server against a UI that is demonstrably not this
repository's and asking for it over HTTP — a backend that has gone back to
owning `public/app` cannot pass that.

## The configuration that replaces the coupling

| | what it names | who reads it | default |
|---|---|---|---|
| `GC_WEB_DIR` | the built UI to serve | backend | `web/dist` |
| `GC_AUTH_SECRET` | the key the runner and the control plane share | **both** | none — auth is off |
| `VITE_AUTH_URL` | where the built app signs in | frontend, at build time | empty — no login at all |
| `GC_WEB_ORIGIN` | the origin allowed to call `/api` with credentials | backend | none — `*`, uncredentialed |
| `VITE_API_URL` | where the built app sends `/api` and `/ws` | frontend, at build time | empty — its own origin |
| `GC_API` | where `npm run dev` proxies `/api` and `/ws` | frontend, dev only | `http://localhost:3000` |

Same-origin — the backend serving the app it talks to — needs none of them, and
that is still what `npm start` does.

## The one thing genuinely shared

`flow.js` and `vocabulary.js` are the case language. Three projects parse the
same grammar: the backend executes cases, the Vue app renders them, and the
browser extension writes them with no server in the picture.

They are **copied**, and the copies are checked:

```
npm run sync:lang      make every copy match the original
npm run check:shared   fail if one has not
```

`scripts/copies.js` lists who holds a copy and why. A copy is not a great
answer; it is a better one than the two alternatives at this size — importing
across a project boundary (rule 1) or publishing a package for two files nobody
outside this repository consumes yet. When the repositories split, that list is
what becomes `@ghostclick/language`, and the consumers are already written as
though it were one.

## Authentication, and where it does not reach

`GC_AUTH_SECRET` is the switch. Unset — the default — the runner is open and the
UI shows no login; that is the laptop case and `npm start` alone must keep
working. Set, every `/api` route and the WebSocket upgrade require a token the
control plane signed, and the boot banner says which mode it is in every time,
because an operator who believes this is protected and is wrong is worse off
than one who knows it is open.

Three things stay outside it deliberately:

- **The origin allowlist and the vault** remain entirely on the runner and are
  re-checked there. The control plane cannot add an origin or read a secret's
  value; it stores names at most.
- **`POST /api/recording`** stays open. The extension posts from whatever page
  you were recording on, with no session and no way to be handed a token, so
  requiring one would not secure the endpoint — it would delete the feature. It
  validates through the same origin gate as everything else and never executes;
  a human presses Run. Giving the extension a real token is worth doing.
- **The UI and the driven pages** are never gated. A login screen you cannot
  load is not a login screen, and the pages under test are fetched by the driven
  browser, which has no token and never will.

## Splitting, when the time comes

```
# the frontend
git mv web ../ghostclick-web && cd ../ghostclick-web && npm install
npm run build                                   # already builds standalone

# the backend
rm -rf web auth                                 # nothing imports either
GC_WEB_DIR=../ghostclick-web/dist npm start

# the control plane
git mv auth ../ghostclick-auth && cd ../ghostclick-auth
pip install -r requirements.txt && python manage.py migrate
```

Deployed apart, the frontend is built with `VITE_API_URL` and served by anything
that serves static files; the backend is told `GC_WEB_ORIGIN` so the browser
lets the two talk.

`web/src/lang/` and `extension/lib/` keep their copies, and `check:shared`
becomes the check that the published package version matches.

## What is deliberately still open

- **SSO.** The reason Django is here, and not built yet. It goes behind the
  same four endpoints without the runner noticing.
- **RBAC.** Anyone who can sign in can drive everything. The token carries a
  `scope` claim so there is somewhere to put this; nothing reads it yet.
- **Rate limiting on `/auth/login`.** Worth having before this meets a network
  you do not control.
- **The WebSocket accepts any origin, and any path.** The token is the gate. An
  `Origin` check would break the repository's own check scripts, which connect
  from Node and send no `Origin` header at all; narrowing the path would break
  six of them and secure nothing.
- **One driven browser, one process.** The runner holds a single Playwright
  browser and a single run lock. A login says *who*, not *which runner* — two
  signed-in people still share one browser, and that is the scaling
  conversation rather than a repository-layout one.
