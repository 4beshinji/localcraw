# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run CLI
npx tsx src/cli.ts chat                    # interactive chat
npx tsx src/cli.ts chat -m "message"       # one-shot
npx tsx src/cli.ts chat --hems             # chat with HEMS tools enabled
npx tsx src/cli.ts hems serve              # start openclaw-bridge replacement server
npx tsx src/cli.ts hems status             # show PC metrics snapshot
npx tsx src/cli.ts config                  # show config
npx tsx src/cli.ts memory search <query>   # search memories

# Development
npm run dev          # tsx watch (auto-reload)
npm run typecheck    # tsc --noEmit (no tests exist)

# Docker (HEMS)
docker build -t localcraw-hems:dev .
docker compose -f docker-compose.hems.yml up
```

## Architecture

**Runtime**: Node 23 + `tsx` (no compilation step). All local imports use `.ts` extensions. `allowImportingTsExtensions: true` + `noEmit: true` in tsconfig.

**Config**: `~/.localcraw/config.json` (JSON5). Validated via Zod in `src/config/index.ts`. HEMS extends base config with `loadHemsConfig()` in `src/hems/config.ts`, which overlays env vars on top.

### Core agent flow

1. `src/cli.ts` — Commander.js entry point. Instantiates `LLMClient`, `ToolRegistry`, `MemoryStore`, `Session`, then `AgentRunner`.
2. `src/agent/runner.ts` — Agent loop (max 10 iterations). Detects tool-calling mode (`native` / `react` / `auto`). Dispatches tool calls, feeds results back to LLM.
3. `src/agent/context.ts` — Assembles system prompt with injected memories + skills, applies context compression when needed.
4. `src/agent/session.ts` — JSONL append log at `~/.localcraw/sessions/<id>.jsonl`.

### LLM layer

- `src/llm/client.ts` — OpenAI-compatible client (works with Ollama, vLLM, OpenAI). Streams responses. Auto-detects native tool calling support.
- `src/llm/toolcall.ts` — ReAct XML fallback: `<tool>name</tool><params>{...}</params>`. Used when native tool calling is unavailable.
- `src/llm/compress.ts` — Token estimation (chars/4) and LLM-based summarization for long conversations.

### Memory

- `src/memory/store.ts` — SQLite via `node:sqlite` (built-in Node 22+; **not** better-sqlite3). Hybrid BM25 + cosine similarity search.
- `src/memory/embed.ts` — Embeddings via the configured `embedModel` (Ollama). Falls back to BM25-only if unavailable.

### Tools

`src/tools/registry.ts` — `Tool` interface + `ToolRegistry`. Each tool: `{ name, description, parameters, execute() }`.

Built-in tools: `filesystem` (read/write/list/search), `shell` (Docker sandbox), `web` (fetch).

HEMS-specific tools in `src/tools/hems/`: `pc` (metrics snapshot, process list), `mqtt` (publish), `ha` (Home Assistant REST API).

### Skills

`src/skills/loader.ts` — Loads `skills/SKILL.md` or `~/.localcraw/skills/SKILL.md`. Parses H2 sections as individual skills. Injects relevant skills into system prompt based on keyword matching.

### HEMS variant (`src/hems/`)

`HemsService` orchestrates: MQTT publisher (`HemsMqttPublisher`), service checkers (`ServiceCheckerManager`), HTTP API server (`HemsApiServer`), and optional Playwright browser (`HemsBrowser`).

- `metrics.ts` — PC snapshot via `systeminformation` (CPU freq/temp, memory, GPU, disk, processes).
- `server.ts` — HTTP API compatible with openclaw-bridge (`/health`, `/api/pc/status`, etc.).
- `services.ts` — Gmail (IMAP), GitHub (Octokit), browser checkers (Playwright JS eval).
- `browser.ts` — Playwright/Chromium manager. Only launched when `browserCheckers` are configured.

**HEMS env vars**: `MQTT_BROKER`, `MQTT_USER`, `MQTT_PASS`, `HEMS_GMAIL_*`, `HEMS_GITHUB_TOKEN`, `HEMS_HA_URL`, `HEMS_HA_TOKEN`, `HEMS_BROWSER_CHECKERS` (JSON array), `PORT`.

### Docker note

Do **not** combine `/proc:ro` mount with `pid:host` — AppArmor blocks healthcheck exec. Use `pid:host` alone (it automatically exposes host `/proc`).
