import Database from 'better-sqlite3';
import fs from 'fs';
import { CONFIG } from '../config';

export interface Session {
  id:           number;
  user_openid:  string;
  workspace:    string;       // workspace name
  session_uuid: string;
  title:        string;
  created_at:   number;
  last_used:    number;
}

export class SessionStore {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    this.db = new Database(CONFIG.DB_FILE);
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
  }

  create(userOpenid: string, workspace: string, sessionUuid: string, title: string): Session {
    const now = Date.now();
    const res = this.db
      .prepare(`INSERT INTO sessions (user_openid, workspace, session_uuid, title, created_at, last_used)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userOpenid, workspace, sessionUuid, title, now, now);
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(res.lastInsertRowid) as Session;
  }

  touch(sessionUuid: string) {
    this.db.prepare('UPDATE sessions SET last_used = ? WHERE session_uuid = ?')
      .run(Date.now(), sessionUuid);
  }

  updateTitle(sessionUuid: string, title: string) {
    this.db.prepare('UPDATE sessions SET title = ?, last_used = ? WHERE session_uuid = ?')
      .run(title, Date.now(), sessionUuid);
  }

  /** Latest session for a user in a specific workspace */
  getLatest(userOpenid: string, workspace: string): Session | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions
                WHERE user_openid = ? AND workspace = ?
                ORDER BY last_used DESC LIMIT 1`)
      .get(userOpenid, workspace) as Session | undefined;
  }

  /** List sessions for a user in a specific workspace */
  list(userOpenid: string, workspace: string, limit = 10): Session[] {
    return this.db
      .prepare(`SELECT * FROM sessions
                WHERE user_openid = ? AND workspace = ?
                ORDER BY last_used DESC LIMIT ?`)
      .all(userOpenid, workspace, limit) as Session[];
  }

  getByIndex(userOpenid: string, workspace: string, index: number): Session | undefined {
    return this.list(userOpenid, workspace)[index - 1];
  }

  getByUuid(uuid: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE session_uuid = ?').get(uuid) as Session | undefined;
  }
}
