import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG } from './config';

export interface WorkspaceDef {
  path:        string;
  description: string;
  extra_dirs?: string[];   // passed as --add-dir to Claude Code
}

export interface WorkspaceFile {
  default:    string;
  workspaces: Record<string, WorkspaceDef>;
}

const DEFAULT_FILE: WorkspaceFile = {
  default: 'home',
  workspaces: {
    home: {
      path:        os.homedir(),
      description: '家目录（默认）',
    },
  },
};

// ── File I/O ──────────────────────────────────────────────────────────────────

export function loadWorkspaces(): WorkspaceFile {
  if (!fs.existsSync(CONFIG.WORKSPACES_FILE)) {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG.WORKSPACES_FILE,
      JSON.stringify(DEFAULT_FILE, null, 2),
    );
    return DEFAULT_FILE;
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG.WORKSPACES_FILE, 'utf8'));
  } catch {
    console.warn('[ws] workspaces.json 解析失败，使用默认配置');
    return DEFAULT_FILE;
  }
}

export function saveWorkspaces(wf: WorkspaceFile) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG.WORKSPACES_FILE, JSON.stringify(wf, null, 2));
}

// ── Runtime manager (per-user current workspace) ─────────────────────────────

export class WorkspaceManager {
  private file: WorkspaceFile;
  // per-user active workspace name
  private active = new Map<string, string>();

  constructor() {
    this.file = loadWorkspaces();
  }

  reload() {
    this.file = loadWorkspaces();
  }

  /** The workspace a user is currently on (falls back to file default) */
  currentName(userId: string): string {
    return this.active.get(userId) ?? this.file.default;
  }

  /** Resolved WorkspaceDef for a user */
  current(userId: string): WorkspaceDef {
    const name = this.currentName(userId);
    return this.file.workspaces[name] ?? this.file.workspaces[this.file.default]!;
  }

  /** List all workspaces */
  list(): Array<{ name: string } & WorkspaceDef> {
    return Object.entries(this.file.workspaces).map(([name, def]) => ({
      name,
      ...def,
    }));
  }

  /** Switch a user to a named workspace. Returns error string or null. */
  switch(userId: string, name: string): string | null {
    if (!this.file.workspaces[name]) {
      const names = Object.keys(this.file.workspaces).join(', ');
      return `找不到工作区 "${name}"，可用: ${names}`;
    }
    const ws = this.file.workspaces[name];
    if (!fs.existsSync(ws.path)) {
      return `工作区路径不存在: ${ws.path}`;
    }
    this.active.set(userId, name);
    return null;
  }

  /** Add a new workspace and persist */
  add(name: string, wsPath: string, description: string): string | null {
    if (this.file.workspaces[name]) return `工作区 "${name}" 已存在`;
    const resolved = wsPath.startsWith('~')
      ? path.join(os.homedir(), wsPath.slice(1))
      : wsPath;
    if (!fs.existsSync(resolved)) return `路径不存在: ${resolved}`;
    this.file.workspaces[name] = { path: resolved, description };
    saveWorkspaces(this.file);
    return null;
  }

  /** Remove a workspace (cannot remove default) */
  remove(name: string): string | null {
    if (name === this.file.default) return `不能删除默认工作区 "${name}"`;
    if (!this.file.workspaces[name]) return `工作区 "${name}" 不存在`;
    delete this.file.workspaces[name];
    // Reset any user pointing at the removed ws
    for (const [uid, ws] of this.active.entries()) {
      if (ws === name) this.active.delete(uid);
    }
    saveWorkspaces(this.file);
    return null;
  }

  /** Set default workspace */
  setDefault(name: string): string | null {
    if (!this.file.workspaces[name]) return `工作区 "${name}" 不存在`;
    this.file.default = name;
    saveWorkspaces(this.file);
    return null;
  }
}
