# The runner: node, playwright, and a real Chromium.
#
# Two stages, because the two halves need opposite things. Building the UI needs
# vite and the whole devDependency tree; running the app needs a browser and
# four production packages. One image with both would ship a bundler to
# production and a browser to the build.

# ---- 1 · the UI, with the control plane's address baked in ------------------
#
# VITE_AUTH_URL is read at BUILD time — it decides whether the app has a login
# at all and where that login lives. That is why it is a build argument: a
# runtime env var would arrive far too late, after the bundle was written.
FROM node:22-slim AS ui
WORKDIR /app
ARG VITE_AUTH_URL=""
COPY package.json package-lock.json ./
RUN npm ci
# web/ is self-contained on purpose (docs/BOUNDARY.md), so this is all it needs.
COPY web ./web
RUN VITE_AUTH_URL="$VITE_AUTH_URL" \
    node node_modules/vite/bin/vite.js build --config web/vite.config.js

# ---- 2 · the runner --------------------------------------------------------
#
# The Playwright image already contains the exact browser build this version
# expects. The tag MUST match the playwright version in package.json — a
# mismatch fails at launch with "Executable doesn't exist", which reads as a
# broken deploy rather than a version skew.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV NODE_ENV=production

# There is no .git in the image — .dockerignore excludes it so the build
# context cannot carry the repository into a layer. Without this argument
# /api/version reports null and the boot banner says "version -> unknown",
# which is a version stamp that has quietly stopped working.
ARG GC_GIT_SHA=""
ENV GC_GIT_SHA=$GC_GIT_SHA

COPY --chown=pwuser:pwuser package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=pwuser:pwuser . .
COPY --from=ui --chown=pwuser:pwuser /app/web/dist ./web/dist

# Run as a real user, not root. Chromium refuses to start as root without
# --no-sandbox, and disabling the sandbox on a service whose entire job is
# visiting URLs other people choose is the wrong trade to make for convenience.
#
# The directory is created and owned HERE so the named volume mounted over it
# inherits that ownership. Without this the volume arrives root-owned and the
# first write — the run history, the origin allowlist — fails.
# The COPYs above already land as pwuser, so this is only the mountpoint. A
# recursive chown of /app would rewrite every node_modules inode into a second
# full-size layer for no gain.
RUN mkdir -p /app/.ghostclick && chown pwuser:pwuser /app/.ghostclick
USER pwuser

EXPOSE 3000
# `serve`, not `start`: start.js exists to rebuild a stale UI, and there is no
# bundler in this image by design. The UI was built in stage 1.
CMD ["node", "server.js"]
