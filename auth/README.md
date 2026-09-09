# ghostclick — the control plane

Django, and it knows about exactly one thing: people.

It has never heard of a test case. It cannot reach the runner's suites, it holds
no secret values, and it has no opinion about which origins may be driven — the
executor owns all of that and re-checks it locally. That is deliberate: two
services with an opinion about the same rule is how a hard gate quietly becomes
advisory, and the gate here decides where a real browser is pointed.

The design it is being built towards is [docs/AUTH.md](../docs/AUTH.md). This
directory is at the **accounts** step of that document's build order: the
foundation (settings profile, hashing, the audit log, the session clocks, the
stores and edge), organisations, roles, invitations and entitlements (the
control-plane half of §10), the Ed25519 executor token (§8), and now
django-allauth for sign-up, sign-in, verification, recovery and the account
changes (§4, §5 and §7, the password parts). Google sign-in and MFA are the
next two steps; the runner does not partition its state by organisation yet —
that is the runner-tenancy step.

## Why Django

SSO. Sign-up, sign-in, the verification code, the reset link and the password
and email changes are `django-allauth`'s, reached by the SPA through its
headless JSON API under `/_allauth/`; Google and MFA slot in behind the same
prefix without a line changing on the runner side. Plus the admin, which is
why adding a colleague is a form rather than a script someone has to write —
and whose login form is gone: `/admin/` sends you to the app's sign-in and
takes you back as a staff session, so staff meet the same rate limits,
verification and (soon) MFA as everyone else.

## Running it

```bash
pip install -r requirements.txt
cp .env.example .env
python manage.py signing_key --new    # prints GC_SIGNING_KEY for .env, and the runner's line
export $(grep -v '^#' .env | xargs)

python manage.py migrate
python manage.py createsuperuser      # email is the login
python manage.py runserver 8000
```

Then point the UI at it and give the runner the PUBLIC half of the key — the
`GC_AUTH_PUBLIC_KEYS=` line `signing_key` printed — and the two origins it
needs to know:

```bash
# in the repository root
GC_AUTH_PUBLIC_KEYS='{"<kid>": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"}' \
GC_WEB_ORIGIN=http://localhost:3000 GC_AUTH_ORIGIN=http://localhost:8000 npm start
VITE_AUTH_URL=http://localhost:8000 npm run build
```

`npm run app -- --auth` from the repository root does all of that, keeping
the keypair in `.ghostclick/`, and prints the control plane's mail — every
sign-up code, invitation and reset link — into the same terminal, because on
a laptop the mail backend is the console.

Leave `VITE_AUTH_URL` unset and the UI runs with no login at all, against a
runner that is also unauthenticated. That is the laptop case and it stays
supported — `npm start` on its own should not require a second service.

## Two profiles, one switch

`config/settings.py` has a laptop profile and a production profile, and the
switch is whether `GC_PUBLIC_URL` is set. Nothing else chooses; nothing is
edited.

| | laptop (no `GC_PUBLIC_URL`) | production (`GC_PUBLIC_URL=https://…`) |
|---|---|---|
| hosts, CSRF origin | `DJANGO_ALLOWED_HOSTS`, `GC_WEB_ORIGIN` | **derived from the URL**; `'*'` refused |
| cookies | plain, `Lax` | `Secure`, `__Host-` prefixed, `Lax`, `HttpOnly` |
| `X-Forwarded-*` | ignored | trusted from the edge, which overwrites them |
| database | SQLite | Postgres via `DATABASE_URL`; SQLite **refused** |
| cache (rate limits) | in-process | Redis via `GC_REDIS_URL`; in-process **refused** |
| mail | printed to the console | SMTP; no `EMAIL_HOST` **refused** unless a backend is named on purpose |

"Refused" means the settings module raises at import. Each of those
configurations would come up, answer, and be wrong — an in-process cache gives
every gunicorn worker its own rate-limit counters; a missing `DATABASE_URL`
would create an empty SQLite file inside the container with nobody in it — so
they fail at the point where the failure is legible.

Everything derives from the one URL because the previous shape had four values
(the hosts, the CSRF origin, the CORS origin, the cookie flags) that had to
agree with how the box was reached, and when they did not the symptom was a
403 that read like a bug. There is one of them now.

## Passwords

Argon2id for everything stored from now on; PBKDF2 hashes made before this
still verify and are rehashed on the next successful sign-in. Validators:

- at least **15** characters, at most **128**
- not on Have I Been Pwned (k-anonymity: five characters of the SHA-1 leave
  the box, never the password). When the API is unreachable the validator
  falls back to Django's common-password list and logs that it did; an outage
  never blocks a sign-up.
- not similar to your own email or name

No composition rules — a passphrase with spaces is fine. The same list runs for
sign-up, the reset, the change, the admin form and `adduser --password-stdin`,
so there is one definition of an acceptable password rather than five.

Have I Been Pwned is asked again at every successful sign-in, with the
password that was just presented: a password that was clean when set and has
been breached since marks the session, and `accounts.middleware
.PasswordChangeRequired` then answers `403 {"error": "password_change_required"}`
to everything but the change itself, `/auth/me`, the session endpoints and
reauthentication `[credentials-1]`. The change ends the session, and the next
sign-in is checked afresh. An outage marks nothing, the same way the
validator lets a sign-up through on one.

## Sessions: two clocks

Database-backed, twelve hours idle and sliding, and **seven days absolute**.
The sliding window alone never ends for a session that keeps being used —
which is exactly what a stolen cookie does — so `user_logged_in` stamps the
sign-in time into the session **once** (`setdefault`, so a reauthentication
or a later Google connect cannot restart it), and
`accounts.middleware.AbsoluteSessionLifetime` flushes the session and answers
`401 {"error": "session_expired"}` past it. `manage.py clearsessions` removes
the expired rows; the deploy runs it after every migrate.

## The audit log

`AuthEvent` is one row per sign-in, sign-out, refused password, expired
session, **minted token** (with the token's `jti`, so a token that never
appears here was not minted here), sign-up, refused sign-up, verification,
reauthentication, password change, reset request and reset, email change,
breached password, new device and Turnstile demand — written by receivers on
Django's own `user_logged_in`, `user_logged_out` and `user_login_failed`
signals, on allauth's account signals, and by the mint view — so a view that
signs someone in or changes something cannot forget to log it. Each row has
the address **as the edge reports it** (`accounts.events.client_ip`, the same
arithmetic allauth uses for its rate limits, with `ALLAUTH_TRUSTED_PROXY_COUNT
= 1` behind Caddy and `0` on a laptop), the user agent, and for a refusal the
email as typed. It is readable in `/admin/` and not editable there.

The same receivers keep `request.session['gc_auth_events']`, the list of
`{method, at}` the executor token's `amr`, `auth_time` and `su` are computed
from: allauth's `authentication_step_completed` fires for a sign-in and for a
reauthentication alike, and its method is written in the token's vocabulary
(`password`, and `otp`, `recovery`, `webauthn`, `google` once those steps
exist) `[mfa-recovery-2]`.

## Making an account

Three ways. People sign up (below); operators make accounts, and the
difference between the two operator commands is who chooses the password.

```bash
python manage.py createsuperuser              # it asks; use this for a person
python manage.py adduser qa@example.com       # it generates one and prints it once
```

An address has to be proven before it can act. `adduser` marks it verified —
an operator typing it at a terminal is the proof, and a test account has no
mailbox to receive a code. `createsuperuser` does not, so the first sign-in
of that account asks for the six-digit code the console backend printed,
which is the right thing for a person.

`createsuperuser` prompts, and a prompt needs a terminal — so it cannot run over
`ssh host '<command>'`, which is where making a test account usually happens. It
dies on "the input device is not a TTY" before asking anything. `adduser` is the
non-interactive half: it never takes the password as an argument (`ps` and shell
history both outlive the run), it makes an ordinary non-admin account unless you
ask for `--staff`, and it refuses an email that already has one unless you say
`--reset-password`. To choose the password yourself, pipe it in:

```bash
printf '%s' "$PASS" | python manage.py adduser qa@example.com --password-stdin
```

From your laptop, against either the local one or the deployed box,
`scripts/adduser.sh` is the same thing without the ssh:

```bash
bash scripts/adduser.sh qa@example.com                 # local
EC2_HOST=<ip> bash scripts/adduser.sh qa@example.com   # the box
```

## Sign-up, sign-in, recovery

docs/AUTH.md §4, §5 and §7, on django-allauth's headless API. Who may sign
up is decided in one place, `accounts/policy.py`, which the account adapter
asks and the social adapter will ask too, so a Google sign-up cannot answer
differently from a password one `[oauth-5]`:

| `GC_SIGNUP_MODE` | rule |
|---|---|
| `invite` (the default) | the address holds a live `Invitation` |
| `open` | anyone; Turnstile in front when configured |
| `domain` | the address's domain — for Google, the id_token's `hd` — is in `GC_SIGNUP_DOMAINS` |

A sign-up creates the account row and sends a six-digit code; until the code
is entered there is no session, the address is unverified, an invitation is
untouched and no membership exists `[credentials-6]`. Three wrong codes end the
attempt. When the address is verified the session begins, the personal
organisation is already there (every account row gets one), and every live
invitation bound to that address becomes a membership in the same moment.

Nothing the sign-up page answers says whether an address exists. An address
that already has an account, and — in invite mode — an address nobody
invited, get the same `401 verify_email` a fresh address gets; the truth goes
to the mailbox ("you already have an account", "sign-up is by invitation").
The existing-address branch also pays an Argon2id hash so the two cannot be
told apart by the clock, and a test asserts the medians are within ten
milliseconds `[credentials-3]`. A domain-mode refusal is said out loud, because
"sign up with your @acme.example address" is policy, not a secret.

Sign-in is one answer for a wrong password and an unknown address; allauth's
limits (`ACCOUNT_RATE_LIMITS`: 30 a minute per address, 10 failures a minute
per address, 5 per five minutes per account) count in Redis, keyed on the
client address the edge reports, and a test sends a forged `X-Forwarded-For`
and asserts the bucket did not move `[credentials-2]`. Once an address has
tripped the per-IP failure limit it must present a Cloudflare Turnstile
token with every sign-in for an hour (`accounts/turnstile.py`; only when
`GC_TURNSTILE_SECRET` and `GC_TURNSTILE_SITE_KEY` are set, and the SPA reads
the site key from `GET /auth/config`). A sign-in from an (address, user
agent) pair the account has not seen before is mailed about, except the
first sign-in ever.

Recovery: a reset link is good for an hour and — because the token is
derived from the password hash — for one use; it does not sign you in; and
the reset ends every session the account has (`accounts/sessions.py`), as
does a password change, which also asks for the current password. Changing
the address is: add the new one, enter the code sent to it, and the old one
is replaced and told. For seven days the old address is still a valid
identifier for a reset (`accounts.PreviousEmail`), so a change the owner did
not make can be undone from the mailbox they still have; the reset mail says
which address the account signs in with now `[mfa-recovery-3]`. Every
reauthentication is appended to the session's events and to the log.

## The surface

Ours, under `/auth`:

| | |
|---|---|
| `GET /auth/csrf` | a CSRF token the SPA echoes in `X-CSRFToken` |
| `GET /auth/config` | `{signup, domains, turnstile}` — what the sign-up page needs before anyone types |
| `GET /auth/me` | who am I, and for which organisation |
| `POST /auth/org` | `{org}` — act for another organisation this session, after a membership check |
| `GET /auth/invitations` | the selected organisation's invitations (owner or admin) |
| `POST /auth/invitations` | `{email, role}` — issue one; the token is mailed to the invitee and appears in no answer |
| `DELETE /auth/invitations/<id>` | revoke one |
| `POST /auth/invitations/accept` | `{token}` — become a member, signed in as the invited, verified address |
| `POST /auth/executor-token` | a short-lived signed token the **runner** will accept; 12 per 10 minutes per session |
| `GET /auth/jwks` | the public key the tokens verify with, for humans and tooling — the runner never fetches it |
| `/admin/` | Django's admin — where accounts, plans and organisations are managed; the edge admits it only from `GC_ADMIN_CIDRS`; its login is the app's |

allauth's, under `/_allauth/browser/v1/` (the SPA's `stores/session.js` is
the client; `HEADLESS_ONLY` means there is no HTML view of any of them):

| | |
|---|---|
| `POST auth/signup` | `{email, password[, turnstile]}` → `401` with `verify_email` pending, always |
| `POST auth/email/verify`, `POST auth/email/verify/resend` | `{key}` — the six-digit code; also the code of an email change |
| `POST auth/login` | `{email, password[, turnstile]}` → `200` and the session, or `401` with what is pending |
| `GET/DELETE auth/session` | who is signed in / sign out |
| `POST auth/reauthenticate` | `{password}` — a fresh proof, for the changes that want one |
| `POST auth/password/request`, `POST auth/password/reset` | `{email}` → the link; `{key, password}` → done, not signed in |
| `POST account/password/change` | `{current_password, new_password}` → every session ended |
| `GET/POST/PUT/DELETE account/email` | the address, and changing it |

Three of those — login, signup, password/request — are this project's
subclasses (`accounts/headless.py`), mounted at the same paths ahead of
allauth's own: the Turnstile field, the invite-mode branch, and the
previous-address lookup are the only additions.

Django rotates the CSRF token on sign-in and sign-out, and allauth's JSON
says nothing about it, so every answer from this service carries the fresh
value in an `X-CSRFToken` response header (`accounts.middleware
.CsrfTokenHeader`, exposed through CORS for the laptop's other origin). The
SPA echoes whatever it last saw. `/auth/me` is the shape it draws from:

```json
{ "user": {"id": 1, "email": "ada@acme.example", "name": "Ada"},
  "org": {"slug": "acme", "name": "Acme", "role": "admin", "personal": false, "plan": "team"},
  "orgs": [{"slug": "ada", "name": "Ada", "role": "owner", "personal": true, "plan": "free"}, "…"],
  "entitlements": {"suites.max": 25, "runs.per_day": 500, "origins.max": 20, "vault.enabled": true,
                   "history.retention_days": 90, "members.max": 10, "mfa.required": false},
  "mfa": {"required": false, "enrolled": false}, "flags": {} }
```

There is no `isStaff`. Staff is a control-plane fact that opens `/admin/`,
and a flag shown to the browser is a flag the browser can show itself; nothing
that decides what someone may do is ever derived from what they were told.

## Organisations, roles, entitlements

`tenants/` is the control-plane half of docs/AUTH.md §10.

**Every account has a personal organisation**, made by a receiver on user
creation — so it does not matter whether the account came from
`createsuperuser`, `adduser`, the admin or a sign-up flow — and on plan
`free` with the user as `owner`. The migration that introduced organisations
made one for every account that already existed; `manage.py personal_orgs`
does the same for a database restored from before the rule, and does nothing
on a healthy one. The slug is the local part of the email (`ada`, then
`ada-2` on a clash), because the domain is the half of an address people do
not expect to see published, and it has to be a directory name on the runner.

**The session holds the selected organisation** as a slug, and the
membership row is looked up again every time it is used — `/auth/me`, the
token, an invitation. A membership removed an hour ago stopped working an
hour ago, and editing the session cannot put you somewhere you are not.
`POST /auth/org` switches after the same check; nothing anywhere takes an
organisation from a request body for authorisation.

**Roles** are `owner`, `admin`, `member`, and they come from `Membership`
and nowhere else. Invitations carry a role, and the cap is the rule that
matters `[authz-tenancy-5]`: an inviter never grants above their own role,
and only an owner grants `admin` or `owner` — so an admin can only ever add
members, and the set of people who can manage an organisation grows only by
an owner's hand.

**Invitations** are `token_urlsafe(32)`, stored as a SHA-256 and looked up
by it, bound to an email, good for seven days, single-use, and consumed only
by a signed-in user holding that address **verified** — either by presenting
the token (`POST /auth/invitations/accept`, an existing account) or by
verifying the invited address at sign-up, at which moment every live
invitation bound to it becomes a membership. An invitation therefore never
creates an account or a session; it turns an existing, proven identity into
a membership `[credentials-6]`. Acceptance is rate limited per client address
(`GC_ACCEPT_RATE`, in `accounts/ratelimit.py`, counting in the same Redis the
production profile insists on), every attempt is an `AuthEvent` with the
real reason, and the client sees one sentence for every refusal — "wrong
email" versus "no such token" is a way to learn who was invited. The raw
token is mailed to the invitee, once, with a link to the app's `/invite`
page, and appears in no response: an inviter who could read it back could
sign up as the invitee and accept it themselves. The same person presenting
a token they already used — the mailed link opened after verification
consumed it — is a double click, not an attack, and gets the membership.

**Entitlements** resolve as `{**plan.entitlements, **org.entitlement_overrides}`
over the keys in `tenants/plans.py`. Three plans are seeded:

| | free | team | enterprise |
|---|---|---|---|
| `suites.max` | 3 | 25 | unlimited |
| `runs.per_day` | 20 | 500 | unlimited |
| `origins.max` | 2 | 20 | unlimited |
| `vault.enabled` | no | yes | yes |
| `history.retention_days` | 7 | 90 | 365 |
| `members.max` | 1 | 10 | unlimited |
| `mfa.required` | no | no | yes |

Unlimited is `null`, not a sentinel. `entitlements_version` on the
organisation is bumped whenever the resolved answer could change — an
override edited, the plan switched, or the plan itself edited (which bumps
every organisation on it) — and rides in the token as `ent_v`, so the runner
can tell a downgrade from a token that simply has not expired yet. Only the
five keys the runner enforces go in the token; `members.max` is enforced
here (at issue and again at acceptance, since the plan may have shrunk in
between) and `mfa.required` is the MFA step's.

In the admin, `is_superuser` and `user_permissions` are read-only unless you
are a superuser: read-only fields are dropped from the form, so a posted
value is ignored rather than merely hidden `[authz-tenancy-6]`.

## The two credentials

```
   browser ──session cookie──► Django        HttpOnly. No JavaScript ever sees it.
      │
      │  POST /auth/executor-token
      ▼
   browser ──Bearer token────► the runner    ~10 minutes, held in memory only
```

The runner is never given the session cookie — in production the edge strips
the `Cookie` header from everything it routes to the runner. It is a different
service reached over a WebSocket, and a WebSocket cannot carry headers — so
the token does not go there either. The UI trades it, over a Bearer header,
for a thirty-second single-use **ticket** (`POST /api/socket-ticket` on the
runner) and opens the socket with that; a `?t=` token in a socket URL is
refused, because a URL is what logs and history keep.

`accounts/tokens.py` mints an **EdDSA** JWT over Ed25519 with the
`cryptography` package, and the runner verifies it with Node's `crypto`.
Neither side has a JWT dependency: signing is one signature over two
base64url segments, and the half that is genuinely easy to get wrong is
verification, which is written out explicitly in `../auth.js` — the algorithm
pinned, the key chosen by `kid` from the set the runner was started with, the
lifetime bounded. Because both sides implement the format independently, the
assertion that matters is a token crossing between them — that is in
`../scripts/check-auth.js`, not here.

The private key is `GC_SIGNING_KEY`, here and nowhere else; the runner is
given `GC_AUTH_PUBLIC_KEYS`, `{kid: pem}`, and can only verify. `manage.py
signing_key --new` makes a pair and prints both lines; without `--new` it
prints the public half of the key in use, which is also what `GET /auth/jwks`
answers. The `kid` is the RFC 7638 thumbprint of the public key, so it can be
recomputed from the public key alone. Rotation is: make a new pair, add its
public key to the runner's set beside the old one, restart the runner, switch
this service to the new private key, and drop the old public key once every
token signed with it has expired.

The claims (docs/AUTH.md §8): `iss` and `aud` name the two services; `sub`
and `email` the account; `org`, `role`, `ent` and `ent_v` the session's
selected organisation, the role from its `Membership` row, the
runner-enforced entitlements and their version; `amr` and `auth_time` the
methods actually used in this session and when, read from the list of
authentication events the sign-in receiver appends to the session; `su` —
"step-up valid until" — is `auth_time + 600` when the strongest factor the
account has was used at `auth_time`, which today is every password sign-in,
and `0` for a session with no recorded event, and the runner checks nothing
about it but `now < su` before it allows an origin; `sid` is a hash of the
session key; `iat`, `exp` (at most 600 seconds later — `GC_TOKEN_TTL` is
clamped to 60–600) and `jti`. Every one is copied from the database or the
session into the signature; the runner reads them from the token and from
nothing else.

## Tests

```bash
python manage.py test          # 273 tests, one module per concern in accounts/tests/ and tenants/tests/
```

They never touch the network: `accounts/testing.py` is the test runner, and it
stubs the Have I Been Pwned client so a test can say "three breaches" or "the
API is down" and assert what happens; the Turnstile verifier is patched the
same way, and mail goes to Django's in-memory outbox, where the tests read
the codes and links back out. The production-profile tests import the
settings module in a subprocess with a chosen environment, because the rules
they check are the ones that raise at import. `accounts/tests/support.py`
holds the client every signed-in test uses: it speaks allauth's JSON and
echoes the CSRF header the way the SPA does.

They also run as part of `npm run check:all` from the repository root, so
"everything is green" means one thing rather than two. They skip loudly if
Python or Django is missing, because this directory is optional.

## What is deliberately not here

- **Suites and run history.** They stay as JSON beside the runner. Moving them
  is a real project and is not what adding a login needed.
- **Enforcement of the organisation on the runner.** The token now says
  which organisation and role, and what the plan allows; the runner does not
  read those claims yet, so everyone who can sign in still drives the one
  shared browser and its one set of state. Partitioning `.ghostclick/` and
  `suites/` by organisation, the driving-org lock and the `402 entitlement`
  refusals are the runner-tenancy step of docs/AUTH.md.
- **Google sign-in and MFA.** The next two steps of docs/AUTH.md. Until MFA
  lands, `/auth/me` reports `mfa: {required: false, enrolled: false}` for
  everyone, the reauthentication that gates a change is the password, and
  "the strongest factor the account has" is the password. The settings those
  steps pin (`MFA_TRUST_ENABLED = False`, `MFA_TOTP_TOLERANCE = 0`) are
  already set so they are not forgotten.
- **A sessions page.** A password change or reset ends every session by
  walking the session table (`accounts/sessions.py`); listing them, and
  ending one, is allauth's usersessions app and comes with MFA.
- **Multi-tenancy on the runner.** The runner holds one browser and one run
  lock. Two people signed in still share it — a login says *who*, not *which
  runner*.
