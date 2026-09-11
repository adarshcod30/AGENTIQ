# AGENTIQ API: the image App Runner pulls from ECR (docs/05_AWS_ARCHITECTURE.md §2).
#
# The API ONLY. The frontend is a static build served from S3 + CloudFront, so
# nothing here needs Vite, React or their toolchains.

# ── build stage: resolve production dependencies ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually
# changes. Copying source first would rebuild node_modules on every edit.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY fixtures/package.json ./fixtures/

# --omit=dev keeps vitest, eslint and the Vite toolchain out of the image.
# --ignore-scripts blocks arbitrary postinstall scripts from running as root at
# build time, which is a supply-chain foothold this project should not leave open.
RUN npm ci --omit=dev --ignore-scripts

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# App Runner routes to this port; index.js reads PORT.
ENV PORT=3001

# Run as an unprivileged user. The node image ships one, so there is no reason
# for this process to be root: a compromised dependency should not inherit it.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server

USER node
EXPOSE 3001

# App Runner has its own health check, but this makes `docker run` locally
# behave the same way and documents the endpoint in one obvious place.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# EXEC form, not shell form. Shell form runs node as a child of /bin/sh, which
# does not forward SIGTERM: the container would ignore a graceful stop and get
# SIGKILLed after the grace period, dropping in-flight requests.
CMD ["node", "server/src/index.js"]
