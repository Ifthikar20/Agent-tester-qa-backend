# ghostclick — the control plane

Django, and it knows about exactly one thing: people.

It has never heard of a test case. It cannot reach the runner's suites, it holds
no secret values, and it has no opinion about which origins may be driven — the
executor owns all of that and re-checks it locally. That is deliberate: two
services with an opinion about the same rule is how a hard gate quietly becomes
advisory, and the gate here decides where a real browser is pointed.

The design it is being built towards is [docs/AUTH.md](../docs/AUTH.md). This
directory is at the **token-runner** step of that document's build order: the
foundation (settings profile, hashing, the audit log, the session clocks, the
stores and edge), organisations, roles, invitations and entitlements (the
control-plane half of §10), and now the Ed25519 executor token, its claims and
its audit row (§8). The runner verifies with public keys only, opens its
socket for a ticket rather than a token, and enforces step-up on allowing an
origin; it does not partition its state by organisation yet — that is the
runner-tenancy step.

## Why Django

SSO. Everything below is ordinary email-and-password today, but `django-allauth`
slots in behind the same endpoints without a line changing on the runner side.
Plus the admin, which is why adding a colleague is a form rather than a script
someone has to write.

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
the keypair in `.ghostclick/`.

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
the admin form and for `adduser --password-stdin`, so there is one definition
of an acceptable password rather than three.

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
session and **minted token** (with the token's `jti`, so a token that never
appears here was not minted here), written by receivers on Django's own
`user_logged_in`, `user_logged_out` and `user_login_failed` signals and by
the mint view — so a view that signs someone in cannot forget to log it. Each row has the address **as the edge
reports it** (`accounts.events.client_ip`, the same arithmetic allauth uses
for its rate limits, with `ALLAUTH_TRUSTED_PROXY_COUNT = 1` behind Caddy and
`0` on a laptop), the user agent, and for a refusal the email as typed. It is
readable in `/admin/` and not editable there.

## Making an account

Two ways, and the difference is who chooses the password.

```bash
python manage.py createsuperuser              # it asks; use this for a person
python manage.py adduser qa@example.com       # it generates one and prints it once
```

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

## The surface

| | |
|---|---|
| `GET /auth/csrf` | a CSRF token the SPA echoes in `X-CSRFToken` |
| `POST /auth/login` | email + password → a session cookie, and the rotated CSRF token |
| `POST /auth/logout` | |
| `GET /auth/me` | who am I, and for which organisation |
| `POST /auth/org` | `{org}` — act for another organisation this session, after a membership check |
| `GET /auth/invitations` | the selected organisation's invitations (owner or admin) |
| `POST /auth/invitations` | `{email, role}` — issue one; the token is in the answer, once |
| `DELETE /auth/invitations/<id>` | revoke one |
| `POST /auth/invitations/accept` | `{token}` — become a member, signed in as the invited address |
| `POST /auth/executor-token` | a short-lived signed token the **runner** will accept; 12 per 10 minutes per session |
| `GET /auth/jwks` | the public key the tokens verify with, for humans and tooling — the runner never fetches it |
| `/admin/` | Django's admin — where accounts, plans and organisations are managed; the edge admits it only from `GC_ADMIN_CIDRS` |

`/auth/login` returns a new `csrfToken` because Django rotates it on sign-in.
Without handing the new one back, the SPA's very next POST is a 403 — sign-in
appears to work and everything after it fails. It also returns everything
`/auth/me` would, so the SPA does not need a second round trip:

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
by a signed-in user holding that address. An invitation therefore never
creates an account or a session; it turns an existing identity into a
membership `[credentials-6]`. Acceptance is rate limited per client address
(`GC_ACCEPT_RATE`, in `accounts/ratelimit.py`, counting in the same Redis the
production profile insists on), every attempt is an `AuthEvent` with the
real reason, and the client sees one sentence for every refusal — "wrong
email" versus "no such token" is a way to learn who was invited. The raw
token is returned once to the inviter; mailing it is the accounts step's.

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
python manage.py test          # 187 tests, one module per concern in accounts/tests/ and tenants/tests/
```

They never touch the network: `accounts/testing.py` is the test runner, and it
stubs the Have I Been Pwned client so a test can say "three breaches" or "the
API is down" and assert what happens. The production-profile tests import the
settings module in a subprocess with a chosen environment, because the rules
they check are the ones that raise at import.

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
- **Mailing an invitation.** `POST /auth/invitations` hands the token back to
  the inviter once; the accounts step, which brings the mail templates and the
  invite-mode sign-up, sends it. Until allauth's `EmailAddress` table exists,
  "signed in as the invited address" is the check and "verified" is taken on
  the operator's word, because every account was made by one.
- **Rate limiting on `/auth/login`.** The cache it needs is here (Redis, and a
  refusal to run without one), and so are the numbers (`ACCOUNT_RATE_LIMITS`);
  the thing that reads them is allauth, which the accounts step installs.
- **Multi-tenancy on the runner.** The runner holds one browser and one run
  lock. Two people signed in still share it — a login says *who*, not *which
  runner*.
