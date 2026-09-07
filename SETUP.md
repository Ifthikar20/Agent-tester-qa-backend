# Setting up, and recording your first flow

Fifteen minutes, most of it waiting for a browser to download.

## 1 · Run the server

```bash
git clone -b claude/ghostclick-automation-poc-mb76oz https://github.com/Ifthikar20/poc-qa-stack
cd poc-qa-stack
npm run app                         # → http://localhost:3000
```

That is the whole thing. `npm run app` installs what is missing, downloads the
browser if it has to, builds the UI and starts the runner — and says which of
those it skipped, because a setup script that works silently is one you cannot
debug when it does not.

Add `--auth` and it also sets up and starts the Django control plane in
`auth/`: pip, the migration, a shared key generated once into
`.ghostclick/auth-secret`, and the UI rebuilt knowing where to sign in. One
Ctrl-C stops everything. It will not create an account for you — it tells you
to run `createsuperuser`, because a script that quietly makes an admin login
with a password it chose has put a login on your machine that you do not know
about.

The longer way still works, and is what `npm run app` does for you:

```bash
npm install
npx playwright install chromium
npm start
```

It prints what it starts with:

```
  ghostclick  ->  http://localhost:3000
  serving     ->  /path/to/poc-qa-stack/web/dist
  allowed     ->  http://localhost:3000
  secrets     ->  QA_PASS, QA_USER
  driving     ->  nothing yet — open a URL in the console
```

`serving` is the built UI it is handing out. It is a directory the server is
pointed at, not one it owns — `GC_WEB_DIR` moves it, which is how the same
backend serves a UI deployed from its own repository.

There is also a `pace` line. A replay glides the pointer, pauses before each
click and types a character at a time, so that a feed running at roughly ten
frames a second shows something you can follow — about two thirds of a second
per click step, plus 42ms per character. Worth it when you are watching and
nothing when you are not, so the console has a **Watch / Fast** toggle beside
Run, and `GC_PACE_MS` sets what this server does by default.

There is also an `auth` line, and on a first run it says `OFF`. That is correct
for one person on one laptop, and it is printed every time rather than left to
be assumed — believing this is protected when it is not is worse than knowing it
is open. `auth/README.md` covers turning it on.

`driving` is where the runner's browser is pointed. On a first run it is
nothing — run history is machine-local, so a fresh clone has none — and the
console says "Nothing open yet" until you open something. After that it starts
on whatever you ran last, and `HOME_URL` overrides it.

Open `http://localhost:3000`. It lands on **Test suites**.

`npm start` builds the UI if anything changed and then serves it, so one
command always runs the latest. It says which:

```
  ui          ->  up to date
  version     ->  0b8c46a, ui built 2026-09-06 16:43
```

The same commit is at the bottom of the sidebar. If it is not the one you
expect, you are looking at an old UI — worth checking before chasing a bug you
have already fixed. (`npm run dev` puts Vite in front of it on :5173 for working
on the UI itself; `npm run serve` runs without building.)

**Scrolling the page you are driving:** point at the canvas and use your wheel
or trackpad, or the ↑ Top / ↓ Bottom buttons. Clicks and keystrokes there go to
the page being driven, never to the console.

## 2 · Point it at your app

Paste your app's URL into the field on that screen and press **Add and test**.

It stops once to say the origin is not allowed yet, with a button. Press it. The
runner refuses to open an origin nobody approved and no script can approve one,
so this is a person deciding, once, per origin.

Then it opens the page, names the suite from the page title, reads what is on it,
asserts you reached it, and runs that. You land on a suite that is already green
or red — which tells you whether the runner can drive your app at all, before you
invest in describing it properly.

If it went green, click **Pages**. The links your app's own nav points at are
offered as one-click adds, so the rest of the pages take a few clicks rather than
a few minutes of typing routes.

**Watch the canvas, not your own page.** Everything ghostclick drives happens in
a *separate* browser it launched and streams onto the canvas in **Console** —
your mouse and your tabs are never touched. If you would rather see a real
window being driven:

```bash
HEADED=1 npm start
```

You can also start pointed at your own app, which allows that origin at the same
time — naming it on the command line is the same decision the Allow button is:

```bash
PORT=3100 HOME_URL=https://staging.acme.com/ npm start
```

The first time, it stops and says the origin is not allowed yet, with a button
to allow it. That gate is what stops a generated plan from reaching an arbitrary
host, so opening it is a decision only a person makes. Press it once; the choice
is remembered in `.ghostclick/origins.json` and survives restarts.

Allowed origins are listed under **Page → Allowed origins**, each with an × if
you change your mind.

Then pick **↳ This page (starter)** from the Script dropdown. It writes a
runnable flow for whatever is open — the real URL, the targets actually
discovered on it, and the node shapes listed as comments so you can add
assertions. Nothing about the bundled demo apps is in your way.

## 3 · Put your credentials somewhere real

A recorded password is never written into the script — it becomes `$TODO` and
fails loudly until you point it at a key.

```bash
GC_SECRET_TREASURY_USER='qa@acme.com' \
GC_SECRET_TREASURY_PASS='…' \
npm start
```

Or, if you would rather not have it in your shell history, create
`.ghostclick/secrets.json` (gitignored):

```json
{ "TREASURY_USER": "qa@acme.com", "TREASURY_PASS": "…" }
```

**Page → Vault keys** lists the names. Values never leave the server: not to a
viewer, not into a log, not into a diagram.

## 4 · Install the extension

The server's own browser has none of your cookies, so anything behind a login
has to be recorded in a browser that is already through it — yours.

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → choose the `extension/` folder in this repo
3. Open your app, click the ghostclick icon to open the side panel

If the server runs anywhere but `http://localhost:3000`, set it under
**Flow → Where ghostclick is running**.

## 5 · Record

```
Start recording      captures the current URL as step 1
Pick element         the next click is HELD, not delivered
  → the panel asks   Click it · Type into it · Assert text visible · Cancel
  → you answer       the step is written AND the click happens for real,
                     so the page moves on
Assert current URL   a checkpoint after landing somewhere
Undo step            drop the last one
Stop                 done
```

Start recording from a URL that stands on its own — the login page. Pressing
Record while already three screens deep produces a flow whose first step is
"go to wherever I happened to be", and in a single-page app that URL usually
lands on the login screen instead.

Record the sign-in as part of the flow. When you type the password, tick
**secret** — the value is dropped in the browser and the step becomes `$TODO`.

Then **Send to ghostclick**. It is validated and dropped into the script box;
it never runs on its own.

## 6 · Run it

Swap `$TODO` for the key you set in step 3:

```
fill 'Password' : textbox = $TREASURY_PASS
```

Press **Run script** and watch the cursor repeat your demonstration. The diagram
below the feed turns green step by step, and red at whatever breaks.

---

## When something goes wrong

**`EADDRINUSE: address already in use :::3000`** — something is already on that
port, usually a previous `npm start` you thought you had closed. Either free it
or use another port; both work, because the demo scripts and the allowlist
follow `PORT` rather than assuming 3000.

```bash
PORT=3100 npm start                       # any shell

# Windows, to find and stop the old one instead (Git Bash / PowerShell):
netstat -ano | findstr :3000              # last column is the PID
taskkill //PID <pid> //F                  # Git Bash needs the doubled slashes
```


**“origin … is not allowed yet”** — press the allow button in the Page panel.

**“This step still says $TODO”** — the recorder deliberately never captured that
password. Rename it to a vault key you have set.

**“This recording starts part-way through a session”** — you pressed Record
while already deep in the app, and its URL does not get anyone back there.
Record again from the login page, with the sign-in as part of the flow.

**A step waits 8 seconds for something in a menu** — the menu was open while you
recorded and is shut on replay. The recorder usually catches this and writes a
`hover` step for you; if it did not, add one by hand:

```
home -->|hover 'Use Cases' : link; click 'Catch harmful answers' : menuitem| home
```

The failure message lists what the page does have, which is often a plain
`link:` version of the same thing — a better target, since it does not need a
menu to be open.

**A step cannot find its element** — open **Targets on this page** to see what
that page actually offers, and click a chip to drop it into the script.

**The recording missed a click** — it only records elements that are actually
interactive. A click on a plain `<div>` is skipped on purpose, because naming a
div by the text inside it produces a target that breaks next week.

**Nothing on the canvas** — a settled page emits no frames, so `0 fps` is normal.
Press **Reload page**.
