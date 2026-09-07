# ghostclick recorder — Chrome extension

Records a flow in **your** browser, on **your** session, and hands it to
ghostclick to replay.

Teach mode inside ghostclick can only record apps its own headless Chrome can
reach. An app behind SSO, a VPN, or any real login is a wall. Your Chrome is
already through that wall — so the recorder goes there instead.

## Load it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this `extension/` directory
3. Open the app you want to record, click the toolbar icon to open the panel

## Recording

```
Start recording      captures the current URL as the first step
Pick element         arms the picker — the next click is HELD, not delivered
  → the panel asks   Click it / Type into it / Assert text visible / Cancel
  → you answer       the step is written AND the click is replayed for real
                     so the page advances
Assert current URL   a checkpoint with no element, for after a navigation
Undo step            drop the last one
Stop                 done
```

Repeat: pick, answer, land on the next page, pick again. Route changes are
recorded as assertions on their own, so the flow checks itself.

**Copy mermaid** puts it on the clipboard. **Send to ghostclick** posts it to
`http://localhost:3000/api/recording`, which validates it and drops it in the
script box — it is never run automatically. A human presses Run.

## Why the click is held

Arm the picker, click a sidebar link, and the page would navigate away while
the panel is still asking what you meant about a button that no longer exists.
So `content.js` swallows `pointerdown`, `mousedown`, `mouseup` and `click` in
the capture phase, and replays the real click only after you answer. Pick,
annotate, then perform — in that order, or nothing else works.

## Two files are shared, deliberately

`lib/propose.js` decides how an element gets named. The server's teach mode
reads that same file off disk and injects it, because the extension proposes a
target on your machine and the runner has to resolve the same one on ours. A
second copy would drift and you would find out in CI.

`lib/flow.js` and `lib/vocabulary.js` are copies of the repository's `flow.js`
and `vocabulary.js`. `npm run check:shared` asserts each is byte-identical to
its original, so a change to the language cannot silently leave the extension
behind, and `npm run sync:lang` is how you make them match again. The Vue app
holds a copy of the vocabulary for the same reason — `scripts/copies.js` lists
all three and `docs/BOUNDARY.md` explains why copying beats importing across a
project boundary.

## Replaying needs a session

The recording runs in ghostclick's own browser, which has none of your cookies.
Anything behind a login fails on the first step unless you **record the login
too** — a `type=password` field records as `$TODO`, and you map it to a vault
key before running.

Exporting cookies from your session would skip the login, but that is handing
live credentials to another process, so it is not in this PoC.

## Known gaps

- One tab, one frame. No iframes, no popups.
- Records click and fill. No select, drag, hover, or keyboard-only navigation.
- `Send to ghostclick` allows any origin, because an extension's origin is
  install-specific. The endpoint validates and stores; it never executes.
