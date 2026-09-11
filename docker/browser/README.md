# Attach the runner to a human-signed-in Chrome (experimental)

**Status: experimental, opt-in, and reversible.** It is a flag — `GC_CDP_URL`.
Set it and the runner drives an external Chrome; unset it and everything is
exactly as before. Nothing here changes the default. The runner-side branches
are marked `TODO(GC_CDP_URL)` in `server.js`.

## Why

The runner's own browser is automated, and some logins refuse an automated
browser outright — **"Continue with Google"** foremost (Google blocks sign-in
from a browser "controlled through software automation"), and a passkey or an
emailed code with it. So the flow past such a login cannot be recorded and
replayed the usual way.

A Chrome launched **normally** (no `--enable-automation` flag) and merely
**attached to** over CDP reports `navigator.webdriver = false` — it looks like an
ordinary browser, because it is one. So a **person** can sign in to it where the
runner's own browser is turned away, and the runner then drives that same
signed-in browser. Measured, both ways:

```
runner today   headless, launched   ->  navigator.webdriver = true,  UA says HeadlessChrome
this container  headful, attached    ->  navigator.webdriver = false, normal Chrome UA
```

This is the same idea as [Save my session](../../README.md#a-saved-sign-in-for-a-login-that-cant-be-recorded),
one step further: instead of copying the session out of your browser, the runner
drives the very browser you signed in to.

## Run it

```bash
docker compose -f docker/browser/docker-compose.browser.yml up -d
```

Two ports open, on localhost only:

| Port | For | What |
|---|---|---|
| **3001** | a person | The web desktop (KasmVNC). Open <http://localhost:3001>, go to the app, and **sign in by hand** — Google included. |
| **9222** | the runner | The CDP endpoint the runner attaches to. |

Then point the runner at it — the browser is in Docker, the runner stays on the
host:

```bash
GC_CDP_URL=http://localhost:9222 npm run app -- --auth
```

The boot banner confirms the mode:

```
  browser     ->  attached — driving an external Chrome at http://localhost:9222 (GC_CDP_URL); a person signs it in, webdriver stays false
```

Open the ghostclick console. It streams the same browser you signed in to at
:3001, and a run starts on the signed-in page — no Google login on the canvas,
because the login already happened, as a person, at :3001.

## What it does NOT do

- **It does not automate the Google login.** A person still does that once, at
  :3001; the profile volume keeps it. What is automated is everything *after*.
- **It is single-browser, single-person.** One shared profile, so there is no
  per-organisation isolation — this is the one-laptop shape, not the multi-tenant
  stack in [`../docker-compose.prod.yml`](../docker-compose.prod.yml). The runner
  does **not** inject a per-org saved session (sessions.js) in this mode, and does
  **not** apply the `GC_BLOCK_PRIVATE` reach sandbox to a person's real browser.
- **It is not hardened.** `9222` is an unauthenticated remote-control port and
  the profile holds a live login — hence localhost-only above. Do not expose
  either port to a network. Pin the image by digest before any non-local use.

## Reverting

Unset `GC_CDP_URL` (and `docker compose … down` the browser). The runner goes
straight back to launching its own headless browser. No code change is needed;
the launch path was never removed.

## Rough edges (it is a prototype)

- **Viewport.** The runner asks the attached page for a 1180×760 viewport so the
  drawn cursor lands true; a KasmVNC desktop may not honour a resize, and the
  feed can then be letterboxed or the cursor slightly off. Sizing the KasmVNC
  desktop to match is the fix.
- **The `cdp-proxy` sidecar is not optional.** Modern Chromium **ignores**
  `--remote-debugging-address` and binds the debug port to the container's own
  `127.0.0.1`, which a published port cannot reach. The `socat` sidecar (sharing
  Chrome's network namespace) forwards `0.0.0.0:9223 → 127.0.0.1:9222`, and the
  published `9222` lands on it. If `connectOverCDP` is refused, check that
  sidecar and `--remote-allow-origins=*` first — Chrome's CDP Host/Origin checks
  shift between versions.
- **Re-attach.** On a driver hand-off the runner re-attaches to the shared page
  rather than replacing the context; with one person that happens at most once.
  Multi-user driving of one shared browser is out of scope here.
