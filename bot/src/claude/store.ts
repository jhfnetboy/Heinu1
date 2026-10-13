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
  modelRouting: 'auto' | 'manual';
}

export interface WorkflowJob {
  id: string; user_openid: string; workspace: string; prompt: string;
  context_json: string; status: string; attempts: number; error: string;
  next_retry: number; created_at: number; session_uuid: string; provider: AgentProvider;
  kb_confirmed: number; result_json: string;
}
export interface InboxReceipt {
  id:string;user_openid:string;workspace:string;items_json:string;
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
    const prefCols = (this.db.prepare('PRAGMA table_info(agent_preferences)').all() as {name:string}[]).map(c=>c.name);
    if (!prefCols.includes('model_routing')) this.db.exec("ALTER TABLE agent_preferences ADD COLUMN model_routing TEXT NOT NULL DEFAULT 'auto'");
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_jobs (
      id TEXT PRIMARY KEY, user_openid TEXT NOT NULL, workspace TEXT NOT NULL,
      prompt TEXT NOT NULL, context_json TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
      next_retry INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      session_uuid TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'codex',
      kb_confirmed INTEGER NOT NULL DEFAULT 0, result_json TEXT NOT NULL DEFAULT ''
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_inbox (
      id TEXT PRIMARY KEY,user_openid TEXT NOT NULL,workspace TEXT NOT NULL,
      items_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'received',
      job_id TEXT NOT NULL DEFAULT '',received_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS reply_contexts (
      user_openid TEXT PRIMARY KEY,context_token TEXT NOT NULL,updated_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS reply_outbox (
      job_id TEXT PRIMARY KEY,user_openid TEXT NOT NULL,text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL
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
      .get(userOpenid) as {provider: AgentProvider; codex_model: string; reasoning_effort: string;model_routing:'auto'|'manual'} | undefined;
    return row ? {provider:row.provider,codexModel:row.codex_model || CONFIG.CODEX_MODEL,reasoningEffort:row.reasoning_effort,modelRouting:row.model_routing}
      : {provider:this.provider,codexModel:CONFIG.CODEX_MODEL,reasoningEffort:CONFIG.CODEX_REASONING_EFFORT,modelRouting:'auto'};
  }

  savePreferences(userOpenid: string, prefs: AgentPreferences) {
    this.db.prepare(`INSERT INTO agent_preferences (user_openid, provider, codex_model, reasoning_effort, model_routing)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_openid) DO UPDATE SET
      provider=excluded.provider, codex_model=excluded.codex_model, reasoning_effort=excluded.reasoning_effort,model_routing=excluded.model_routing`)
      .run(userOpenid,prefs.provider,prefs.codexModel,prefs.reasoningEffort,prefs.modelRouting);
  }

  createJob(id:string,user:string,workspace:string,prompt:string,context:unknown,receipts:string[]=[]) {
    return this.db.transaction(()=>{
      this.db.prepare(`INSERT OR IGNORE INTO workflow_jobs (id,user_openid,workspace,prompt,context_json,status,created_at)
        VALUES (?,?,?,?,?,'pending',?)`).run(id,user,workspace,prompt,JSON.stringify(context),Date.now());
      if (receipts.length) this.attachInbox(receipts,id);
      return this.job(id)!;
    })();
  }
  job(id:string) { return this.db.prepare('SELECT * FROM workflow_jobs WHERE id=?').get(id) as WorkflowJob|undefined; }
  recentJobs(user:string,limit=10):WorkflowJob[] {
    return this.db.prepare('SELECT * FROM workflow_jobs WHERE user_openid=? ORDER BY created_at DESC LIMIT ?').all(user,limit) as WorkflowJob[];
  }
  failedJobs(user?:string, dueOnly=false): WorkflowJob[] {
    return this.db.prepare(`SELECT * FROM workflow_jobs WHERE ${dueOnly ? "status='failed'" : "status IN ('failed','blocked')"}
      ${user ? 'AND user_openid=?' : ''} ${dueOnly ? 'AND (attempts<3 OR next_retry=-1) AND next_retry<=?' : ''}
      ORDER BY created_at`).all(...(user?[user]:[]),...(dueOnly?[Date.now()]:[])) as WorkflowJob[];
  }
  claimJob(id:string) {
    return this.db.prepare("UPDATE workflow_jobs SET status='running',attempts=attempts+1 WHERE id=? AND status IN ('failed','blocked','pending')").run(id).changes>0;
  }
  updateJob(id:string,values:Partial<Pick<WorkflowJob,'status'|'error'|'next_retry'|'session_uuid'|'provider'|'kb_confirmed'|'result_json'>>) {
    const entries=Object.entries(values);if (!entries.length) return;
    this.db.prepare(`UPDATE workflow_jobs SET ${entries.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...entries.map(([,v])=>v),id);
  }
  recoverInterruptedJobs() {
    this.db.prepare("UPDATE workflow_jobs SET status='failed',error='机器人重启，继续核对未完成步骤',next_retry=0 WHERE status IN ('running','pending')").run();
  }
  requestRetry(id:string) {
    this.db.prepare("UPDATE workflow_jobs SET status='failed',next_retry=-1 WHERE id=? AND status IN ('failed','blocked')").run(id);
  }
  saveReplyContext(user:string,token:string) {
    if (!token) return;
    this.db.prepare(`INSERT INTO reply_contexts VALUES (?,?,?) ON CONFLICT(user_openid) DO UPDATE SET
      context_token=excluded.context_token,updated_at=excluded.updated_at`).run(user,token,Date.now());
  }
  replyContext(user:string):string|undefined {
    return (this.db.prepare('SELECT context_token FROM reply_contexts WHERE user_openid=?').get(user) as {context_token:string}|undefined)?.context_token;
  }
  queueReply(jobId:string,user:string,text:string) {
    this.db.prepare(`INSERT INTO reply_outbox (job_id,user_openid,text,created_at) VALUES (?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET text=excluded.text,status='pending',created_at=excluded.created_at`).run(jobId,user,text,Date.now());
  }
  pendingReplies(user:string):{job_id:string;text:string}[] {
    return this.db.prepare("SELECT job_id,text FROM reply_outbox WHERE user_openid=? AND status='pending' ORDER BY created_at").all(user) as {job_id:string;text:string}[];
  }
  replySent(id:string) {this.db.prepare("UPDATE reply_outbox SET status='sent' WHERE job_id=?").run(id);}
  receive(id:string,user:string,workspace:string,items:unknown) {
    return this.db.prepare('INSERT OR IGNORE INTO message_inbox (id,user_openid,workspace,items_json,received_at) VALUES (?,?,?,?,?)')
      .run(id,user,workspace,JSON.stringify(items),Date.now()).changes>0;
  }
  pendingInbox():InboxReceipt[] {
    return this.db.prepare("SELECT * FROM message_inbox WHERE status='received' ORDER BY received_at").all() as InboxReceipt[];
  }
  attachInbox(ids:string[],jobId:string) {
    const stmt=this.db.prepare("UPDATE message_inbox SET status='attached',job_id=? WHERE id=? AND status='received'");
    this.db.transaction(()=>{for (const id of new Set(ids))stmt.run(jobId,id);})();
  }
  cancelInbox(ids:string[]) {
    const stmt=this.db.prepare("UPDATE message_inbox SET status='cancelled' WHERE id=? AND status='received'");
    this.db.transaction(()=>{for (const id of new Set(ids))stmt.run(id);})();
  }

  close() { this.db.close(); }
}
