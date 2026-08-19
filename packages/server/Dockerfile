# Build from the repo root:  docker build -f packages/server/Dockerfile -t eraser-server .
# Multi-stage: node:22-slim build → distroless nonroot runtime.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# `pnpm deploy` produces a self-contained node_modules for the server package.
RUN pnpm --filter @eraserlabs/server deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /out ./
ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production RENDER_PAGES=0
EXPOSE 8080

# Read-only rootfs is expected at runtime; mount a writable volume at /fonts-cache.
# docker run --read-only -v fonts-cache:/fonts-cache -p 8080:8080 eraser-server
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["dist/index.js"]
