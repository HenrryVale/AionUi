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
# Run. The service runs as uid/gid 10001, so prefer named volumes: Docker
# initialises an empty one from the image directory, ownership and mode
# included, and both /data and /home/aionui are built owned by that account.
# /home/aionui is HOME, and holds the CLI agents' config and credentials
# (~/.claude, ~/.gemini) — mount it or recreating the container loses the login.
#   docker run -d -p 25808:25808 \
#       -v aionui-data:/data -v aionui-home:/home/aionui aionui-web
#
# Authentication. No account is authenticated and no credential is baked in at
# build time. Log the agents in once, after deploying, against the running
# container; the credentials land in the /home/aionui volume and persist:
#   docker exec -it <container> claude /login
#   docker exec -it <container> gemini          # then complete its sign-in flow
#
# A host bind mount keeps the host directory's own ownership — Docker never
# rewrites it — so give it to 10001 once before the first start. This recipe
# works under rootless Docker too, because the throwaway container writes
# through the same uid mapping the service will use:
#   mkdir -p data
#   docker run --rm --user 0 -v "$(pwd)/data:/data" aionui-web \
#       chown 10001:10001 /data
#
ARG SKILL_DESIGN_COMMIT=2fc19a167312c62022fe813490e52852c4afc0ff

# ---- Builder ----------------------------------------------------------------
# node:22-slim satisfies package.json "engines" (node >=22 <25) and matches the
# Node version used by the release workflow.
FROM node:22-slim AS builder

ARG SKILL_DESIGN_COMMIT

WORKDIR /app

# curl/tar/unzip are used by scripts/prepare-aioncore.js to fetch and unpack the
# backend release asset; ca-certificates is required for the HTTPS download.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 tar unzip \
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

# Curated Team role skills. The source repo and every upstream dependency it
# installs are pinned/audited; the staging script normalizes the skills CLI's
# agent-specific layout into one flat bundle. This happens at image build time,
# never from the mutable /workspace bind mount.
RUN set -eu; \
    mkdir -p /opt/skill-design; \
    git -C /opt/skill-design init -q; \
    git -C /opt/skill-design remote add origin https://github.com/HenrryVale/skill-design.git; \
    git -C /opt/skill-design fetch --depth 1 origin "$SKILL_DESIGN_COMMIT"; \
    git -C /opt/skill-design checkout -q --detach FETCH_HEAD; \
    test "$(git -C /opt/skill-design rev-parse HEAD)" = "$SKILL_DESIGN_COMMIT"; \
    python3 /opt/skill-design/scripts/validate.py; \
    python3 /opt/skill-design/scripts/stage_aionui_team.py /opt/aionui-team-skills --force; \
    test "$(find /opt/aionui-team-skills/bundle -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 17; \
    test ! -e /opt/aionui-team-skills/bundle/canvas-design; \
    test ! -e /opt/aionui-team-skills/bundle/design-taste-frontend; \
    test ! -e /opt/aionui-team-skills/bundle/webapp-testing; \
    mkdir -p "/opt/aionui-team-skills-versioned/$SKILL_DESIGN_COMMIT"; \
    cp -a /opt/aionui-team-skills/bundle/. "/opt/aionui-team-skills-versioned/$SKILL_DESIGN_COMMIT/"

COPY . .

# The application vendors the exact role-policy snapshot used by TypeScript.
# Fail the image build if it drifts from the pinned skill-design commit.
RUN cmp \
    /app/packages/desktop/src/renderer/pages/team/components/memberPicker/teamRoleSkillPolicy.snapshot.json \
    /opt/skill-design/pack/aionui-team-roles.json

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
# node:22-slim is still the base for two reasons: agent CLIs the user installs
# into the container themselves (npx-based tools) find a node/npm on PATH, and
# the Gemini CLI preinstalled below needs a real `node` at RUNTIME, not just at
# build time — see the CLI agents section for why. Gemini CLI declares
# engines.node >=20, which node:22-slim satisfies.
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

# Versioned, audited role-skill bundle. It remains root-owned under /app and is
# therefore immutable when the runtime container is launched with --read-only.
COPY --from=builder /opt/aionui-team-skills-versioned/ /app/team-skills/

# Claude QA capability wall. The hook and managed policy are baked outside HOME,
# root-owned, and become immutable at runtime because production runs with a
# read-only root filesystem. This is intentionally independent from Claude's
# permission mode: QA remains plan-mode as defence in depth, while PreToolUse
# enforces the closed capability surface before any tool execution.
COPY --from=builder /app/scripts/runtime/claude-qa-guard.mjs /app/claude-qa-guard.mjs
RUN install -d -o root -g root -m 0755 /etc/claude-code
COPY --from=builder /app/scripts/runtime/claude-managed-settings.json /etc/claude-code/managed-settings.json
RUN chmod 0444 /etc/claude-code/managed-settings.json /app/claude-qa-guard.mjs \
    && node --check /app/claude-qa-guard.mjs \
    && node -e "JSON.parse(require('fs').readFileSync('/etc/claude-code/managed-settings.json', 'utf8'))"

# /app stays root-owned so the service can read and execute it but cannot
# rewrite its own binary or the SPA it serves. a+rX grants read everywhere and
# execute only where it already applies (binaries and directories, never plain
# files); go-w drops the world-writable bit the pack step leaves on the static
# assets. Neither widens access the way a blanket 0777 would.
RUN chmod -R a+rX,go-w /app

# ---- CLI agents -------------------------------------------------------------
# Claude Code and Gemini CLI, installed from npm at pinned top-level versions
# rather than "latest", so rebuilds do not silently change the requested CLI
# versions.
#
# Keep lifecycle scripts and optional dependencies enabled as required by the
# published packages. The smoke checks below verify that both installed entry
# points actually execute before the image is accepted.
#
# Lifecycle scripts and optional dependencies must stay ENABLED here — the
# opposite of the builder stage's --ignore-scripts policy — because the Claude
# Code wrapper's postinstall (install.cjs) is what puts the CLI in place: it
# hardlinks the native binary out of the already-downloaded
# @anthropic-ai/claude-code-linux-x64 package over a placeholder stub. It makes
# NO network calls, so the step stays reproducible and offline once the registry
# fetch is done. With --ignore-scripts or --omit=optional you get a stub that
# only prints install instructions.
#
# Runtime dependency on node (answering "does this need npm/npx at runtime?"):
#   - claude  → NO. After the postinstall, /usr/local/bin/claude is a symlink
#               straight to an ELF binary. No Node process stays resident.
#   - gemini  → YES, `node` only (never npm/npx). Its bin is bundle/gemini.js,
#               a bundled JS entry point run by node. Dropping node from the
#               runtime image would break `gemini` while leaving `claude`
#               working.
#
# No credentials are baked in and no account is authenticated during build; the
# smoke check below runs under a throwaway HOME which is then deleted, so no
# ~/.claude or ~/.gemini from the build ever reaches the image.
#
# The chmod mirrors the /app treatment: npm preserves package modes, so remove
# group/other write bits while keeping the installed CLI trees readable and
# executable for uid 10001.
#
# The three --version calls are a build-time smoke check: they fail the build
# loudly rather than ship an image where an agent is silently a stub. They run
# under a throwaway HOME that is deleted in the same layer, together with any
# /root/.claude, /root/.claude.json, /root/.gemini and /root/.npm residue.
ARG CLAUDE_CODE_VERSION=2.1.236
ARG GEMINI_CLI_VERSION=0.60.0
ARG OPENCODE_VERSION=1.18.31
RUN set -eu \
    && npm install -g --no-audit --no-fund \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
	"opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && chmod -R a+rX,go-w \
        /usr/local/lib/node_modules/@anthropic-ai \
        /usr/local/lib/node_modules/@google \
        /usr/local/lib/node_modules/opencode-ai \
    && mkdir -p /tmp/cli-smoke \
    && HOME=/tmp/cli-smoke claude --version \
    && HOME=/tmp/cli-smoke command -v gemini \
    && HOME=/tmp/cli-smoke gemini --version \
    && HOME=/tmp/cli-smoke command -v opencode \
    && HOME=/tmp/cli-smoke opencode --version \
    && rm -rf /tmp/cli-smoke /root/.claude /root/.claude.json /root/.gemini /root/.npm

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

# HOME doubles as the CLI agents' config root: Claude Code writes ~/.claude and
# ~/.claude.json, Gemini CLI writes ~/.gemini. Those hold the subscription
# credentials created by a post-deploy login, so the directory has
# to be writable by the service account and has to survive container
# replacement — hence the declared volume below.
#
# `useradd --create-home` already made it, but its mode comes from
# /etc/login.defs HOME_MODE and would drift with the base image; restate it so
# the build is deterministic. 0700 keeps those credentials private to uid 10001.
#
# Same ordering rule as /data: this must come BEFORE the VOLUME instruction,
# because a later layer's changes to a declared volume path are discarded.
RUN install -d -o 10001 -g 10001 -m 0700 /home/aionui

# HOME is set explicitly: with a numeric USER, Docker would otherwise leave it
# at "/", which the service account cannot write, breaking any agent CLI that
# expects a usable home.
#
# DISABLE_AUTOUPDATER keeps the pinned Claude Code version authoritative. The
# CLI lives under /usr/local, which is root-owned while the service runs as
# 10001, so a self-update could not succeed anyway — this turns a recurring
# failed attempt into a no-op, and stops the image silently diverging from the
# version this Dockerfile pins. It is Claude Code's own variable — no claim is
# made that it affects the Gemini CLI, and no Gemini-specific workaround is
# added here.
ENV NODE_ENV=production \
    HOME=/home/aionui \
    DISABLE_AUTOUPDATER=1 \
    AIONUI_PORT=25808 \
    AIONUI_ALLOW_REMOTE=true \
    AIONUI_DATA_DIR=/data

# /data        — SQLite database and backend state
# /home/aionui — HOME: the CLI agents' config and credentials (~/.claude, ~/.gemini)
# Mount both:  -v aionui-data:/data -v aionui-home:/home/aionui
VOLUME ["/data", "/home/aionui"]

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
