# ── localcraw-hems ─────────────────────────────────────────────────────────────
# Drop-in replacement for openclaw-bridge in the HEMS stack.
# Provides: PC metrics collection, Gmail/GitHub/browser checkers,
#           Home Assistant tools, and an HTTP API compatible with HEMS brain.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:23-slim

# System packages:
#   procps, lm-sensors — systeminformation host metrics
#   curl              — healthcheck
#   Playwright Chromium deps — browser control + HEMS_BROWSER_CHECKERS
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    lm-sensors \
    curl \
    # Chromium runtime dependencies (required by Playwright)
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Install Playwright's Chromium browser (cached in /root/.cache/ms-playwright)
RUN npx playwright install chromium

# Source files
COPY tsconfig.json ./
COPY src/ ./src/
COPY AGENTS.md ./
COPY skills/ ./skills/

# Runtime configuration
ENV PORT=8000
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production
# Playwright: use installed Chromium (skip auto-download at runtime)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/health || exit 1

CMD ["node_modules/.bin/tsx", "src/cli.ts", "hems", "serve"]
