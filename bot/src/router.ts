import { ILinkMessage, ItemType } from './ilink/types';
import { Sender } from './ilink/sender';
import { SessionStore } from './claude/store';
import { runClaude, RunEvent } from './claude/runner';

const HELP = `🦞 Claude Code 微信机器人

直接发消息 → Claude Code 帮你干活

命令：
/new          开启新会话（不继承上下文）
/sessions     查看历史会话列表
/resume <n>   恢复第 n 个会话（默认1）
/status       查看当前状态
/stop         请求停止当前任务
/help         显示此帮助

提示：Claude Code 在你家里的笔记本上运行，
有完整的文件读写和命令执行权限。`;

export class Router {
  private activeSession = new Map<string, string>();   // userId → session_uuid
  private contextTokens = new Map<string, string>();   // userId → latest context_token
  private running       = new Set<string>();            // userId set

  constructor(
    private sender: Sender,
    private store:  SessionStore,
  ) {}

  async handle(msg: ILinkMessage) {
    const userId = msg.from_user_id;
    this.contextTokens.set(userId, msg.context_token);

    // Extract text from item_list
    const text = msg.item_list
      ?.filter(i => i.type === ItemType.TEXT && i.text_item?.text)
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

  private async handleCommand(userId: string, input: string) {
    const [cmd, ...rest] = input.split(/\s+/);
    switch (cmd.toLowerCase()) {
      case '/help': {
        await this.reply(userId, HELP);
        break;
      }
      case '/new': {
        if (this.running.has(userId)) {
          await this.reply(userId, '⏳ 当前有任务运行，结束后再开新会话');
          return;
        }
        this.activeSession.delete(userId);
        await this.reply(userId, '✅ 已重置，下一条消息将开启全新会话');
        break;
      }
      case '/sessions': {
        const sessions = this.store.list(userId);
        if (!sessions.length) { await this.reply(userId, '暂无历史会话'); return; }
        const lines = sessions.map((s, i) =>
          `${i + 1}. ${s.title}\n   ${formatAgo(Date.now() - s.last_used)}前`
        );
        await this.reply(userId, `📋 最近 ${sessions.length} 个会话：\n\n` + lines.join('\n\n'));
        break;
      }
      case '/resume': {
        if (this.running.has(userId)) {
          await this.reply(userId, '⏳ 有任务运行中，等完成后再切换'); return;
        }
        const n       = parseInt(rest[0] ?? '1', 10);
        const session = this.store.getByIndex(userId, n);
        if (!session) {
          await this.reply(userId, `❌ 找不到第 ${n} 个会话，发 /sessions 查看列表`); return;
        }
        this.activeSession.set(userId, session.session_uuid);
        await this.reply(userId, `✅ 已切换到：${session.title}\n继续发消息即可`);
        break;
      }
      case '/status': {
        const isRunning = this.running.has(userId);
        const uuid      = this.activeSession.get(userId);
        const session   = uuid ? this.store.getByUuid(uuid) : undefined;
        await this.reply(userId,
          `${isRunning ? '🔄 运行中' : '⏸ 空闲'}\n` +
          (session ? `当前会话：${session.title}` : '无活跃会话'),
        );
        break;
      }
      case '/stop': {
        await this.reply(userId, this.running.has(userId)
          ? '⚠️ 任务运行中，完成当前步骤后停止（Claude Code 不支持强制中断）'
          : '当前没有运行中的任务'
        );
        break;
      }
      default: {
        await this.reply(userId, `❓ 未知命令 ${cmd}，发 /help 查看帮助`);
      }
    }
  }

  private async runTask(userId: string, prompt: string) {
    if (this.running.has(userId)) {
      await this.reply(userId, '⏳ 上一个任务还在运行（/status 查看）');
      return;
    }
    this.running.add(userId);

    const ctxToken = this.contextTokens.get(userId)!;
    this.sender.sendTyping(userId, ctxToken); // best-effort, don't await

    const existingUuid  = this.activeSession.get(userId)
                          ?? this.store.getLatest(userId)?.session_uuid
                          ?? null;
    const textParts: string[] = [];
    const tools:    string[]  = [];
    let   newSessionId        = existingUuid;

    try {
      const finalSid = await runClaude(prompt, existingUuid, (ev: RunEvent) => {
        switch (ev.type) {
          case 'session_id': if (ev.sessionId) newSessionId = ev.sessionId; break;
          case 'text':       if (ev.text)      textParts.push(ev.text);     break;
          case 'tool':
            if (ev.toolName) tools.push(`🔧 ${ev.toolName}(${(ev.toolInput ?? '').slice(0, 60)})`);
            break;
          case 'result':
            if (ev.sessionId) newSessionId = ev.sessionId; break;
        }
      });

      if (finalSid) newSessionId = finalSid;

      if (newSessionId) {
        if (!this.store.getByUuid(newSessionId)) {
          const title = prompt.slice(0, 28) + (prompt.length > 28 ? '…' : '');
          this.store.create(userId, newSessionId, title);
        } else {
          this.store.touch(newSessionId);
        }
        this.activeSession.set(userId, newSessionId);
      }

      const fullText = textParts.join('').trim();
      const reply    = (tools.length ? tools.join('\n') + '\n\n' : '')
                     + (fullText || '（任务完成，无文字输出）');
      await this.reply(userId, reply);
    } catch (err: any) {
      console.error('[router] error:', err.message);
      await this.reply(userId, `❌ 出错了：${err.message}`);
    } finally {
      this.running.delete(userId);
    }
  }

  private async reply(userId: string, text: string) {
    const ctxToken = this.contextTokens.get(userId);
    if (!ctxToken) { console.error('[router] 没有 context_token for', userId); return; }
    await this.sender.send(userId, ctxToken, text);
  }
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  const h = Math.floor(m / 60),   d = Math.floor(h / 24);
  if (d) return `${d}天`; if (h) return `${h}小时`;
  if (m) return `${m}分钟`; return `${s}秒`;
}
