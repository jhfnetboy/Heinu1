import { randomUUID } from 'crypto';
import { WeixinMessage, MessageItem, MessageItemType } from './ilink/types';
import { Sender } from './ilink/sender';
import { SessionStore } from './claude/store';
import { runClaude, RunEvent } from './claude/runner';
import { WorkspaceManager } from './workspace';
import { CONFIG } from './config';
import { downloadMedia, saveMedia, guessExt } from './ilink/cdn';

const HELP = `🦞 Claude Code 微信机器人

直接发消息 → Claude Code 帮你干活
支持：文字、图片、语音、文件（含PDF）、视频

─ 会话命令 ─
/new          开启新会话（也取消当前轮次）
/sessions     本工作区历史会话
/resume <n>   恢复第 n 个会话
/status       查看当前状态
/stop         停止任务或取消待发轮次

─ 工作区命令 ─
/ws                   列出全部工作区
/ws <名称>            切换工作区
/ws add <名称> <路径> <描述>  添加工作区
/ws rm <名称>         删除工作区
/ws default <名称>    设为默认工作区

/help         显示此帮助`;

// ── Turn buffer types ─────────────────────────────────────────────────────────

interface TurnItem {
  type:           MessageItemType;
  text?:          string;       // TEXT body or VOICE transcription
  fileName?:      string;       // FILE original name
  rawItem:        MessageItem;  // preserved for CDN download
  localPath?:     string;       // set after successful CDN download
  downloadError?: string;       // set if CDN download fails
}

interface PendingTurn {
  items: TurnItem[];
  timer: ReturnType<typeof setTimeout>;
}

export class Router {
  private activeSession = new Map<string, string>();
  private contextTokens = new Map<string, string>();
  private running       = new Set<string>();
  private aborts        = new Map<string, AbortController>();
  private turns         = new Map<string, PendingTurn>();

  constructor(
    private sender: Sender,
    private store:  SessionStore,
    private wsm:    WorkspaceManager,
  ) {}

  async handle(msg: WeixinMessage) {
    const userId = msg.from_user_id;
    this.contextTokens.set(userId, msg.context_token);

    const items = msg.item_list ?? [];
    if (!items.length) {
      await this.reply(userId, '⚠️ 收到空消息');
      return;
    }

    // Extract text content for command detection only
    const text = items
      .filter(i => i.type === MessageItemType.TEXT && i.text_item?.text)
      .map(i => i.text_item!.text)
      .join('')
      .trim();

    // Commands execute immediately, bypassing the turn buffer
    if (text.startsWith('/')) {
      await this.handleCommand(userId, text);
      return;
    }

    // All other messages (text, image, voice, file, video) accumulate in the turn
    await this.addToTurn(userId, items);
  }

  // ── Turn buffer ───────────────────────────────────────────────────────────

  private async addToTurn(userId: string, msgItems: MessageItem[]) {
    const newItems = this.toTurnItems(msgItems);
    if (!newItems.length) return;

    const existing = this.turns.get(userId);
    const isFirst  = !existing;

    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(...newItems);
    }

    const allItems = existing ? existing.items : newItems;
    const timer    = setTimeout(() => this.flushTurn(userId), CONFIG.TURN_TIMEOUT_MS);
    this.turns.set(userId, { items: allItems, timer });

    if (isFirst) {
      const sec     = CONFIG.TURN_TIMEOUT_MS / 1000;
      const summary = this.describeTurnItems(newItems);
      await this.reply(userId, `⏳ 收到：${summary}\n${sec}秒内可继续发送，之后开始处理`);
    }
    // Subsequent messages: WeChat delivery receipt is sufficient feedback
  }

  private toTurnItems(msgItems: MessageItem[]): TurnItem[] {
    const result: TurnItem[] = [];
    for (const item of msgItems) {
      switch (item.type) {
        case MessageItemType.TEXT:
          if (item.text_item?.text?.trim()) {
            result.push({ type: item.type, text: item.text_item.text.trim(), rawItem: item });
          }
          break;
        case MessageItemType.VOICE:
          result.push({
            type:    item.type,
            text:    item.voice_item?.text?.trim() || undefined,
            rawItem: item,
          });
          break;
        case MessageItemType.IMAGE:
          result.push({ type: item.type, rawItem: item });
          break;
        case MessageItemType.FILE:
          result.push({ type: item.type, fileName: item.file_item?.file_name, rawItem: item });
          break;
        case MessageItemType.VIDEO:
          result.push({ type: item.type, rawItem: item });
          break;
      }
    }
    return result;
  }

  private async flushTurn(userId: string) {
    const turn = this.turns.get(userId);
    if (!turn) return;
    this.turns.delete(userId);

    if (this.running.has(userId)) {
      await this.reply(userId, '⏳ 上一个任务还在运行，本轮消息已丢弃，请稍后重发');
      return;
    }

    // Download media files before building the prompt
    await this.downloadTurnMedia(userId, turn.items);

    const prompt = this.buildTurnPrompt(turn.items);
    await this.runTask(userId, prompt);
  }

  /** Download IMAGE and FILE items, store localPath on the item in-place. */
  private async downloadTurnMedia(userId: string, items: TurnItem[]) {
    const downloads = items.filter(
      i => (i.type === MessageItemType.IMAGE ||
            i.type === MessageItemType.FILE  ||
            i.type === MessageItemType.VIDEO) && !i.localPath
    );
    if (!downloads.length) return;

    await this.reply(userId, `📥 下载媒体文件 (${downloads.length} 个)...`);

    for (const item of downloads) {
      try {
        let data: Buffer;
        let filename: string;

        if (item.type === MessageItemType.IMAGE) {
          const img = item.rawItem.image_item!;
          data      = await downloadMedia(img.media, img.aeskey);
          filename  = `${randomUUID()}${guessExt(data)}`;
        } else if (item.type === MessageItemType.FILE) {
          const f  = item.rawItem.file_item!;
          data     = await downloadMedia(f.media);
          const original = f.file_name ?? '';
          filename = original
            ? `${randomUUID()}-${original.replace(/[^a-zA-Z0-9._-]/g, '_')}`
            : `${randomUUID()}${guessExt(data)}`;
          item.fileName = original || filename;
        } else {
          // VIDEO — download the main video stream
          const v  = item.rawItem.video_item!;
          data     = await downloadMedia(v.media);
          filename = `${randomUUID()}.mp4`;
        }

        item.localPath = await saveMedia(data, filename);
        console.log(`[router] 已下载: ${item.localPath} (${data.length} bytes)`);
      } catch (err: any) {
        console.error(`[router] 媒体下载失败: ${err.message}`);
        item.downloadError = err.message;
      }
    }
  }

  private buildTurnPrompt(items: TurnItem[]): string {
    // Single plain-text message: pass through unchanged
    if (items.length === 1 && items[0].type === MessageItemType.TEXT) {
      return items[0].text!;
    }

    const parts: string[] = [];
    for (const item of items) {
      switch (item.type) {
        case MessageItemType.TEXT:
          parts.push(item.text!);
          break;
        case MessageItemType.VOICE:
          parts.push(item.text ? `[语音] ${item.text}` : '[语音（未识别）]');
          break;
        case MessageItemType.IMAGE:
          if (item.localPath)       parts.push(`[图片: ${item.localPath}]`);
          else if (item.downloadError) parts.push(`[图片（下载失败: ${item.downloadError}）]`);
          else                      parts.push('[图片]');
          break;
        case MessageItemType.FILE:
          if (item.localPath)       parts.push(`[文件: ${item.fileName ?? ''} → ${item.localPath}]`);
          else if (item.downloadError) parts.push(`[文件: ${item.fileName ?? '未知'}（下载失败: ${item.downloadError}）]`);
          else                      parts.push(`[文件: ${item.fileName ?? '未知'}]`);
          break;
        case MessageItemType.VIDEO:
          if (item.localPath)          parts.push(`[视频: ${item.localPath}]`);
          else if (item.downloadError) parts.push(`[视频（下载失败: ${item.downloadError}）]`);
          else                         parts.push('[视频]');
          break;
      }
    }
    return parts.join('\n');
  }

  private describeTurnItems(items: TurnItem[]): string {
    return items.map(i => {
      switch (i.type) {
        case MessageItemType.TEXT:  return '文字';
        case MessageItemType.VOICE: return '语音';
        case MessageItemType.IMAGE: return '图片';
        case MessageItemType.FILE:  return i.fileName ? `文件(${i.fileName})` : '文件';
        case MessageItemType.VIDEO: return '视频';
        default: return '未知';
      }
    }).join(' + ');
  }

  private cancelPendingTurn(userId: string): boolean {
    const turn = this.turns.get(userId);
    if (!turn) return false;
    clearTimeout(turn.timer);
    this.turns.delete(userId);
    return true;
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
        const hadTurn = this.cancelPendingTurn(userId);
        if (this.running.has(userId)) {
          await this.reply(userId, '⏳ 当前有任务运行，结束后再开新会话'); return;
        }
        this.activeSession.delete(userId);
        const ws = this.wsm.currentName(userId);
        await this.reply(userId,
          `✅ 已重置会话\n工作区: ${ws}` + (hadTurn ? '\n（待处理的消息轮次已取消）' : ''));
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
        const turn    = this.turns.get(userId);
        await this.reply(userId,
          `${this.running.has(userId) ? '🔄 运行中' : turn ? '⏳ 收集消息中' : '⏸ 空闲'}\n` +
          `工作区: ${ws} (${wsDef.path})\n` +
          (turn ? `待处理: ${this.describeTurnItems(turn.items)}\n` : '') +
          (session ? `会话: ${session.title}` : '无活跃会话')
        );
        break;
      }

      case '/stop': {
        // First cancel any pending turn
        if (this.cancelPendingTurn(userId)) {
          await this.reply(userId, '🛑 已取消待处理的消息轮次');
          return;
        }
        // Then abort any running task
        const aborter = this.aborts.get(userId);
        if (this.running.has(userId) && aborter) {
          aborter.abort();
          await this.reply(userId, '🛑 已发送停止信号，正在终止当前任务');
        } else {
          await this.reply(userId, '当前没有运行中的任务或待处理的轮次');
        }
        break;
      }

      default:
        await this.reply(userId, `❓ 未知命令 ${cmd}，发 /help 查看帮助`);
    }
  }

  // ── /ws subcommands ───────────────────────────────────────────────────────

  private async handleWs(userId: string, args: string[]) {
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

    if (sub === 'rm' || sub === 'remove') {
      const name = args[1];
      if (!name) { await this.reply(userId, '用法: /ws rm <名称>'); return; }
      const err = this.wsm.remove(name);
      await this.reply(userId, err ? `❌ ${err}` : `✅ 工作区 "${name}" 已删除`);
      return;
    }

    if (sub === 'default') {
      const name = args[1];
      if (!name) { await this.reply(userId, '用法: /ws default <名称>'); return; }
      const err = this.wsm.setDefault(name);
      await this.reply(userId, err ? `❌ ${err}` : `✅ 默认工作区已设为 "${name}"`);
      return;
    }

    // /ws <name> → switch
    if (this.running.has(userId)) {
      await this.reply(userId, '⏳ 有任务运行中，等完成后再切换工作区'); return;
    }
    const name = args[0];
    const err  = this.wsm.switch(userId, name);
    if (err) { await this.reply(userId, `❌ ${err}`); return; }

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

    const wsName = this.wsm.currentName(userId);
    const wsDef  = this.wsm.current(userId);
    this.sender.sendTyping(userId, this.contextTokens.get(userId)!);

    const preview = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;
    await this.reply(userId, `⚡ 收到，开始执行\n📁 工作区: ${wsName}\n📝 ${preview}`);

    const existingUuid = this.activeSession.get(userId)
                         ?? this.store.getLatest(userId, wsName)?.session_uuid
                         ?? null;

    const textParts: string[]    = [];
    const toolNames: Set<string> = new Set();
    let resultText   = '';
    let newSessionId = existingUuid;

    try {
      const finalSid = await runClaude(
        prompt,
        {
          sessionId: existingUuid,
          cwd:       wsDef.path,
          extraDirs: [...(wsDef.extra_dirs ?? []), CONFIG.MEDIA_DIR],
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

      if (aborter.signal.aborted) {
        const partial = (resultText || textParts.join('')).trim();
        await this.reply(userId, '🛑 任务已停止' +
          (partial ? `\n\n（已完成部分）\n${partial.slice(0, 300)}` : ''));
        return;
      }

      const toolLine = toolNames.size
        ? '🔧 ' + [...toolNames].join(' · ') + '\n\n'
        : '';

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
