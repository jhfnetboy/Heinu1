import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CONFIG, AgentProvider } from '../config';

export interface Session {
  id:           number;
  user_openid:  string;
  workspace:    string;       // workspace name
  provider:     AgentProvider;
  session_uuid: string;
  title:        string;
  created_at:   number;
  last_used:    number;
}

export interface AgentPreferences {
  provider: AgentProvider;
  codexModel: string;
  reasoningEffort: string;
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbFile = CONFIG.DB_FILE, private provider: AgentProvider = CONFIG.AGENT_PROVIDER) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new Database(dbFile);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_openid  TEXT    NOT NULL,
        workspace    TEXT    NOT NULL DEFAULT 'default',
        session_uuid TEXT    NOT NULL UNIQUE,
        title        TEXT    NOT NULL DEFAULT '(新会话)',
        created_at   INTEGER NOT NULL,
        last_used    INTEGER NOT NULL
      )
    `);
    // Migrate old tables that lack the workspace column
    const cols = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as any[])
      .map((c: any) => c.name);
    if (!cols.includes('workspace')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default'`);
    }
    // All pre-migration UUIDs belong to Claude, never pass them to Codex resume.
    if (!cols.includes('provider')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_preferences (
      user_openid TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      codex_model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL
    )`);
  }

  create(userOpenid: string, workspace: string, sessionUuid: string, title: string, provider = this.provider): Session {
    const now = Date.now();
    const res = this.db
      .prepare(`INSERT INTO sessions (user_openid, workspace, provider, session_uuid, title, created_at, last_used)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(userOpenid, workspace, provider, sessionUuid, title, now, now);
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(res.lastInsertRowid) as Session;
  }

  touch(sessionUuid: string, provider = this.provider) {
    this.db.prepare('UPDATE sessions SET last_used = ? WHERE session_uuid = ? AND provider = ?')
      .run(Date.now(), sessionUuid, provider);
  }

  updateTitle(sessionUuid: string, title: string, provider = this.provider) {
    this.db.prepare('UPDATE sessions SET title = ?, last_used = ? WHERE session_uuid = ? AND provider = ?')
      .run(title, Date.now(), sessionUuid, provider);
  }

  /** Latest session for a user in a specific workspace */
  getLatest(userOpenid: string, workspace: string, provider = this.provider): Session | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions
                WHERE user_openid = ? AND workspace = ? AND provider = ?
                ORDER BY last_used DESC LIMIT 1`)
      .get(userOpenid, workspace, provider) as Session | undefined;
  }

  /** List sessions for a user in a specific workspace */
  list(userOpenid: string, workspace: string, limit = 10, provider = this.provider): Session[] {
    return this.db
      .prepare(`SELECT * FROM sessions
                WHERE user_openid = ? AND workspace = ? AND provider = ?
                ORDER BY last_used DESC LIMIT ?`)
      .all(userOpenid, workspace, provider, limit) as Session[];
  }

  getByIndex(userOpenid: string, workspace: string, index: number, provider = this.provider): Session | undefined {
    return this.list(userOpenid, workspace, 10, provider)[index - 1];
  }

  getByUuid(uuid: string, provider = this.provider): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE session_uuid = ? AND provider = ?')
      .get(uuid, provider) as Session | undefined;
  }

  preferences(userOpenid: string): AgentPreferences {
    const row = this.db.prepare('SELECT * FROM agent_preferences WHERE user_openid = ?')
      .get(userOpenid) as {provider: AgentProvider; codex_model: string; reasoning_effort: string} | undefined;
    return row ? {provider:row.provider,codexModel:row.codex_model || CONFIG.CODEX_MODEL,reasoningEffort:row.reasoning_effort}
      : {provider:this.provider,codexModel:CONFIG.CODEX_MODEL,reasoningEffort:CONFIG.CODEX_REASONING_EFFORT};
  }

  savePreferences(userOpenid: string, prefs: AgentPreferences) {
    this.db.prepare(`INSERT INTO agent_preferences (user_openid, provider, codex_model, reasoning_effort)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_openid) DO UPDATE SET
      provider=excluded.provider, codex_model=excluded.codex_model, reasoning_effort=excluded.reasoning_effort`)
      .run(userOpenid,prefs.provider,prefs.codexModel,prefs.reasoningEffort);
  }

  close() { this.db.close(); }
}
