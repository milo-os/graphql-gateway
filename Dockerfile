# --- Stage 1: Build ---
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS builder

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
FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

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

# Run as the image's unprivileged node uid/gid (1000). Using the numeric id keeps
# the runtime identity visible in the image config, so runAsNonRoot can be
# verified from the image alone. The copied files and node_modules are
# world-readable but root-owned, so the process never needs write access below
# /app; mount a writable emptyDir at /tmp if a runtime dependency needs one.
USER 1000:1000

EXPOSE 4000

CMD ["node", "dist/gateway/index.js"]
