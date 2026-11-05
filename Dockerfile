# --- Stage 1: Build ---
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code and config
COPY tsconfig.json esbuild.config.mjs ./
COPY src/ ./src/

# Build the application
RUN npm run build

# --- Stage 2: Runtime ---
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

ARG VERSION=dev

WORKDIR /app

# Set the environment to production
ENV NODE_ENV=production
ENV VERSION=${VERSION}

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled gateway code (bundled by esbuild)
COPY --from=builder /app/dist ./dist

# Copy the committed supergraph snapshot served at runtime
COPY supergraph/ ./supergraph/

# Copy runtime configuration
COPY config/ ./config/

EXPOSE 4000

CMD ["node", "dist/gateway/index.js"]
