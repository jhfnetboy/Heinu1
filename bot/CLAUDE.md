# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The parent-level CLAUDE.md (`../CLAUDE.md`) covers the overall architecture and commands. This file
adds detail specific to working inside `bot/`.

## Commands

```bash
npm start            # run the daemon (QR login on first run)
npm run relogin      # clear ~/.heinu1-bot/token.json, force re-scan
npm run logs         # tail ~/.heinu1-bot/bot.log
npm run ws -- <sub>  # workspace CLI: list | add <name> <path> [desc] | rm <name> | default <name>
npx tsc --noEmit     # type-check without emitting (no build step exists)
```

macOS service (label `com.heinu1.wechat-bot`):
```bash
launchctl start com.heinu1.wechat-bot
launchctl stop  com.heinu1.wechat-bot
launchctl list | grep heinu1
```

## Source module responsibilities

| File | Role |
|---|---|
| `main.ts` | Entry point: wires all components, starts monitor loop, handles SIGINT/SIGTERM |
| `config.ts` | All paths under `~/.heinu1-bot/`, env-var overrides (`CLAUDE_BIN`, `CLAUDE_PERMISSION_MODE`) |
| `router.ts` | Per-user state machine: `running` set, `activeSession`, `contextTokens`, `aborts` map |
| `workspace.ts` | `WorkspaceManager` (in-memory per-user selection) + JSON file persistence |
| `cli.ts` | The `npm run ws` workspace management binary — not the daemon |
| `ilink/auth.ts` | QR login flow, token save/load (`~/.heinu1-bot/token.json`, mode 600) |
| `ilink/client.ts` | `ILinkClient` (authenticated POST) + `ILinkPreAuth` (unauthenticated GET for QR) |
| `ilink/monitor.ts` | Long-poll loop (`/ilink/bot/getupdates`), cursor management, reconnect-on-error |
| `ilink/sender.ts` | Reply chunking at `MAX_MSG_LEN` (1800 chars) + typing indicator |
| `ilink/types.ts` | Verbatim enums from the iLink reference SDK — do not "clean up" their values |
| `claude/runner.ts` | Spawns `claude --print --output-format stream-json --verbose`, parses JSONL events |
| `claude/store.ts` | SQLite sessions table scoped by `(user_openid, workspace)` |
| `ilink/cdn.ts` | CDN media download + AES-128-ECB decryption; `saveMedia` writes to `~/.heinu1-bot/media/` |

## Claude JSONL stream format

`runClaude` in `claude/runner.ts` processes these event types from `claude --output-format stream-json --verbose`:

| `ev.type` / `ev.subtype` | What we extract |
|---|---|
| `system` / `init` | `session_id` — captured immediately for `--resume` |
| `assistant` | content blocks: `text` blocks → `RunEvent{type:'text'}`, `tool_use` blocks → `RunEvent{type:'tool'}` |
| `result` | `result` (final summary text), `session_id`, `cost_usd` |

Non-JSON lines (debug output from Claude) are silently skipped.

## iLink API conventions

- Every endpoint must start with `/ilink/bot/` — omitting this prefix returns HTTP 404.
- `ILinkClient.post` checks **both** HTTP status (non-2xx) **and** the `ret` field (`ret !== 0` is a
  business-logic error even on HTTP 200). See `client.ts:parseResponse`.
- After QR login the server may return a different `baseurl`; `main.ts` passes it to `ILinkClient`
  so all subsequent calls use it instead of the hardcoded default.
- `X-WECHAT-UIN` header must be a fresh random base64 value per request (see `client.ts:buildHeaders`).

## Turn-based message buffering

Non-command messages from the same user accumulate in a **PendingTurn** for `TURN_TIMEOUT_MS`
(default 10 s) of silence. When the timer fires, `flushTurn` runs:

1. `downloadTurnMedia` — downloads IMAGE / FILE / VIDEO items from the WeChat CDN (AES-128-ECB
   decrypt via `cdn.ts`), saves to `~/.heinu1-bot/media/<uuid>.<ext>`
2. `buildTurnPrompt` — assembles a single prompt string:
   - TEXT → raw text; VOICE → `[语音] <transcription>` or `[语音（未识别）]`
   - IMAGE/FILE/VIDEO → `[图片: /path]` / `[文件: name → /path]` / `[视频: /path]`
   - single plain-text message is passed through unchanged (no brackets)
3. `runTask` — spawns `claude` with the assembled prompt; `MEDIA_DIR` is always appended to
   `--add-dir` so Claude can read downloaded files

Commands (`/...`) execute immediately and bypass the turn buffer.
`/new` and `/stop` both cancel any pending turn before their normal action.

## Per-user state in Router

`Router` holds five in-memory maps keyed by `userId` (WeChat `from_user_id`):

- `activeSession`: the Claude Code session UUID for `--resume` (lost on restart; recovered via `store.getLatest`)
- `contextTokens`: the iLink `context_token` required to post a reply — refreshed on every incoming message
- `running`: a `Set` enforcing one concurrent task per user
- `aborts`: `AbortController` per in-flight task — passed as `signal` to `spawn()` so `/stop` terminates the subprocess
- `turns`: pending `PendingTurn` per user — cleared when the turn fires or is cancelled

`/stop` cancels a pending turn first; if none, sends `AbortController.abort()` to kill the subprocess.

## Workspace persistence

`WorkspaceManager` owns two layers:
- **File layer** (`~/.heinu1-bot/workspaces.json`): `{ default: string, workspaces: Record<name, {path, description, extra_dirs?}> }`. Written synchronously on any mutation.
- **Runtime layer**: `Map<userId, name>` — which workspace each user is currently on. Lost on restart; users fall back to `file.default`.

Switching workspace (`/ws <name>`) clears `activeSession` for that user, so the new workspace's last
SQLite session is resumed (or a fresh session starts).

## Gotchas

- `launchd/com.heinu1.wechat-bot.plist` hardcodes `/Users/jason/Dev/tools/Heinu1/bot` — fix or
  regenerate if the checkout path changes.
- `CLAUDE_PERMISSION_MODE` defaults to `bypassPermissions`. The daemon runs Claude Code with full
  trust; the user is assumed to be the laptop owner.
- `tsx` is CommonJS (`"type": "commonjs"` in `package.json`), `strict: true`. No emit, no bundler.
- `better-sqlite3` is synchronous — all DB calls block the event loop. Session DB ops are tiny and
  infrequent, so this is intentional.
- The `workspace` column in the sessions table was added in a migration; the `SessionStore`
  constructor `ALTER TABLE`s it in on old DBs automatically.
