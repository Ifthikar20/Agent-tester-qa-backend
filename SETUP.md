# Setting up, and recording your first flow

Fifteen minutes, most of it waiting for a browser to download.

## 1 · Run the server

```bash
git clone -b claude/ghostclick-automation-poc-mb76oz https://github.com/Ifthikar20/poc-qa-stack
cd poc-qa-stack
npm install
npx playwright install chromium     # skip if you already have one
npm start                           # → http://localhost:3000
```

It prints what it starts with:

```
  ghostclick  ->  http://localhost:3000
  allowed     ->  http://localhost:3000
  secrets     ->  QA_PASS, QA_USER
```

Open `http://localhost:3000` and press **Run script** to watch it drive the
bundled demo app and go red on a planted bug. If that works, everything works.

## 2 · Point it at your app

Type the host into **Page** — `treasury.acme.com` is enough, no scheme needed —
and press **Open**.

The first time, it stops and says the origin is not allowed yet, with a button
to allow it. That gate is what stops a generated plan from reaching an arbitrary
host, so opening it is a decision only a person makes. Press it once; the choice
is remembered in `.ghostclick/origins.json` and survives restarts.

Allowed origins are listed under **Page → Allowed origins**, each with an × if
you change your mind.

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

**“origin … is not allowed yet”** — press the allow button in the Page panel.

**“This step still says $TODO”** — the recorder deliberately never captured that
password. Rename it to a vault key you have set.

**“This recording starts part-way through a session”** — you pressed Record
while already deep in the app, and its URL does not get anyone back there.
Record again from the login page, with the sign-in as part of the flow.

**A step cannot find its element** — open **Targets on this page** to see what
that page actually offers, and click a chip to drop it into the script.

**The recording missed a click** — it only records elements that are actually
interactive. A click on a plain `<div>` is skipped on purpose, because naming a
div by the text inside it produces a target that breaks next week.

**Nothing on the canvas** — a settled page emits no frames, so `0 fps` is normal.
Press **Reload page**.
