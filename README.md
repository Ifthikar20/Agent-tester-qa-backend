# ghostclick

A browser-automation PoC: a synthetic cursor visibly glides across a live
headless-Chrome feed and clicks things, driven by a small DSL — against any
allowlisted URL, with the script rendered as a mermaid diagram.

```bash
npm install
npx playwright install chromium   # skip if your sandbox already ships one
npm start                         # → http://localhost:3000

npm run check                     # end-to-end, against a running server
npm run check:diagram             # generated mermaid vs. the real parser
```

Two bundled apps to drive. **Meridian** silently truncates a username to 16
characters while showing a success toast. **Nimbus** shows `Widget × 2` in the
cart and charges for one. Both bugs turn their run red.

---

## How it works

Three loops share one Chrome. Video flows right-to-left, control flows
left-to-right, and they meet only inside `VirtualCursor`. The IR forks: the
same data structure the executor walks is what gets drawn.

```
   LOOP 1 — video                        LOOP 2 — control

   Chrome                                viewer <textarea>
     │ Page.screencastFrame                    │ WS {t:'command', text}
     ▼                                         ▼
   node: ACK, cache lastFrame              parse.js   text → IR
     │ WS binary (JPEG)                         │
     ▼                                         ▼
   canvas.drawImage()                      validate() ← origin allowlist
                                               │        + target grammar
                                               ├──────────────┐
                                               ▼              ▼   LOOP 3 — picture
                                           executor       diagram.js
                                               │              │ IR → block-beta
                                               ▼              ▼ WS {t:'diagram'}
                                        VirtualCursor    mermaid.render()
                                          (owns x,y)
                                               │
                            ┌──────────────────┴──────────────────┐
                            ▼                                     ▼
              CDP Input.dispatchMouseEvent            WS {t:'cursor'|'press'}
                            │                                     │
                            ▼                                     ▼
                   Chrome really moves                 <svg> arrow moves
                                                       (delayed by LAG)
```

The fork at the bottom is the core design. One object owns the pointer
position; every move injects a real event into Chrome **and** emits a draw
event to the overlay in the same tick. `click()` takes no coordinates — it
fires wherever the cursor already is — so the drawn arrow and the injected
click cannot disagree about where they are.

The fork in the middle is why the diagram can't lie either: `diagram.js` is a
pure function of the same IR, run twice — once before execution as a plan, once
after with outcomes folded in as a report.

### One click, in time

```
 t=0      executor : pointAt('button:Sign in') → waitFor → boundingBox → (373,434)
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

## Any URL

`goto` reaches any origin on the allowlist:

```bash
ALLOWED_ORIGINS="https://staging.acme.com,https://app.acme.com" npm start
ALLOWED_ORIGINS="*" npm start        # public origins only; see below
```

Under `*` the private network stays off limits — `localhost`, RFC1918,
`169.254.0.0/16` (cloud metadata lives there), `.internal`, `.local`. Naming an
internal origin explicitly is an opt-in; a wildcard is not. **Known gap:** this
checks the hostname, not what it resolves to, so a public name pointing at a
private address still gets through. The real fix is resolve-and-pin, or an
egress firewall on the container.

### Targets, without a hand-written registry

An app you just typed a URL for has no page-object registry, so targets are a
small closed grammar of semantic locators:

```
button:Sign in        role shorthand   → getByRole('button', {name, exact})
textbox:Email         role shorthand
label:Username        → getByLabel
text:Profile saved    → getByText
placeholder:Search    → getByPlaceholder
testid:save-btn       → getByTestId
auth.email            an alias, which resolves to one of the above
```

Matching is **exact**: a target names one element, so `button:Add Widget` does
not also match "Add Widget Pro" and resolve to two nodes.

The viewer's **Targets on this page** panel is populated from Playwright's
`ariaSnapshot()` on every navigation — the same accessibility model
`getByRole` queries, so everything listed is guaranteed to resolve. Click a
chip to drop it into the script. That is what makes an unseen URL scriptable.

Aliases (`targets.js`) are optional per-origin sugar, and they are **data**:
their values are target strings in the grammar above, never functions, so an
alias table cannot smuggle in a selector or a callback.

---

## The security model is subtractive

There is no `evaluate` op and no raw-selector op. A target is never interpreted
as a selector — it is parsed into a fixed strategy and looked up. An automation
agent reads the app under test, which is untrusted content; injection can only
buy an attacker whatever the action space permits, and this one is five verbs
over elements that must already exist on an allowlisted page.

Dynamic URLs move part of the gate to run time, so it is now two layers:

| | checks |
|---|---|
| `validate()`, before anything runs | op vocabulary, origin allowlist, target **grammar**, plan length, no literal credentials |
| resolution, at step time | the parsed target must actually resolve on the live page |

`npm run check` asserts these stay rejected — re-run it after any change to
`ops.js` or `targets.js`:

```
click nope.nothing                              → Bad target — expected <role|label|…>:<name>
click css:#usr_nm_2                             → Unknown target strategy "css"
click button                                    → Bad target (no name)
goto "file:///etc/passwd"                       → goto needs an http(s) url
goto "http://169.254.169.254/latest/meta-data/" → origin is not allowlisted
goto "https://evil.example.com/"                → origin is not allowlisted
evaluate "fetch(1)"                             → unknown verb
```

---

## The DSL, and its picture

```
suite  "Cart total ignores quantity"
goto   "http://localhost:3000/shop.html"
fill   textbox:Search with "Widget"
fill   auth.password  with $secrets.QA_PASS
fill   profile.username with repeat("a", 20)
click  button:Add Widget
expect url contains "/cart"
expect text "Widget × 2"
expect value profile.username is repeat("a", 20)
wait   500
```

`parse.js` is a placeholder for a model emitting IR through a tool-use schema.
The validator and the diagram generator downstream don't care which produced
it — that's the point.

`diagram.js` turns the same IR into `block-beta`. Actions become grid cells,
`goto` becomes a full-width band, assertions become hexagons on the arrow
spine, and a credential shows as `← vault` — the value was never in the IR, so
the diagram is safe to paste into a ticket.

```mermaid
block-beta
  columns 3
  suite["Username length boundary · 11/11 run · 1 failed"]:3
  s0("1 ▶ http://localhost:3000/demo.html"):3
  s1["2 fill auth.email ← vault"]
  s2["3 fill auth.password ← vault"]
  s3["4 click auth.submit"]
  s4["5 click nav.settings"]
  s5{{"6 url ~ /settings"}}
  s6["7 click settings.profileTab"]
  s7["8 fill profile.username"]
  s8["9 click profile.save"]
  s9{{"10 text: Profile saved"}}
  s10{{"11 profile.username = 20 chars"}}
  space space
  err["✕ profile.username is 16 chars, expected 20 chars"]:3

  s0 --> s5
  s5 --> s9
  s9 --> s10

  classDef page fill:#ffe0b2,stroke:#fb8c00,stroke-width:2px,color:#4e342e
  classDef pass fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
  classDef fail fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#b71c1c
  class s0,s1,s2,s3,s4,s5,s6,s7,s8,s9 pass
  class s10,err fail
```

`npm run check:diagram` renders every generated diagram with the real mermaid
parser. Generated mermaid that doesn't parse is worse than none — it fails
silently inside someone else's docs.

---

## Files

| File | Role |
|---|---|
| `server.js` | express + ws, CDP screencast pump, executor loop |
| `cursor.js` | `VirtualCursor` — sole authority for pointer position |
| `targets.js` | target grammar, aliases, page discovery |
| `ops.js` | op vocabulary, origin allowlist, validation gate |
| `parse.js` | DSL text → JSON IR |
| `diagram.js` | JSON IR → mermaid `block-beta` |
| `public/index.html` | canvas feed, cursor overlay, editor, targets, diagram |
| `public/demo.html` | Meridian — truncates a username to 16 chars |
| `public/shop.html` | Nimbus — cart total ignores quantity |
| `scripts/check.js` | end-to-end: rejections, discovery, both runs |
| `scripts/check-diagram.js` | generated mermaid vs. the real parser |

---

## Five things that will bite you

**Ack every frame, first thing.** `Page.screencastFrameAck` is Chrome's
backpressure valve. Skip it and you get exactly one frame and then silence,
which presents as a broken WebSocket and is not.

**Delay the overlay to match the video.** Frames land ~120ms behind reality;
cursor events land in ~10ms. Without `LAG` the arrow clicks before the frame
showing the click, and the whole thing reads as glitching rather than as an
agent working.

**Frames are damage-driven, not a fixed framerate.** A static page emits
nothing, so a viewer connecting to an idle session sees a blank canvas —
`server.js` caches `lastFrame` and primes new clients. (`0 fps` on a settled
page is this, not a stall.)

**Clear the run lock before announcing the run ended.** `run.end` means "you
may start another run". Emitting it while still locked makes a caller that runs
back-to-back scripts hang on a silently refused second run.

**block-beta sizes cells roughly square, so label length drives the diagram's
height.** A 24-character budget produced 550×478 for eleven steps; leaving the
labels long produced 983×1192 for the same steps. Nested `block:…end` groups
are worse — they stretch their rows to ~2500px. `diagram.js` uses one flat grid
with full-width bands, and hexagons get a smaller budget than rectangles
because their angled sides eat usable width.

---

## Deliberately not here yet

- Screenshot artifacts, and shipping them to S3 rather than over the socket
- Human takeover (canvas clicks routed through the same `VirtualCursor`)
- Pause/resume gate in the executor loop
- `theatrical` / `normal` / `fast` modes — glide and typing delays turn a
  4-second test into ~25 seconds, right for demos and wrong for CI
- Timestamp-based overlay sync instead of a fixed `LAG` constant
- Auth on the WebSocket; one container per session; egress firewall
- `Target.attachedToTarget`, so a popup doesn't freeze the feed on the old page
- Discovery refresh on DOM mutation, not just on navigation — the panel goes
  stale when a click reveals new controls without navigating
