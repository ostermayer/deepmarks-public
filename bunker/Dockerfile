# ─── Build stage ─────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# ─── Runtime stage ───────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Dedicated non-login user with a pinned uid/gid. The host-side deploy
# creates a matching bunker:bunker at uid/gid 900 so the bind-mounted
# nsec files (chmod 400 on host) are readable inside the container
# without being world-readable on the host. A container exploit gets
# uid 900, not root.
RUN addgroup -g 900 -S bunker \
 && adduser -u 900 -S -D -G bunker -H bunker \
 && chown -R bunker:bunker /app
USER bunker

EXPOSE 4100

# Use 127.0.0.1 explicitly, NOT 'localhost'. Alpine's /etc/hosts maps
# localhost to ::1 only (IPv6); fastify binds to 0.0.0.0 (IPv4 wildcard);
# wget tries IPv6 first, gets ECONNREFUSED, exits 1 — that's why this
# healthcheck failed 6000+ times in a row even though the bunker was
# fine and signing zap receipts the whole time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4100/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
