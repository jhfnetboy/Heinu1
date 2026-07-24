# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Heinu1 bridges WeChat to a local Claude Code CLI. A long-running daemon (`bot/`) receives WeChat
messages over Tencent's official **iLink Bot API** and, for each non-command message, spawns the
`claude` CLI as a subprocess in a configured workspace directory, streams its output back, and
replies to the user in WeChat. The user controls a home laptop's Claude Code from their phone.

All real code lives in `bot/`. The `libs/` tree is git submodules of reference projects only —
never edit them; they exist for protocol research (`docs/wechat-bot-research.md` is the canonical
iLink protocol write-up).

## Commands

Run everything from `bot/`. There is **no build, lint, or test suite** — TypeScript runs directly
via `tsx` (CommonJS, `strict: true`).

```bash
npm start            # run the daemon (also the first-time QR login flow)
npm run relogin      # clear saved token, force re-scan
npm run logs         # tail ~/.heinu1-bot/bot.log
npm run ws -- <sub>  # workspace config CLI: list | add <name> <path> [desc] | rm <name> | default <name> | show
bash setup.sh        # npm install + install the launchd auto-start agent
```

Type-check a change with `npx tsc --noEmit` (no emit config is wired up; `outDir: dist` is unused).

macOS service control (label `com.heinu1.wechat-bot`):
```bash
launchctl start/stop com.heinu1.wechat-bot
launchctl list | grep heinu1
```

## Architecture

### Two-process model
The daemon never embeds Claude — it shells out. `claude/runner.ts` does
`spawn("claude", ["--print", prompt, "--output-format", "stream-json", "--verbose",
"--permission-mode", <mode>, "--resume", <sessionId>?, "--add-dir", <dir>?], { cwd })` and parses
the JSONL event stream line-by-line: `system/init` → captures `session_id`; `assistant` content
blocks → `text` / `tool_use`; `result` → final summary + cost. The captured `session_id` is what
makes `--resume` work across messages — Claude Code holds the real conversation state, not us.

### Message flow
`main.ts` wires the pieces: `Monitor` long-polls iLink → `Router.handle()` → either `handleCommand`
(text starts with `/`) or `runTask` → `runClaude` → `Sender` posts the reply. `Sender` chunks
replies at `MAX_MSG_LEN` (1800) and best-effort sends a typing indicator first.

### iLink protocol layer (`bot/src/ilink/`)
- Every endpoint is under the **`/ilink/bot/` prefix** (omitting it gives HTTP 404 — a real trap).
- After QR login the server may return a **different `baseurl`**; all later requests must use it,
  not the default domain. The token + baseurl are persisted to `~/.heinu1-bot/token.json` (mode 600).
- The poll loop treats timeouts as normal (re-poll immediately) and reconnects after other errors.
  A fatal monitor error exits the process so launchd restarts it (and re-triggers QR login on an
  expired session). `KeepAlive.SuccessfulExit=false` means a clean exit (code 0) does NOT restart.
- Enum values in `types.ts` (MessageType, MessageState, MessageItemType) are copied verbatim from a
  reference SDK — treat them as ground truth, don't "clean them up".

### State & persistence
- **Router holds per-user in-memory state**: `activeSession` (userId→session uuid),
  `contextTokens` (needed to reply), and a `running` set enforcing **one concurrent task per user**.
  This state is lost on restart; sessions are recovered from SQLite via `getLatest`.
- **Workspaces** (`workspace.ts`, `~/.heinu1-bot/workspaces.json`): a named map of
  `name → { path, description, extra_dirs? }` plus a `default`. `WorkspaceManager` tracks each
  user's *current* workspace in memory. Switching workspace changes the `cwd` passed to `claude`
  AND clears the active session so the new workspace's last session resumes (or starts fresh).
- **Sessions** (`claude/store.ts`, `~/.heinu1-bot/sessions.db`, better-sqlite3): scoped by
  `(user_openid, workspace)`. Includes a runtime migration that `ALTER TABLE`s in the `workspace`
  column on old DBs. `/sessions` and `/resume <n>` index into the per-workspace `last_used` list.

### Knowledge base ingest
Turns carrying media (image/file/video) or a URL are auto-ingested into the **global MemPalace**
palace at `~/.mempalace/palace` (wing `heinu1`), shared across every Claude Code session on the
machine — not a local SQLite KB. `router.ts` appends a KB instruction to the prompt asking Claude
to emit a fenced ` ```kb-record ` JSON block; `kb/ingest.ts` parses that block after the run,
archives raw files, and `kb/mempalace-store.ts` writes the record by shelling out to
`kb/scripts/mp_bridge.py` (a Python bridge into the `mempalace` package). URLs are fetched via the
`libs/agent-reach` submodule (XiaoHongShu/公众号/web) before ingest. Plain-text-only turns are
never ingested (prevents chat noise polluting the KB). See `bot/CLAUDE.md` for the module
breakdown and `docs/kb-system-plan.md` / `docs/agent-reach-integration.md` for design detail.

### Configuration
`config.ts` centralizes paths (all under `~/.heinu1-bot/`) and reads env vars set in the launchd
plist: `CLAUDE_PERMISSION_MODE` (default `bypassPermissions`), `CLAUDE_BIN` (default `claude`),
`CLAUDE_MODEL` (default `claude-sonnet-4-6`, bot-only — does not affect interactive `claude` CLI
usage), and `MEMPALACE_PYTHON` (default `~/.mempalace/venv/bin/python`). `start.sh` exists to give
launchd a sane PATH (Homebrew/nvm/Volta) since it runs with a minimal environment; proxy exports
are present but commented out (uncomment if operating from behind a firewall).

## Gotchas
- `bot/launchd/com.heinu1.wechat-bot.plist` hardcodes `/Users/jason/Dev/tools/Heinu1/bot`, which is
  NOT this repo's location. The plist path must be fixed (or regenerated) before the service will
  run from a different checkout.
- The WeChat-facing command set (`/ws`, `/new`, `/sessions`, `/resume`, `/status`, `/help`) is
  defined entirely in `router.ts`'s `handleCommand`/`handleWs`. `/stop` works: it calls
  `AbortController.abort()`, which kills the `claude` subprocess via the `signal` option on `spawn`.
