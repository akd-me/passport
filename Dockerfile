# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/store/package.json packages/store/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run pack

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PASSPORT_DATA_DIR=/data \
    PASSPORT_HOST=0.0.0.0 \
    PASSPORT_PORT=3000
WORKDIR /app
COPY --from=build /build/apps/server/dist/*.tgz /tmp/passport.tgz
RUN npm install --global --omit=dev --no-audit --no-fund /tmp/passport.tgz \
    && rm /tmp/passport.tgz \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:" + process.env.PASSPORT_PORT + "/api/health", { signal: AbortSignal.timeout(4000) }).then(r => { if (!r.ok) process.exit(1); return r.json(); }).then(v => { if (!v.ok) process.exit(1); }).catch(() => process.exit(1))'
ENTRYPOINT ["passport"]
CMD ["serve"]
