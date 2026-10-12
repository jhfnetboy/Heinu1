# Heinu1 agent instructions

Heinu1 receives WeChat messages through Tencent's official iLink API and runs a local coding CLI in the user's selected workspace. **Codex is the default backend**; Claude Code remains available with `AGENT_PROVIDER=claude`.

## Working on this repository

- All application code is in `bot/`. Never edit `libs/` reference submodules.
- Run `npm test` and `npx tsc --noEmit` from `bot/` for runner/session changes. `npm run smoke:codex` checks real authenticated Codex execution, file writes and conversation resume without sending WeChat messages.
- `agent/runner.ts` dispatches to `codex/runner.ts` or `claude/runner.ts`. Codex runs `codex exec --json` with the prompt over stdin; subsequent turns use `codex exec resume <thread-id> -`. Parse `thread.started`, tool items, agent messages and terminal turn events.
- Session storage remains at `src/claude/store.ts` for compatibility. SQLite sessions are scoped by `(user_openid, workspace, provider)`. Legacy rows migrate to `provider=claude`. Never pass a Claude UUID to Codex or delete old history during backend switches.
- The launchd template defaults to `CODEX_MODEL=gpt-6-luna` and `CODEX_REASONING_EFFORT=medium`. If `CODEX_MODEL` is unset in manual runs, inherit the machine configuration. Never change global Codex settings for bot-specific preferences.
- Headless tasks use `approval_policy=never`; default `CODEX_SANDBOX_MODE=danger-full-access` preserves the existing owner-authorized full access. `workspace-write` and `read-only` are also supported.
- `/backend codex|claude` explicitly switches per user; `/model luna|terra|sol [medium]` changes Codex model/effort. Preferences persist in SQLite and users cannot change another user's backend. Block changes while a task, pending turn or queue exists. Switching back resumes that provider's own latest conversation; context does not cross providers.
- Codex quota failures offer `/backend claude`; do not automatically replay tasks on a different backend. A valid Claude login can still have exhausted quota.
- `/help` and `/status` must identify the active backend. `/stop` must abort the CLI and its command children. Failed workflow jobs persist their full input/context and retry at most three times with a delay. Always deduplicate and reconcile Blog/WeChat/KB evidence before continuing; never recreate completed drafts or blindly replay a publish operation.

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

## Default content pipeline (owner confirmed 2026-10-11)

- Every non-command content message, including plain text and voice, defaults to: KB → bilingual article with a matching banner → live Blog + WeChat Official Account draft. Slash commands, routine status/chat and explicit read-only/no-publish requests retain their intended meaning; do not turn control commands into public articles.
- `workflow.ts` selects Luna Medium for routine queries and Sol Medium for research or the complete pipeline, before launching the CLI. Default model routing is automatic within Codex. This is distinct from provider fallback: switching to Claude remains explicit. `/model auto` restores routing; explicit `/model luna|terra|sol ...` pins the model until auto is restored.
- Run the blog's duplicate checker before writing. Then archive the full original input in KB before any writing. Existing articles/drafts are reconciliation targets; KB-only material is still allowed to become its first article.
- Use the installed, current MemPalace environment. Do not force-import the old local checkout or write to a modern Chroma DB with the old 0.6 client. Verify writes by reading them back. The MCP package redirects fd 1 during import; keep the bridge JSON output on a preserved descriptor.
- `workflow_jobs` in SQLite stores source material, workspace, attempts, confirmed KB receipt, session and publication proof. Startup recovers interrupted jobs. `/jobs` lists failures; `/retry all` retries the current user's failed jobs. `/stop` cancels the current job without auto-retrying it.
- Completion requires verified KB, existing article/banner, matching M2 media ID and HTTP-success Blog URL. A reply delivery failure after successful verification must not turn a completed publication into a retry job.

- Incoming content is persisted in `message_inbox` before the 30-second turn buffer. Redelivered message IDs are ignored; startup restores buffered material. Creating a workflow job and attaching its receipts is one transaction, avoiding loss or duplicate jobs across a restart. `/stop` cancels buffered receipts too.
- KB writes use MemPalace's current backend wrapper so its writer lock is shared with CLI/MCP writers. Public publication ledgers strip bot user/session routing identifiers.
- Treat history checks, failure compensation and bot troubleshooting as maintenance, not article subjects. Preserve remote dedup failure details. WeChat 40164 is an IP allowlist configuration failure, never a Codex login failure; mark the job `blocked`, stop automatic retries and retain it for explicit `/retry all` after repair. Still archive the original material to KB before surfacing a remote-ledger failure; no writing may start while dedup is incomplete.
