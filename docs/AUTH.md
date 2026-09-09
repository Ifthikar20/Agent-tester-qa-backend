# Who may drive the browser — the authentication design

This is the specification for ghostclick's sign-up, sign-in, Google sign-in, MFA,
sessions, executor tokens and entitlements, after a ten-lens attack review of the
first draft and an adversarial verification pass. It is written to be built from,
flow by flow, and to be argued with. Every rule below either closes a finding
from that review (referenced as `[token-3]`, `[oauth-2]` and so on) or pins a
control that the review confirmed and that must not be removed by accident.

The two sentences that matter most:

**The UI is untrusted.** Nothing that decides who you are, which organisation
you act for, what role you hold, whether you are staff, or what your plan allows
is ever read from a request body, a query string, a header the client can set,
or a flag the client was shown. Every such fact comes from the control plane's
database and reaches the runner only inside a signature.

**The runner cannot mint.** It holds only public keys. A compromised runner can
misuse the browser it already owns; it cannot become anybody.

---

## 0. Components and trust

| component | trusts | for | on proof of |
|---|---|---|---|
| **UI** (Vue, served by the runner at `/app/`) | nothing about itself | display | — |
| **Control plane** (Django + django-allauth in `auth/`) | its own database; the edge for the client IP and scheme | identity, sessions, MFA, orgs, plans, minting | session cookie + CSRF; `X-Forwarded-*` only from the edge |
| **Runner** (Node + Playwright) | the control plane's *public* keys | who is calling and what they may do | an EdDSA token or a ticket derived from one |
| **Edge** (Caddy) | operator config | TLS, routing, header hygiene, admin IP allowlist | — |
| **Google** | — | a verified email and a `sub` | id_token via OAuth code + PKCE |

Network layout (compose): two networks. `edge` carries caddy ↔ runner and caddy
↔ control. `data` (`internal: true`) carries control ↔ postgres and control ↔
redis. The runner — and therefore the driven Chromium — has no route to control,
postgres or redis `[transport-3] [ops-supply-5]`. The runner never calls the
control plane at all: its trust anchor is delivered in its environment
`[token-3]`.

Laptop mode stays supported: with no `GC_AUTH_PUBLIC_KEYS` on the runner and no
`VITE_AUTH_URL` in the UI, there is no login and the banner says `auth -> OFF`.

---

## 1. Transport, cookies, hosts

Applies when `GC_PUBLIC_URL` is set (production). Everything is derived from it
so the four values that used to have to agree now cannot disagree `[transport-2]
[transport-5] [oauth-4]`.

```python
# auth/config/settings.py — the production profile, derived from one URL
PUBLIC_URL = env('GC_PUBLIC_URL')                         # e.g. https://app.example.com
PUBLIC_HOST = urlsplit(PUBLIC_URL).hostname
IS_HTTPS = PUBLIC_URL.startswith('https://')
ALLOWED_HOSTS = [PUBLIC_HOST]                             # never '*'; import fails if '*' and not DEBUG
CSRF_TRUSTED_ORIGINS = [PUBLIC_URL]
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
USE_X_FORWARDED_HOST = False
SESSION_COOKIE_SECURE = CSRF_COOKIE_SECURE = IS_HTTPS
SESSION_COOKIE_NAME = '__Host-sessionid' if IS_HTTPS else 'sessionid'
CSRF_COOKIE_NAME    = '__Host-csrftoken' if IS_HTTPS else 'csrftoken'
SESSION_COOKIE_SAMESITE = CSRF_COOKIE_SAMESITE = 'Lax'    # Strict breaks the Google callback [session-6]
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_AGE = 12 * 3600                            # idle
SESSION_SAVE_EVERY_REQUEST = True                         # sliding
GC_SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600               # enforced by accounts.middleware.AbsoluteSessionLifetime
SECURE_REFERRER_POLICY = 'strict-origin-when-cross-origin'
ALLAUTH_TRUSTED_PROXY_COUNT = 1                           # the edge; Caddy replaces X-Forwarded-For [credentials-2]
```

- The edge emits `Strict-Transport-Security: max-age=63072000; includeSubDomains`
  on https sites; Django does not, because the edge terminates TLS `[transport-1]`.
  The refuted control here was "TLS at the edge" alone — without HSTS a first
  contact over http can be stripped.
- The edge **overwrites** `X-Forwarded-Proto` and `X-Forwarded-For`; a client
  cannot spoof either. gunicorn runs with `--forwarded-allow-ips='*'` because only
  the edge can reach it on the `edge` network.
- The edge strips `Cookie` from everything routed to the runner. The runner never
  authenticates by cookie, so the runner never sees one `[session-1]`.
- The edge routes to the control plane exactly: `/auth/*`, `/_allauth/*`,
  `/accounts/google/login/callback/`, `/admin/*`, `/static/*`. Not `/accounts/*`
  wholesale: the One Tap token endpoint is csrf-exempt and stays unrouted
  `[oauth-3]`. Everything else goes to the runner.
- `/admin/*` is additionally restricted at the edge to `GC_ADMIN_CIDRS`.
- The edge's access log deletes the `ticket` query parameter and never logs
  credentials `[ops-supply-4]`.
- Absolute lifetime: a `login_at` stamp is written in one `user_logged_in`
  receiver with `setdefault`, so a Google "connect" or a reauthentication never
  restarts the 7-day clock; the middleware flushes the session and answers 401
  `{error:'session_expired'}` past it `[session-2] [session-4]`.
- Sessions are database-backed; `manage.py clearsessions` runs daily and after
  every deploy; backups exclude `django_session` and the usersessions table
  `[ops-supply-2]`.

Site address in the Caddyfile is `{$GC_PUBLIC_URL}`: an `https://host` gets
automatic certificates; an `http://ip` still works for a demo and the deploy
script says loudly that cookies are not Secure there.

---

## 2. Passwords and hashing

```python
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.Argon2PasswordHasher',   # argon2-cffi
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',   # legacy; upgraded on next sign-in
]
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 15}},
    {'NAME': 'accounts.validators.MaximumLengthValidator', 'OPTIONS': {'max_length': 128}},
    {'NAME': 'pwned_passwords_django.validators.PwnedPasswordsValidator'},   # HIBP k-anonymity
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
]
```

No composition rules. Passphrases with spaces are fine. The same validators run
for `adduser --password-stdin`, the admin form and allauth `[credentials-5]`.
When the HIBP API is unreachable the validator falls back to the common-password
list and logs a warning; it never blocks sign-up on an outage.

---

## 3. Rate limits and the client IP

Real only with a shared cache. `CACHES` is Redis (`GC_REDIS_URL`) in production;
the settings module raises at import if `DEBUG` is off and the cache is
`LocMemCache` `[mfa-recovery-4] [credentials-2]`.

```python
ACCOUNT_RATE_LIMITS = {
    'login': '30/m/ip',
    'login_failed': '10/m/ip,5/5m/key',
    'signup': '10/h/ip,3/h/key',
    'reset_password': '20/m/ip,3/m/key',
    'reset_password_from_key': '20/m/ip',
    'confirm_email': '1/10s/key',
    'reauthenticate': '10/m/ip',
    'change_password': '5/m/user',
    'manage_email': '10/m/user',
}
ACCOUNT_LOGIN_ATTEMPTS_LIMIT = 5
ACCOUNT_LOGIN_ATTEMPTS_TIMEOUT = 300
MFA_TOTP_TOLERANCE = 0
GC_MINT_RATE = '12/10m'      # per session key, on POST /auth/executor-token [token-5]
GC_ACCEPT_RATE = '10/m/ip'   # invitation acceptance
```

Per-IP limits key on the client address as the edge reports it
(`ALLAUTH_TRUSTED_PROXY_COUNT = 1`). A test sends `X-Forwarded-For: 1.2.3.4`
through the middleware and asserts the bucket is the peer, not the header
`[credentials-2]`.

Credential stuffing is not stopped by per-IP limits. Two additional controls
`[credentials-1]`: after the `login_failed` per-IP limit trips, that IP must
present a Turnstile token on login for an hour (when `GC_TURNSTILE_SECRET` is
set); and every successful login runs the presented password through the HIBP
check, and a hit forces a password change before anything else.

Django's own admin login form is removed: `admin.site.login` is wrapped with
allauth's `secure_admin_login`, so `/admin/` authenticates only through the
rate-limited, MFA-enforcing flow `[credentials-1] [ops-supply-6]`.

---

## 4. Sign-up (F1)

Endpoints under `/_allauth/browser/v1/`: `POST auth/signup`, `POST auth/email/verify`,
`POST auth/email/verify/resend`.

```python
ACCOUNT_LOGIN_METHODS = {'email'}
ACCOUNT_SIGNUP_FIELDS = ['email*', 'password1*']
ACCOUNT_EMAIL_VERIFICATION = 'mandatory'
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED = True
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_MAX_ATTEMPTS = 3
ACCOUNT_PREVENT_ENUMERATION = True
ACCOUNT_EMAIL_NOTIFICATIONS = True
ACCOUNT_ADAPTER = 'accounts.adapters.AccountAdapter'
GC_SIGNUP_MODE = 'invite'    # open | invite | domain
GC_SIGNUP_DOMAINS = []       # for domain mode; exact match on the email's domain / Google's hd
```

Rules:

1. `is_open_for_signup` is implemented **once**, in `accounts/policy.py`
   (`signup_allowed(email, hd=None)`), and both the account adapter and the
   social adapter call it, so the two paths cannot drift `[oauth-5]`.
2. `invite` mode requires a live `Invitation` whose email matches. The
   invitation is consumed, and the membership created, only when email
   verification completes; an unverified sign-up neither burns the invitation
   nor gains a membership `[credentials-6]`.
3. The "email already exists" branch pays the same Argon2id cost as the
   creation branch (a `make_password` on the discarded password), so the timing
   oracle closes; a test asserts the two branches are within 10 ms
   `[credentials-3]`.
4. In `open` mode, `POST auth/signup` requires a Turnstile token when
   `GC_TURNSTILE_SECRET` is set.
5. On verification, a personal organisation is created on plan `free` with the
   user as owner, and the session begins.
6. Every sign-up, verification and refusal writes an `AuthEvent`.

The UI: `/app/signup`, `/app/verify` (six-digit code, resend), one password
field with a reveal toggle, paste allowed, no strength meter theatre — the
validators decide.

---

## 5. Sign-in (F2)

`POST auth/login`, then possibly `POST auth/2fa/authenticate`, or passkeys via
`GET/POST auth/webauthn/login`.

1. Uniform response for unknown email and wrong password; Django runs the hasher
   in both cases.
2. On success Django cycles the session key and allauth rotates CSRF; the SPA
   takes the new token from the session response.
3. The session records **authentication events**: `request.session['gc_auth_events']`
   is a list of `{method, at}` appended by receivers on allauth's login and
   reauthentication signals, with `method` ∈ `password | otp | recovery | webauthn
   | google` `[mfa-recovery-2]`. Everything downstream — `amr`, `auth_time`,
   step-up — is computed from these events, never from a flag.
4. **MFA policy is session-scoped, not mint-scoped** `[mfa-recovery-1]`.
   `accounts.middleware.MfaRequired` runs after authentication: when the user's
   policy requires an authenticator and none exists, every path is refused with
   403 `{error:'mfa_required'}` except the enrolment endpoints
   (`account/authenticators/*`), `auth/session` (DELETE), `auth/reauthenticate`
   and `/auth/me`. The policy is true when: the user is staff; the user holds
   `owner` or `admin` in any org; the org's resolved entitlements say
   `mfa.required`; or the account has no usable password (Google-only)
   `[oauth-1] [oauth-6]`.
5. A Google sign-in is a single factor (`amr: ['google']`). It never satisfies
   `mfa.required` `[oauth-6]`.
6. New device: when the `ip, user-agent` pair has not been seen on this account,
   an email says so.
7. Passkeys require user verification for both login and second-factor use; an
   assertion without the UV flag is refused and never yields `webauthn` in `amr`
   `[mfa-recovery-5]`.
8. `MFA_TRUST_ENABLED = False`, always: a trusted-device cookie is the one
   allauth feature that skips the authenticate stage `[mfa-recovery-6]`.

---

## 6. Google (F3)

`POST auth/provider/redirect` (form: `provider=google`, `callback_url`,
`process=login|connect`), the callback at `/accounts/google/login/callback/`,
`GET/DELETE account/providers`.

```python
SOCIALACCOUNT_PROVIDERS = {'google': {
    'APPS': [{'client_id': env('GOOGLE_CLIENT_ID'), 'secret': env('GOOGLE_CLIENT_SECRET'), 'key': ''}],
    'SCOPE': ['profile', 'email'],
    'AUTH_PARAMS': {'prompt': 'select_account'},
    'OAUTH_PKCE_ENABLED': True,
    'EMAIL_AUTHENTICATION': True,
    'EMAIL_AUTHENTICATION_AUTO_CONNECT': True,
}}
SOCIALACCOUNT_AUTO_SIGNUP = True
SOCIALACCOUNT_STORE_TOKENS = False
SOCIALACCOUNT_LOGIN_ON_GET = False
SOCIALACCOUNT_ADAPTER = 'accounts.adapters.SocialAccountAdapter'
ACCOUNT_CHANGE_EMAIL = True
ACCOUNT_MAX_EMAIL_ADDRESSES = 2
```

1. `callback_url` is validated by `AccountAdapter.is_safe_url`, which requires
   scheme and host equal to `PUBLIC_URL` and a path under `/app/`. It does not
   rely on `ALLOWED_HOSTS` `[oauth-4]`. The UI hard-codes the callback and
   validates `?next=` to a relative path.
2. Linking by email happens only when Google says `email_verified`, **and** the
   local `EmailAddress` is verified, **and** the account has no other Google
   identity with a different `sub` `[oauth-2]`. Otherwise the callback returns
   one generic message for every refusal: "We could not sign you in with Google.
   Sign in the way you usually do, then connect Google from Settings."
   `[credentials-3]`.
3. Sign-up through Google goes through `signup_allowed(email, hd)` and consumes
   the `signup` rate limit `[oauth-5]`. `domain` mode reads `hd` from the
   id_token, never from the email suffix.
4. Google tokens are not stored. One Tap is not enabled.
5. A Google-only account has no reauthentication method, so it falls under the
   MFA policy in §5.4 and must enrol an authenticator before anything sensitive
   `[oauth-1]`.
6. Unverified secondary addresses older than 15 minutes are deleted by a
   periodic command `[oauth-2]`.

---

## 7. Recovery and account changes (F4)

`POST auth/password/request`, `POST auth/password/reset`,
`POST account/password/change`, `GET/POST/PUT/DELETE account/email`,
`POST auth/reauthenticate`, `POST auth/2fa/reauthenticate`.

```python
PASSWORD_RESET_TIMEOUT = 3600
ACCOUNT_LOGIN_ON_PASSWORD_RESET = False
ACCOUNT_LOGOUT_ON_PASSWORD_CHANGE = True
ACCOUNT_REAUTHENTICATION_REQUIRED = True
ACCOUNT_REAUTHENTICATION_TIMEOUT = 300
```

1. Reset links are single-use and expire in an hour; a reset flushes every
   session and emails the account. Authenticators survive a reset, so a mailbox
   thief still meets the second factor `[mfa-recovery-3]`.
2. **Strong reauthentication**: for an account with an authenticator, the reauth
   that gates password change, email change, authenticator changes and recovery
   codes must be a second-factor event within 300 s; a password reauth answers
   401 with `mfa_reauthenticate` pending `[mfa-recovery-2]`.
3. Email change: the new address is verified by code, the old address is
   notified, and the old address remains a valid identifier for password reset
   for 7 days so a victim can undo a takeover `[mfa-recovery-3]`.
4. Every reauthentication appends to `gc_auth_events`.

---

## 8. The executor token (F5) and its verification (F6)

The control plane signs with **Ed25519**. Keys are generated by
`manage.py signing_key --new` which prints two things: the private key for the
control plane's environment (`GC_SIGNING_KEY`, PEM, with a `kid` derived from
the public key thumbprint) and the public set for the runner's environment
(`GC_AUTH_PUBLIC_KEYS`, JSON `{kid: pem}`). `GET /auth/jwks` publishes the public
set for humans and tooling; the runner does not fetch it `[token-3] [ops-supply-5]`.

Cutover from HS256 is atomic and one-directional: the same commit replaces the
minter and the verifier, removes `GC_AUTH_SECRET` from every service, and the
runner refuses to boot if `GC_AUTH_SECRET` is present in its environment
("this process must not hold a signing key") `[token-1] [token-2]
[authz-tenancy-2]`.

Minting — `POST /auth/executor-token` (session + CSRF; the body is ignored):

1. `request.user` must be authenticated, active, past MFA policy (§5.4), and
   within the absolute session lifetime.
2. The org is the session's selected org, validated against `Membership`; the
   role comes from that row `[authz-tenancy-3]`.
3. Rate limit `12/10m` per session key; every mint writes an `AuthEvent` with the
   `jti` `[token-5]`.
4. Claims:

```json
{ "iss": "ghostclick-control", "aud": "ghostclick-runner",
  "sub": "42", "email": "ada@acme.example",
  "org": "acme", "role": "admin",
  "amr": ["password", "otp"], "auth_time": 1789000000,
  "su": 1789000600,
  "ent": {"suites.max": 25, "runs.per_day": 500, "origins.max": 20, "vault.enabled": true, "history.retention_days": 90},
  "ent_v": 7, "sid": "h(session_key)",
  "iat": 1789000300, "exp": 1789000900, "jti": "c1f0…" }
```

- `amr` is the set of methods actually used in this session.
- `auth_time` is the most recent **strong** event if the account has an
  authenticator, else the most recent event.
- `su` ("step-up valid until") is computed by the control plane, not the runner:
  `auth_time + 600` when the strongest factor the account has was used at
  `auth_time`, otherwise `0`. The runner's step-up check is simply `now < su`
  `[mfa-recovery-2]`.
- `sid` lets the runner revoke by session.
- `exp - iat` is at most 600 and the control plane clamps `GC_TOKEN_TTL` to
  60–600 `[token-4]`.

Verification on the runner (`auth.js`), for every `/api` call:

1. `Authorization: Bearer` present, else 401.
2. Header `alg` must equal `EdDSA`; `kid` must name a key in `GC_AUTH_PUBLIC_KEYS`.
   No branching on `alg`; no HS256 path exists in the file.
3. `crypto.verify(null, …)` with that public key.
4. `iss`, `aud`, `sub`, `org`, `iat`, `exp` required; `exp` not past (60 s
   skew); `iat` not in the future; `exp - iat ≤ 660`; `nbf` honoured if present.
5. Claims are attached as `req.user` and **used**: every store is keyed by
   `org`; entitlements read `ent`; step-up reads `su`; role reads `role`.
6. Revocation: the control plane posts nothing to the runner (no route exists).
   Instead the runner honours `ent_v` per org and `sid`: `POST /api/revoke` does
   not exist; a token is worthless within 10 minutes, and the socket bound to a
   session closes at the token's `exp` (§9). This is the accepted residual, and
   it is bounded.

---

## 9. The socket (F7) and step-up (F8)

1. `POST /api/socket-ticket` with a valid Bearer returns `{ticket, expiresIn: 30}`.
   The ticket is 32 random bytes, base64url, single-use, stored in memory with
   the claims and an expiry. At most 5 outstanding tickets per `sub`.
2. The UI opens `wss://…/ws?ticket=…`. A `?t=` JWT in the URL is refused with
   401 — a token in a URL must fail, not work `[ops-supply-4]`.
3. At upgrade the runner requires `Origin` to equal the app origin
   `[websocket-6] [browser-side-5]`, looks up and deletes the ticket, binds the
   claims to the socket, and schedules `ws.close(4401)` at the token's `exp`.
   The UI reconnects with a fresh ticket from a fresh token `[websocket-1]`.
4. At most 3 live sockets per `sub`; a fourth closes the oldest. `maxPayload` is
   1 MiB `[websocket-5]`.
5. **Every message is authorised against the socket's claims**, exactly as the
   HTTP routes are: `command` and `open` require the socket's org to be the
   driving org; `origin.add` is identical to `POST /api/origins` and requires
   step-up; `human.*` require the driving org `[websocket-2]`.
6. **Broadcast is per org.** Frames, `url`, `targets`, `console`, `nav` and run
   events go only to sockets whose org is the driving org. The `ready` greeting
   carries the driven URL and origins for that org only and never carries vault
   key names; names come from `GET /api/state` under the token `[websocket-3]
   [authz-tenancy-4]`.
7. The UI closes its socket on sign-out and before a new sign-in; the runner
   drops a socket that sends `{t:'bye'}` immediately `[session-3]`.
8. A `401` from `/auth/executor-token` is terminal in the UI: the session store
   clears the user, disconnects the socket, and routes to `/login`; a 403
   `mfa_required` routes to `/app/security/mfa`. Reconnects back off
   exponentially to 30 s `[session-4]`.

Step-up: allowing an origin — `POST /api/origins` and the `origin.add` message —
requires `now < claims.su`. Otherwise 403 `{error:'step_up_required'}`; the UI
reauthenticates (strong factor if the account has one), re-mints, retries.

---

## 10. Organisations, roles, entitlements (F10)

`tenants` app: `Plan`, `Organization`, `Membership(role ∈ owner|admin|member)`,
`Invitation`.

- Every account has a personal organisation. The session holds the selected org;
  `POST /auth/org` switches it after a membership check. No endpoint anywhere
  takes an org from the client for authorisation.
- Roles: `owner` — billing, delete org, manage admins, invite any role;
  `admin` — members, invitations for `member` and `admin` only, origins, vault;
  `member` — run and view. An inviter can never grant a role above their own,
  and only an owner can grant `admin` or `owner` `[authz-tenancy-5]`.
- Invitations: `secrets.token_urlsafe(32)`, stored hashed, looked up by token,
  bound to an email, 7-day expiry, single-use, consumed at verified acceptance;
  acceptance requires being signed in with that verified email; attempts are
  rate limited and logged `[credentials-6]`.
- Entitlements resolve as `{**plan.entitlements, **org.entitlement_overrides}`
  with `entitlements_version` bumped on any change. Only the runner-enforced
  subset rides in the token.
- `/auth/me` returns `{user:{id,email,name}, org:{slug,name,role}, orgs:[…],
  entitlements, mfa:{required, enrolled}, flags}`. There is no `isStaff`
  `[authz-tenancy-6]`. Staff is a control-plane-only fact that opens `/admin/`.
- In the admin, `is_superuser` and `user_permissions` are read-only for
  non-superusers `[authz-tenancy-6]`.

Runner tenancy `[authz-tenancy-1]`:

- State lives under `.ghostclick/<org>/` (origins, vault, runs) and suites under
  `suites/<org>/`. A suite id from another org is a 404, never a 403.
- There is one Chromium and one run lock. The runner records the **driving org**
  when a page is opened or a run starts; requests from another org while that
  org is driving get 409 `{error:'runner_busy', org:'<slug>'}` rather than a
  view of someone else's browser. This is the honest shape until a runner pool
  exists.
- Enforcement, always on the runner and never only in the UI: `suites.max` on
  create, `runs.per_day` on run (from the org's history), `origins.max` on allow,
  `vault.enabled` when a `$KEY` is resolved, `history.retention_days` when
  pruning. Refusals are 402 `{error:'entitlement', limit:'suites.max', plan:'free'}`.

---

## 11. The driven browser's reach (F12 and SSRF)

The allowlist gates navigation. It says nothing about what an allowed page
fetches, and the page runs inside the runner's network namespace
`[browser-side-1] [transport-4]`.

- `context.route('**/*')` inspects every request. Any host that is loopback,
  RFC 1918, link-local (169.254.0.0/16, including IMDS), `::1`, a bare hostname
  (`control`, `runner`, `redis`, `postgres`, `caddy`), `*.internal` or
  `*.local` is aborted — after resolving the name, so rebinding to a private
  address is caught too. The runner's own origin is never seeded as drivable in
  production.
- The compose networks give the runner no route to control, redis or postgres
  regardless.
- IMDSv2 with hop limit 1 is required by the deploy script, not just the
  bring-up script.
- `POST /api/recording` requires a Bearer token whenever auth is on. The
  extension obtains one through the control plane with the user's session
  (extension origins listed in `GC_EXTENSION_ORIGINS` are trusted for CSRF and
  CORS) `[browser-side-2]`.
- The demo fixtures and `/go/*` redirects are served only when auth is off or
  `GC_DEMO=1`; `/go/r` accepts relative paths only `[browser-side-6]`.
- Runner responses carry `Content-Security-Policy: default-src 'self';
  connect-src 'self' wss: https:; img-src 'self' data: blob:; style-src 'self'
  'unsafe-inline'; frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy: camera=(),
  microphone=(), geolocation=()` `[browser-side-3] [browser-side-4]`. The
  wildcard `Access-Control-Allow-Origin` is gone when auth is on.

---

## 12. Keys, secrets, backups, supply chain (F11)

- The Ed25519 private key is in the control plane's environment only, delivered
  by a root-owned `.env.prod` read by `docker compose` under `sudo`; the deploy
  user is not in the docker group `[ops-supply-1]`. Rotation: `signing_key --new`,
  add the new public key to the runner's set, restart, then remove the old key
  after 15 minutes. Every mint is logged with its `jti`, so a forged token that
  never appears in the log is detectable.
- TOTP secrets and recovery codes are encrypted at rest with `GC_MFA_KEY`
  (Fernet), a key separate from `DJANGO_SECRET_KEY` `[ops-supply-2]`.
- `auth/requirements.txt` is pinned with hashes and installed with
  `--require-hashes`; `npm ci --ignore-scripts`; base images by digest; CI runs
  `pip-audit` and `npm audit` and checks the control image for secrets
  `[ops-supply-3]`.
- `AuthEvent` rows older than 90 days are purged; sessions are cleared daily.
- `adduser --staff/--superuser` prints that `/admin/` will demand MFA enrolment
  at first sign-in.

---

## 13. Analysis: what stops what, and what remains

Attacker-by-attacker, the control that stops them, and the residual.

| attacker | stopped by | residual |
|---|---|---|
| on-path network | TLS, HSTS, `__Host-` Secure cookies, `wss://` | first-ever contact before HSTS is cached; use the preload list once stable |
| password guessing, stuffing | Argon2id, 15-char minimum, HIBP on set **and** on login, per-IP and per-account limits keyed on the real client IP, Turnstile after trips, uniform responses, equalised timing | a slow, distributed, one-guess-per-account campaign against reused passwords that HIBP does not know |
| mailbox thief | reset never removes authenticators; login after reset still needs the factor; old address can undo an email change for 7 days | accounts with no authenticator and no policy requiring one |
| stolen session cookie | Secure, HttpOnly, 12h idle, 7d absolute, sessions page, strong reauth for changes, mint rate limit and audit | up to 12h of use as the victim, minus anything step-up gated |
| stolen executor token | 10-minute life, never in a URL, socket ticket, `su` for step-up, org-partitioned runner | ≤10 minutes of the victim's ordinary runner rights |
| hijacked socket | claims bound at upgrade, per-message authorisation, closed at token `exp`, Origin check, per-sub caps | a run dispatched in the final second continues to completion |
| XSS in the SPA | CSP, no inline script, tokens never in storage, mint rate limit and audit, step-up for the blast-radius action | a script on the page can still act as the user for ordinary actions until the page is closed |
| Google account attacks | PKCE, session-bound state, CSRF on the redirect endpoint, linking only verified-to-verified with matching `sub`, One Tap unrouted, pinned callback | a Google Workspace admin can reset a member's Google password; treat Google as one factor, which the design does |
| tenant crossing on the runner | org-keyed state, per-org broadcast, driving-org lock, 404 for foreign ids, `org` only ever from the signature | one Chromium process: a page-level isolation failure inside the browser is not a tenancy control the runner can promise |
| privilege escalation | roles only from `Membership`, invitation role cap, no staff flag to the browser, superuser fields read-only, staff MFA middleware, admin behind allowlist and allauth login | a superuser is a superuser |
| runner compromise | public keys only, no route to the control plane or data stores, no signing material | the attacker owns the browser the runner already owns and every vault value it can resolve for the driving org |
| control plane compromise | — | total; this is the root of trust, which is why its network is closed, its dependencies are hashed, and every mint is logged |
| operator with the deploy key | root-only secrets, no docker group, audit of every mint | an operator is an operator; KMS-backed signing (`ES256`) is the next step if that must change |
| driven page pivoting inward | request interception with resolved-address checks, compose networks, IMDSv2 hop limit | a browser sandbox escape lands in the runner container, see "runner compromise" |

"Fully secured" therefore means: every path an attacker can take is either
closed or bounded to a short, logged, single-tenant window, and no component can
be lied to about identity, role, organisation or entitlements. It does not mean
a compromised control plane, a compromised operator, or a compromised browser
engine can be survived without detection and rotation — those are the three
things the logging and key-rotation procedures exist for.

---

## 14. Build order

Each step is one commit series, each leaves every check green, and each keeps
laptop mode working.

1. **foundation** — §1 §2 §3: settings profile, Argon2 and validators, Redis
   and Postgres and Caddy in compose with the two networks, `AuthEvent`,
   absolute lifetime middleware, deploy-script checks, requirements pinning.
2. **tenants** — §10 control-plane half: models, personal org, roles,
   invitations, entitlement resolution, `/auth/me`, admin hardening.
3. **token-runner** — §8 §9 §11: Ed25519 minting and verification, the atomic
   cutover, socket ticket and socket authorisation, runner headers, request
   interception, demo gating, `/api/recording` under the gate, UI socket and
   401 handling.
4. **accounts** — §4 §5 (password parts) §7: allauth headless, adapters, signup
   modes, verification by code, reset and changes, admin login through allauth,
   Vue screens.
5. **google** — §6.
6. **mfa** — §5 (MFA parts) §7 (strong reauth): TOTP, recovery codes, passkeys,
   MFA policy middleware, auth events and `su`, usersessions, staff MFA,
   encrypted secrets, UI.
7. **runner-tenancy** — §10 runner half: org-partitioned state, driving-org
   lock, entitlement enforcement, per-org broadcast, step-up on both paths.
8. **ops** — §12: hashes, CI, backups, purges, extension token, documentation.
