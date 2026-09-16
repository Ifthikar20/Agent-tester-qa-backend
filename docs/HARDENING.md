# Hardening: switches, limits, headers and request ids

Three measures that sit across both services — the runner (`server.js`) and the
control plane (`auth/`) — and the UI that calls them. Each exists because of a
specific way the product could be misused or fail:

1. **Switches.** An operator can turn a part of the product off for everyone —
   deployment-wide, or one service at a time — without a deploy.
2. **Limits.** No single address can guess its way in or keep a real browser
   busy on its behalf.
3. **Headers and request ids.** Every response closes the browser doors nothing
   here uses, and every request can be followed through both services' logs.

Plans and entitlements (docs/AUTH.md §10) are a different thing and are
unchanged: they say what a *customer* bought. A switch says what the
*deployment* offers at all, and it wins.

---

## 1. Switches

| Switch | What it turns off | Enforced by |
|---|---|---|
| `runner.recording` | recording a flow (Record, `POST /api/recording`) | runner |
| `runner.runs` | running scripts and suites | runner |
| `runner.onboarding` | creating suites, pages and page scans | runner |
| `runner.origins` | allowing or removing origins | runner |
| `runner.driving` | opening pages and driving them from the console | runner |
| `runner.heal` | fixing broken steps automatically: every run is `GC_HEAL=off`, and suggested fixes cannot be accepted or the organisation's AI setting changed | runner |
| `control.signup` | self-service sign-up, including through Google | control plane |
| `control.invitations` | issuing and accepting invitations | control plane |
| `control.google` | signing in with Google | control plane |
| `control.passkeys` | signing in with a passkey | control plane |

Signing in with a password, signing out, MFA and the admin are never
switchable: they are how an operator gets in to turn a switch back on.

The catalogue lives in both services — `switches.js` and
`auth/tenants/switches.py` — and a control-plane test fails when the two lists
differ.

### Turning one off

- **`GC_SWITCHES_OFF`**, in the environment of *both* services (compose passes
  the same line to each): comma-separated switches, a service name (`runner`,
  `control`) meaning all of that service's switches, or `*` for every switch.
  A name either service does not know stops it at boot — a typo would
  otherwise leave on exactly what it was written to turn off. Read at startup,
  so a change needs a restart.
- **The control plane's admin**, at runtime: *Tenants → Switches*, a row per
  key with *enabled* unticked. Ticking it, or deleting the row, turns the
  feature back on. No row means on. Saving or deleting a row bumps every
  organisation's entitlements version, so runner tokens minted before the
  change are refused as stale and the UI mints fresh ones at once.

The environment wins: nothing in the admin or a token can switch on what
`GC_SWITCHES_OFF` turned off, and the admin's list says when that is the case.

### How it reaches the runner

The runner never calls the control plane. The executor token carries an `off`
claim — the `runner.*` switches that are off, a sorted list — and the runner
adds its own `GC_SWITCHES_OFF`. A token can only turn things off.

### What a caller sees

- The runner, over HTTP: `403 {"ok": false, "error": "switched_off", "switch": "runner.recording", "message": "Recording a flow is turned off on this deployment"}`.
- The runner, over the socket: `{"t": "refused", "of": "record.start", "error": "switched_off", "switch": "runner.recording"}`, plus a log line.
- The control plane: `403 {"error": "switched_off", "switch": "control.invitations"}`
  on its own endpoints. Under `/_allauth/` the same words also ride in
  allauth's shape — `{"status": 403, "errors": [{"code": "switched_off", "message": "Google sign-in is switched off.", "switch": "control.google"}], …}`
  — so the sign-in pages show its sentence.
- The runner's `GET /api/state` and the socket's greeting carry `switches`
  (`{"runner.recording": false, …}`). The control plane's `/auth/me` carries
  all nine as `flags`, and `/auth/config` closes the doors before anyone
  knocks: `signupOff`, and `google`, `passkeys` and `invitations` as booleans.
- The UI disables Record and Run script when theirs is off and says why on
  hover; the sign-in and sign-up pages drop a switched-off door rather than
  offer one that refuses; the organisation page hides the invitation form;
  *Origins & vault → Diagnostics* lists what is off.
- An invitation consumed at email verification while invitations are off is
  refused and stays good for when they are back; that, and the Google sign-up
  path, write an audit row. Other switched-off refusals do not.

---

## 2. Limits

Every limit is per client address — the entry the edge wrote into
`X-Forwarded-For`, never one a client typed. Over a limit the answer is `429`,
with `Retry-After` in seconds and `{"error": "rate_limited"}` (in allauth's
shape as well under `/_allauth/`). A limit is tripped in the log once per
window, never once per request.

### The runner

| Variable | Default | What |
|---|---|---|
| `GC_API_RATE` | `600/m` | every `/api` request |
| `GC_AUTH_FAIL_RATE` | `20/5m` | tokens that do not verify; the twentieth shuts the address out of **everything** for the rest of the window |
| `GC_TICKET_RATE` | `30/m` | `POST /api/socket-ticket` (on top of five outstanding per subject) |
| `GC_WS_CONNECT_RATE` | `30/m` | socket upgrades |
| `GC_WS_MESSAGE_RATE` | `3000/10s` | messages per socket — a canvas sends a pointer position every frame |
| `GC_TRUSTED_PROXY_COUNT` | `0` | proxies whose `X-Forwarded-For` entry is believed; compose sets `1` |

- On whenever auth is on (the deployed shape), or when any rate is named. A
  laptop runner is one person's, and the check suites drive it hard on purpose.
- What counts as a failed authentication: a token that does not verify, a
  socket ticket that does not redeem, a token in a socket URL, a socket from
  another origin. Not a stale token (it was genuine a moment ago) and not a
  missing one (that is a control plane that is down, and shutting its users
  out after it recovers helps nobody).
- Bodies are parsed only past the limits and the gate, up to 512kb; too big is
  `413`, not JSON is `400`, both in the API's own shape.
- A client has twenty seconds to finish sending its headers.
- Counters are in the runner's process, which is right for the one runner a
  deployment has. A second runner behind the same edge would need them in Redis.

### The control plane

allauth's own sign-in limits and the per-account lockout are unchanged
(docs/AUTH.md §3). Added in front of every view:

| Variable | Default | What |
|---|---|---|
| `GC_REQUEST_RATE` | `300/m/ip` | every request under `/auth/`, `/_allauth/`, `/accounts/`, `/admin/` |
| `GC_CSRF_RATE` | `60/m/ip` | `GET /auth/csrf` on its own — the one that starts a session for anyone who asks |

It runs before the session middleware, so a refused request never creates a
session or touches the database, and after CORS, so a preflight is never
counted and a 429 is readable from the UI's origin on a laptop. An IPv6
client is counted per /64 — one subscriber is routinely handed a whole one.
The compose healthcheck, `GET /auth/csrf` from loopback, is exempt: a
healthcheck refused once restarts a healthy service. The first refusal in a
window writes one `rate_limited` audit row and one warning; the rest cost a
counter and nothing else.

`GC_MINT_RATE` (`12/10m`), `GC_ACCEPT_RATE` (`10/m/ip`), `GC_INVITE_RATE`
(`20/h/user`) and `GC_PASSKEY_LOGIN_RATE` (`10/m/ip`) are read from the
environment too, and every rate is checked at import — an unreadable one, or
one that allows nothing, refuses to start. The counters live in Redis beside
allauth's; the windows are short, which keeps the number of keys — and the
eviction pressure on a 64MB `allkeys-lru` instance — bounded.

---

## 3. Headers

**Both services, every response:** `X-Request-Id`; `Cross-Origin-Resource-Policy:
same-site`; `Origin-Agent-Cluster: ?1`; `X-Permitted-Cross-Domain-Policies:
none`; a `Permissions-Policy` naming camera, microphone, geolocation, payment
and USB (never the passkey features).

**The runner** keeps its CSP, `X-Frame-Options`, `nosniff` and
`Referrer-Policy`, and adds `Cross-Origin-Opener-Policy: same-origin` and
`X-DNS-Prefetch-Control: off`. `X-Powered-By` is gone. `/api` answers are
`Cache-Control: no-store`.

**The control plane** adds a CSP to its JSON (`default-src 'none';
frame-ancestors 'none'`) with `Cache-Control: no-store`, and a framing-only CSP
to the admin, whose scripts it must not break.

**CORS**, in both: the UI may send `x-request-id` and `traceparent`, and may
read back `X-Request-Id` and `Retry-After`.

**HSTS stays at the edge** (Caddy), where TLS ends: a second copy in a service
would be a second place to get the value wrong.

---

## 4. Request ids and tracing

- **`X-Request-Id`.** The UI sends a fresh one on every call. A service keeps a
  sane one (`[A-Za-z0-9._:-]{8,128}`), makes one otherwise, and echoes it on the
  response. The UI puts it on every runner error it raises (`err.requestId`),
  so an error a person reports can be found in the log.
- **`traceparent`** (W3C). Its trace id is the same for everything one page
  load does, across both services. Its *sampled* flag is how a caller asks for
  its requests to be logged: the UI sets it while *Origins & vault →
  Diagnostics → Trace my requests* is on.
- **Logging**, in both services:

  | Variable | Values | Default |
  |---|---|---|
  | `GC_LOG_LEVEL` | `error`, `warn`/`warning`, `info`, `debug` | `info` |
  | `GC_LOG_FORMAT` | `text`, `json` | `text` (compose sets `json`) |
  | `GC_REQUEST_LOG` | `off`, `sampled`, `all` | `sampled` |

  `sampled` logs a request only when its traceparent is sampled — one person's
  session, followed, with no restart and nobody else's requests with it.
  `all` logs every request.

- **A request line holds** the request id, trace id, method, path *without its
  query string*, status, duration, address, and the account and organisation
  when they are already known. Never a header, a cookie, a token or a body.
  Every other log line the control plane writes during a request carries the
  request id and trace too.
- The control plane also writes the request id into the audit row
  (`AuthEvent.detail.rid`) of anything it records during that request.

---

## Checking it

- `npm run check:hardening` — the runner: the rules against the modules, the
  boot refusals, then a real open runner and a real gated one (switches on the
  API and the socket, 429s, the guessing loop, headers, request ids, the
  request log).
- `cd auth && python manage.py test accounts.tests.test_hardening tenants.tests.test_switches`
  — the control plane's half; the whole suite is `python manage.py test`.
