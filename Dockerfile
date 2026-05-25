# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Build the Rust engine to WebAssembly.
# ─────────────────────────────────────────────────────────────────────────────
FROM rust:1.83-slim AS engine-builder

# wasm-pack pinned to match CI.
ARG WASM_PACK_VERSION=0.15.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && cargo install wasm-pack --locked --version "${WASM_PACK_VERSION}" \
 && rustup target add wasm32-unknown-unknown

WORKDIR /build

# Copy manifests first to maximize cache hits on dependency layers.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates

RUN wasm-pack build crates/trippy-engine \
      --target web \
      --out-dir /pkg \
      --release \
 && rm -f /pkg/.gitignore /pkg/README.md

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Install JS deps and build the web bundle.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS web-builder

RUN apk add --no-cache libstdc++ \
 && corepack enable \
 && corepack prepare pnpm@10.24.0 --activate

WORKDIR /app

# Manifests + lockfile first, for cached `pnpm install`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/trippy-format/package.json ./packages/trippy-format/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Now the source.
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json ./

# Drop in the wasm engine artifacts produced by stage 1.
COPY --from=engine-builder /pkg ./apps/web/src/engine/pkg

RUN pnpm --filter @trippy/web build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Serve the static bundle with nginx.
#           COOP/COEP headers are mandatory: the audio engine relies on
#           SharedArrayBuffer, which the browser only exposes in a
#           cross-origin-isolated context.
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html

# Cloud Run, Fly, Render, and most PaaS hosts default to 8080.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
