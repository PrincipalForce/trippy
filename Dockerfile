# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Build the Rust engine to WebAssembly.
#
# We install wasm-pack from its pre-built GitHub release rather than
# `cargo install`. The cargo-install path tries to compile wasm-pack's
# transitive deps (which now require Rust edition2024, i.e. ≥1.85) — pulling
# the static binary sidesteps that toolchain coupling and shaves several
# minutes off the build.
# ─────────────────────────────────────────────────────────────────────────────
FROM rust:1.83-slim AS engine-builder

ARG WASM_PACK_VERSION=0.13.1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends pkg-config libssl-dev curl ca-certificates xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    rustup target add wasm32-unknown-unknown; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  triple="x86_64-unknown-linux-musl" ;; \
      aarch64) triple="aarch64-unknown-linux-musl" ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    tarball="wasm-pack-v${WASM_PACK_VERSION}-${triple}.tar.gz"; \
    url="https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${tarball}"; \
    curl -sSfL "$url" -o /tmp/wp.tgz; \
    tar -xzf /tmp/wp.tgz -C /tmp; \
    install -m 0755 "/tmp/wasm-pack-v${WASM_PACK_VERSION}-${triple}/wasm-pack" /usr/local/bin/wasm-pack; \
    rm -rf /tmp/wp.tgz /tmp/wasm-pack-v${WASM_PACK_VERSION}-${triple}; \
    wasm-pack --version

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
#
# Uses the official `nginx-unprivileged` image: same nginx, but runs as the
# non-root `nginx` user (UID 101) and listens on 8080 by default. Required
# for Cloud Run, GKE Autopilot, and any host that refuses root containers —
# and it's strictly better hygiene than running web servers as root.
#
# COOP/COEP/CORP headers are mandatory: the audio engine relies on
# SharedArrayBuffer, which the browser only exposes in a cross-origin-isolated
# context.
# ─────────────────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html

# Cloud Run, Fly, Render, and most PaaS hosts default to 8080.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
