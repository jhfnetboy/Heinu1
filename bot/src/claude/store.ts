import Database from 'better-sqlite3';
import fs from 'fs';
import { CONFIG } from '../config';

export interface Session {
  id:           number;
  user_openid:  string;
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
        user_openid  TEXT NOT NULL,
        session_uuid TEXT NOT NULL UNIQUE,
        title        TEXT NOT NULL DEFAULT '(新会话)',
        created_at   INTEGER NOT NULL,
        last_used    INTEGER NOT NULL
      )
    `);
  }

  create(userOpenid: string, sessionUuid: string, title: string): Session {
    const now = Date.now();
    const res = this.db
      .prepare(`INSERT INTO sessions (user_openid, session_uuid, title, created_at, last_used)
                VALUES (?, ?, ?, ?, ?)`)
      .run(userOpenid, sessionUuid, title, now, now);
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(res.lastInsertRowid) as Session;
  }

  updateTitle(sessionUuid: string, title: string) {
    this.db
      .prepare('UPDATE sessions SET title = ?, last_used = ? WHERE session_uuid = ?')
      .run(title, Date.now(), sessionUuid);
  }

  touch(sessionUuid: string) {
    this.db
      .prepare('UPDATE sessions SET last_used = ? WHERE session_uuid = ?')
      .run(Date.now(), sessionUuid);
  }

  getLatest(userOpenid: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE user_openid = ? ORDER BY last_used DESC LIMIT 1')
      .get(userOpenid) as Session | undefined;
  }

  list(userOpenid: string, limit = 10): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE user_openid = ? ORDER BY last_used DESC LIMIT ?')
      .all(userOpenid, limit) as Session[];
  }

  getByIndex(userOpenid: string, index: number): Session | undefined {
    return this.list(userOpenid)[index - 1]; // 1-based
  }

  getByUuid(uuid: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE session_uuid = ?')
      .get(uuid) as Session | undefined;
  }
}
