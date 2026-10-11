import { CONFIG, AgentProvider } from '../config';
import { runClaude } from '../claude/runner';
import { runCodex } from '../codex/runner';

export interface RunOptions {
  sessionId: string | null;
  cwd: string;
  extraDirs?: string[];
  signal?: AbortSignal;
  provider?: AgentProvider;
  codexModel?: string;
  codexReasoningEffort?: string;
}

export interface RunEvent {
  type: 'session_id' | 'text' | 'tool' | 'result' | 'error';
  text?: string;
  toolName?: string;
  toolInput?: string;
  sessionId?: string;
  costUsd?: number;
}

export function agentLabel(provider: AgentProvider) {
  return provider === 'codex' ? 'Codex' : 'Claude Code';
}
export const AGENT_LABEL = agentLabel(CONFIG.AGENT_PROVIDER);

export function runAgent(prompt: string, opts: RunOptions, onEvent: (ev: RunEvent) => void) {
  return (opts.provider ?? CONFIG.AGENT_PROVIDER) === 'codex'
    ? runCodex(prompt, opts, onEvent)
    : runClaude(prompt, opts, onEvent);
}
