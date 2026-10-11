import { CONFIG } from '../config';
import { runClaude } from '../claude/runner';
import { runCodex } from '../codex/runner';

export interface RunOptions {
  sessionId: string | null;
  cwd: string;
  extraDirs?: string[];
  signal?: AbortSignal;
}

export interface RunEvent {
  type: 'session_id' | 'text' | 'tool' | 'result' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: string;
  sessionId?: string;
  costUsd?: number;
}

export const AGENT_LABEL = CONFIG.AGENT_PROVIDER === 'codex' ? 'Codex' : 'Claude Code';

export function runAgent(prompt: string, opts: RunOptions, onEvent: (ev: RunEvent) => void) {
  return CONFIG.AGENT_PROVIDER === 'codex'
    ? runCodex(prompt, opts, onEvent)
    : runClaude(prompt, opts, onEvent);
}
