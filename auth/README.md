# ghostclick — the control plane

Django, and it knows about exactly one thing: people.

It has never heard of a test case. It cannot reach the runner's suites, it holds
no secret values, and it has no opinion about which origins may be driven — the
executor owns all of that and re-checks it locally. That is deliberate: two
services with an opinion about the same rule is how a hard gate quietly becomes
advisory, and the gate here decides where a real browser is pointed.

The design it is being built towards is [docs/AUTH.md](../docs/AUTH.md). This
directory is at the **mfa** step of that document's build order: the
foundation (settings profile, hashing, the audit log, the session clocks, the
stores and edge), organisations, roles, invitations and entitlements (the
control-plane half of §10), the Ed25519 executor token (§8), django-allauth
for sign-up, sign-in, verification, recovery and the account changes (§4, §5
and §7), Google sign-in (§6), and now the second factor — an authenticator
app, recovery codes and passkeys, the policy that says who must hold one,
the strong reauthentication that gates every sensitive change, and the
sessions list (§5, §7.2, §12). The runner does not partition its state by
organisation yet — that is the runner-tenancy step.

## Why Django

SSO. Sign-up, sign-in, the verification code, the reset link and the password
and email changes are `django-allauth`'s, reached by the SPA through its
headless JSON API under `/_allauth/`; Google and MFA slot in behind the same
prefix without a line changing on the runner side. Plus the admin, which is
why adding a colleague is a form rather than a script someone has to write —
and whose login form is gone: `/admin/` sends you to the app's sign-in and
takes you back as a staff session, so staff meet the same rate limits,
verification and second factor as everyone else — and are sent to enrol
one before the admin draws a page.

## Running it

```bash
pip install -r requirements.txt
cp .env.example .env
python manage.py signing_key --new    # prints GC_SIGNING_KEY for .env, and the runner's line
python manage.py mfa_key              # prints GC_MFA_KEY for .env (optional on a laptop; see .env.example)
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
the keypair and the second-factor key in `.ghostclick/`, and prints the
control plane's mail — every sign-up code, invitation and reset link — into
the same terminal, because on a laptop the mail backend is the console.

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
breached password, new device, Turnstile demand, refused, connected and
disconnected Google identity, and — for the second factor — every
authenticator added or removed, recovery codes regenerated, every refused
code, and other sessions signed out — written by receivers on Django's own
`user_logged_in`, `user_logged_out` and `user_login_failed` signals, on
allauth's account and mfa signals, and by the mint view — so a view that
signs someone in or changes something cannot forget to log it. Each row has
the address **as the edge reports it** (`accounts.events.client_ip`, the same
arithmetic allauth uses for its rate limits, with `ALLAUTH_TRUSTED_PROXY_COUNT
= 1` behind Caddy and `0` on a laptop), the user agent, and for a refusal the
email as typed. It is readable in `/admin/` and not editable there.

The same receivers keep `request.session['gc_auth_events']`, the list of
`{method, at}` the executor token's `amr`, `auth_time` and `su` are computed
from: allauth's `authentication_step_completed` fires for a sign-in and for a
reauthentication alike, and its method is written in the token's vocabulary
(`password`, `otp`, `recovery`, `webauthn`, `google`) `[mfa-recovery-2]`.
Enrolling an authenticator is written as a proof of it too — the code that
enrolled the app came from the app — so the recovery codes can be shown in
the same breath.

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
"sign up with your @acme.example address" is policy, not a secret. The policy
is applied in the sign-up input (`accounts/headless.py`) rather than in the
adapter's `clean_email`, because allauth runs that hook on every address it
meets — Google's included — and a Google address is judged by the social
adapter with the id_token's `hd`, never by the string after the @.

## Sign in with Google

docs/AUTH.md §6, on allauth's `socialaccount` with the `google` provider
alone, configured from `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (both or
neither; the settings module refuses one without the other, and unset there
is no button, no provider and no callback — `GET /auth/config` says
`google: false`). The client is not a database row: the admin's Social
applications screen is unregistered, so the secret lives in the environment
like every other one and there are never two clients to choose between.

The flow: the SPA POSTs `provider=google`, `process=login|connect` and a
hard-coded `callback_url` — its own origin plus `/app/login` (or
`/app/security` for a connect) — to `/_allauth/browser/v1/auth/provider/redirect`,
as a form, with the CSRF token as a field, because the answer is a 302 to
Google that only a navigation can follow. A `GET` starts nothing
(`SOCIALACCOUNT_LOGIN_ON_GET` is off, and the GET login URL is not mounted at
all). Google comes back to `/accounts/google/login/callback/` — the only path
this project mounts under `/accounts/`, so One Tap's csrf-exempt token
endpoint does not exist here and the edge's exact route for the callback is a
second wall rather than the only one. The code is exchanged over PKCE, the
id_token is the only thing read, and no Google token is stored
(`SOCIALACCOUNT_STORE_TOKENS`). The rules allauth has no setting for are in
`accounts/adapters.py`:

- **`callback_url`** must have the app's scheme and host — `GC_PUBLIC_URL`
  in production, `GC_WEB_ORIGIN` on a laptop — and a path under `/app/`.
  Not `ALLOWED_HOSTS`, and not a relative path `[oauth-4]`.
- **Sign-up** asks `accounts/policy.py` exactly as a password sign-up does,
  with `hd` read from the id_token — a Google account with no `hd` is a
  consumer account whatever its address ends in, and domain mode refuses it —
  and draws on the same `signup` rate-limit bucket `[oauth-5]`. An admitted
  address Google has verified is verified here on Google's word, so the
  invitations bound to it become memberships in the same moment, as they
  would at a code. An address Google has not verified gets a code.
- **An existing account** is opened by a Google identity in two cases only:
  the identity is already connected (the `sub` is known), or Google says the
  address is verified **and** the account's own `EmailAddress` is verified
  **and** no other Google identity is attached to the account — in which
  case the identity is connected, and from then on it is the `sub` that
  matters `[oauth-2]`. An address that someone merely typed into an account
  is a claim and opens nothing; a second `sub` for an address that already
  has one is refused. A refused match is never turned into a second account.
- **Every refusal is one sentence.** allauth names each failure in the
  redirect it answers with, and the names say things about other people's
  accounts, so `accounts/google.py` wraps the callback: whatever went wrong —
  a foreign or replayed `state`, an unsafe `callback_url`, a policy refusal,
  a link that may not be made — the browser is sent to `/app/login?error=refused`
  (or `/app/security` for a connect), the SPA shows "We could not sign you
  in with Google. Sign in the way you usually do, then connect Google from
  Settings.", and the real reason and the address go to the audit log
  (`google_refused`, or `signup_refused` with `method: google`)
  `[credentials-3]`. Only a cancel keeps its own word; it is the person's
  own doing and says nothing about any account.
- **A Google-only account** has no usable password and therefore no way to
  reauthenticate; `/auth/me` reports `mfa.required: true` for it, and the
  MFA step turns that into the demand to enrol an authenticator before
  anything sensitive `[oauth-1]`. Google is one factor and never satisfies
  `mfa.required` `[oauth-6]`; the token's `amr` says `google`.
- **Connected accounts** under Security list the identities
  (`GET account/providers`), connect another (the same form, `process=connect`),
  and disconnect one (`DELETE account/providers`, behind a reauthentication;
  refused when it is the last way into an account with no password).

`manage.py purge_unverified_emails` deletes unverified *secondary*
addresses older than fifteen minutes — the lifetime of the code that would
have proven them — because such a row is a claim on an address that blocks
its real owner's sign-up `[oauth-2]` (§6.6). `accounts.EmailAddressAdded`
stamps every `EmailAddress` row when it is made, since allauth's row has no
date. In this configuration the code-verified email change never leaves such
a row behind (the new address stays in the session until the code is
entered), so the purge is a guard for rows made by hand in the admin or by
a later flow rather than a routine that finds work; it is meant to run
every few minutes and nothing schedules it yet.

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

## The second factor

docs/AUTH.md §5 (the MFA parts), §7.2 and §12, on `allauth.mfa` with all
three of its kinds — an authenticator app (TOTP, six digits, thirty
seconds, **no** neighbouring window: `MFA_TOTP_TOLERANCE = 0`), the ten
recovery codes made beside it, and passkeys, which also sign in on their own
(`MFA_PASSKEY_LOGIN_ENABLED`); a passkey sign-in *is* the second factor and
skips the challenge. A trusted-device cookie is the one allauth feature
that skips the challenge for a password sign-in, so `MFA_TRUST_ENABLED` is
off and stays off `[mfa-recovery-6]`.

**Who must hold one** is `accounts/mfa.py`, computed from the database on
every request and never from a flag in the session `[mfa-recovery-1]`:
staff; the owner or admin of an organisation other than their own personal
one (everybody owns that, and it has one seat — the rule is about the
people a manager's session can act on); any member of an organisation on a
plan whose resolved entitlements say `mfa.required`; and an account with no
usable password, which is what a Google-only account is — Google is one
factor and never satisfies the policy `[oauth-1] [oauth-6]`. While such an
account holds nothing, `accounts.middleware.MfaRequired` answers
`403 {"error": "mfa_required"}` to everything but enrolment
(`account/authenticators/*`), the session endpoints, every kind of
reauthentication, the password change, "who am I" and the read-only
helpers; `/auth/executor-token` repeats the check itself, because a token
must never be a middleware ordering away. `/auth/me` reports
`mfa: {required, enrolled, reasons}` so the enrolment page can say why —
except that being staff is never given as a reason, since there is no
`isStaff` in what the browser is told `[authz-tenancy-6]`. For `/admin/`,
which is HTML, `StaffMFARequired` redirects an unenrolled staff session to
the app's enrolment page instead. `adduser --staff` says so.

**Enrolling**: `GET account/authenticators/totp` answers a fresh secret,
the `otpauth://` URL and — this project's addition — an SVG of it as a QR
code, drawn here because the UI's CSP admits no script from anywhere else;
a code from the app activates it, the recovery codes are generated beside
it, and `GET account/authenticators/recovery-codes` hands them over **once**
(`MFA_RECOVERY_CODES_SHOW_ONCE`), after which the endpoint only counts
them. Every addition and removal is mailed to the account and logged.

**Passkeys** `[mfa-recovery-5]`: the relying party is the host of
`GC_PUBLIC_URL` (`GC_WEB_ORIGIN` on a laptop) and never the request's Host
header (`accounts.adapters.MFAAdapter`); every ceremony — registration,
sign-in, challenge, reauthentication — demands user verification
(`accounts/webauthn.py`, whose `begin_*` set the requirement fido2 then
enforces at completion), so an assertion whose UV flag is clear is refused
and never becomes `webauthn` in `amr`; and the origin the browser wrote into
`clientDataJSON` must equal the configured origin exactly before allauth
reads the credential at all — fido2's own check would also admit a
subdomain. fido2 refuses an `http://` origin other than localhost, so
passkeys need `https://` anywhere real; an `http://ip` demo still has the
app.

**Strong reauthentication** `[mfa-recovery-2]`: the password change, the
email change, every authenticator change, the recovery codes and a Google
disconnect want a proof within `ACCOUNT_REAUTHENTICATION_TIMEOUT` (300 s).
For an account that holds an authenticator, `accounts.middleware
.StrongReauthentication` requires that proof to be a second factor — read
from the session's `gc_auth_events`, not from a flag — and refuses a
password reauthentication outright, before the password is looked at, with
`401` and the `mfa_reauthenticate` flow pending and no `reauthenticate`
flow listed. `POST auth/2fa/reauthenticate` (a code) and
`GET/POST auth/webauthn/reauthenticate` (a passkey) are the proofs; each is
appended to the session's events and to the log.

**The token** (§8): `amr` is every method the session used; `auth_time`
is the most recent *strong* event for an account that holds an
authenticator, else the most recent event; `su` is `auth_time + 600` when
the strongest factor the account has was the one used, otherwise `0` — a
session that enrolled after signing in with the password, or a password
account that signed in through Google, cannot allow an origin until it
proves the stronger thing (`accounts.views.step_up`). A session whose
password was right and whose code has not landed is not signed in and
mints nothing.

**At rest** `[ops-supply-2]`: TOTP secrets and recovery-code seeds are
Fernet-encrypted with `GC_MFA_KEY` — required in production, derived from
the fixed dev secret on a laptop when unset, checked to be a Fernet key at
import; `manage.py mfa_key` prints one, and several keys comma-separated
rotate (the first encrypts, every one decrypts). A row the key cannot open
verifies no code and is logged, rather than raising. allauth's admin screen
for authenticators is replaced by a read-only one (removal only, for
someone locked out): the data column is ciphertext, but a form that could
rewrite a second factor is still a form.

**Sessions**: `allauth.usersessions` with `USERSESSIONS_TRACK_ACTIVITY`
keeps a row per session with the last address and time it was seen;
`GET auth/sessions` lists them and `DELETE auth/sessions {sessions: [id…]}`
ends the chosen ones (only the account's own — the input resolves ids
against the user), and this project logs it. A password change or reset
still ends every session by walking the session table (`accounts/sessions.py`),
which also covers rows from before the app existed. Backups should exclude
this table along with `django_session`.

**Rate limit**: a wrong code counts against allauth's `login_failed` —
`10/m/ip` and `5/5m` per account — so six wrong codes from two addresses
are refused on the sixth before any code is checked; and a code is good
once, in its own thirty seconds.

## The surface

Ours, under `/auth`:

| | |
|---|---|
| `GET /auth/csrf` | a CSRF token the SPA echoes in `X-CSRFToken` |
| `GET /auth/config` | `{signup, domains, turnstile, google}` — what the sign-up page needs before anyone types |
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
| `POST auth/provider/redirect` | a form: `provider=google`, `process=login\|connect`, `callback_url` → 302 to Google |
| `GET/DELETE account/providers` | the Google identities that open this account; `{provider, account}` detaches one |
| `GET /accounts/google/login/callback/` | where Google sends the browser back; not under `/_allauth/`, and the only path under `/accounts/` |
| `POST auth/2fa/authenticate` | `{code}` — the app's code or a recovery code, after the password |
| `GET/POST auth/webauthn/login` | a passkey signing in on its own: the request options, then `{credential}` |
| `GET/POST auth/webauthn/authenticate` | a passkey answering the challenge after a password |
| `POST auth/2fa/reauthenticate`, `GET/POST auth/webauthn/reauthenticate` | the second factor as the fresh proof a sensitive change wants |
| `GET account/authenticators` | what the account holds |
| `GET/POST/DELETE account/authenticators/totp` | the secret, URL and QR to enrol from (`404` + `meta`); `{code}` activates; remove |
| `GET/POST account/authenticators/recovery-codes` | the codes, once; regenerate |
| `GET/POST/PUT/DELETE account/authenticators/webauthn` | creation options (`?passwordless`); `{name, credential}` adds; rename; `{authenticators: [id…]}` removes |
| `GET/DELETE auth/sessions` | every session the account has; `{sessions: [id…]}` ends the chosen ones |

Several of those are this project's subclasses (`accounts/headless.py`),
mounted at the same paths ahead of allauth's own: the Turnstile field, the
invite-mode branch and the previous-address lookup on login, signup and
password/request; user verification and the pinned origin on the four
WebAuthn views; the QR code on the TOTP view; the audit row on the code
reauthentication and on ending sessions.

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
  "mfa": {"required": true, "enrolled": false, "reasons": ["manages_organisation"]}, "flags": {} }
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
authentication events the sign-in receiver appends to the session, with
`auth_time` the most recent second-factor event for an account that holds
an authenticator; `su` — "step-up valid until" — is `auth_time + 600` when
the strongest factor the account has was the one used, and `0` otherwise
(a session with no recorded event, an enrolled account that has not shown
its authenticator this session, a password account that came in through
Google), and the runner checks nothing about it but `now < su` before it
allows an origin; `sid` is a hash of the
session key; `iat`, `exp` (at most 600 seconds later — `GC_TOKEN_TTL` is
clamped to 60–600) and `jti`. Every one is copied from the database or the
session into the signature; the runner reads them from the token and from
nothing else.

## Tests

```bash
python manage.py test          # 352 tests, one module per concern in accounts/tests/ and tenants/tests/
```

They never touch the network: `accounts/testing.py` is the test runner, and it
stubs the Have I Been Pwned client so a test can say "three breaches" or "the
API is down" and assert what happens; the Turnstile verifier is patched the
same way, mail goes to Django's in-memory outbox, where the tests read the
codes and links back out, and Google is stubbed at the two calls that would
reach it — the token exchange and the id_token — so `test_google.py` drives
the real redirect endpoint, callback, session and database with whatever
id_token payload a case needs. The production-profile tests import the
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
- **A purge of anything.** `AuthEvent` rows past 90 days, expired
  invitations, previous addresses past their week, and the stale-address
  purge on a schedule are the ops step's; the commands that exist are
  idempotent and nothing runs them yet.
- **Multi-tenancy on the runner.** The runner holds one browser and one run
  lock. Two people signed in still share it — a login says *who*, not *which
  runner*.
