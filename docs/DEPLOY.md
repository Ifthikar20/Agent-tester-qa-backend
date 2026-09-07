# Deploying ghostclick to AWS

The goal of this first deploy is narrow and worth stating: **see the app
working on a real host**, signed in, driving a page. Not production, not
multi-user, not highly available. Everything below is sized for that, and the
places where it would have to change for anything more are called out rather
than glossed over.

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
is still a reachable POST endpoint. For this deploy nginx blocks it, because
the extension is not part of what we are demonstrating.

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
generates both secrets **on the box**, where they stay; builds; and does not
report success until five checks pass from outside the instance. It prints the
URL. Roughly ten minutes, almost all of it the first image build.

Then make yourself an account and sign in:

```bash
ssh -i ghostclick-deploy.pem ubuntu@<ip> \
  'cd /opt/ghostclick && ./scripts/gc exec control python manage.py createsuperuser'
```

`bash scripts/aws-down.sh` deletes all of it. About $35/month while it runs.

**Port 80 is open to the world by default**, because the point is to open it on
another machine. The app is gated — anonymous requests to `/api/*` get 401 —
but there is no TLS yet, so the session cookie and the executor token cross the
network in cleartext. Pass `HTTP_CIDR=<ip>/32` to narrow it to one machine, and
read "Where this goes next" before treating any of this as permanent.

Everything below is what that script does, in case you want to do it by hand or
change a piece of it.

## Architecture

One EC2 host, Docker Compose, everything behind a single nginx so the whole app
is **one origin** — which removes CORS, cross-site cookies and a build-time URL
from the problem entirely.

```
                    you  ──►  http://<elastic-ip>/
                                     │
                            ┌────────▼────────┐
                            │  nginx  :80     │
                            └───┬──────────┬──┘
              /auth/ /admin/ /static/      │  everything else
                                │          │  (incl. the /ws upgrade)
                     ┌──────────▼───┐   ┌──▼─────────────────────────┐
                     │ control      │   │ runner                     │
                     │ Django :8000 │   │ node + playwright :3000    │
                     │              │   │ one Chromium, one run lock │
                     │ vol: db      │   │ vol: .ghostclick           │
                     └──────────────┘   └────────────────────────────┘
```

| | |
|---|---|
| **Host** | Ubuntu 24.04, **t3.medium** (see sizing below), 20 GB gp3 |
| **App dir** | `/opt/ghostclick` |
| **Orchestration** | `docker/docker-compose.prod.yml` |
| **Runner image** | `mcr.microsoft.com/playwright:v1.63.0-noble` — the browser is already in it, and the tag must match the Playwright version in `package.json` |
| **Control plane** | `python:3.12-slim` + Django, SQLite |
| **Env file** | `/opt/ghostclick/.env.prod` (never committed) |
| **Edge** | none for now — port 80, security group locked to your IP |

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
bug and will waste an afternoon.

### The same PEM, a different instance

`cansee-deploy.pem` is a key **pair**. Launch the new instance with that same
key pair selected and the same PEM authenticates you to it. What you must not
do is deploy onto the Cansee host itself: its nginx already owns 80/443, and
the memory maths above does not work.

---

## What has to persist

Everything ghostclick remembers is gitignored, which is correct for a laptop
and a trap for a container. Two volumes, or every deploy silently resets:

| Path | Holds | Lost without a volume |
|---|---|---|
| `/opt/ghostclick/.ghostclick` | run history, the **origin allowlist**, the vault, the shared auth secret | Every allowed origin. Every run. And a regenerated secret, which logs everyone out and invalidates in-flight tokens. |
| `/opt/ghostclick/auth-db` | the accounts database | Every account. You would create a superuser on every deploy. |

Suites are the happy exception: `suites/*.json` is **in git**, so cases deploy
with the code and need no volume. That is the point of storing them there.

---

## The one-origin trick

Because nginx fronts both services, the app is a single origin and the
configuration collapses:

```
VITE_AUTH_URL = http://<elastic-ip>     ← the UI signs in at its own origin
GC_WEB_ORIGIN = http://<elastic-ip>     ← Django trusts it for CSRF
```

Same value, and no CORS preflight ever happens because nothing is cross-origin.
Set them to the eventual hostname if you put DNS in front; they must match each
other and they must match how you actually reach the box, or sign-in fails with
a 403 that reads like a bug.

`VITE_AUTH_URL` is **baked into the bundle at build time**, so it is a build
argument, not a runtime env var. The compose file passes it as a build arg and
the image is rebuilt when it changes.

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
nano .env.prod          # see below — GC_AUTH_SECRET and the two URLs
```

`.env.prod` needs three values. Generate the two secrets by RUNNING these and
pasting what they print — do not paste the commands themselves:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # GC_AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # DJANGO_SECRET_KEY
```

so that the file ends up holding literal values:

```bash
GC_AUTH_SECRET=xQ7f...           # the OUTPUT of the first command
DJANGO_SECRET_KEY=9mKp...        # the OUTPUT of the second
PUBLIC_URL=http://<elastic-ip>
```

> Compose reads `.env.prod` as data. It does no command substitution, so a
> `$(...)` written into the file becomes the signing key verbatim — long enough
> to pass every length check, identical on both services, so every token
> verifies and the deploy is entirely healthy with a key that is printed in
> this file. `scripts/deploy.sh` now refuses a `.env.prod` containing `$(`.

Then bring it up and make yourself an account:

```bash
./scripts/gc up -d --build
./scripts/gc exec control \
  python manage.py createsuperuser
```

**No account is created for you.** A deploy script that invents an admin
password has put a login on a public host that nobody chose.

---

## Deploying a change

From your laptop, with the PEM at the repo root:

```bash
EC2_HOST=<elastic-ip> bash scripts/deploy.sh
```

It SSHes in itself. What it does, in order:

1. `git pull` in `/opt/ghostclick`
2. **Refuses to continue if `.env.prod` has no `GC_AUTH_SECRET`** — the one
   check worth failing the deploy over
3. `docker compose up -d --build`
4. `manage.py migrate` and `collectstatic` on the control plane
5. Smoke-checks, from the host: `/app/` is 200, and `/api/state` is **401**

That last one is the interesting assertion. On this deploy a 401 from
`/api/state` is the **success** condition: it proves the gate is on. A 200
there would mean the runner came up unauthenticated and the deploy should be
treated as failed.

---

## How we check it actually works

Three layers, cheapest first.

### 1 · From your laptop, no browser

```bash
curl -sI  http://<ip>/app/            | head -1     # 200 — the UI loads
curl -s   http://<ip>/api/state       -o /dev/null -w '%{http_code}\n'   # 401 — gated
curl -s   http://<ip>/auth/csrf       | head -c 60                        # {"csrfToken": …
curl -sI  http://<ip>/api/recording -X POST | head -1                     # 403 — blocked at nginx
```

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

1. Open `http://<ip>/app/` → you should be sent to the **sign-in screen**.
   (If you land on the console instead, auth is off.)
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
8. Try a redirect: open `http://<ip>/go/tracked`. The address bar should show
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

- `./scripts/gc config` parses, resolves
  every variable, and declares the three volumes.
- The compose file **refuses to start with no `GC_AUTH_SECRET`** — that is not
  a comment, it is `${GC_AUTH_SECRET:?...}` and it fails the command.
- Django's settings are valid under `DEBUG=0` with exactly the environment the
  compose file supplies: `manage.py check` → *no issues*.
- `npm run check:all` is green on this commit — 20 checks, exit 0 — including
  the assertion that `http://169.254.169.254/latest/meta-data/` is refused.

**Not verified, because there is no Docker daemon in the environment I built
this in:**

- **Neither image has been built.** The Dockerfiles are written from the
  known-good facts (Playwright 1.63.0, Node 22, four production dependencies)
  but they have not been through `docker build`.
- The `mcr.microsoft.com/playwright:v1.63.0-noble` tag has not been pulled. If
  it does not exist, pick the nearest published tag **at or above** the
  Playwright version in `package.json`.
- nginx has not parsed `docker/nginx.conf`.

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

Four warnings, and all four are the same fact — there is no TLS yet:

```
security.W004  SECURE_HSTS_SECONDS not set
security.W008  SECURE_SSL_REDIRECT not True
security.W012  SESSION_COOKIE_SECURE not True
security.W016  CSRF_COOKIE_SECURE not True
```

They are correct and they are expected. Turning any of them on before there is
TLS makes sign-in fail silently: a `Secure` cookie is simply not sent over
http, so you would log in and stay logged out. They all clear at once when you
put a certificate in front and set `GC_COOKIE_SECURE=1`.

## Security group

The single cheapest control, and the one to get right:

| Direction | Port | Source | Why |
|---|---|---|---|
| Inbound | 22 | **your IP /32** | SSH |
| Inbound | 80 | **your IP /32** | the app — not `0.0.0.0/0` |
| Outbound | 443, 80 | `0.0.0.0/0` | the runner has to reach the sites under test |

Do not open 80 to the world for this. Auth is on, but an open port is an
invitation to find out whether the auth is any good, and this is a PoC.

Also, on the instance: **IMDSv2 required**.

```bash
aws ec2 modify-instance-metadata-options --instance-id <id> \
  --http-tokens required --http-endpoint enabled
```

---

## Common operations

From `/opt/ghostclick` on the host.

| Task | Command |
|---|---|
| Runner logs | `./scripts/gc logs -f runner` |
| Control plane logs | `./scripts/gc logs -f control` |
| Restart the runner | `./scripts/gc restart runner` |
| Add an account | `... exec control python manage.py createsuperuser` |
| Which origins are allowed | `cat .ghostclick/origins.json` |
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
re-runs the same five smoke checks. Do not roll back by hand with
`git checkout <sha>`: that leaves a detached HEAD, and the next deploy's branch
lookup then resolves to the literal string `HEAD`.

Both volumes survive a rollback. There are no destructive migrations in this
app today — the control plane's schema is four columns — but that stops being
true the moment it stores anything real.

---

## Deliberately not done

- **TLS.** Port 80 only, locked to your IP. That means the session cookie and
  the executor token cross the network in the clear, which is acceptable
  between two addresses you control and not acceptable for anything else. A
  hostname plus Cloudflare (Full Strict) or an ALB with ACM is the fix, and
  it is the first thing to add if this outlives the demo.
- **CI deploy on merge.** Cansee auto-deploys from `main`. This does not, and
  should not until there is a staging host — an auto-deploy that restarts the
  browser mid-run is a confusing failure.
- **Horizontal scale.** One browser, one run lock. Two instances behind a load
  balancer would give two people two different runners and a screencast that
  follows whichever they happened to land on. The fix is a runner pool with a
  session-affinity router, and it is a real project.
- **Backups.** The two volumes are on one EBS volume with no snapshot
  schedule. Fine for a demo; take an EBS snapshot before anything you care about.

## Pre-deploy checklist

- [ ] `npm run check:all` green locally — exit code 0, 20 checks
- [ ] A **new** t3.medium instance, not the Cansee host
- [ ] Launched with the `cansee-deploy` key pair
- [ ] Security group: 22 and 80 to **your IP only**
- [ ] IMDSv2 required
- [ ] `.env.prod` has a real `GC_AUTH_SECRET` (48 random bytes, not a word)
- [ ] `PUBLIC_URL` matches how you will actually reach the box
- [ ] Both volumes declared in the compose file before the first `up`
