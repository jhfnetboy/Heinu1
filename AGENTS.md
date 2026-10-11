# Heinu1 agent instructions

Heinu1 receives WeChat messages through Tencent's official iLink API and runs a local coding CLI in the user's selected workspace. **Codex is the default backend**; Claude Code remains available with `AGENT_PROVIDER=claude`.

## Working on this repository

- All application code is in `bot/`. Never edit `libs/` reference submodules.
- Run `npm test` and `npx tsc --noEmit` from `bot/` for runner/session changes. `npm run smoke:codex` checks real authenticated Codex execution, file writes and conversation resume without sending WeChat messages.
- `agent/runner.ts` dispatches to `codex/runner.ts` or `claude/runner.ts`. Codex runs `codex exec --json` with the prompt over stdin; subsequent turns use `codex exec resume <thread-id> -`. Parse `thread.started`, tool items, agent messages and terminal turn events.
- Session storage remains at `src/claude/store.ts` for compatibility. SQLite sessions are scoped by `(user_openid, workspace, provider)`. Legacy rows migrate to `provider=claude`. Never pass a Claude UUID to Codex or delete old history during backend switches.
- Default `CODEX_MODEL` is unset: inherit the machine's Codex model configuration. A bot-specific override uses `CODEX_MODEL`. Do not edit global Codex model settings to configure this bot.
- Headless tasks use `approval_policy=never`; default `CODEX_SANDBOX_MODE=danger-full-access` preserves the existing owner-authorized full access. `workspace-write` and `read-only` are also supported.
- `/help` and `/status` must identify the active backend. `/stop` must abort the CLI and its command children. Never automatically replay a failed publishing task after tool execution.

## Live service

- Use `bot/ctl.sh`; label is `com.heinu1.wechat-bot`. Only one live iLink poller may run.
- `bot/launchd/com.heinu1.wechat-bot.plist` is a template. Runtime configuration is `~/Library/LaunchAgents/com.heinu1.wechat-bot.plist`; update it and reload the service for environment changes to apply.
- Before restarting, check for active CLI children. Back up the session DB before migrations and the installed plist before changes. Preserve WeChat token and workspace configuration; a backend change needs no QR login.
- Secrets belong outside the repo. Do not print token files, authentication JSON, or unfiltered environment variables.

## Blog workspace and editorial workflow

The owner's current default workspace is `/Users/jason/Dev/mycelium/blog`. Codex must load that project's `AGENTS.md` and `.agents/skills/` workflows when executing there.

- Topic discovery uses `forage` (the user may say “forge”). Fetch primary Hugging Face/model-card/repository sources, deduplicate published topics, and support claims with source evidence and actual local test results where available.
- This owner's established preference is to write and publish requested articles: use `blog-publisher`, including bilingual content, cover/inline imagery, `seo-geo`, M1 Blog, M2 WeChat drafts, live URL/list-order checks and publication records. Follow explicit instructions to draft only when given.
- Record reusable workflow preferences in the blog's `AGENTS.md`; record each completed batch in the forage feedback/publication ledger. Do not claim a MemPalace write succeeded unless verified.
- An integration test asking only for status or a short reply does not authorize publishing an article.
