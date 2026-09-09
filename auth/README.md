# ghostclick — the control plane

Django, and it knows about exactly one thing: people.

It has never heard of a test case. It cannot reach the runner's suites, it holds
no secret values, and it has no opinion about which origins may be driven — the
executor owns all of that and re-checks it locally. That is deliberate: two
services with an opinion about the same rule is how a hard gate quietly becomes
advisory, and the gate here decides where a real browser is pointed.

The design it is being built towards is [docs/AUTH.md](../docs/AUTH.md). This
directory is at the **foundation** step of that document's build order: the
settings profile, hashing, the audit log, the session clocks, and the stores
and edge that the later steps stand on.

## Why Django

SSO. Everything below is ordinary email-and-password today, but `django-allauth`
slots in behind the same endpoints without a line changing on the runner side.
Plus the admin, which is why adding a colleague is a form rather than a script
someone has to write.

## Running it

```bash
pip install -r requirements.txt
cp .env.example .env                  # then set GC_AUTH_SECRET
export $(grep -v '^#' .env | xargs)

python manage.py migrate
python manage.py createsuperuser      # email is the login
python manage.py runserver 8000
```

Then point the UI at it and give the runner the same shared secret:

```bash
# in the repository root
GC_AUTH_SECRET=<the same value> npm start
VITE_AUTH_URL=http://localhost:8000 npm run build
```

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

`AuthEvent` is one row per sign-in, sign-out, refused password and expired
session, written by receivers on Django's own `user_logged_in`,
`user_logged_out` and `user_login_failed` signals — so a view that signs
someone in cannot forget to log it. Each row has the address **as the edge
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
| `GET /auth/me` | who am I |
| `POST /auth/executor-token` | a short-lived signed token the **runner** will accept |
| `/admin/` | Django's admin — where accounts are made; the edge admits it only from `GC_ADMIN_CIDRS` |

`/auth/login` returns a new `csrfToken` because Django rotates it on sign-in.
Without handing the new one back, the SPA's very next POST is a 403 — sign-in
appears to work and everything after it fails.

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
service reached over a WebSocket, and a WebSocket cannot carry headers — the
token ends up in a query string, which is precisely why it is minted
short-lived and why a cookie must never take its place there.

`accounts/tokens.py` mints an HS256 JWT using the standard library, and the
runner verifies it with Node's. Neither side has a JWT dependency: signing is
HMAC-SHA256 over two base64url segments, and the half that is genuinely easy to
get wrong is verification, which is written out explicitly in `../auth.js`.
Because both sides implement the format independently, the assertion that
matters is a token crossing between them — that is in
`../scripts/check-auth.js`, not here. (The move to Ed25519, where the runner
holds only public keys, is the token step of docs/AUTH.md and has not happened
yet: `GC_AUTH_SECRET` is still shared.)

## Tests

```bash
python manage.py test          # 67 tests, one module per concern in accounts/tests/
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
- **RBAC, organisations.** Everyone who can sign in can drive everything. The
  token carries a `scope` claim so there is somewhere to put this, and nothing
  reads it yet. Tenancy is the next step of docs/AUTH.md.
- **Rate limiting on `/auth/login`.** The cache it needs is here (Redis, and a
  refusal to run without one), and so are the numbers (`ACCOUNT_RATE_LIMITS`);
  the thing that reads them is allauth, which the accounts step installs.
- **Multi-tenancy on the runner.** The runner holds one browser and one run
  lock. Two people signed in still share it — a login says *who*, not *which
  runner*.
