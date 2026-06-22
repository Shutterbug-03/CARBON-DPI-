FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build
RUN npm run build

# Production image
FROM node:20-alpine
WORKDIR /app

# Copy built assets and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Default environment variables
ENV PORT=3005
ENV NODE_ENV=production

EXPOSE 3005

CMD ["node", "dist/index.js"]
