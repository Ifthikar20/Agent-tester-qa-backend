# ghostclick — the control plane

Django, and it knows about exactly one thing: people.

It has never heard of a test case. It cannot reach the runner's suites, it holds
no secret values, and it has no opinion about which origins may be driven — the
executor owns all of that and re-checks it locally. That is deliberate: two
services with an opinion about the same rule is how a hard gate quietly becomes
advisory, and the gate here decides where a real browser is pointed.

## Why Django

SSO. Everything below is ordinary email-and-password today, but `django-allauth`
or `djangosaml2` slot in behind the same four endpoints without a line changing
on the runner side. Plus the admin, which is why adding a colleague is a form
rather than a script someone has to write.

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
| `/admin/` | Django's admin — where accounts are made |

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

The runner is never given the session cookie. It is a different service on a
different origin reached over a WebSocket, and a WebSocket cannot carry headers
— the token ends up in a query string, which is precisely why it is minted
short-lived and why a cookie must never take its place there.

`accounts/tokens.py` mints an HS256 JWT using the standard library, and the
runner verifies it with Node's. Neither side has a JWT dependency: signing is
HMAC-SHA256 over two base64url segments, and the half that is genuinely easy to
get wrong is verification, which is written out explicitly in `../auth.js`.
Because both sides implement the format independently, the assertion that
matters is a token crossing between them — that is in
`../scripts/check-auth.js`, not here.

## Tests

```bash
python manage.py test          # 27 tests
```

They also run as part of `npm run check:all` from the repository root, so
"everything is green" means one thing rather than two. They skip loudly if
Python or Django is missing, because this directory is optional.

## What is deliberately not here

- **Suites and run history.** They stay as JSON beside the runner. Moving them
  is a real project and is not what adding a login needed.
- **RBAC.** Everyone who can sign in can drive everything. The token carries a
  `scope` claim so there is somewhere to put this, and nothing reads it yet.
- **Rate limiting on `/auth/login`.** Worth having before this is exposed to a
  network you do not control.
- **Multi-tenancy.** The runner holds one browser and one run lock. Two people
  signed in still share it — a login says *who*, not *which runner*.
