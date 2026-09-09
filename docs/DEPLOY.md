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
`GC_AUTH_PUBLIC_KEYS` unset means the runner is open — the banner says so at
every boot. On a laptop that is correct. On a public IP it is an
unauthenticated service that will fetch any allowed URL on your behalf, from
inside your VPC, and stream the result back. The deploy refuses to start
without it (see `scripts/deploy.sh`), and that refusal is deliberate. The
runner holds the *public* half of an Ed25519 keypair and can only verify; the
private half (`GC_SIGNING_KEY`) reaches the control plane and nothing else, so
a runner that is taken over cannot mint. A `GC_AUTH_SECRET` — the old shared
HMAC secret — anywhere in the runner's environment stops it from booting.

**2 · The origin allowlist is the blast radius.**
The runner will only navigate to origins someone has explicitly allowed, and
only a signed-in person can add one. `scripts/check.js` asserts that
`http://169.254.169.254/latest/meta-data/` is refused — the EC2 metadata
endpoint — and that assertion is a load-bearing part of this deployment, not a
curiosity. **Also set IMDSv2 to required on the instance**, so that even a hole
in the allowlist does not hand out instance credentials.

**3 · `POST /api/recording` is under the gate like everything else.**
The browser extension posts a recording from whatever page you were recording
on, where it has no session — so its background worker asks the control plane
for a ten-minute executor token on the strength of the person's own session
and presents that to the runner (docs/AUTH.md §11). Only an extension whose
origin is listed in `GC_EXTENSION_ORIGINS` is handed one; with the variable
unset the recorder can only copy the flow to the clipboard. The runner answers
401 to anything else, validates what it is handed through the same origin gate
as the UI, and never executes it — a human presses Run.

**4 · The driven page cannot reach inward.** With auth on, every request the
browser makes is checked against the address it resolves to, and one bound for
loopback, RFC 1918, link-local (the instance metadata service included), a
bare compose hostname, `*.internal` or `*.local` is aborted. The compose
networks give the runner no route to the control plane or the stores anyway;
this is the check that holds when a page at an allowed origin tries. The
bundled demo pages are not served on a gated runner (`GC_DEMO=1` brings them
back), and its own origin is not seeded as drivable.

**And one product limit, so nobody is surprised:** there is one browser and one
run lock per process. Two signed-in people share the same browser. A login says
*who*, not *which runner*. This is fine for a demo and is the thing that has to
change first for real multi-user use.

---

## The short version

From a laptop with the AWS CLI logged in:

```bash
HTTP_CIDR=<your-ip>/32 bash scripts/aws-up.sh
```

`HTTP_CIDR` is who may reach the app on 80 and 443, and it has no default:
the default used to be the internet, and a browser that fetches URLs on your
behalf from inside your VPC is not something to publish by omission. Your own
address is the usual answer; `HTTP_CIDR=0.0.0.0/0` is accepted when typed on
purpose, and the script says what that means before it continues.

It creates the key pair, security group, a t3.medium with an encrypted volume
and IMDSv2 required (hop limit 1), and an Elastic IP; installs Docker; writes
the sudoers line the deploy user runs the stack through; clones this repo;
generates every secret **on the box**, into a root-owned `.env.prod`, where
they stay; builds; and does not report success until five checks pass from
outside the instance. It prints the URL. Roughly ten minutes, almost all of
it the first image build.

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
every time it runs. Read "Giving it a hostname" below: with DNS pointing at
the box, changing `PUBLIC_URL` to `https://that` is the whole of the TLS
setup.

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
| **Control plane** | `python:3.12-slim` + Django, behind gunicorn; every package installed with `--require-hashes` from `auth/requirements.txt` |
| **Scheduler** | the control image again, running `manage.py housekeeping`: `clearsessions` and `purge_auth_events` daily, `purge_unverified_emails` every five minutes |
| **Stores** | `postgres:17-alpine` (scram-sha-256), `redis:7-alpine` (requirepass, nothing persisted) |
| **Env file** | `/opt/ghostclick/.env.prod` (never committed; root-owned, 0600, read by compose under `sudo`) |

Every image that is pulled rather than built is pinned by **digest** as well
as by tag, in both Dockerfiles and the compose file: a tag is a name the
registry can point somewhere else tomorrow, a digest is the image that was
tested. To move one, `docker buildx imagetools inspect <image:tag>` prints the
new digest; `npm run check:deploy` fails on an unpinned one, and asserts that
CI runs inside the same Playwright image the runner is built from.

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
| `ghostclick-state` | run history, the **origin allowlist**, the vault — one directory per organisation, `.ghostclick/<org>/` | Every allowed origin. Every run. |
| `postgres-data` | the accounts, the sessions, the audit log | Every account. You would create a superuser on every deploy. |
| `caddy-data` | certificates and the ACME account key | A fresh certificate request per deploy, against a rate limit that will eventually say no. |
| `control-static` | Django's collected admin CSS | Nothing you would miss for long; it is rebuilt by `collectstatic`. |

Redis has no volume on purpose: it holds rate-limit counters, and a restart
that forgets them hands out a few extra attempts rather than losing anything.

Suites are the happy exception: `suites/<org>/*.json` is **in git**, so cases
deploy with the code and need no volume. That is the point of storing them
there. A suite belongs to the organisation whose directory it is in; a file
committed under `suites/local/` is the laptop's and no signed-in organisation
sees it.

> **Upgrading a box from before per-organisation state.** The first boot
> moves `.ghostclick/origins.json`, `runs.json` and `secrets.json` under
> `.ghostclick/local/`, and `suites/*.json` under `suites/local/`, and says
> so in the runner's banner (`migrated -> …`). Nothing is deleted. Those
> files were made by a runner with no login, which is what `local` means;
> an organisation that should have them gets a copy placed under its own
> directory by an operator, not by the code guessing.

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
| the runner | `GC_WEB_ORIGIN` | the origin allowed to call `/api`, and the only origin a socket is accepted from |

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

That installs Docker, adds the swapfile, creates `/opt/ghostclick`, writes
`/etc/sudoers.d/ghostclick`, and stops. It does **not** put you in the docker
group, on purpose (docs/AUTH.md §12): that group is root by another name and
nothing logs its use. Instead the sudoers file lets you run exactly
`scripts/gc` — the stack's own compose wrapper — as root, so every command
that reaches the daemon is in `auth.log` with who ran it, and lets the deploy
script read `.env.prod`'s key *names* through `sudo cat`:

```
ubuntu ALL=(root) NOPASSWD:SETENV: /opt/ghostclick/scripts/gc
ubuntu ALL=(root) NOPASSWD: /usr/bin/cat /opt/ghostclick/.env.prod
```

Then:

```bash
ssh -i cansee-deploy.pem ubuntu@<ip>
git clone <repo-url> /opt/ghostclick
cd /opt/ghostclick
sudo install -m 600 -o root -g root .env.prod.example .env.prod
sudoedit .env.prod      # see below — the URL, the keypair and three secrets
```

`.env.prod` is **root-owned and 0600**: it holds the signing key, compose reads
it as root (through `scripts/gc`), and nothing that runs as `ubuntu` — a shell,
a script, anything a mistake starts — can read it. The deploy refuses a file
owned by anyone else, and refuses to run at all from a user in the docker
group.

`.env.prod` needs seven values. The signing keypair and the second-factor
key come from two commands, run on your laptop in `auth/` (they need Django
and `cryptography` installed — `pip install -r auth/requirements.txt`),
which print the lines ready to paste, quotes included:

```bash
cd auth && python manage.py signing_key --new     # GC_SIGNING_KEY and GC_AUTH_PUBLIC_KEYS
cd auth && python manage.py mfa_key               # GC_MFA_KEY — authenticator secrets are encrypted with it
```

Generate the other secrets by RUNNING these and pasting what they print — do
not paste the commands themselves:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # DJANGO_SECRET_KEY
python -c "import secrets; print(secrets.token_urlsafe(24))"                      # POSTGRES_PASSWORD
python -c "import secrets; print(secrets.token_urlsafe(24))"                      # REDIS_PASSWORD
```

so that the file ends up holding literal values:

```bash
PUBLIC_URL=http://<elastic-ip>   # or https://<hostname> once you have one
GC_SIGNING_KEY='-----BEGIN PRIVATE KEY-----\nMC4C...\n-----END PRIVATE KEY-----'   # as printed, one line
GC_AUTH_PUBLIC_KEYS='{"<kid>": "-----BEGIN PUBLIC KEY-----\nMCow...\n-----END PUBLIC KEY-----\n"}'
GC_MFA_KEY=Zk9v...=              # as printed by mfa_key: 44 characters ending in =
DJANGO_SECRET_KEY=9mKp...        # the OUTPUT of the first node command
POSTGRES_PASSWORD=Lk2a...        # URL-safe: letters, digits, - and _
REDIS_PASSWORD=p0Xn...
GC_ADMIN_CIDRS=<your-ip>/32      # or /admin/ is closed to everyone
```

The PEMs are on one line with `\n` where the line breaks were, and the single
quotes keep those literal; both services turn them back into newlines. No
Python on the box? `scripts/aws-up.sh` makes the same keypair with `openssl`,
and its `kid` the same way — the RFC 7638 thumbprint of the public key — so the
two halves still name each other.

> Compose reads `.env.prod` as data. It does no command substitution, so a
> `$(...)` written into the file becomes the value verbatim. With the old
> shared secret that produced a deploy that was entirely healthy with a key
> printed in this file; with a PEM it produces a control plane that refuses to
> start. `scripts/deploy.sh` refuses a `.env.prod` containing `$(` either way.

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
composition rules; a passphrase with spaces is fine. Have I Been Pwned is
asked again at every sign-in: a password that has been breached since it was
set gets one page — change it — and nothing else until it does.

Everyone else arrives through sign-up (docs/AUTH.md §4), and who may is
`.env.prod`'s decision:

| `GC_SIGNUP_MODE` | who gets an account |
|---|---|
| `invite` (unset) | an address holding a live invitation, issued from the app by an organisation's owner or admin and mailed to the invitee; the membership appears the moment the address is verified |
| `open` | anyone — put `GC_TURNSTILE_SITE_KEY` / `GC_TURNSTILE_SECRET` in front of it |
| `domain` | exactly the domains in `GC_SIGNUP_DOMAINS` |

Every sign-up verifies its address with a six-digit code before it can do
anything, which means the mail backend has to deliver: with the console
backend the codes are in `./scripts/gc logs control`, which is a demo and
not a product. The same goes for password resets and the notices every
change sends — set `EMAIL_HOST` before anyone but you signs in.

`/admin/` has no login form of its own any more: it sends you to the app's
sign-in and comes back once you are a staff session, so staff go through the
same rate limits and verification as everyone else.

### Sign in with Google

Optional, and off until `.env.prod` has both `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` (docs/AUTH.md §6). Make an OAuth client in the Google
Cloud console — APIs & Services → Credentials → OAuth client ID, type "Web
application" — with the authorised redirect URI set to exactly

```
<PUBLIC_URL>/accounts/google/login/callback/
```

and `PUBLIC_URL` as the authorised JavaScript origin. That path is the only
thing under `/accounts/` the edge routes and the only thing the control plane
mounts there: the sign-in is started by a CSRF-protected POST under
`/_allauth/`, a `GET` can never start one, and Google's One Tap endpoint does
not exist in this deployment. Then `bash scripts/deploy.sh`; the button
appears on the sign-in and sign-up pages and "Connect a Google account" under
Security.

What it does and does not do: a Google identity is one factor, never two. Who
may make an account through it is still `GC_SIGNUP_MODE` — in `domain` mode
the Google Workspace (`hd` in the id_token) must match, and a consumer Google
account with a matching address is refused. A Google sign-in opens an
existing account only when Google says the address is verified, the account's
own address is verified, and no other Google identity is attached; otherwise
the person is told, in one sentence for every reason, to sign in the usual
way and connect Google from Security. No Google tokens are stored. An account
made through Google has no password, and `/auth/me` says `mfa.required` for
it; the MFA step turns that into a demand to enrol.

Every five minutes the `scheduler` service runs `manage.py
purge_unverified_emails`, which removes unverified secondary addresses older
than fifteen minutes — a claim on an address that was never proven — and once
a day it runs `clearsessions` and `purge_auth_events` (audit rows older than
ninety days). All three are `manage.py housekeeping`'s; see "Housekeeping"
below.

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

1. **Refuses** to run from a deploy user in the docker group, or with a
   `.env.prod` that is not `root:600` — and then a `.env.prod` that only
   looks filled in: a placeholder, an unexpanded `$(`, CRLF line endings, a
   duplicate key, no PEM in `GC_SIGNING_KEY`, no public key in
   `GC_AUTH_PUBLIC_KEYS` (or a private one there), a leftover
   `GC_AUTH_SECRET` line, a `DJANGO_ALLOWED_HOSTS` line (nothing reads it;
   `'*'` in particular), a `GC_TOKEN_TTL` outside 60–600, or a store password
   that is not URL-safe. It reads the file's *shape* through `sudo cat`;
   no value leaves the box.
2. **Refuses** a box where IMDSv1 is still enabled (an untokened GET of the
   metadata service answering 200); off EC2 there is no metadata service
   and the check says so and moves on
3. **Warns**, loudly, when `PUBLIC_URL` is `http://`
4. Fetches and resets to the target commit
5. `docker compose up -d --build`, through `scripts/gc` and so under `sudo`
6. **Proves the IMDS hop limit** from inside the runner container: a `PUT`
   for a metadata token must fail one NAT hop away. If it succeeds, the driven
   Chromium can read instance credentials, and the script takes the stack
   down rather than leave it up
7. `manage.py migrate`, `collectstatic`, `clearsessions` and
   `purge_auth_events` on the control plane — the scheduler runs the last two
   daily, and after a deploy is the one moment guaranteed to come round
8. Waits for the **browser**, not the port
9. Smoke-checks, through the edge with the public host: `/app/` is 200,
   `/api/state` is **401**, `/auth/csrf` is 200, `/healthz` is 200,
   `POST /api/recording` is **401**, and `/admin/` is **403** from the box
   itself

The 401s are the interesting assertions. On this deploy a 401 from
`/api/state` is the **success** condition: it proves the gate is on. A 200
there would mean the runner came up unauthenticated, and the script takes the
stack down rather than leave it up. The 401 on `POST /api/recording` proves
the extension hand-off is behind the same gate (a 403 would be the edge's old
refusal back, which the extension can never get past). The 403 on `/admin/`
proves the allowlist is being applied — the docker bridge is in nobody's
`GC_ADMIN_CIDRS` — which is also why `0.0.0.0/0` is not a value that variable
takes.

---

## How we check it actually works

Three layers, cheapest first.

### 1 · From your laptop, no browser

```bash
curl -sI  https://<host>/app/            | head -1     # 200 — the UI loads
curl -s   https://<host>/api/state       -o /dev/null -w '%{http_code}\n'   # 401 — gated
curl -s   https://<host>/auth/csrf       | head -c 60                        # {"csrfToken": …
curl -s   https://<host>/_allauth/browser/v1/auth/session | head -c 60      # {"status": 401, … — allauth is mounted
curl -sI  https://<host>/api/recording -X POST | head -1                     # 401 — gated by the runner
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
  auth        ->  on — an EdDSA token from the control plane is required; keys: <kid>
  extension   ->  no origin listed in GC_EXTENSION_ORIGINS — the recorder cannot hand off to this runner
  reach       ->  the driven page cannot reach loopback, private or link-local addresses
  demo        ->  not served — GC_DEMO=1 serves them behind the gate
```

The kid after `keys:` is the one `./scripts/gc exec control python manage.py
signing_key` prints for the control plane's key. If they differ, every token
is "unknown key" and it reads as a broken login.

### 3 · The actual thing — drive a page

This is the test that matters, because it exercises the browser, the
screencast, the socket and the gate together.

1. Open the app at `PUBLIC_URL/app/` → you should be sent to the **sign-in
   screen**. (If you land on the console instead, auth is off.)
2. Sign in with the superuser you made. The first sign-in of an account made
   with `createsuperuser` asks for a six-digit code, because the address has
   not been proven yet; on the console mail backend the code is in
   `./scripts/gc logs control`. An `adduser` account skips this — an operator
   typing the address is the proof.
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
- `auth/requirements.txt` — every package pinned and hashed — resolves for
  the image's platform: `pip install --dry-run --require-hashes` against
  `manylinux`/`cp312` accepts every file it names. The digests in both
  Dockerfiles and the compose file are the ones the registries answered for
  those tags on the day.

**Not verified, because there is no working Docker daemon in the environment
this was written in:**

- **Neither image has been built with the hashed install and the digest
  pins**; CI's `images` job is what does that on every push, and its
  `supply-chain` job runs `pip-audit` and `npm audit` against the same sets.
- **The sudoers path has not been walked on a real host**: `scripts/gc`
  re-executing itself under `sudo -n` with `GC_GIT_SHA` carried through
  `SETENV`, and the deploy reading a root-owned `.env.prod` through `sudo
  cat`. Both are written against sudo's documented behaviour and checked as
  text; the first deploy on a fresh box is the test, and every refusal names
  what to fix.
- **The IMDS hop-limit proof** (a `PUT` for a metadata token from inside the
  runner container) has been reasoned through, not run: a container on a
  bridge network is one NAT hop from the host, and a response with a hop
  limit of 1 does not survive it.

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
`aws-up.sh` sets it at launch and re-asserts it on a reused instance, and
`scripts/deploy.sh` **refuses** a box where it is not so: an untokened GET of
the metadata service answering 200 stops the deploy before the build, and a
`PUT` for a token that succeeds from inside the runner container takes the
stack down after it. For a box made by hand:

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
| Who signed in, from where, who signed up, what changed | `/admin/` → Auth events, from an allowed address |
| Which old address may still reset which account this week | `/admin/` → Previous emails |
| Let an address sign up | the owner or admin of an organisation invites it from the app; or `GC_SIGNUP_MODE=open` / `domain` in `.env.prod` |
| Which Google identity opens which account | `/admin/` → Social accounts, from an allowed address |
| What the scheduler has been doing | `./scripts/gc logs -f scheduler` |
| Run every housekeeping task now | `... exec -T control python manage.py housekeeping --once` |
| Remove stale unverified address claims by hand | `... exec -T control python manage.py purge_unverified_emails` |
| Remove audit rows older than ninety days by hand | `... exec -T control python manage.py purge_auth_events [--dry-run]` |
| Which origins an organisation allows | `sudo docker run --rm -v ghostclick_ghostclick-state:/s alpine cat /s/<org>/origins.json` |
| A database shell | `... exec postgres psql -U ghostclick` |
| Container status | `./scripts/gc ps` |
| Memory, when it feels slow | `sudo docker stats --no-stream` |

`...` is `./scripts/gc`, which runs compose as root through the sudoers line;
the two `docker` commands above go through `sudo` for the same reason, since
the deploy user is not in the docker group.

## Housekeeping

Three things decay unless a command runs (docs/AUTH.md §1, §6.6, §12):
expired sessions are rows that only `clearsessions` removes, an unverified
address claim is stale after fifteen minutes, and audit rows past ninety days
are a liability rather than a record. The `scheduler` service in the compose
file is the control image running `manage.py housekeeping`, which does

| task | every |
|---|---|
| `purge_unverified_emails` | 5 minutes |
| `clearsessions` | 24 hours |
| `purge_auth_events` (rows older than 90 days) | 24 hours |

with the control plane's own environment, on the `data` network only, and
logs each run to `./scripts/gc logs scheduler`. A task that fails — the
database restarting, say — is logged and tried again at its next period; one
bad tick never stops the others. The deploy also runs `clearsessions` and
`purge_auth_events` after every migrate, so a box that is redeployed often
never waits on the loop.

Would you rather use the host's cron? Every task is idempotent, so run them
all every five minutes and let the loop's periods go:

```
*/5 * * * * cd /opt/ghostclick && ./scripts/gc exec -T control python manage.py housekeeping --once >> /var/log/ghostclick-housekeeping.log 2>&1
```

— in **root's** crontab (`sudo crontab -e`), since `scripts/gc` needs the
daemon. Then remove the `scheduler` service, or leave it; the two do not
conflict.

## Backups

The volumes are on one EBS volume with no snapshot schedule; take an EBS
snapshot before anything you care about. For a backup that can be restored
somewhere else, three things, and one of them is deliberately not a table:

1. **The database, minus the sessions.** A session table in a backup is a set
   of live credentials in a backup [ops-supply-2]. Skip both session tables'
   data — the schema stays, so a restore does not need them recreated:

   ```bash
   ./scripts/gc exec -T postgres pg_dump -U ghostclick -d ghostclick \
       --exclude-table-data=django_session \
       --exclude-table-data=usersessions_usersession \
     | gzip | age -r <your-age-recipient> > ghostclick-$(date +%F).sql.gz.age
   ```

   Encrypted before it touches disk: the dump holds password hashes, the
   audit log with every address, and the authenticator table. That last one
   is safe to keep *because* its secrets are ciphertext under `GC_MFA_KEY` —
   which is why the next item exists. `age` (`apt install age`) or `gpg
   --symmetric` both do; a dump with neither is a dump that must not leave
   the box. Restore with `age -d … | gunzip | ./scripts/gc exec -T postgres
   psql -U ghostclick -d ghostclick` into an empty database, then run
   `manage.py migrate` and, if the dump predates organisations,
   `personal_orgs`.

2. **`.env.prod`, separately, and to somewhere else.** It holds
   `GC_SIGNING_KEY`, `GC_MFA_KEY` and `DJANGO_SECRET_KEY`. Losing the MFA key
   makes every enrolled second factor unreadable (people re-enrol; nothing
   else breaks); losing the signing key means `signing_key --new` and a
   runner restart. Copy it with `sudo cat .env.prod | age -r … > env.age` —
   it is root-owned — and keep it apart from the database dump, because the
   whole point of a separate key is that the two are two things to steal.

3. **The runner's state**, one directory per organisation: the origin
   allowlists, the vaults, the run history.

   ```bash
   sudo docker run --rm -v ghostclick_ghostclick-state:/s alpine tar czf - -C /s . \
     | age -r … > ghostclick-state-$(date +%F).tgz.age
   ```

   Encrypted for the same reason: `<org>/secrets.json` is every vault value
   in the clear.

Suites are in git and need nothing. Certificates (`caddy-data`) are
re-requested on a fresh box; keep the volume if you can, because Let's
Encrypt rate-limits asking.

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
- **A backup schedule.** The commands are under "Backups" above; nothing
  runs them for you, and the volumes are on one EBS volume with no snapshot
  schedule.
- **Passkeys on an `http://ip` demo.** WebAuthn needs a secure origin, and
  fido2 refuses an http origin other than localhost, so passkeys work only
  once `PUBLIC_URL` is `https://`. The authenticator app and recovery codes
  work either way, so the policy can still be met on a demo.
- **Mail.** `.env.prod.example` names the console backend, so verification
  codes, invitations, reset links and change notices go to the control
  plane's log until an `EMAIL_HOST` is set. Everything that makes or changes
  an account sends mail now, so that is a demo setting and nothing more.
- **Turnstile by default.** The keys are optional because a demo has no
  Cloudflare account; with `GC_SIGNUP_MODE=open` on a public host they are
  not optional in any sense that matters.
- **Verifying the Google console side.** The flow is tested end to end with
  Google stubbed at the token exchange; the redirect URI registered in the
  console has to be the exact path above, with the trailing slash, and the
  first real sign-in is the test of that.
- **Key rotation on a schedule.** `signing_key --new`, add the new public key
  to `GC_AUTH_PUBLIC_KEYS` beside the old one, restart the runner, switch
  `GC_SIGNING_KEY`, restart the control plane, and drop the old public key
  after fifteen minutes. Every mint is in the audit log with its `jti`, so a
  token that was never minted is detectable. Nothing does this for you yet.

## Pre-deploy checklist

- [ ] `npm run check:all` green locally — exit code 0
- [ ] A **new** t3.medium instance, not the Cansee host
- [ ] Launched with the `cansee-deploy` key pair
- [ ] Security group: 22 to **your IP only**; 80 and 443 to your audience (`HTTP_CIDR`, typed, never defaulted)
- [ ] IMDSv2 required, hop limit 1 — the deploy refuses otherwise
- [ ] `/etc/sudoers.d/ghostclick` written (bootstrap-ec2.sh or aws-up.sh), and the deploy user **not** in the docker group
- [ ] `.env.prod` is `root:600`, and has real values for all seven — the keypair from `signing_key --new`, `GC_MFA_KEY` from `mfa_key`, 48 random bytes for the rest
- [ ] If the recorder extension will hand off to this box: its `chrome-extension://<id>` in `GC_EXTENSION_ORIGINS`
- [ ] The first staff sign-in will be sent to enrol an authenticator before `/admin/` opens; have a phone with a TOTP app to hand
- [ ] `GC_AUTH_PUBLIC_KEYS` holds the public key and `GC_SIGNING_KEY` the private one, not the other way round
- [ ] `PUBLIC_URL` matches how you will actually reach the box
- [ ] `GC_ADMIN_CIDRS` is your address, or you accept that `/admin/` is closed
- [ ] `GC_SIGNUP_MODE` is what you mean — unset is invitation-only — and open mode has Turnstile keys
- [ ] `EMAIL_HOST` is set, or you accept reading sign-up codes out of the control plane's log
- [ ] If Google is wanted: both `GOOGLE_*` values, and the console's redirect URI is `<PUBLIC_URL>/accounts/google/login/callback/`
- [ ] All four volumes declared in the compose file before the first `up`
