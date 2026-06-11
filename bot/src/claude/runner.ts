import { spawn } from 'child_process';
import { CONFIG } from '../config';

export interface RunOptions {
  sessionId:  string | null;
  cwd:        string;          // working directory for Claude Code
  extraDirs?: string[];        // --add-dir paths
  signal?:    AbortSignal;     // abort to kill the claude subprocess (/stop)
}

export interface RunEvent {
  type:       'session_id' | 'text' | 'tool' | 'result' | 'error';
  text?:      string;
  toolName?:  string;
  toolInput?: string;
  sessionId?: string;
  costUsd?:   number;
}

type EventCallback = (ev: RunEvent) => void;

/**
 * Spawn `claude --print <prompt> --output-format stream-json --verbose`
 * in the given cwd (workspace path).
 * Returns the final Claude session ID for future --resume calls.
 */
export function runClaude(
  prompt:  string,
  opts:    RunOptions,
  onEvent: EventCallback,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Already-stopped before we even spawn
    if (opts.signal?.aborted) {
      resolve(opts.sessionId ?? '');
      return;
    }

    const args: string[] = [
      '--print', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', CONFIG.CLAUDE_PERMISSION_MODE,
    ];

    if (opts.sessionId) args.push('--resume', opts.sessionId);
    for (const d of opts.extraDirs ?? []) args.push('--add-dir', d);

    const proc = spawn(CONFIG.CLAUDE_BIN, args, {
      cwd:    opts.cwd,          // ← working directory
      env:    { ...process.env },
      stdio:  ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,       // /stop aborts → process is killed (SIGTERM)
    });

    let finalSessionId = opts.sessionId ?? '';
    let aborted = false;
    let buf = '';

    // Mark aborts so the 'error'/'close' handlers resolve quietly instead of
    // surfacing the kill as a task failure.
    opts.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });

    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const sid = dispatchEvent(JSON.parse(trimmed), onEvent);
          if (sid) finalSessionId = sid;
        } catch { /* non-JSON debug line */ }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error('[claude]', text);
    });

    proc.on('close', (code) => {
      if (aborted) resolve(finalSessionId);
      else if (code !== 0 && code !== null) reject(new Error(`claude 退出码 ${code}`));
      else resolve(finalSessionId);
    });

    proc.on('error', (err: any) => {
      // Killing via AbortSignal surfaces here as ABORT_ERR — not a real failure
      if (aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        resolve(finalSessionId);
      } else {
        reject(err);
      }
    });
  });
}

function dispatchEvent(ev: any, onEvent: EventCallback): string | null {
  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
    onEvent({ type: 'session_id', sessionId: ev.session_id });
    return ev.session_id;
  }

  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) {
        onEvent({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const inputStr = JSON.stringify(block.input ?? {}).slice(0, 120);
        onEvent({ type: 'tool', toolName: block.name, toolInput: inputStr });
      }
    }
    return null;
  }

  if (ev.type === 'result') {
    onEvent({ type: 'result', text: ev.result ?? '', sessionId: ev.session_id, costUsd: ev.cost_usd });
    if (ev.session_id) return ev.session_id;
  }

  return null;
}
