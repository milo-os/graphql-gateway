#!/usr/bin/env bash
set -euo pipefail

image="${1:-graphql-gateway:smoke}"
here="$(cd "$(dirname "$0")" && pwd)"

docker build -t "$image" "$here/.."
docker run --rm \
  -v "$here/image-smoke:/app/image-smoke:ro" \
  "$image" node /app/image-smoke/plan-query.mjs
