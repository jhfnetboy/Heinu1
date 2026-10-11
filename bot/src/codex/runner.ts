import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { CONFIG } from '../config';
import type { RunOptions, RunEvent } from '../agent/runner';

/** One headless Codex turn. Prompts travel over stdin, never process arguments. */
export function runCodex(
  prompt: string, opts: RunOptions, onEvent: (ev: RunEvent) => void,
): Promise<string> {
  if (opts.signal?.aborted) return Promise.resolve(opts.sessionId ?? '');

  return new Promise((resolve, reject) => {
    const args = [
      'exec', '--json', '--skip-git-repo-check',
      '-c', `approval_policy=${JSON.stringify(CONFIG.CODEX_APPROVAL_POLICY)}`,
      '-c', `sandbox_mode=${JSON.stringify(CONFIG.CODEX_SANDBOX_MODE)}`,
      '-c', `model_reasoning_effort=${JSON.stringify(opts.codexReasoningEffort ?? CONFIG.CODEX_REASONING_EFFORT)}`,
    ];
    const model = opts.codexModel ?? CONFIG.CODEX_MODEL;
    if (model) args.push('--model', model);
    for (const dir of opts.extraDirs ?? []) args.push('--add-dir', dir);
    if (opts.sessionId) args.push('resume', opts.sessionId);
    args.push('-');

    const proc = spawn(CONFIG.CODEX_BIN, args, {
      cwd: opts.cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let sessionId = opts.sessionId ?? '';
    let lastMessage = '';
    let errorText = '';
    let stderr = '';
    let completed = false;
    let failed = false;
    let acted = false;
    let aborted = false;
    let callbackError: Error | undefined;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const tools = new Set<string>();

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch { /* process group already exited */ }
    };
    const abort = () => {
      aborted = true;
      kill('SIGTERM');
      // Include shell/tool children when /stop interrupts an active command.
      const timer = setTimeout(() => kill('SIGKILL'), 2_000);
      timer.unref();
    };
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();

    const emit = (ev: RunEvent) => {
      try { onEvent(ev); }
      catch (err) { callbackError = err as Error; kill('SIGTERM'); }
    };
    const parse = (line: string) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'thread.started' && ev.thread_id) {
        sessionId = ev.thread_id;
        emit({ type: 'session_id', sessionId });
      } else if (ev.type === 'item.started' || ev.type === 'item.completed') {
        const item = ev.item;
        if (!item) return;
        if (item.type === 'agent_message' && ev.type === 'item.completed') {
          lastMessage = item.text ?? '';
          acted = true;
          emit({ type: 'text', text: lastMessage });
        } else if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) {
          const key = item.id ?? JSON.stringify(item);
          if (tools.has(key)) return;
          tools.add(key);
          acted = true;
          emit({ type: 'tool', toolName: item.type === 'mcp_tool_call'
            ? `${item.server ?? 'mcp'}.${item.tool ?? 'call'}` : item.type,
            toolInput: item.command ?? item.query });
        }
      } else if (ev.type === 'turn.completed') {
        completed = true;
        emit({ type: 'result', text: lastMessage, sessionId });
      } else if (ev.type === 'turn.failed') {
        failed = true;
        errorText = ev.error?.message ?? 'Codex turn failed';
        emit({ type: 'error', text: errorText });
      } else if (ev.type === 'error') {
        // Retry/reconnect notices are not terminal unless the turn/CLI fails.
        errorText = ev.message ?? ev.error?.message ?? errorText;
      }
    };
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) parse(line);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    // EPIPE is normal if the CLI rejects a stale session before reading stdin.
    proc.stdin.on('error', err => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        callbackError = err; kill('SIGTERM');
      }
    });
    proc.stdin.end(prompt);
    proc.on('error', err => {
      opts.signal?.removeEventListener('abort', abort);
      reject(err);
    });
    proc.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', abort);
      buffer += decoder.end();
      if (buffer.trim()) parse(buffer);
      if (aborted) { resolve(sessionId); return; }
      if (callbackError) { reject(callbackError); return; }
      if (code === 0 && completed && !failed) { resolve(sessionId); return; }
      const detail = errorText || stderr.trim() || `exit ${code}, signal ${signal}; no completed turn`;
      // Only restart a missing thread before any work, avoiding duplicate publishing.
      if (opts.sessionId && !acted && /no rollout found for thread|thread (?:id .* )?not found|session .*not found/i.test(detail)) {
        console.error('[codex] Saved thread unavailable; starting a new conversation');
        resolve(runCodex(prompt, { ...opts, sessionId: null }, onEvent));
      } else {
        reject(new Error(`Codex: ${detail.slice(-4_000)}`));
      }
    });
  });
}
