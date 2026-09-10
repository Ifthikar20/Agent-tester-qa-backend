# The line between this repository and the UI's

They are two repositories now. This one holds the runner and the control
plane; `ghostclick-web` holds the app. Nothing imports across, because nothing
can.

This document used to be a plan for that split, with four rules and a check
that failed if any of them was broken. Three of those rules were about keeping
`web/` liftable, and lifting it settled them. What is left is the seam itself:
what crosses it, what each side is allowed to assume, and which of the old
rules still needs a check because the repository boundary does not enforce it.

```
   ghostclick-web (repo)                   ghostclick (this repo)
   ┌───────────────────────────┐        ┌───────────────────────────┐
   │  src/         the app     │        │  server.js, ops.js, …     │
   │  src/lang/    a copy of   │        │  public/     pages to drive
   │               the grammar │        │  suites/<org>/ saved suites
   │  dist/        the build   │        │  scripts/    the checks   │
   └───────────┬───────────────┘        │  auth/       Django      │
               │                        └────────────┬──────────────┘
               │  builds to its own dist/            │  is POINTED at one
               │──────────────► GC_WEB_DIR ──────────┘
               │
               │  HTTP  /api/*      ─────────►  VITE_API_URL  (default: same origin)
               │  WebSocket /ws     ─────────►  derived from the same base
               │                                          ▲
               │  HTTP  /auth/*  ──► VITE_AUTH_URL        │ Bearer token
               ▼                                          │
   ┌───────────────────────────┐                          │
   │  auth/   (this repo)      │ ── mints a signed ───────┘
   │    Django: users, SSO,    │    10-minute token
   │    admin. Nothing else.   │
   └───────────────────────────┘
```

## The seam is one directory and three URLs

**The UI is a directory this repository is pointed at.** `GC_WEB_DIR` names a
built app. There is no default and there cannot be one: a default would name a
path this repository cannot produce, so it could only ever be a directory that
is not there — and "not there" arrives as a 404 on the application's own
address, which reads as a broken deploy rather than as an unset variable.

So absence is stated instead of guessed at. `server.js` starts happily without
one, says `serving -> NO UI` in its banner, and answers every GET under `/app/`
with a 503 naming the variable. `npm run serve` is that mode on purpose: the
API, the socket and the recorder hand-off are all useful with no app in front
of them. `npm start` and `npm run app` are the other mode — "run the
application", which has a UI — and both refuse with a sentence rather than
start something half-wired.

**The UI reaches the runner over HTTP `/api/*` and one WebSocket `/ws`**, and
the control plane over `/auth/*` and `/_allauth/*`. Those bases are baked into
its bundle from `VITE_API_URL` and `VITE_AUTH_URL` at build time; empty means
same origin, which is what a deployment behind one edge uses.

**The control plane is reached only over HTTP.** It mints a signed token; the
runner verifies it and holds public keys only.

## What still needs a check, and why

`npm run check:boundary` starts its own servers and asserts four things. Two of
the old rules are gone from it — "the frontend reads nothing outside `web/`"
and "and writes nothing outside it" are ghostclick-web's to keep, and it cannot
break them without breaking its own build. Asserting them here would mean
asserting something about files this checkout does not contain, which is a
check that passes because it found nothing.

**1. The runner reads no UI source, and has no bundler.**
No module the server loads names a path under `web/`; `package.json` declares
no vite, vue or tailwind in either dependency set; no npm script runs a
bundler; `node_modules` contains none. The pull this guards against is real and
sounds reasonable every time — *just build it here, it is one dependency* — and
it is one dependency until it is a toolchain, and then the two repositories are
one again.

**2. The runner and the control plane share no file, in either direction.**
This rule has MORE teeth than it had, not fewer. `auth/` went to its own
*directory*, not its own repository, so nothing but this check stands between
two services and a shared opinion about the same rule. The control plane's
temptation is to reach *into* the runner — to read `suites/`, to decide whether
an origin is allowed — and two services with an opinion about one rule is how a
hard gate becomes advisory. That is the security model, not a build
convenience.

The check distinguishes a **URL** from a **file path** deliberately:
`/_allauth/browser/v1/auth/login` is the boundary working, not a breach of it.

**3. It serves whatever built UI it is pointed at.**
Proved by running one: a temp directory with an `index.html` in it, served at
`/app/`, with client-side routes falling back to that index and the cache
headers travelling with it. A backend that has gone back to owning
`public/app` cannot pass this, and no amount of reading the source proves it
the way this does.

**4. And says so when it is pointed at nothing.**
The failure the split introduced. The server must still start, must answer a
503 rather than a 404, and must name `GC_WEB_DIR` in what it says — an error a
person can act on without reading this repository.

## The configuration that replaces the coupling

| | what it names | who reads it | default |
|---|---|---|---|
| `GC_WEB_DIR` | the built UI to serve | this repo | **none** — no UI, and it says so |
| `GC_SIGNING_KEY` | the Ed25519 private key tokens are signed with | control plane | none — no token can be minted |
| `GC_AUTH_PUBLIC_KEYS` | the public half, `{kid: pem}` | runner | none — auth is off |
| `VITE_AUTH_URL` | where the built app signs in | ghostclick-web, at build time | empty — no login at all |
| `GC_WEB_ORIGIN` | the origin allowed to call `/api` with credentials | runner | none — `*`, uncredentialed |
| `VITE_API_URL` | where the built app sends `/api` and `/ws` | ghostclick-web, at build time | empty — its own origin |

## The mismatch neither side can prevent

`VITE_AUTH_URL` is baked into the bundle by whoever ran the build over there,
minutes or weeks ago. So `--auth` on this side cannot put a login into an app
that was built without one, and turning it off cannot take one out. Two ways to
be wrong, and neither errors:

- **a bundle with no sign-in, on a gated runner** — the console loads, every
  `/api` call is refused, and there is no way offered to log in;
- **a bundle with a sign-in, on an open runner** — the login screen appears,
  the login *succeeds*, and the token comes back to a runner that ignores it,
  so every account looks like it has the same empty workspace.

`scripts/app.js` cannot fix either, but it can see both: it reads the build it
was handed and says so before starting anything. `scripts/deploy.sh` goes
further and refuses, because a deployment is not a place to find this out — it
checks that the directory exists, that it holds an `index.html`, and that the
bundle mentions `PUBLIC_URL` at all. That last one is the "bundle built against
the wrong origin" the smoke-probe table has named as unseeable since it was
written; now that the UI is a directory on the host, it can be looked at.

## Running the two together

```
# once
git clone <ghostclick-web> ../ghostclick-web
cd ../ghostclick-web && npm install

# the UI, built knowing where to sign in
VITE_AUTH_URL=http://localhost:8000 npm run build

# the application
cd -
GC_WEB_DIR=../ghostclick-web/dist bash run.sh
```

`bash run.sh` is the runner, the control plane and the sign-in. `npm run app`
is the same without the login. `npm run serve` is the server alone, with no UI
at all — useful, and it says so rather than pretending.

Deployed, the UI is built on the host and bind-mounted into the runner at
`/app/ui`; `GC_WEB_DIR` in `.env.prod` says where the build is. A UI release is
then a directory swap and a restart, with no rebuild of an image whose own
contents did not change (docs/DEPLOY.md).

## The one thing genuinely shared

`flow.js` and `vocabulary.js` are the case language. Three projects parse the
same grammar: the runner executes cases, the Vue app renders them, and the
browser extension writes them with no server in the picture.

Two of those copies are still here — `extension/lib/` — and are still checked
byte for byte:

```
npm run sync:lang      make every copy match
npm run check:shared   fail if one has not
```

The third went with the UI, and nothing that runs here can read it. So the
language carries a number instead. `LANGUAGE_VERSION` in `vocabulary.js` is
reported at `GET /api/version`, and a consumer holding a copy compares itself
against the runner it is talking to — what a published package would settle at
install time, settled at the one moment the two halves are in the same room.

`scripts/copies.js` pins that number against a digest of the grammar's bytes,
so a verb added without a bump fails `check:shared` here rather than surprising
the UI a fortnight later. Bumping is deliberately a human decision:
`sync:lang` refuses to re-pin a digest whose version has not moved, because a
script that silently re-pinned would make the whole mechanism a hash of
whatever happens to be there.

`scripts/copies.js` is also what becomes `@ghostclick/language` when two
consumers are worth a release process. The version above is its first version
number.

## Authentication, and where it does not reach

`GC_AUTH_PUBLIC_KEYS` is the switch. Unset — the default — the runner is open
and the UI shows no login; that is the laptop case and `npm start` alone must
keep working. Set, every `/api` route and the WebSocket upgrade require a token
the control plane signed with the matching private key, and the boot banner
says which mode it is in every time, because an operator who believes this is
protected and is wrong is worse off than one who knows it is open. The runner
holds public keys only: it verifies and cannot mint, and it refuses to start
with the old shared `GC_AUTH_SECRET` anywhere in its environment.

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
it is now under the gate like everything else, and the extension's background
worker gets a token of its own through the control plane with the person's
session (docs/AUTH.md §11) — from an origin the operator listed in
`GC_EXTENSION_ORIGINS`, which both services read from the same line.

## What is deliberately still open

- **The control plane is still in this repository.** It is reached only over
  HTTP and shares no file with the runner, so the next `git filter-repo` is as
  cheap as this one was. What has not happened is a reason to do it: two
  services deployed from one repository, released together, is not a problem
  yet. Rule 2 above is what keeps it true that it would still be cheap.
- **SSO.** The reason Django is here. Sign-up, sign-in, verification, reset,
  the account changes and Google sign-in are django-allauth's, behind
  `/_allauth/` (plus the one Google callback under `/accounts/`).
- **Plans on the runner are numbers in a token.** The runner keys every store
  by `org`, enforces `ent` and honours `ent_v` and `role` — and learns all four
  from the signature and nothing else. It never asks the control plane what a
  plan allows, and the control plane never reads a suite: the facts cross this
  boundary inside the token, once, and each side enforces its own half
  (docs/AUTH.md §10).
- **The WebSocket accepts any path.** The ticket is the gate, and with auth on
  the `Origin` header must be the app's — the repository's own check scripts,
  which connect from Node with no `Origin` at all, run against an open runner.
  Narrowing the path would break six of them and secure nothing.
- **One driven browser, one process.** The runner holds a single Playwright
  browser and a single run lock, with one organisation driving at a time and
  the others told it is busy (tenancy.js). A login says *who*, not *which
  runner* — two organisations driving at once is a second runner, and that is
  the scaling conversation rather than a repository-layout one.
