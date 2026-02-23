# ── localcraw-hems ─────────────────────────────────────────────────────────────
# Drop-in replacement for openclaw-bridge in the HEMS stack.
# Provides: PC metrics collection, Gmail/GitHub checkers, Home Assistant tools,
#           and an HTTP API compatible with the HEMS brain tool calls.
#
# NOTE: Host metrics (CPU, memory, GPU, processes) require access to host
# namespaces. See docker-compose.hems.yml for the full runtime configuration.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:23-slim

# System utilities needed by systeminformation for host metric collection
RUN apt-get update && apt-get install -y --no-install-recommends \
    # GPU temperature / nvidia-smi fallback
    procps \
    # lm-sensors for CPU temperature (optional, graceful fallback if missing)
    lm-sensors \
    # curl for healthcheck
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Source files
COPY tsconfig.json ./
COPY src/ ./src/
COPY AGENTS.md ./
COPY skills/ ./skills/

# Runtime configuration
ENV PORT=8000
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

# Expose the API port (same as existing openclaw-bridge internal port)
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/health || exit 1

CMD ["node_modules/.bin/tsx", "src/cli.ts", "hems", "serve"]
