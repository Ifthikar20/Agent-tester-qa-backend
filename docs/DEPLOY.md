# Deploying ghostclick to AWS

The goal of this first deploy is narrow and worth stating: **see the app
working on a real host**, signed in, driving a page. Not multi-user, not highly
available. Everything below is sized for that, and the places where it would
have to change for anything more are called out rather than glossed over.

Read the **Before anything** section first. ghostclick is not a CRUD app and
deploying it like one puts a browser you do not control inside your VPC.

---

## Before anything: what this thing actually is

ghostclick launches a real Chromium and drives it at URLs it is told to drive.
That makes three ordinary decisions load-bearing:

**1 · Authentication is not optional here.**
`GC_AUTH_SECRET` unset means the runner is open — the banner says so at every
boot. On a laptop that is correct. On a public IP it is an unauthenticated
service that will fetch any allowed URL on your behalf, from inside your VPC,
and stream the result back. The deploy refuses to start without it (see
`scripts/deploy.sh`), and that refusal is deliberate.

**2 · The origin allowlist is the blast radius.**
The runner will only navigate to origins someone has explicitly allowed, and
only a signed-in person can add one. `scripts/check.js` asserts that
`http://169.254.169.254/latest/meta-data/` is refused — the EC2 metadata
endpoint — and that assertion is a load-bearing part of this deployment, not a
curiosity. **Also set IMDSv2 to required on the instance**, so that even a hole
in the allowlist does not hand out instance credentials.

**3 · `POST /api/recording` is deliberately unauthenticated.**
The browser extension posts a recording from whatever page you were recording
on, so it has no session and no way to be handed a token. It validates through
the same origin gate and never executes anything — a human presses Run — but it
is still a reachable POST endpoint. For this deploy the edge answers it with a
403, because the extension is not part of what we are demonstrating.

**And one product limit, so nobody is surprised:** there is one browser and one
run lock per process. Two signed-in people share the same browser. A login says
*who*, not *which runner*. This is fine for a demo and is the thing that has to
change first for real multi-user use.

---

## The short version

From a laptop with the AWS CLI logged in:

```bash
bash scripts/aws-up.sh
```

It creates the key pair, security group, a t3.medium with an encrypted volume
and IMDSv2 required, and an Elastic IP; installs Docker; clones this repo;
generates every secret **on the box**, where they stay; builds; and does not
report success until five checks pass from outside the instance. It prints the
URL. Roughly ten minutes, almost all of it the first image build.

Then make yourself an account and sign in:

```bash
ssh -t -i ghostclick-deploy.pem ubuntu@<ip> \
  'cd /opt/ghostclick && ./scripts/gc exec control python manage.py createsuperuser'
```

`-t` because `createsuperuser` prompts: without a TTY `docker compose exec`
refuses the input device and you never reach the questions. For a test
account, or any account made by a script, there is a version that does not
ask — it generates a password and prints it once:

```bash
EC2_HOST=<ip> bash scripts/adduser.sh qa@example.com
```

`bash scripts/aws-down.sh` deletes all of it. About $35/month while it runs.

**`aws-up.sh` gives the box a bare IP and an `http://` URL**, because there is
no hostname yet and a certificate needs one. The app is gated — anonymous
requests to `/api/*` get 401 — but over http the session cookie and the
executor token cross the network in cleartext, and the deploy script says so
every time it runs. Pass `HTTP_CIDR=<ip>/32` to narrow it to one machine, and
read "Giving it a hostname" below: with DNS pointing at the box, changing
`PUBLIC_URL` to `https://that` is the whole of the TLS setup.

Everything below is what that script does, in case you want to do it by hand or
change a piece of it.

## Architecture

One EC2 host, Docker Compose, everything behind a single Caddy so the whole app
is **one origin** — which removes CORS, cross-site cookies and a build-time URL
from the problem entirely — and **two networks**, so the process that holds a
browser other people drive cannot reach the process that decides who they are.

```
                    you  ──►  https://<host>/      (or http://<ip>/ for a demo)
                                     │
                            ┌────────▼────────┐
                            │  caddy  :80 :443│  TLS, HSTS, routing, admin allowlist
                            └───┬──────────┬──┘
     /auth/* /_allauth/* /admin/*          │  everything else
     /accounts/google/login/callback/      │  (incl. the /ws upgrade)
     /static/* ── from a volume            │  Cookie header stripped
  ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─   network: edge
                 │                         │
      ┌──────────▼───┐                  ┌──▼─────────────────────────┐
      │ control      │                  │ runner                     │
      │ Django :8000 │                  │ node + playwright :3000    │
      │ gunicorn     │                  │ one Chromium, one run lock │
      └───┬──────┬───┘                  │ vol: .ghostclick           │
  ─ ─ ─ ─ │ ─ ─ ─│─ ─ ─   network: data └────────────────────────────┘
          │      │        (internal: no route out, and the runner is not on it)
   ┌──────▼───┐ ┌▼─────────┐
   │ postgres │ │ redis    │
   │ accounts │ │ rate     │
   │ sessions │ │ limits   │
   │ audit    │ └──────────┘
   └──────────┘
```

| | |
|---|---|
| **Host** | Ubuntu 24.04, **t3.medium** (see sizing below), 20 GB gp3 |
| **App dir** | `/opt/ghostclick` |
| **Orchestration** | `docker/docker-compose.prod.yml` |
| **Edge** | `caddy:2.10-alpine`, configured by `docker/Caddyfile` from `PUBLIC_URL` |
| **Runner image** | `mcr.microsoft.com/playwright:v1.63.0-noble` — the browser is already in it, and the tag must match the Playwright version in `package.json` |
| **Control plane** | `python:3.12-slim` + Django, behind gunicorn |
| **Stores** | `postgres:17-alpine` (scram-sha-256), `redis:7-alpine` (requirepass, nothing persisted) |
| **Env file** | `/opt/ghostclick/.env.prod` (never committed) |

Every container drops every Linux capability (`cap_drop: ALL`) and runs with
`no-new-privileges`. Caddy adds back the one it needs to bind 80 and 443.
Postgres and Redis run as their own users from the start so their entrypoints
never need root. The runner needs nothing: Playwright launches Chromium with
`--no-sandbox`, so there is no setuid helper to keep working.

### Sizing, and why not t3.small

Cansee runs on a t3.small. Do not put ghostclick on that box, and do not copy
that instance type:

- Chromium with a page open is 300–700 MB on its own, and it grows with the
  page under test.
- Node, the screencast pump and the JPEG encoding sit on top.
- **t3.small is 2 GB total.** Cansee already has Postgres, Redis, Celery,
  Django and two FastAPI sidecars on it. Adding a browser will OOM-kill
  something, and the thing the kernel picks will not be the browser.

**t3.medium (4 GB)** for this. Add a 2 GB swapfile anyway — the bootstrap
script does it — because an OOM kill mid-run looks exactly like a ghostclick
bug and will waste an afternoon. Postgres and Redis together are under 200 MB
here; the memory limits in the compose file are the ceilings, not the usage.

### The same PEM, a different instance

`cansee-deploy.pem` is a key **pair**. Launch the new instance with that same
key pair selected and the same PEM authenticates you to it. What you must not
do is deploy onto the Cansee host itself: its nginx already owns 80/443, and
the memory maths above does not work.

---

## What has to persist

Everything ghostclick remembers is gitignored, which is correct for a laptop
and a trap for a container. Four volumes, or every deploy silently resets:

| Volume | Holds | Lost without it |
|---|---|---|
| `ghostclick-state` | run history, the **origin allowlist**, the vault, the shared auth secret | Every allowed origin. Every run. And a regenerated secret, which logs everyone out and invalidates in-flight tokens. |
| `postgres-data` | the accounts, the sessions, the audit log | Every account. You would create a superuser on every deploy. |
| `caddy-data` | certificates and the ACME account key | A fresh certificate request per deploy, against a rate limit that will eventually say no. |
| `control-static` | Django's collected admin CSS | Nothing you would miss for long; it is rebuilt by `collectstatic`. |

Redis has no volume on purpose: it holds rate-limit counters, and a restart
that forgets them hands out a few extra attempts rather than losing anything.

Suites are the happy exception: `suites/*.json` is **in git**, so cases deploy
with the code and need no volume. That is the point of storing them there.

> **Upgrading a box that ran the SQLite version.** The control plane used to
> keep its accounts in a `control-db` volume. It now reads Postgres and refuses
> SQLite with `DJANGO_DEBUG=0`, so that volume is orphaned rather than migrated:
> there were never more than a handful of test accounts on a demo host, and
> `adduser` remakes them in seconds. If yours are worth keeping, before the
> deploy run `./scripts/gc exec -T control python manage.py dumpdata accounts.User
> > users.json` on the old stack and `loaddata` it into the new one. Then
> `docker volume rm ghostclick_control-db`.

---

## One URL, and everything derives from it

`PUBLIC_URL` is the only address anything is configured with, and it has to be
how you actually reach the box — exactly as you would type it in the browser.

| who reads it | as | for |
|---|---|---|
| the UI, **at build time** | `VITE_AUTH_URL` | where to sign in — its own origin |
| Caddy | the site address | which host to answer for; whether to get a certificate |
| Django | `GC_PUBLIC_URL` | `ALLOWED_HOSTS`, the CSRF origin, and whether cookies are `Secure` and `__Host-` prefixed |
| the runner | `GC_WEB_ORIGIN` | the origin allowed to call `/api` |

There used to be four values here that all had to agree with each other, and a
deployment where they did not failed with a 403 that read like a bug. Now they
cannot disagree, because there is one of them.

Two consequences worth knowing. Because `ALLOWED_HOSTS` is exactly the public
host, a `curl http://localhost/...` on the box is not a useful probe any more:
Caddy answers an empty page for a host it does not serve, and Django answers 400
for one it does not allow. `scripts/deploy.sh` sends every probe with the public
name pinned to `127.0.0.1` (`curl --resolve`), which is the request a browser
would make, certificate check included. And because the UI is baked with it,
changing `PUBLIC_URL` is a rebuild — the compose file passes it as a build
argument and the image is rebuilt when it changes.

### Giving it a hostname

1. Point a DNS name at the Elastic IP.
2. Open 443 in the security group to the same audience as 80 (`aws-up.sh` does
   both).
3. `PUBLIC_URL=https://that.name` in `.env.prod`, then `bash scripts/deploy.sh`.

Caddy asks Let's Encrypt for a certificate on first request, keeps it in the
`caddy-data` volume, and renews it. From then on: cookies are `Secure` and
`__Host-` prefixed, `Strict-Transport-Security` is sent for two years, and
port 80 only redirects. The deploy script's http warning stops printing, and
`manage.py check --deploy` stops having anything to say.

---

## First-time bootstrap

On a fresh instance, as `ubuntu`:

```bash
# from your laptop
scp -i cansee-deploy.pem scripts/bootstrap-ec2.sh ubuntu@<ip>:/tmp/
ssh -i cansee-deploy.pem ubuntu@<ip> 'bash /tmp/bootstrap-ec2.sh'
```

That installs Docker, adds the swapfile, creates `/opt/ghostclick`, and stops.
Then:

```bash
ssh -i cansee-deploy.pem ubuntu@<ip>
git clone <repo-url> /opt/ghostclick
cd /opt/ghostclick
cp .env.prod.example .env.prod
nano .env.prod          # see below — the URL and four secrets
```

`.env.prod` needs five values. Generate the secrets by RUNNING these and
pasting what they print — do not paste the commands themselves:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # GC_AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # DJANGO_SECRET_KEY
python3 -c "import secrets; print(secrets.token_urlsafe(24))"                     # POSTGRES_PASSWORD
python3 -c "import secrets; print(secrets.token_urlsafe(24))"                     # REDIS_PASSWORD
```

so that the file ends up holding literal values:

```bash
PUBLIC_URL=http://<elastic-ip>   # or https://<hostname> once you have one
GC_AUTH_SECRET=xQ7f...           # the OUTPUT of the first command
DJANGO_SECRET_KEY=9mKp...        # the OUTPUT of the second
POSTGRES_PASSWORD=Lk2a...        # URL-safe: letters, digits, - and _
REDIS_PASSWORD=p0Xn...
GC_ADMIN_CIDRS=<your-ip>/32      # or /admin/ is closed to everyone
```

> Compose reads `.env.prod` as data. It does no command substitution, so a
> `$(...)` written into the file becomes the signing key verbatim — long enough
> to pass every length check, identical on both services, so every token
> verifies and the deploy is entirely healthy with a key that is printed in
> this file. `scripts/deploy.sh` refuses a `.env.prod` containing `$(`.

The two store passwords are spliced into URLs (`postgres://ghostclick:PASS@…`),
which is why they have to be URL-safe: a `@` or `/` in one would be parsed as
part of the address, and the symptom would be "the database is unreachable".
The deploy refuses anything else.

Then bring it up and make yourself an account:

```bash
./scripts/gc up -d --build
./scripts/gc exec control \
  python manage.py createsuperuser
```

**No account is created for you.** A deploy script that invents an admin
password has put a login on a public host that nobody chose.

Making one *deliberately* without a prompt is a different thing, and it is
what a test that signs in on every run needs. `adduser` never takes the
password as an argument, because `ps` on this host shows every argument of
every process to every account on it:

```bash
./scripts/gc exec -T control python manage.py adduser qa@example.com
printf '%s' "$PASS" | ./scripts/gc exec -T control \
  python manage.py adduser qa@example.com --password-stdin
```

A chosen password has to be at least 15 characters, at most 128, not something
Have I Been Pwned has seen, and not your own email address. There are no
composition rules; a passphrase with spaces is fine.

Every account gets a personal organisation on the `free` plan the moment it
is made, and `migrate` gave one to every account that existed before the
rule. Plans and organisations are edited in `/admin/`; a database restored
from an older dump gets its missing organisations back with
`manage.py personal_orgs`, which does nothing when there is nothing to do.

---

## Deploying a change

From your laptop, with the PEM at the repo root:

```bash
EC2_HOST=<elastic-ip> bash scripts/deploy.sh
```

It SSHes in itself. What it does, in order:

1. **Refuses** a `.env.prod` that only looks filled in: a placeholder, an
   unexpanded `$(`, CRLF line endings, a duplicate key, no `GC_AUTH_SECRET`,
   a `DJANGO_ALLOWED_HOSTS` line (nothing reads it; `'*'` in particular),
   a `GC_TOKEN_TTL` outside 60–600, or a store password that is not URL-safe
2. **Warns**, loudly, when `PUBLIC_URL` is `http://`
3. Fetches and resets to the target commit
4. `docker compose up -d --build`
5. `manage.py migrate`, `collectstatic`, and `clearsessions` on the control
   plane — sessions are database rows, and expired ones are only ever removed
   by that command
6. Waits for the **browser**, not the port
7. Smoke-checks, through the edge with the public host: `/app/` is 200,
   `/api/state` is **401**, `/auth/csrf` is 200, `/healthz` is 200,
   `POST /api/recording` is 403, and `/admin/` is **403** from the box itself

That 401 is the interesting assertion. On this deploy a 401 from `/api/state`
is the **success** condition: it proves the gate is on. A 200 there would mean
the runner came up unauthenticated, and the script takes the stack down rather
than leave it up. The 403 on `/admin/` proves the allowlist is being applied —
the docker bridge is in nobody's `GC_ADMIN_CIDRS` — which is also why
`0.0.0.0/0` is not a value that variable takes.

---

## How we check it actually works

Three layers, cheapest first.

### 1 · From your laptop, no browser

```bash
curl -sI  https://<host>/app/            | head -1     # 200 — the UI loads
curl -s   https://<host>/api/state       -o /dev/null -w '%{http_code}\n'   # 401 — gated
curl -s   https://<host>/auth/csrf       | head -c 60                        # {"csrfToken": …
curl -sI  https://<host>/api/recording -X POST | head -1                     # 403 — closed at the edge
curl -sI  https://<host>/admin/          | head -1     # 403 unless you are in GC_ADMIN_CIDRS
curl -sI  https://<host>/ | grep -i strict-transport   # HSTS, on an https URL only
```

Use the `PUBLIC_URL` exactly; on an `http://<ip>` demo, the last line prints
nothing, and that is correct.

### 2 · The boot banner says what mode it is in

```bash
ssh -i cansee-deploy.pem ubuntu@<ip> \
  'cd /opt/ghostclick && ./scripts/gc logs runner | head -20'
```

Look for these two lines. If `auth` says OFF, stop and fix it before anything
else:

```
  serving     ->  /app/web/dist
  auth        ->  on — a token from the control plane is required
```

### 3 · The actual thing — drive a page

This is the test that matters, because it exercises the browser, the
screencast, the socket and the gate together.

1. Open the app at `PUBLIC_URL/app/` → you should be sent to the **sign-in
   screen**. (If you land on the console instead, auth is off.)
2. Sign in with the superuser you made.
3. You land on **Test suites**. Go to **Console**.
4. Paste `https://example.com` into the URL box and press **Open**.
5. It will refuse: `example.com is not allowed yet`, with an **Allow** button.
   **That refusal is the security model working** — take the moment to notice
   it, then press Allow.
6. The canvas paints the page. The **address bar above it** shows
   `example.com/`.
7. Click something on the canvas. The pink arrow moves and the page reacts —
   you are driving a browser on EC2 from your laptop.
8. Try a redirect: open `PUBLIC_URL/go/tracked`. The address bar should show
   the landing URL and a **`2 redirects`** chip that expands to the chain.

If all eight work, the deployment is good.

### 4 · Optional: the suite, on the host

```bash
./scripts/gc exec runner npm run check:all
```

20 checks, and slow — it drives real browsers. Worth doing once to prove the
host is sane, not on every deploy.

---

## What is verified, and what is not

Being straight about this, because a deployment guide that reads as tested and
is not is worse than one that admits the gap.

**Verified here:**

- `./scripts/gc config` parses, resolves every variable, declares the two
  networks with `data` internal, and puts every service on the side of the
  line it belongs on (`npm run check:deploy` asserts the same as text).
- The compose file **refuses to start without any of the five values** — that
  is not a comment, it is `${…:?}` and it fails the command.
- `docker/Caddyfile` is checked as text by `npm run check:deploy`: the
  `Cookie` strip on the runner route, the overwritten `X-Forwarded-*`, HSTS on
  https only, the exact control-plane prefixes, the admin allowlist and the
  `/api/recording` refusal each written **inside** the handle whose upstream
  it guards — Caddy re-sorts `handle` blocks, so a refusal that merely comes
  first in the file is not a refusal — and the `ticket` parameter deleted
  from the access log.
- Django's settings import under `DEBUG=0` with exactly the environment the
  compose file supplies, and refuse to import with anything that only looks
  safe: `'*'` in the hosts, an in-process cache, SQLite, SMTP with no host.
  Those refusals are tests (`auth/accounts/tests/test_profile.py`).
- The deploy script's refusals were run against good and bad `.env.prod`
  files, and the Django suite, `check:deploy`, `check:boundary` and
  `check:auth`'s runner half are green on this commit.

**Not verified, because there is no working Docker daemon in the environment
this was written in:**

- **The Caddyfile has not been through `caddy validate` here.** It is written
  against Caddy's documented syntax, but the first thing the deploy does after
  the refusals is have the caddy image validate it — before any build, so a
  mistake stops the deploy with Caddy's own message rather than a container
  in a restart loop. To check an edit by hand:
  `./scripts/gc run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile`.
- **The images have not been rebuilt and run together** after the move to
  Caddy, Postgres and Redis. Each piece is validated alone; the first run is
  the integration.
- Certificate issuance has not been exercised — it needs a public hostname.

So the first run is a build, not a deploy. Do it on your laptop, where the
output is in front of you:

```bash
docker build -t gc-runner .
docker build -t gc-control ./auth
docker run --rm -it gc-runner node -e "require('playwright').chromium.executablePath()"
```

That last line is the one that matters: it proves the image tag and the
Playwright version agree, which is the single most likely thing to be wrong.

## What `manage.py check --deploy` will say

With `PUBLIC_URL=https://…`: nothing. HSTS and the http→https redirect are the
edge's job and Django is told so (`SECURE_HSTS_SECONDS = 0`,
`SECURE_SSL_REDIRECT = False`), which clears W004 and W008; the cookies are
`Secure`, which clears W012 and W016.

With `PUBLIC_URL=http://<ip>`: W012 and W016, and they are correct — a `Secure`
cookie is simply not sent over http, so turning it on would sign you in and
keep you signed out. They clear the moment the URL becomes `https://`.

## Security group

The single cheapest control, and the one to get right:

| Direction | Port | Source | Why |
|---|---|---|---|
| Inbound | 22 | **your IP /32** | SSH |
| Inbound | 80 | your audience | the app on a bare IP; only a redirect and the ACME challenge once there is a hostname |
| Inbound | 443 | your audience | the app, once there is a hostname |
| Outbound | 443, 80 | `0.0.0.0/0` | the runner has to reach the sites under test; Caddy has to reach Let's Encrypt |

Postgres and Redis publish no ports and sit on an internal network; there is
nothing to open for them and nothing to close.

Also, on the instance: **IMDSv2 required**, with a hop limit of 1 so that a
container — the runner's Chromium in particular — cannot reach it at all.

```bash
aws ec2 modify-instance-metadata-options --instance-id <id> \
  --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled
```

---

## Common operations

From `/opt/ghostclick` on the host.

| Task | Command |
|---|---|
| Runner logs | `./scripts/gc logs -f runner` |
| Control plane logs (and the mail, on the console backend) | `./scripts/gc logs -f control` |
| Edge access log | `./scripts/gc logs -f caddy` |
| Restart the runner | `./scripts/gc restart runner` |
| Add an account, prompting | `... exec control python manage.py createsuperuser` |
| Add one without a prompt | `... exec -T control python manage.py adduser <email>` |
| Who has an account | `... exec -T control python manage.py adduser --list` |
| An account with no personal organisation (restored from an old dump) | `... exec -T control python manage.py personal_orgs` |
| Plans, organisations, members, invitations | `/admin/` → Organisations, from an allowed address |
| Who signed in, from where | `/admin/` → Auth events, from an allowed address |
| Which origins are allowed | `docker run --rm -v ghostclick_ghostclick-state:/s alpine cat /s/origins.json` |
| A database shell | `... exec postgres psql -U ghostclick` |
| Container status | `./scripts/gc ps` |
| Memory, when it feels slow | `docker stats --no-stream` |

## Rolling back

No blue/green. Compose swaps containers only once the new image builds, so a
failed build leaves the old one running.

```bash
EC2_HOST=<ip> bash scripts/deploy.sh rollback           # to the previous deploy
EC2_HOST=<ip> bash scripts/deploy.sh rollback <sha>     # to a specific commit
```

It records the sha it replaced before every deploy, resets to it, rebuilds and
re-runs the same smoke checks. Do not roll back by hand with
`git checkout <sha>`: that leaves a detached HEAD, and the next deploy's branch
lookup then resolves to the literal string `HEAD`.

Every volume survives a rollback. Migrations are forward-only: a rollback
across one leaves the newer tables in place, which Django ignores, and that is
fine until a migration ever changes a column — none does today.

---

## Deliberately not done

- **CI deploy on merge.** Cansee auto-deploys from `main`. This does not, and
  should not until there is a staging host — an auto-deploy that restarts the
  browser mid-run is a confusing failure.
- **Horizontal scale.** One browser, one run lock. Two instances behind a load
  balancer would give two people two different runners and a screencast that
  follows whichever they happened to land on. The fix is a runner pool with a
  session-affinity router, and it is a real project.
- **Backups.** The volumes are on one EBS volume with no snapshot schedule.
  Fine for a demo; take an EBS snapshot before anything you care about. When a
  backup does exist it should skip `django_session`: a session table in a
  backup is a set of live credentials in a backup.
- **Mail.** `.env.prod.example` names the console backend, so verification
  codes and reset links go to the control plane's log until an `EMAIL_HOST`
  is set. Nothing sends mail yet; the moment something does, set the host.

## Pre-deploy checklist

- [ ] `npm run check:all` green locally — exit code 0
- [ ] A **new** t3.medium instance, not the Cansee host
- [ ] Launched with the `cansee-deploy` key pair
- [ ] Security group: 22 to **your IP only**; 80 and 443 to your audience
- [ ] IMDSv2 required, hop limit 1
- [ ] `.env.prod` has real values for all five (48 random bytes, not a word)
- [ ] `PUBLIC_URL` matches how you will actually reach the box
- [ ] `GC_ADMIN_CIDRS` is your address, or you accept that `/admin/` is closed
- [ ] All four volumes declared in the compose file before the first `up`
