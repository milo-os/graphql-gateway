# --- Stage 1: Build ---
# Both stages use the same Debian (glibc) image. Native modules such as the
# query planner install a binary for the build stage's C library, so the
# runtime stage must keep the same one (datum-cloud/infra#8476).
FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS builder

WORKDIR /app

# Install dependencies first so this layer stays cached until the lockfile
# changes. Node 26 ships no corepack, so install the pnpm that package.json's
# packageManager pins; it stays in this stage only. The split drops a
# `+sha512.` suffix, which npm can't parse.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager.split("+")[0]')" --no-audit --no-fund && \
    pnpm install --frozen-lockfile --prod=false --ignore-scripts

# Copy source code and config
COPY tsconfig.json esbuild.config.mjs ./
COPY src/ ./src/

# Build the application, then drop devDependencies
RUN pnpm build && \
    pnpm prune --prod --ignore-scripts

# --- Stage 2: Runtime ---
FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5

ARG VERSION=dev

WORKDIR /app

# Set the environment to production
ENV NODE_ENV=production
ENV VERSION=${VERSION}

# Copy package metadata and the pruned production dependencies
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

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
