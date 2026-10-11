import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CONFIG } from '../src/config';
import { runCodex } from '../src/codex/runner';
import { SessionStore } from '../src/claude/store';
import { RunEvent } from '../src/agent/runner';
import { Router } from '../src/router';
import { WorkspaceManager } from '../src/workspace';
import { Sender } from '../src/ilink/sender';
import { WeixinMessage } from '../src/ilink/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(),'heinu1-codex-test-'));
const originalBin = CONFIG.CODEX_BIN;
CONFIG.CODEX_BIN = path.join(__dirname,'fixtures/codex.cjs');
fs.chmodSync(CONFIG.CODEX_BIN,0o755);
test.after(() => { CONFIG.CODEX_BIN = originalBin; fs.rmSync(dir,{recursive:true,force:true}); });
const opts = {sessionId:null, cwd:dir};

test('migrates Claude history without exposing it to Codex, scoped by user/workspace/provider', () => {
  const file = path.join(dir,'sessions.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, user_openid TEXT NOT NULL,
    session_uuid TEXT UNIQUE NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL);
    INSERT INTO sessions VALUES (1, 'u', 'legacy', 'old Claude', 1, 1);`);
  old.close();
  const codex = new SessionStore(file,'codex');
  const claude = new SessionStore(file,'claude');
  try {
    assert.equal(codex.getByUuid('legacy'),undefined);
    assert.equal(claude.getLatest('u','default')?.session_uuid,'legacy');
    codex.create('u','blog','new','Codex task');
    assert.equal(codex.getByIndex('u','blog',1)?.session_uuid,'new');
    assert.equal(codex.getLatest('other','blog'),undefined);
    assert.equal(codex.getLatest('u','home'),undefined);
    assert.equal(claude.list('u','blog').length,0);
  } finally { codex.close(); claude.close(); }
});

test('parses chunked Unicode + final unterminated JSON, deduplicates tools, returns final summary', async () => {
  const log = path.join(dir,'normal.jsonl');
  const events: RunEvent[] = [];
  assert.equal(await runCodex(JSON.stringify({log}), {...opts, extraDirs:[dir]},ev => events.push(ev)),'codex-thread');
  assert.equal(events.filter(ev => ev.type === 'tool').length,1);
  assert.equal(events.find(ev => ev.type === 'result')?.text,'完成🍄');
  const invocation = JSON.parse(fs.readFileSync(log,'utf8'));
  assert.equal(invocation.args.at(-1),'-');
  assert(!invocation.args.includes(invocation.input));
  assert(invocation.args.includes('approval_policy="never"'));
});

test('resume uses explicit thread and retries a missing one only before doing work', async () => {
  const log = path.join(dir,'resume.jsonl');
  await runCodex(JSON.stringify({log}),{...opts,sessionId:'missing-thread'},()=>{});
  const calls = fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,2);
  assert(calls[0].args.includes('resume'));
  assert(calls[0].args.includes('missing-thread'));
  assert(!calls[1].args.includes('resume'));
  const after = path.join(dir,'after-tool.jsonl');
  await assert.rejects(runCodex(JSON.stringify({log:after,mode:'missing-after-tool'}),{...opts,sessionId:'existing'},()=>{}),/no rollout/);
  assert.equal(fs.readFileSync(after,'utf8').trim().split('\n').length,1);
});

test('rejects failed or incomplete turns even when CLI exits 0', async () => {
  await assert.rejects(runCodex('{"mode":"failed"}',opts,()=>{}),/token expired/);
  await assert.rejects(runCodex('{"mode":"incomplete"}',opts,()=>{}),/no completed turn/);
});

test('WeChat /status identifies Codex, /new starts fresh, next task resumes the saved thread', async () => {
  const wsFile = CONFIG.WORKSPACES_FILE;
  CONFIG.WORKSPACES_FILE = path.join(dir,'workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const store = new SessionStore(path.join(dir,'router.db'),'codex');
  const replies: string[] = [];
  const sender = {send:async (_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async ()=>{}} as unknown as Sender;
  const router = new Router(sender,store,new WorkspaceManager());
  const message = (text:string)=>({from_user_id:'user',context_token:'test-context',item_list:[{type:1,text_item:{text}}]} as WeixinMessage);
  const log = path.join(dir,'router.jsonl');
  try {
    store.create('user','blog','previous-codex','previous');
    await router.handle(message('/status'));
    assert(replies.at(-1)?.includes('执行后端: Codex'));
    await router.handle(message('/new'));
    await (router as any).runTask('user',JSON.stringify({log}));
    assert(replies.at(-1)?.includes('完成🍄'));
    await (router as any).runTask('user',JSON.stringify({log}));
    const calls = fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert(!calls[0].args.includes('resume'));
    assert(calls[1].args.includes('resume'));
    assert(calls[1].args.includes('codex-thread'));
    assert.equal(store.list('user','blog').length,2);
  } finally { CONFIG.WORKSPACES_FILE=wsFile; store.close(); }
});

test('/stop kills a command child as well as the Codex process', async () => {
  const controller = new AbortController();
  const pidFile = path.join(dir,'child.pid');
  const run = runCodex(JSON.stringify({mode:'wait',pidFile}),{...opts,signal:controller.signal},()=>{});
  const deadline = Date.now()+5000;
  while (!fs.existsSync(pidFile) && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
  assert(fs.existsSync(pidFile),'fixture child started');
  const pid = Number(fs.readFileSync(pidFile,'utf8'));
  controller.abort();
  assert.equal(await run,'codex-thread');
  let alive = true;
  for (let n=0;n<150;n++) {
    try { process.kill(pid,0); } catch { alive=false; break; }
    await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(alive,false,'tool subprocess terminated');
});
