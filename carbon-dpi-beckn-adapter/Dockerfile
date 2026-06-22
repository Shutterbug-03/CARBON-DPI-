# ────────────────────────────────────────────────────────────────────────────
#  Carbon DPI Beckn Adapter — Multi-stage Docker Build
#  
#  Build:  docker build -t carbon-dpi-beckn-adapter .
#  Run:    docker run -p 3002:3002 --env-file .env carbon-dpi-beckn-adapter
# ────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

LABEL maintainer="Carbon DPI Contributors"
LABEL description="Carbon DPI Beckn BPP Adapter — standalone verification node"
LABEL version="1.1.0"

WORKDIR /app

# Only production dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -S cdpi && adduser -S cdpi -G cdpi
USER cdpi

EXPOSE 3002

ENV NODE_ENV=production
ENV PORT=3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/heartbeat || exit 1

CMD ["node", "dist/server.js"]
