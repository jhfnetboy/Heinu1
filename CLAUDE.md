# CLAUDE.md

Read `AGENTS.md` first: it is the current provider-neutral project guidance. Codex is the default; Claude is an optional fallback. The Claude CLI details below describe that fallback.

## What this is

Heinu1 bridges WeChat to the local Codex CLI by default (optional Claude fallback).
The daemon receives messages through Tencent's official iLink API, runs the CLI in the
selected workspace and replies with the final summary. See `AGENTS.md` for current rules.

All real code lives in `bot/`. The `libs/` tree is git submodules of reference projects only —
never edit them; they exist for protocol research (`docs/wechat-bot-research.md` is the canonical
iLink protocol write-up).

## Commands

Run everything from `bot/`. There is no build or lint step; run `npm test` for the runner/session suite — TypeScript runs directly
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
`agent/runner.ts` dispatches to the configured CLI. `codex/runner.ts` runs `codex exec --json -`
with stdin prompts and `resume <thread-id> -` for later turns. `thread.started` captures the
thread ID, item events provide text/tools, and `turn.completed` finalizes the last agent message.
`claude/runner.ts` retains the legacy Claude stream-json integration for explicit fallback.

### Message flow
`main.ts` wires the pieces: `Monitor` long-polls iLink → `Router.handle()` → either `handleCommand`
(text starts with `/`) or `runTask` → `runAgent` → `Sender` posts the reply. `Sender` chunks
replies at `MAX_MSG_LEN` (1800) and best-effort sends a typing indicator first.

### iLink protocol layer (`bot/src/ilink/`)
- Every endpoint is under the **`/ilink/bot/` prefix** (omitting it gives HTTP 404 — a real trap).
- After QR login the server may return a **different `baseurl`**; all later requests must use it,
  not the default domain. The token + baseurl are persisted to `~/.heinu1-bot/token.json` (mode 600).
- The poll loop treats timeouts as normal (re-poll immediately) and reconnects after other errors.
  A fatal monitor error exits the process so launchd restarts it (and re-triggers QR login on an
  expired session). `KeepAlive=true` restarts even after clean exits; use `ctl.sh autostart off` to stop.
- Enum values in `types.ts` (MessageType, MessageState, MessageItemType) are copied verbatim from a
  reference SDK — treat them as ground truth, don't "clean them up".

### State & persistence
- **Router holds per-user in-memory state**: `activeSession` (userId→session uuid),
  `contextTokens` (needed to reply), and a `running` set enforcing **one concurrent task per user**.
  This state is lost on restart; sessions are recovered from SQLite via `getLatest`.
- **Workspaces** (`workspace.ts`, `~/.heinu1-bot/workspaces.json`): a named map of
  `name → { path, description, extra_dirs? }` plus a `default`. `WorkspaceManager` tracks each
  user's *current* workspace in memory. Switching workspace changes the `cwd` passed to the CLI
  AND clears the active session so the new workspace's last session resumes (or starts fresh).
- **Sessions** (`claude/store.ts`, `~/.heinu1-bot/sessions.db`, better-sqlite3): scoped by
  `(user_openid, workspace, provider)`. Includes a runtime migration that `ALTER TABLE`s in the `workspace`
  column on old DBs. `/sessions` and `/resume <n>` index into the per-workspace `last_used` list.

### Knowledge base ingest
All content turns, including plain text and voice, are auto-ingested into the **global MemPalace**
palace at `~/.mempalace/palace` (wing `heinu1`), shared across every Claude Code session on the
machine — not a local SQLite KB. `router.ts` appends a KB instruction to the prompt asking Claude
to emit a fenced ` ```kb-record ` JSON block; `kb/ingest.ts` parses that block after the run,
archives raw files, and `kb/mempalace-store.ts` writes the record by shelling out to
`kb/scripts/mp_bridge.py` (a Python bridge into the `mempalace` package). URLs are fetched via the
`libs/agent-reach` submodule (XiaoHongShu/公众号/web) before ingest. The original input is stored before writing. Publishing follows the owner-authorized default
three-part workflow, with dedup and verified completion. Durable failed jobs resume after restart. See `bot/CLAUDE.md` for the module
breakdown and `docs/kb-system-plan.md` / `docs/agent-reach-integration.md` for design detail.

### Configuration
`config.ts` reads `AGENT_PROVIDER` (default `codex`), `CODEX_BIN`, `CODEX_MODEL` (launchd template = gpt-6-luna; unset = local
model), `CODEX_REASONING_EFFORT` (medium), and `CODEX_SANDBOX_MODE` (default `danger-full-access`). Codex uses `approval_policy=never`.
`CLAUDE_BIN`, `CLAUDE_MODEL` and `CLAUDE_PERMISSION_MODE` apply only to the Claude fallback.
`MEMPALACE_PYTHON` defaults to `~/.mempalace/venv/bin/python`. `start.sh` provides launchd's PATH.

## Gotchas
- `bot/launchd/com.heinu1.wechat-bot.plist` is a template containing `__BOT_DIR__` / `__HOME__`;
  `setup.sh` renders it with the real paths into `~/Library/LaunchAgents/`. Editing the rendered
  copy is what takes effect — render/install the updated template, then run `ctl.sh autostart off` and `ctl.sh autostart on`.
- `bot/ctl.sh` is the start/stop entry point (`start|stop|restart|status|logs|fg` plus
  `autostart on|off|status`). Only one machine may run the bot at a time; deployment runbook for
  the always-on Mac mini is `docs/DEPLOY-MACMINI.md`.
- The WeChat-facing command set (`/ws`, `/new`, `/sessions`, `/resume`, `/status`, `/help`) is
  defined entirely in `router.ts`'s `handleCommand`/`handleWs`. `/stop` works: it calls
  `AbortController.abort()`, which kills Codex and its tool process group (or the Claude subprocess in fallback mode).
