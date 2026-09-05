# ghostclick

A browser-automation PoC: a synthetic cursor visibly glides across a live
headless-Chrome feed and clicks things, driven by a small DSL.

```bash
npm install
npx playwright install chromium   # skip if your sandbox already ships one
npm start                         # → http://localhost:3000
```

Hit **Run script**. It logs into the bundled demo app, walks to Settings →
Profile, types a 20-character username, and saves. The demo silently truncates
to 16 characters while still showing a success toast, so the final assertion
goes red — a realistic silent-data-loss bug.

```bash
node scripts/check.js             # end-to-end check against a running server
```

---

## How it works

Two independent loops share one Chrome. Video flows right-to-left, control
flows left-to-right, and they only meet inside `VirtualCursor`.

```
   LOOP 1 — video                        LOOP 2 — control

   Chrome                                viewer <textarea>
     │ Page.screencastFrame                    │ WS {t:'command', text}
     ▼                                         ▼
   node: ACK, cache lastFrame              parse.js   text → IR
     │ WS binary (JPEG)                         │
     ▼                                         ▼
   canvas.drawImage()                      validate() ← registry + origin
                                               │        allowlist
                                               ▼
                                           executor: for each step
                                               │
                                               ▼
                                           VirtualCursor  (owns x,y)
                                               │
                            ┌──────────────────┴──────────────────┐
                            ▼                                     ▼
              CDP Input.dispatchMouseEvent            WS {t:'cursor'|'press'}
                            │                                     │
                            ▼                                     ▼
                   Chrome really moves                 <svg> arrow moves
                                                       (delayed by LAG)
```

That fork at the bottom is the whole design. One object owns the pointer
position; every move injects a real event into Chrome **and** emits a draw
event to the overlay in the same tick. `click()` takes no coordinates — it
fires wherever the cursor already is — so the drawn arrow and the injected
click cannot disagree about where they are.

### One click, in time

```
 t=0      executor : pointAt('auth.submit') → waitFor → boundingBox → (373,434)
 t=0..420 cursor   : ~26 × moveTo() ─┬─ CDP mouseMoved       ──▶ Chrome
                                     └─ WS {t:'cursor',x,y}  ──▶ viewer (draws at t+LAG)
 t=420    cursor   : re-read the box; correct if the page reflowed mid-glide
 t=560    cursor   : click() ─┬─ WS {t:'press'} ──▶ ripple at t+LAG
                              ├─ CDP mousePressed
                              │   └ 70ms hold — a press with no duration is
                              │     invisible on a 10fps feed
                              └─ CDP mouseReleased
 t=630+   Chrome   : repaints → screencastFrame → ack → viewer canvas
```

---

## Files

| File | Role |
|---|---|
| `server.js` | express + ws, CDP screencast pump, executor loop |
| `cursor.js` | `VirtualCursor` — sole authority for pointer position |
| `ops.js` | element registry, op vocabulary, validation gate |
| `parse.js` | DSL text → JSON IR |
| `public/index.html` | canvas feed, cursor overlay, script editor, run log |
| `public/demo.html` | target app, with a planted truncation bug |
| `scripts/check.js` | end-to-end check + rejection cases |

## The DSL

```
suite  "Username length boundary"
goto   "http://localhost:3000/demo.html"
fill   auth.email    with $secrets.QA_USER
fill   profile.username with repeat("a", 20)
click  auth.submit
expect url contains "/settings"
expect text "Profile saved"
expect value profile.username is repeat("a", 20)
wait   500
```

`parse.js` is a placeholder for a model emitting IR through a tool-use schema.
The validator downstream doesn't care which produced it — that's the point.

## The security model is subtractive

There is no `evaluate` op and no raw-selector op. Targets are keys into
`registry`, so a plan cannot invent a selector, and anything the validator
doesn't recognise never reaches Chrome. An automation agent reads the app under
test, which is untrusted content; injection can only buy an attacker whatever
the action space permits. Six verbs over seven named elements is a small prize.

`scripts/check.js` asserts these stay rejected — re-run it after any change to
`ops.js`:

```
click profile.nonexistent                      → unknown target "profile.nonexistent"
goto "file:///etc/passwd"                      → goto needs an http(s) url, got file:
goto "http://169.254.169.254/latest/meta-data/" → origin is not allowlisted
evaluate "fetch(1)"                            → unknown verb "evaluate"
```

## Three things that will bite you

**Ack every frame, first thing.** `Page.screencastFrameAck` is Chrome's
backpressure valve. Skip it and you get exactly one frame and then silence,
which presents as a broken WebSocket and is not.

**Delay the overlay to match the video.** Frames land ~120ms behind reality;
cursor events land in ~10ms. Without `LAG` the arrow clicks before the frame
showing the click, and the whole thing reads as glitching rather than as an
agent working.

**Frames are damage-driven, not a fixed framerate.** A static page emits
nothing, so a viewer connecting to an idle session sees a blank canvas —
`server.js` caches `lastFrame` and primes new clients with it. (The status bar
reading `0 fps` on a settled page is this, not a stall.)

## Deliberately not here yet

- Screenshot artifacts, and shipping them to S3 rather than base64 over the socket
- Human takeover (canvas clicks routed through the same `VirtualCursor`)
- Pause/resume gate in the executor loop
- `theatrical` / `normal` / `fast` modes — glide and typing delays turn a
  4-second test into ~25 seconds, which is right for demos and wrong for CI
- Timestamp-based overlay sync instead of a fixed `LAG` constant
- Auth on the WebSocket; one container per session
- `Target.attachedToTarget`, so a popup doesn't freeze the feed on the old page
