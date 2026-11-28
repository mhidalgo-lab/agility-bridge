# syntax=docker/dockerfile:1.29@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
# SPDX-License-Identifier: Apache-2.0
# agility-bridge server image (P2-11, L-102): built on the build platform (pure-JavaScript dependencies, so every target
# architecture needs only a copy, no emulation), run as a non-root user on distroless Node 24 with a read-only root
# filesystem and the database on the /data volume. Base images are pinned by digest (Renovate updates them).
#   docker build -f docker/Dockerfile -t agility-bridge:local .

ARG BUILD_IMAGE=node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:675c532423b908f9e56f9d60a4e62309b63cd2a3175acb90a46b96f7ee68e121

FROM --platform=$BUILDPLATFORM ${BUILD_IMAGE} AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter agility-bridge build \
 && pnpm --filter agility-bridge deploy --prod --legacy /out \
 && rm -rf /out/src /out/test /out/tsconfig.json /out/tsdown.config.ts /out/vitest.config.ts \
 && mkdir -p /data && chown 65532:65532 /data && chmod 700 /data

FROM ${RUNTIME_IMAGE}
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="agility-bridge" \
      org.opencontainers.image.description="Unofficial MCP server for Digital.ai Agility (agility-bridge serve)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/mhidalgo-lab/agility-bridge" \
      org.opencontainers.image.documentation="https://github.com/mhidalgo-lab/agility-bridge/blob/main/docs/guide/self-hosting.md" \
      org.opencontainers.image.vendor="agility-bridge contributors" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=build /out /app
COPY docker/healthcheck.mjs /app/healthcheck.mjs
COPY --from=build --chown=65532:65532 /data /data
ENV NODE_ENV=production AB_HOST=0.0.0.0 AB_PORT=8787 AB_DATA_DIR=/data
USER 65532:65532
WORKDIR /app
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["/nodejs/bin/node", "/app/healthcheck.mjs"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/index.mjs"]
CMD ["serve"]
