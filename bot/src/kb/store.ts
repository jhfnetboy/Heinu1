import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';

export interface KbRecord {
  id:             number;
  user_openid:    string;
  workspace:      string;
  title:          string;
  summary:        string;
  content_type:   string;       // text | image | file | mixed
  tags:           string[];     // parsed from JSON column
  entities:       string[];     // parsed from JSON column
  raw_text:       string;       // original message text
  raw_files:      string[];     // archived file paths under kb/raw/
  source_session: string;       // claude session uuid that produced the analysis
  created_at:     number;
}

/** Shape written by the ingest step (before DB assigns id/timestamps). */
export interface KbDraft {
  user_openid:    string;
  workspace:      string;
  title:          string;
  summary:        string;
  content_type:   string;
  tags:           string[];
  entities:       string[];
  raw_text:       string;
  raw_files:      string[];
  source_session: string;
}

type Row = Omit<KbRecord, 'tags' | 'entities' | 'raw_files'> & {
  tags:      string;
  entities:  string;
  raw_files: string;
};

export class KbStore {
  private db: Database.Database;

  constructor() {
    fs.mkdirSync(path.dirname(CONFIG.KB_DB_FILE), { recursive: true });
    this.db = new Database(CONFIG.KB_DB_FILE);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_openid    TEXT    NOT NULL,
        workspace      TEXT    NOT NULL DEFAULT 'default',
        title          TEXT    NOT NULL DEFAULT '',
        summary        TEXT    NOT NULL DEFAULT '',
        content_type   TEXT    NOT NULL DEFAULT 'text',
        tags           TEXT    NOT NULL DEFAULT '[]',
        entities       TEXT    NOT NULL DEFAULT '[]',
        raw_text       TEXT    NOT NULL DEFAULT '',
        raw_files      TEXT    NOT NULL DEFAULT '[]',
        source_session TEXT    NOT NULL DEFAULT '',
        created_at     INTEGER NOT NULL
      );

      -- Standalone FTS5 index. We populate it manually (not external-content)
      -- so we can CJK-segment the body: unicode61 doesn't split Chinese, so we
      -- space-out each CJK char to make per-character tokens. rowid == records.id.
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        body, tokenize='unicode61'
      );
    `);
  }

  insert(draft: KbDraft): KbRecord {
    const now = Date.now();
    const insertRec = this.db.prepare(`
      INSERT INTO records
        (user_openid, workspace, title, summary, content_type,
         tags, entities, raw_text, raw_files, source_session, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(
      'INSERT INTO records_fts(rowid, body) VALUES (?, ?)'
    );

    const tx = this.db.transaction(() => {
      const res = insertRec.run(
        draft.user_openid, draft.workspace, draft.title, draft.summary, draft.content_type,
        JSON.stringify(draft.tags), JSON.stringify(draft.entities),
        draft.raw_text, JSON.stringify(draft.raw_files), draft.source_session, now,
      );
      const id = Number(res.lastInsertRowid);
      const body = segmentCJK([
        draft.title, draft.summary, draft.tags.join(' '),
        draft.entities.join(' '), draft.raw_text,
      ].join(' '));
      insertFts.run(id, body);
      return id;
    });

    return this.get(tx())!;
  }

  get(id: number): KbRecord | undefined {
    const row = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** Full-text search (CJK-aware), newest-first within relevance. */
  search(userOpenid: string, query: string, limit = 10): KbRecord[] {
    const match = this.toMatchQuery(query);
    if (!match) return [];
    const rows = this.db.prepare(`
      SELECT r.* FROM records_fts f
      JOIN records r ON r.id = f.rowid
      WHERE f.records_fts MATCH ? AND r.user_openid = ?
      ORDER BY rank, r.created_at DESC, r.id DESC
      LIMIT ?
    `).all(match, userOpenid, limit) as Row[];
    return rows.map(r => this.hydrate(r));
  }

  recent(userOpenid: string, limit = 10): KbRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM records WHERE user_openid = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(userOpenid, limit) as Row[];
    return rows.map(r => this.hydrate(r));
  }

  count(userOpenid: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_openid = ?')
      .get(userOpenid) as { n: number };
    return r.n;
  }

  private hydrate(row: Row): KbRecord {
    return {
      ...row,
      tags:      safeJsonArray(row.tags),
      entities:  safeJsonArray(row.entities),
      raw_files: safeJsonArray(row.raw_files),
    };
  }

  /**
   * Build an FTS5 MATCH query from free user text. Each whitespace term becomes
   * a CJK-segmented phrase; terms are OR'd. A 2-char Chinese term like "烤鸭"
   * becomes the phrase "烤 鸭", matching consecutive chars in the segmented body.
   */
  private toMatchQuery(query: string): string {
    const terms = query.split(/\s+/).map(t => t.trim()).filter(Boolean);
    const phrases = terms
      .map(t => segmentCJK(t).replace(/"/g, '').trim())  // strip quotes first
      .filter(Boolean)                                    // drop empties (lone punctuation)
      .map(seg => `"${seg}"`);
    return phrases.join(' OR ');
  }
}

/**
 * Insert a space around every CJK character so unicode61 tokenizes per-char.
 * Uses Unicode script properties (covers Han incl. astral-plane extensions,
 * plus Japanese kana) rather than hard-coded BMP ranges.
 */
function segmentCJK(text: string): string {
  return text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, c => ` ${c} `)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
