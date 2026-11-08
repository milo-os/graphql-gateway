# --- Stage 1: Build ---
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS builder

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
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

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
COPY --chown=node:node --from=builder /app/dist ./dist

# Copy the committed supergraph snapshot served at runtime
COPY --chown=node:node supergraph/ ./supergraph/

# Copy runtime configuration
COPY --chown=node:node config/ ./config/

# Run as the image's unprivileged node user (uid/gid 1000). The copied files and
# node_modules are world-readable, so the process never needs write access below
# /app; mount a writable emptyDir at /tmp if a runtime dependency needs one.
USER node

EXPOSE 4000

CMD ["node", "dist/gateway/index.js"]
