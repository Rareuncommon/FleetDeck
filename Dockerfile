# node:20-slim chosen over alpine: better-sqlite3 compiles native bindings,
# and slim's glibc + toolchain link more reliably than alpine's musl.

# ---- builder: compile native deps (better-sqlite3) ----
FROM node:20-slim AS builder

# Build toolchain required by better-sqlite3's native compile step.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so `npm ci` is cached until deps actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: slim image without the build toolchain ----
FROM node:20-slim AS runtime

ENV NODE_ENV=production

# Non-root user to own and run the app.
RUN useradd -m -u 10001 fleetdeck

WORKDIR /app

# Bring in the already-compiled node_modules from the builder stage.
COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Application source. CHANGELOG.md is read at runtime by the "what's new"
# panel, so it must be in the image, not just the repo.
COPY src ./src
COPY CHANGELOG.md ./CHANGELOG.md

# Build provenance shown in Settings and /api/system/info. Pass at build time:
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) \
#                --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) .
# Baked as env vars so the running process can read them (no .git in the image).
ARG GIT_COMMIT=""
ARG BUILD_DATE=""
ENV GIT_COMMIT=$GIT_COMMIT
ENV BUILD_DATE=$BUILD_DATE

# SQLite data lives here; mount a host-path volume over it to persist state.
RUN mkdir -p /data && chown -R fleetdeck:fleetdeck /app /data
VOLUME ["/data"]

USER fleetdeck

# Documentation only — the actual bind is controlled by HTTP_PORT/HTTP_BIND env vars.
EXPOSE 8080

CMD ["node", "src/server.js"]
