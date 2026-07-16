# --- Stage 1: Build ---
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code and config
COPY tsconfig.json esbuild.config.mjs ./
COPY src/ ./src/

# Build the application
RUN bun run build

# --- Stage 2: Runtime ---
FROM node:22-slim

ARG VERSION=dev

WORKDIR /app

# Set the environment to production
ENV NODE_ENV=production
ENV VERSION=${VERSION}

# Copy package files
COPY package.json bun.lock ./

# Install bun for production dependency install
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

# Install only production dependencies
RUN bun install --frozen-lockfile --production

# Copy compiled gateway code (bundled by esbuild)
COPY --from=builder /app/dist ./dist

# Copy runtime configuration
COPY config/ ./config/

EXPOSE 4000

CMD ["node", "dist/gateway/index.js"]
