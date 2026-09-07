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
               └──────────────► GC_WEB_DIR ◄─────────┘
               │
               │  HTTP  /api/*      ─────────►  VITE_API_URL  (default: same origin)
               └─ WebSocket /ws     ─────────►  derived from the same base
```

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

**4. The UI is a directory the backend is pointed at.**
`GC_WEB_DIR` names a built UI; the default is the sibling `web/dist`. The check
proves this by starting a server against a UI that is demonstrably not this
repository's and asking for it over HTTP — a backend that has gone back to
owning `public/app` cannot pass that.

## The configuration that replaces the coupling

| | what it names | who reads it | default |
|---|---|---|---|
| `GC_WEB_DIR` | the built UI to serve | backend | `web/dist` |
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

## Splitting, when the time comes

```
# the frontend
git mv web ../ghostclick-web && cd ../ghostclick-web && npm install
npm run build                                   # already builds standalone

# the backend
rm -rf web                                      # nothing imports it
GC_WEB_DIR=../ghostclick-web/dist npm start
```

Deployed apart, the frontend is built with `VITE_API_URL` and served by anything
that serves static files; the backend is told `GC_WEB_ORIGIN` so the browser
lets the two talk.

`web/src/lang/` and `extension/lib/` keep their copies, and `check:shared`
becomes the check that the published package version matches.

## What is deliberately still open

- **Authentication.** There is none, at either end. `GC_WEB_ORIGIN` exists so
  that the day a session cookie arrives, CORS is already able to name a real
  origin instead of `*` — a browser rejects `*` on any credentialed request, so
  that is the header that would otherwise silently block the whole app.
- **The WebSocket accepts any origin.** It has to, today: the check scripts
  connect from Node and send no `Origin` header at all. An origin check on `/ws`
  belongs with the auth that would give it teeth, not before it.
- **One driven browser, one process.** The backend holds a single Playwright
  browser and a single run lock, so it does not scale past one runner per
  process. That is a runtime question, not a repository-layout one.
