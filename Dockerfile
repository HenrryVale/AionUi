# syntax=docker/dockerfile:1.7
#
# AionUi WebUI — standalone container image (no Electron, no Xvfb).
#
# Mirrors the release pipeline in .github/workflows/pack-web-cli.yml:
#   bun install  →  electron-vite build (out/renderer)  →  scripts/pack-web-cli.js
# The pack script downloads the pinned aioncore backend (package.json
# "aioncoreVersion") and compiles packages/web-cli into a single bun binary,
# producing the same tarball that scripts/install-web.sh installs on a host.
#
# Build (linux/amd64):
#   docker build -t aionui-web .
#
# The aioncore download hits GitHub release assets anonymously. If the build
# host is rate-limited, pass a token as a BuildKit secret — never as an ARG or
# ENV, which would persist in the image history:
#   docker build --secret id=gh_token,env=GH_TOKEN -t aionui-web .
#
# Run. The service runs as uid/gid 10001, so prefer a named volume: Docker
# initialises an empty one from the image directory, ownership and mode
# included, and /data is built owned by that account.
#   docker run -d -p 25808:25808 -v aionui-data:/data aionui-web
#
# A host bind mount keeps the host directory's own ownership — Docker never
# rewrites it — so give it to 10001 once before the first start. This recipe
# works under rootless Docker too, because the throwaway container writes
# through the same uid mapping the service will use:
#   mkdir -p data
#   docker run --rm --user 0 -v "$(pwd)/data:/data" aionui-web \
#       chown 10001:10001 /data
#
# ---- Builder ----------------------------------------------------------------
# node:22-slim satisfies package.json "engines" (node >=22 <25) and matches the
# Node version used by the release workflow.
FROM node:22-slim AS builder

WORKDIR /app

# curl/tar/unzip are used by scripts/prepare-aioncore.js to fetch and unpack the
# backend release asset; ca-certificates is required for the HTTPS download.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar unzip \
    && rm -rf /var/lib/apt/lists/*

# Pinned so image builds stay reproducible (the workflow tracks bun latest).
RUN npm install -g bun@1.4.2

# Dependency layer: workspace manifests only, so edits to source do not
# invalidate the install cache.
COPY package.json bun.lock ./
COPY patches/ ./patches/
COPY packages/desktop/package.json ./packages/desktop/
COPY packages/shared-scripts/package.json ./packages/shared-scripts/
COPY packages/web-cli/package.json ./packages/web-cli/
COPY packages/web-host/package.json ./packages/web-host/
#
# --ignore-scripts is load-bearing twice over.
#
# Correctness: the root "postinstall" is `node scripts/postinstall.js`, and this
# layer deliberately carries no scripts/ directory, so running lifecycle scripts
# here aborts the install outright. The script only calls `electron-builder
# install-app-deps`, which rebuilds native modules against Electron's ABI — the
# WebUI artifact ships no node_modules and loads none of them.
#
# Supply chain: it also blocks the install hooks of every dependency (electron,
# esbuild, sharp, better-sqlite3, electron-winstaller). None are needed — vite's
# esbuild and the rest resolve their prebuilt binaries from ordinary
# @scope/platform optional dependencies, not from an install hook, and nothing
# in this build ever launches Electron.
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

# Renderer SPA → out/renderer (consumed by pack-web-cli.js as static/).
RUN NODE_OPTIONS=--max-old-space-size=8192 \
    bunx electron-vite build --config packages/desktop/electron.vite.config.ts

# PACK_ARCH uses Node's arch naming ("x64"); pack-web-cli.js maps it to the
# "x86_64" tarball suffix itself.
RUN --mount=type=secret,id=gh_token \
    set -eu; \
    if [ -f /run/secrets/gh_token ]; then GH_TOKEN="$(cat /run/secrets/gh_token)"; export GH_TOKEN; fi; \
    PACK_PLATFORM=linux PACK_ARCH=x64 node scripts/pack-web-cli.js

# Unpack the release tarball so the runtime stage copies exactly what a host
# install of scripts/install-web.sh would lay down.
RUN mkdir -p /opt \
    && tar -xzf dist-web-cli/aionui-web-*-linux-x86_64.tar.gz -C /opt \
    && test -x /opt/aionui-web/aionui-web \
    && test -x /opt/aionui-web/bundled-aioncore/linux-x64/aioncore \
    && test -f /opt/aionui-web/static/index.html

# ---- Runtime ----------------------------------------------------------------
# The WebUI binary embeds its own bun runtime, and aioncore ships a managed
# Node under bundled-aioncore/*/managed-resources/node for the CLIs it manages.
# node:22-slim is still the base so that agent CLIs the user installs into the
# container themselves (npx-based tools) find a node/npm on PATH.
FROM node:22-slim AS runtime

# officecli (the Office preview component, auto-installed at runtime by the
# backend) is a .NET binary that aborts on startup without ICU, and Debian
# base images don't ship it. libicu-dev is version-agnostic so it keeps
# resolving the right libicuNN when the base image bumps Debian releases.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libicu-dev \
    && rm -rf /var/lib/apt/lists/*

# Dedicated unprivileged account. The ids are pinned rather than auto-assigned
# so that a host directory bind-mounted at /data can be chown'd to a stable,
# documented owner.
RUN groupadd --system --gid 10001 aionui \
    && useradd --system --uid 10001 --gid 10001 \
       --home-dir /home/aionui --create-home --shell /bin/sh aionui

WORKDIR /app

# Layout is load-bearing: web-cli resolves static/ and bundled-aioncore/
# as siblings of the executable via process.execPath.
COPY --from=builder /opt/aionui-web/ /app/

# /app stays root-owned so the service can read and execute it but cannot
# rewrite its own binary or the SPA it serves. a+rX grants read everywhere and
# execute only where it already applies (binaries and directories, never plain
# files); go-w drops the world-writable bit the pack step leaves on the static
# assets. Neither widens access the way a blanket 0777 would.
RUN chmod -R a+rX,go-w /app

# aioncore writes aionui-backend.db, logs/, runtime/, builtin-skills/ and its
# internal secrets under /data — web-cli passes it as the backend's data, cache
# and work dir, and spawns the backend with /data as its cwd — so the directory
# must be owned by the service account. 0700 keeps it private to that account.
#
# This must come BEFORE the VOLUME instruction: changes a later layer makes to
# a declared volume path are discarded. Getting it right here is what lets a
# brand-new named volume work with no host-side setup, since Docker seeds an
# empty volume from this directory's ownership and mode.
RUN install -d -o 10001 -g 10001 -m 0700 /data

# HOME is set explicitly: with a numeric USER, Docker would otherwise leave it
# at "/", which the service account cannot write, breaking any agent CLI that
# expects a usable home.
ENV NODE_ENV=production \
    HOME=/home/aionui \
    AIONUI_PORT=25808 \
    AIONUI_ALLOW_REMOTE=true \
    AIONUI_DATA_DIR=/data

# SQLite data volume — mount with: -v aionui-data:/data
VOLUME ["/data"]

# Above 1024, so the unprivileged account can bind it without CAP_NET_BIND_SERVICE.
EXPOSE 25808

USER 10001:10001

# The process would otherwise inherit umask 0000 and create its SQLite database
# and JSON state 0644 and its logs/, runtime/ and builtin-skills/ directories
# 0755. /data being 0700 already keeps those out of reach, so this is defence in
# depth: 0077 masks every group and other bit, landing new files at 0600 and new
# directories at 0700. aioncore and the agent CLIs it spawns inherit it.
#
# "start" is required as argv[0]: web-cli reads the subcommand positionally, so
# passing only "--remote" would be parsed as the command name and dropped.
#
# The shell is a wrapper, not a supervisor. `exec` replaces it in place, so
# aionui-web keeps the pid the shell was given — no intermediate process
# survives, nothing needs to forward signals, and `docker stop` delivers SIGTERM
# straight to the handler web-cli installs. node's docker-entrypoint.sh leaves
# this form alone: it only prepends `node` when argv[0] starts with "-", cannot
# be resolved, or names a non-executable file, and /bin/sh is none of those.
CMD ["/bin/sh", "-c", "umask 0077 && exec /app/aionui-web start --remote"]
