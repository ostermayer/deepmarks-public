# ─── Build stage ─────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Install build deps for native modules (lightning pulls in node-gyp stuff)
RUN apk add --no-cache python3 make g++ git

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# ─── Runtime stage ───────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Production deps only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as non-root
RUN addgroup -S dm && adduser -S dm -G dm && chown -R dm:dm /app
USER dm

EXPOSE 4000

# Use 127.0.0.1 explicitly, NOT 'localhost'. Alpine's /etc/hosts maps
# localhost to ::1 only (IPv6); fastify binds to 0.0.0.0 (IPv4 wildcard);
# wget tries IPv6 first, gets ECONNREFUSED, exits 1 — that's why this
# healthcheck failed 6000+ times in a row even though the service was
# healthy and serving real traffic on the same port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
