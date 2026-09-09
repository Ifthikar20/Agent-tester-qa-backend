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
distinguishes a **URL** from a **file path** on purpose: `/_allauth/browser/v1/auth/login`
in the UI is the boundary working, not a breach of it.

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
| `GC_SIGNING_KEY` | the Ed25519 private key tokens are signed with | control plane | none — no token can be minted |
| `GC_AUTH_PUBLIC_KEYS` | the public half, `{kid: pem}` | backend | none — auth is off |
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

`GC_AUTH_PUBLIC_KEYS` is the switch. Unset — the default — the runner is open
and the UI shows no login; that is the laptop case and `npm start` alone must
keep working. Set, every `/api` route and the WebSocket upgrade require a
token the control plane signed with the matching private key, and the boot
banner says which mode it is in every time, because an operator who believes
this is protected and is wrong is worse off than one who knows it is open.
The runner holds public keys only: it verifies and cannot mint, and it refuses
to start with the old shared `GC_AUTH_SECRET` anywhere in its environment.

Two things stay outside it deliberately:

- **The origin allowlist and the vault** remain entirely on the runner and are
  re-checked there. The control plane cannot add an origin or read a secret's
  value; it stores names at most.
- **The UI** is never gated. A login screen you cannot load is not a login
  screen. The pages under test are fetched by the driven browser, which has no
  token and never will — but the *bundled* demo pages are fixtures, and a gated
  runner does not serve them unless `GC_DEMO=1` says so.

`POST /api/recording` used to be a third: the extension posts from whatever
page you were recording on, with no session, so it was left open. With auth on
it is now under the gate like everything else, and the extension gets a token
of its own through the control plane (docs/AUTH.md §11) — the ops step's.

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

- **SSO.** The reason Django is here. Sign-up, sign-in, verification, reset
  and the account changes are django-allauth's now, behind `/_allauth/`;
  Google and MFA are the next two steps of docs/AUTH.md and slot in behind
  the same prefix without the runner noticing.
- **RBAC on the runner.** The control plane now has organisations, roles and
  plans, and the token carries `org`, `role` and `ent`; the runner does not
  read them yet, so anyone who can sign in still drives everything. Reading
  them — and keying every store by `org` — is the runner-tenancy step of
  docs/AUTH.md, and it still crosses this boundary only inside the token.
- **The WebSocket accepts any path.** The ticket is the gate, and with auth on
  the `Origin` header must be the app's — the repository's own check scripts,
  which connect from Node with no `Origin` at all, run against an open runner.
  Narrowing the path would break six of them and secure nothing.
- **One driven browser, one process.** The runner holds a single Playwright
  browser and a single run lock. A login says *who*, not *which runner* — two
  signed-in people still share one browser, and that is the scaling
  conversation rather than a repository-layout one.
