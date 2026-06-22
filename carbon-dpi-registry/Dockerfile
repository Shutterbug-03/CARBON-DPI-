FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and Prisma schema
COPY . .

# Generate Prisma Client and build
RUN npx prisma generate
RUN npm run build

# Production image
FROM node:20-alpine
WORKDIR /app

# Copy built assets and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Create directory for SQLite DB volume
RUN mkdir -p /data

# Default environment variables
ENV DATABASE_URL="file:/data/registry.db"
ENV PORT=3003
ENV NODE_ENV=production

EXPOSE 3003

# Automatically push schema to SQLite DB and start server
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
