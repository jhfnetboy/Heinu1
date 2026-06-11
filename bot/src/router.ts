import { WeixinMessage, MessageItemType } from './ilink/types';
import { Sender } from './ilink/sender';
import { SessionStore } from './claude/store';
import { runClaude, RunEvent } from './claude/runner';
import { WorkspaceManager } from './workspace';

const HELP = `🦞 Claude Code 微信机器人

直接发消息 → Claude Code 帮你干活

─ 会话命令 ─
/new          开启新会话
/sessions     本工作区历史会话
/resume <n>   恢复第 n 个会话
/status       查看当前状态
/stop         请求停止任务

─ 工作区命令 ─
/ws                   列出全部工作区
/ws <名称>            切换工作区
/ws add <名称> <路径> <描述>  添加工作区
/ws rm <名称>         删除工作区
/ws default <名称>    设为默认工作区

/help         显示此帮助`;

export class Router {
  private activeSession = new Map<string, string>();   // userId → session_uuid
  private contextTokens = new Map<string, string>();   // userId → context_token
  private running       = new Set<string>();
  private aborts        = new Map<string, AbortController>();  // userId → in-flight task aborter

  constructor(
    private sender: Sender,
    private store:  SessionStore,
    private wsm:    WorkspaceManager,
  ) {}

  async handle(msg: WeixinMessage) {
    const userId = msg.from_user_id;
    this.contextTokens.set(userId, msg.context_token);

    const text = msg.item_list
      ?.filter(i => i.type === MessageItemType.TEXT && i.text_item?.text)
      .map(i => i.text_item!.text)
      .join('')
      .trim() ?? '';

    if (!text) {
      await this.reply(userId, '⚠️ 收到非文字消息，暂时只支持文字');
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(userId, text);
    } else {
      await this.runTask(userId, text);
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private async handleCommand(userId: string, input: string) {
    const parts = input.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();

    switch (cmd) {
      case '/help': {
        await this.reply(userId, HELP);
        break;
      }

      case '/ws': {
        await this.handleWs(userId, parts.slice(1));
        break;
      }

      case '/new': {
        if (this.running.has(userId)) {
          await this.reply(userId, '⏳ 当前有任务运行，结束后再开新会话'); return;
        }
        this.activeSession.delete(userId);
        const ws = this.wsm.currentName(userId);
        await this.reply(userId, `✅ 已重置会话\n工作区: ${ws}`);
        break;
      }

      case '/sessions': {
        const ws       = this.wsm.currentName(userId);
        const sessions = this.store.list(userId, ws);
        if (!sessions.length) {
          await this.reply(userId, `工作区 [${ws}] 暂无历史会话`); return;
        }
        const lines = sessions.map((s, i) =>
          `${i + 1}. ${s.title}\n   ${formatAgo(Date.now() - s.last_used)}前`
        );
        await this.reply(userId, `📋 [${ws}] 最近 ${sessions.length} 个会话：\n\n` + lines.join('\n\n'));
        break;
      }

      case '/resume': {
        if (this.running.has(userId)) {
          await this.reply(userId, '⏳ 有任务运行中，等完成后再切换'); return;
        }
        const ws      = this.wsm.currentName(userId);
        const n       = parseInt(parts[1] ?? '1', 10);
        const session = this.store.getByIndex(userId, ws, n);
        if (!session) {
          await this.reply(userId, `❌ 找不到第 ${n} 个会话，发 /sessions 查看列表`); return;
        }
        this.activeSession.set(userId, session.session_uuid);
        await this.reply(userId, `✅ 已切换到：${session.title}\n工作区: ${ws}`);
        break;
      }

      case '/status': {
        const ws      = this.wsm.currentName(userId);
        const wsDef   = this.wsm.current(userId);
        const uuid    = this.activeSession.get(userId);
        const session = uuid ? this.store.getByUuid(uuid) : undefined;
        await this.reply(userId,
          `${this.running.has(userId) ? '🔄 运行中' : '⏸ 空闲'}\n` +
          `工作区: ${ws} (${wsDef.path})\n` +
          (session ? `会话: ${session.title}` : '无活跃会话')
        );
        break;
      }

      case '/stop': {
        const aborter = this.aborts.get(userId);
        if (this.running.has(userId) && aborter) {
          aborter.abort();
          await this.reply(userId, '🛑 已发送停止信号，正在终止当前任务');
        } else {
          await this.reply(userId, '当前没有运行中的任务');
        }
        break;
      }

      default:
        await this.reply(userId, `❓ 未知命令 ${cmd}，发 /help 查看帮助`);
    }
  }

  // ── /ws subcommands ───────────────────────────────────────────────────────

  private async handleWs(userId: string, args: string[]) {
    // /ws  (no args) → list
    if (!args.length) {
      const current = this.wsm.currentName(userId);
      const list    = this.wsm.list();
      const lines   = list.map(w =>
        `${w.name === current ? '▶ ' : '  '}${w.name}  ${w.description}\n   ${w.path}`
      );
      await this.reply(userId, `📁 工作区列表：\n\n` + lines.join('\n\n') +
        `\n\n当前: ${current}\n发 /ws <名称> 切换`);
      return;
    }

    const sub = args[0].toLowerCase();

    // /ws add <name> <path> <description...>
    if (sub === 'add') {
      const [, name, wsPath, ...descParts] = args;
      if (!name || !wsPath) {
        await this.reply(userId, '用法: /ws add <名称> <路径> <描述>'); return;
      }
      const desc = descParts.join(' ') || name;
      const err  = this.wsm.add(name, wsPath, desc);
      await this.reply(userId, err ? `❌ ${err}` : `✅ 工作区 "${name}" 已添加\n路径: ${wsPath}`);
      return;
    }

    // /ws rm <name>
    if (sub === 'rm' || sub === 'remove') {
      const name = args[1];
      if (!name) { await this.reply(userId, '用法: /ws rm <名称>'); return; }
      const err = this.wsm.remove(name);
      await this.reply(userId, err ? `❌ ${err}` : `✅ 工作区 "${name}" 已删除`);
      return;
    }

    // /ws default <name>
    if (sub === 'default') {
      const name = args[1];
      if (!name) { await this.reply(userId, '用法: /ws default <名称>'); return; }
      const err = this.wsm.setDefault(name);
      await this.reply(userId, err ? `❌ ${err}` : `✅ 默认工作区已设为 "${name}"`);
      return;
    }

    // /ws <name>  → switch
    if (this.running.has(userId)) {
      await this.reply(userId, '⏳ 有任务运行中，等完成后再切换工作区'); return;
    }
    const name = args[0];
    const err  = this.wsm.switch(userId, name);
    if (err) { await this.reply(userId, `❌ ${err}`); return; }

    // When switching workspace, clear active session so we resume
    // the last session for the new workspace (or start fresh)
    this.activeSession.delete(userId);
    const wsDef    = this.wsm.current(userId);
    const lastSess = this.store.getLatest(userId, name);
    if (lastSess) {
      this.activeSession.set(userId, lastSess.session_uuid);
      await this.reply(userId,
        `✅ 已切换到工作区: ${name}\n路径: ${wsDef.path}\n` +
        `续接上次会话: ${lastSess.title}`
      );
    } else {
      await this.reply(userId,
        `✅ 已切换到工作区: ${name}\n路径: ${wsDef.path}\n（新工作区，将开启新会话）`
      );
    }
  }

  // ── Task runner ───────────────────────────────────────────────────────────

  private async runTask(userId: string, prompt: string) {
    if (this.running.has(userId)) {
      await this.reply(userId, '⏳ 上一个任务还在运行（/status 查看）');
      return;
    }
    this.running.add(userId);
    const aborter = new AbortController();
    this.aborts.set(userId, aborter);

    const wsName   = this.wsm.currentName(userId);
    const wsDef    = this.wsm.current(userId);
    this.sender.sendTyping(userId, this.contextTokens.get(userId)!);

    const preview = prompt.length > 40 ? prompt.slice(0, 40) + '…' : prompt;
    await this.reply(userId, `⚡ 收到，开始执行\n📁 工作区: ${wsName}\n📝 ${preview}`);

    const existingUuid = this.activeSession.get(userId)
                         ?? this.store.getLatest(userId, wsName)?.session_uuid
                         ?? null;

    const textParts: string[]   = [];   // assistant 中间文字（兜底用）
    const toolNames: Set<string> = new Set();  // 工具调用名称（去重）
    let resultText   = '';              // Claude 最终摘要（优先发这个）
    let newSessionId = existingUuid;

    try {
      const finalSid = await runClaude(
        prompt,
        {
          sessionId: existingUuid,
          cwd:       wsDef.path,
          extraDirs: wsDef.extra_dirs,
          signal:    aborter.signal,
        },
        (ev: RunEvent) => {
          switch (ev.type) {
            case 'session_id': if (ev.sessionId) newSessionId = ev.sessionId; break;
            case 'text':       if (ev.text)      textParts.push(ev.text);     break;
            case 'tool':       if (ev.toolName)  toolNames.add(ev.toolName);  break;
            case 'result':
              if (ev.sessionId) newSessionId = ev.sessionId;
              if (ev.text)      resultText   = ev.text;
              break;
          }
        },
      );
      if (finalSid) newSessionId = finalSid;

      if (newSessionId) {
        if (!this.store.getByUuid(newSessionId)) {
          this.store.create(userId, wsName, newSessionId,
            prompt.slice(0, 28) + (prompt.length > 28 ? '…' : ''));
        } else {
          this.store.touch(newSessionId);
        }
        this.activeSession.set(userId, newSessionId);
      }

      // 被 /stop 中断：发已停止提示，不当成正常完成
      if (aborter.signal.aborted) {
        const partial = (resultText || textParts.join('')).trim();
        await this.reply(userId, '🛑 任务已停止' +
          (partial ? `\n\n（已完成部分）\n${partial.slice(0, 300)}` : ''));
        return;
      }

      // 工具行：仅展示名称，去重
      const toolLine = toolNames.size
        ? '🔧 ' + [...toolNames].join(' · ') + '\n\n'
        : '';

      // 正文：优先用 result 摘要；没有则截断 assistant 文字兜底
      let body: string;
      if (resultText.trim()) {
        body = resultText.length > 600
          ? resultText.slice(0, 600) + `\n…(共${resultText.length}字)`
          : resultText;
      } else {
        const full = textParts.join('').trim();
        body = full.length > 400
          ? full.slice(0, 400) + `\n…(共${full.length}字，详情在工作区)`
          : full || '（任务完成）';
      }

      await this.reply(userId, toolLine + body);
    } catch (err: any) {
      console.error('[router] error:', err.message);
      await this.reply(userId, `❌ 出错了：${err.message}`);
    } finally {
      this.running.delete(userId);
      this.aborts.delete(userId);
    }
  }

  private async reply(userId: string, text: string) {
    const ctxToken = this.contextTokens.get(userId);
    if (!ctxToken) { console.error('[router] no context_token for', userId); return; }
    await this.sender.send(userId, ctxToken, text);
  }
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  const h = Math.floor(m / 60),   d = Math.floor(h / 24);
  if (d) return `${d}天`; if (h) return `${h}小时`;
  if (m) return `${m}分钟`; return `${s}秒`;
}
