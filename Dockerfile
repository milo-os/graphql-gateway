# --- Stage 1: Build ---
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0 AS builder

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
FROM node:26.12.1-trixie-slim@sha256:94816674c62774da0d099a947bf4613b9e1972a2733abd0d0cd80e795f8411d0

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
