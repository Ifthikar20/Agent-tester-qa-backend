# The runner: node, playwright, and a real Chromium.
#
# One stage. There used to be two, because building the UI needed vite and the
# whole devDependency tree while running the app needs a browser and four
# production packages, and one image with both would ship a bundler to
# production and a browser to the build. That stage cannot exist here any more:
# the UI is the poc-qa-stack repository (docs/BOUNDARY.md) and its source is
# not in this build context, so there is nothing to build and no reason for a
# second stage.
#
# WHICH LEAVES THE QUESTION OF HOW THE IMAGE GETS A UI, and the answer is:
# from outside, by one of two routes.
#
#   mount it       the deployment's answer, and the default. GC_WEB_DIR points
#                  at /app/ui, and docker/docker-compose.prod.yml bind-mounts
#                  the built UI over it read-only. A UI release is then a
#                  directory swap and a `docker compose up`, with no rebuild of
#                  an image whose contents did not change — which is the right
#                  shape for two repositories that release on their own clocks.
#
#   bake it        copy poc-qa-stack's dist/ into this context and build with
#                  --build-arg GC_WEB_SRC=<that path>. Right for an air-gapped
#                  registry, or anywhere a running container must not depend on
#                  a directory on the host.
#
# With neither, /app/ui is the placeholder committed at docker/no-ui/, whose
# index.html says what is missing and how to supply it. That is deliberate: the
# image must still RUN with no UI — the API, the socket and the recorder
# hand-off are all useful without one — and an operator who has skipped the
# mount should meet a page that explains itself rather than a 503 or a 404. It
# is also a page nobody can mistake for the app, which the empty directory it
# replaced was not.
#
# The base image is pinned by digest as well as by tag (docs/AUTH.md §12
# [ops-supply-3]): a tag is a name the registry can point somewhere else
# tomorrow, a digest is the image that was tested. To move, look the new one up
# with `docker buildx imagetools inspect <image:tag>` and change both.
#
# The Playwright image already contains the exact browser build this version
# expects. The tag MUST match the playwright version in package.json — a
# mismatch fails at launch with "Executable doesn't exist", which reads as a
# broken deploy rather than a version skew. The digest pins the exact image
# behind that tag; .github/workflows/check.yml runs inside the same one.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
WORKDIR /app
ENV NODE_ENV=production

# There is no .git in the image — .dockerignore excludes it so the build
# context cannot carry the repository into a layer. Without this argument
# /api/version reports null and the boot banner says "version -> unknown",
# which is a version stamp that has quietly stopped working.
ARG GC_GIT_SHA=""
ENV GC_GIT_SHA=$GC_GIT_SHA

COPY --chown=pwuser:pwuser package.json package-lock.json ./
# --ignore-scripts: nothing here needs a lifecycle script, and a package's
# install hook is arbitrary code from the registry running as the build. The
# lockfile decides what is installed; the hooks do not get a say.
#
# --omit=dev is kept even though this repository now declares no devDependencies
# at all. It costs nothing today and it is the line that keeps a bundler out of
# production on the day somebody adds one for a test runner.
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=pwuser:pwuser . .

# The UI, from wherever the build was told to take it. The default lands the
# placeholder; a real build gets --build-arg GC_WEB_SRC=<dir in the context>.
ARG GC_WEB_SRC=docker/no-ui
COPY --chown=pwuser:pwuser $GC_WEB_SRC ./ui
ENV GC_WEB_DIR=/app/ui

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
# `serve`, not `start`: start.js refuses to run without a built UI, and a
# container that must not start because a bind mount was forgotten is a worse
# outage than one serving a page that says what is missing. server.js is the
# half that is content either way.
CMD ["node", "server.js"]
