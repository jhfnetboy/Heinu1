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
import { planTask, isPublicationQuery, duplicateFailure, checkDuplicate, WorkflowBlockedError, verifyPublication, publicationReply } from '../src/workflow';

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

test('explicit backend/model selection persists and routes isolated histories to the correct CLI', async () => {
  const oldWs = CONFIG.WORKSPACES_FILE;
  const oldClaude = CONFIG.CLAUDE_BIN;
  CONFIG.WORKSPACES_FILE = path.join(dir,'backend-workspaces.json');
  CONFIG.CLAUDE_BIN = path.join(__dirname,'fixtures/claude.cjs');
  fs.chmodSync(CONFIG.CLAUDE_BIN,0o755);
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const file = path.join(dir,'backend.db');
  const store = new SessionStore(file,'codex');
  const replies: string[] = [];
  const sender = {send:async (_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router = new Router(sender,store,new WorkspaceManager());
  const message = (text:string,user='user')=>({from_user_id:user,context_token:'test',item_list:[{type:1,text_item:{text}}]} as WeixinMessage);
  const log = path.join(dir,'backend.jsonl');
  try {
    store.create('user','blog','old-claude','CLAUDE_HISTORY','claude');
    store.create('user','blog','old-codex','CODEX_HISTORY','codex');
    await router.handle(message('/backend claude'));
    await router.handle(message('/sessions'));
    assert(replies.at(-1)?.includes('CLAUDE_HISTORY'));
    assert(!replies.at(-1)?.includes('CODEX_HISTORY'));
    await (router as any).runTask('user',JSON.stringify({log}));
    assert(replies.at(-1)?.includes('CLAUDE_DONE'));
    await router.handle(message('/backend codex'));
    await router.handle(message('/model terra high'));
    await (router as any).runTask('user',JSON.stringify({log}));
    const calls = fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls[0].backend,'claude');
    assert(calls[0].args.includes('old-claude'));
    assert(calls[1].args.includes('old-codex'));
    assert(!calls[1].args.includes('old-claude'));
    assert(calls[1].args.includes('gpt-5.6-terra'));
    assert(calls[1].args.includes('model_reasoning_effort="high"'));
    assert.equal(store.preferences('other').provider,'codex');
    assert.notEqual(store.preferences('other').codexModel,'gpt-5.6-terra');
    const reopened = new SessionStore(file,'codex');
    try { assert.deepEqual(reopened.preferences('user'),{provider:'codex',codexModel:'gpt-5.6-terra',reasoningEffort:'high',modelRouting:'manual'}); }
    finally { reopened.close(); }
    await router.handle(message('/backend unknown'));
    assert.equal(store.preferences('user').provider,'codex');
    await router.handle(message('/model luna medium'));
    assert.equal(store.preferences('user').codexModel,'gpt-6-luna');
    assert.equal(store.preferences('user').reasoningEffort,'medium');
    await router.handle(message('/backend claude'));
    await (router as any).runTask('user',JSON.stringify({mode:'quota',log}));
    assert(replies.at(-1)?.includes('/backend codex'));
  } finally { CONFIG.WORKSPACES_FILE=oldWs; CONFIG.CLAUDE_BIN=oldClaude; store.close(); }
});

test('pending messages block switching and Codex quota errors offer explicit fallback without replay', async () => {
  const oldWs = CONFIG.WORKSPACES_FILE;
  CONFIG.WORKSPACES_FILE=path.join(dir,'quota-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const store = new SessionStore(path.join(dir,'quota.db'),'codex');
  const replies: string[] = [];
  const sender = {send:async (_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router = new Router(sender,store,new WorkspaceManager());
  const message = (text:string)=>({from_user_id:'user',context_token:'test',item_list:[{type:1,text_item:{text}}]} as WeixinMessage);
  const log=path.join(dir,'quota.jsonl');
  try {
    await router.handle(message('pending task'));
    await router.handle(message('/backend claude'));
    assert.equal(store.preferences('user').provider,'codex');
    assert(replies.at(-1)?.includes('/stop'));
    await router.handle(message('/model terra high'));
    assert.notEqual(store.preferences('user').codexModel,'gpt-5.6-terra');
    await router.handle(message('/stop'));
    await (router as any).runTask('user',JSON.stringify({mode:'quota',log}));
    assert(replies.at(-1)?.includes('/backend claude'));
    assert.equal(store.preferences('user').provider,'codex');
    assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,1);
  } finally { CONFIG.WORKSPACES_FILE=oldWs; store.close(); }
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

test('auto routing uses Luna for read-only replies and Sol before research/publishing; manual choice wins', () => {
  const prefs={provider:'codex' as const,codexModel:'gpt-6-luna',reasoningEffort:'medium',modelRouting:'auto' as const};
  assert.equal(planTask('只回答当前状态，不要发布',prefs).model,'gpt-6-luna');
  assert.equal(planTask('现在用哪个模型？',prefs).model,'gpt-6-luna');
  assert.equal(planTask('是不是发布了博客？',prefs).publish,false);
  assert.equal(planTask('你要确定，没有重复发送blog或者公众号',prefs).publish,false);
  assert.equal(planTask('你复用之前，不是应该查下是不是发布过么？',prefs).publish,false);
  assert.equal(planTask('不要重复发blog',prefs).publish,false);
  assert.equal(planTask('写一篇关于如何避免公众号重复发布的文章',prefs).publish,true);
  assert.equal(isPublicationQuery('OpenHoopVision，上一篇blog发了没？这篇继续三件套'),false);
  assert.equal(planTask('帮我修复微信机器人',prefs).publish,false);
  assert.equal(planTask('检查历史消息,我记得有失败的处理,你看看,补一下',prefs).publish,false);
  assert.equal(planTask('你帮我检查历史失败的消息。你是不是都？再次重试完成这些任务了，检查',prefs).publish,false);
  assert.equal(planTask('为啥微信消息总是报错呢？请fix',prefs).publish,false);
  assert.equal(planTask('检查历史消息,我记得有失败的处理,你看看,补一下',prefs).model,'gpt-6.1-sol');
  assert.equal(planTask('https://github.com/example/project',prefs).model,'gpt-6.1-sol');
  assert.equal(planTask('深入研究模型架构，先不要发布',prefs).model,'gpt-6.1-sol');
  assert.equal(planTask('直接收到的文字素材',prefs).publish,true);
  assert.equal(planTask('深入研究',{...prefs,modelRouting:'manual'}).model,'gpt-6-luna');
});

test('maintenance routing recognizes failure records and homepage carousel troubleshooting without authorizing articles', () => {
  const prefs={provider:'codex' as const,codexModel:'gpt-6-luna',reasoningEffort:'medium',modelRouting:'auto' as const};
  for (const prompt of [
    '检查历史失败记录，重试 ，不要重复发',
    '你帮我查一下，为什么blog的首页这个banner轮轮换的图形上没有你当前的最新的这个blog',
    '检查历史失败消息，补齐缺失步骤',
    '首页轮播不显示最新文章，帮我修复',
  ]) {
    const plan=planTask(prompt,prefs);
    assert.equal(plan.publish,false,prompt);
    assert.equal(plan.model,'gpt-6.1-sol',prompt);
  }
  assert.equal(planTask('写一篇介绍博客首页轮播设计的文章',prefs).publish,true);
  assert.equal(planTask('检查历史失败记录，然后写一篇文章',prefs).publish,true);
});

test('asking whether Blog published returns saved channel receipts without starting another article', async () => {
  const file=path.join(dir,'publication-query.db'),store=new SessionStore(file,'codex');
  const job=store.createJob('published','user','blog','Known topic',{rawText:'Known topic',rawPaths:[],urls:[],hasMedia:false});
  store.updateJob(job.id,{status:'complete',kb_confirmed:1,result_json:JSON.stringify({blogUrl:'https://blog.mushroom.cv/blog/known-topic/',mediaId:'known-draft'})});
  const replies:string[]=[];
  const sender={send:async(_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager());
  try {
    await router.handle({message_id:78,from_user_id:'user',context_token:'context',item_list:[{type:1,text_item:{text:'是不是发布了博客？'}}]} as WeixinMessage);
    assert(replies.at(-1)?.includes('是不是发布了博客？是'));assert(replies.at(-1)?.includes('https://blog.mushroom.cv/blog/known-topic/'));
    assert(replies.at(-1)?.includes('known-draft'));assert.equal(store.pendingInbox().length,0);assert.equal((router as any).turns.size,0);
  } finally {store.close();}
});

test('duplicate-publication control reaches the agent with a non-publishing boundary and no publisher invocation', async () => {
  const oldWs=CONFIG.WORKSPACES_FILE;CONFIG.WORKSPACES_FILE=path.join(dir,'dedup-control-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const store=new SessionStore(path.join(dir,'dedup-control.db'),'codex'),replies:string[]=[];
  const sender={send:async(_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager(),{
    checkDuplicate:async()=>{throw new Error('publisher must not run');},
    verifyPublication:async()=>{throw new Error('publisher must not run');},
  });
  (router as any).kb={insert:()=>({id:1,tags:[],title:'control'})};(router as any).contextTokens.set('user','context');
  const log=path.join(dir,'dedup-control.jsonl'),prompt=JSON.stringify({log})+'\n你要确定，没有重复发送blog或者公众号';
  try {
    await (router as any).runTask('user',prompt,{rawText:prompt,rawPaths:[],urls:[],hasMedia:false});
    const invocation=JSON.parse(fs.readFileSync(log,'utf8').trim());
    assert.match(invocation.input,/不部署 Blog、不创建公众号草稿/);assert(!invocation.input.includes('[机主已授权的默认内容三件套'));
    const job=store.recentJobs('user')[0];assert.equal(job.status,'complete');assert.equal(job.result_json,'');
    assert(!replies.at(-1)?.includes('✅ Blog'));
  } finally {CONFIG.WORKSPACES_FILE=oldWs;store.close();}
});

test('recent publication queries order recovered results by receipt time rather than original message time', () => {
  const file=path.join(dir,'receipt-order.db'),store=new SessionStore(file,'codex');
  try {
    store.createJob('older-input','user','blog','Older source',{});store.createJob('newer-input','user','blog','Newer source',{});
    store.queueReply('older-input','user','older completed later');store.queueReply('newer-input','user','newer completed earlier');
    const db=new Database(file);
    try {
      db.prepare('UPDATE workflow_jobs SET created_at=? WHERE id=?').run(1,'older-input');
      db.prepare('UPDATE workflow_jobs SET created_at=? WHERE id=?').run(2,'newer-input');
      db.prepare('UPDATE reply_outbox SET created_at=? WHERE job_id=?').run(100,'older-input');
      db.prepare('UPDATE reply_outbox SET created_at=? WHERE job_id=?').run(50,'newer-input');
    } finally {db.close();}
    assert.deepEqual(store.recentJobs('user').map(j=>j.id),['older-input','newer-input']);
    assert.equal(store.recentJobs('other').length,0);
  } finally {store.close();}
});

test('actual duplicate-check failure preserves the WeChat IP cause and never exposes credentials', async () => {
  const oldRoot=CONFIG.BLOG_WORKSPACE,oldData=CONFIG.DATA_DIR;
  const root=path.join(dir,'wechat-dedup-fixture');
  const script=path.join(root,'.agents/skills/blog-publisher/check-duplicate.cjs');
  fs.mkdirSync(path.dirname(script),{recursive:true});fs.writeFileSync(path.join(root,'.env'),'');
  fs.writeFileSync(script,'console.error(JSON.stringify({errcode:40164,errmsg:"invalid ip 203.0.113.8, not in whitelist"}));process.exit(2);');
  CONFIG.BLOG_WORKSPACE=root;CONFIG.DATA_DIR=path.join(root,'data');
  try {
    await assert.rejects(checkDuplicate('source','test-ip'),e=>e instanceof WorkflowBlockedError && /203\.0\.113\.8/.test(e.message));
    assert.equal(JSON.parse(fs.readFileSync(path.join(CONFIG.DATA_DIR,'jobs/test-ip/duplicate-check.json'),'utf8')).code,2);
    fs.writeFileSync(script,'console.error(JSON.stringify({errcode:40164,errmsg:"invalid ip 203.0.113.8, not in whitelist"}));console.log("```dedup-result\\n"+JSON.stringify({duplicate:true,localLedgersRead:true,wechatError:"{\\\"errcode\\\":40164,\\\"errmsg\\\":\\\"invalid ip 203.0.113.8, not in whitelist\\\"}"})+"\\n```");process.exit(2);');
    const partial=await checkDuplicate('source','local-ip');assert.equal(partial.duplicate,true);assert(partial.wechatError?.includes('203.0.113.8'));
    const message=duplicateFailure(2,'❌ request failed access_token=private-token secret=private-secret').message;
    assert(!message.includes('private-token'));assert(!message.includes('private-secret'));
    assert(!(duplicateFailure(2,'❌ request timed out') instanceof WorkflowBlockedError));
  } finally {CONFIG.BLOG_WORKSPACE=oldRoot;CONFIG.DATA_DIR=oldData;}
});

test('WeChat whitelist failure saves KB, pauses automatic retries, and resumes manually after repair', async () => {
  const oldWs=CONFIG.WORKSPACES_FILE;CONFIG.WORKSPACES_FILE=path.join(dir,'wechat-blocked-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const file=path.join(dir,'wechat-blocked.db');const store=new SessionStore(file,'codex');
  const replies:string[]=[],steps:string[]=[],kbKeys=new Set<string>();let repaired=false;
  const sender={send:async(_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager(),{
    checkDuplicate:async()=>{steps.push('dedup');if(!repaired)throw duplicateFailure(2,'{"errcode":40164,"errmsg":"invalid ip 203.0.113.8, not in whitelist"}');return {file:'/tmp/check',duplicate:false};},
    verifyPublication:async()=>({slug:'test',blogUrl:'https://blog.mushroom.cv/blog/test/',mediaId:'draft',banner:'test.jpg'}),
  });
  (router as any).kb={insert:(draft:any)=>{steps.push('kb');kbKeys.add(draft.idempotency_key);return {id:1,tags:[],title:'source'};}};
  (router as any).contextTokens.set('user','test');
  const log=path.join(dir,'wechat-blocked-cli.jsonl'),prompt=JSON.stringify({log});
  const ctx={rawText:prompt,rawPaths:[],urls:[],hasMedia:false};
  try {
    await (router as any).runTask('user',prompt,ctx);
    const job=store.failedJobs('user')[0];assert(job);assert.equal(job.status,'blocked');assert.equal(job.kb_confirmed,1);
    assert.deepEqual(steps,['dedup','kb']);assert(!fs.existsSync(log));
    assert.equal(store.failedJobs('user',true).length,0);assert.equal(store.failedJobs('other').length,0);
    assert(replies.at(-1)?.includes('203.0.113.8'));assert(replies.at(-1)?.includes('✅ KB'));
    assert(!replies.at(-1)?.includes('codex login'));
    const reopen=new SessionStore(file,'codex');try {reopen.recoverInterruptedJobs();assert.equal(reopen.job(job.id)?.status,'blocked');assert.equal(reopen.failedJobs('user').length,1);} finally {reopen.close();}
    repaired=true;await (router as any).runTask('user',prompt,ctx,job.id);
    assert.equal(store.job(job.id)?.status,'complete');assert.equal(store.job(job.id)?.attempts,2);assert(fs.existsSync(log));
    assert.equal(kbKeys.size,1); // completion enriches the same durable KB record
  } finally {CONFIG.WORKSPACES_FILE=oldWs;store.close();}
});

test('partial publication keeps the verified Blog link, reports every channel, and resumes only the missing draft', async () => {
  const oldWs=CONFIG.WORKSPACES_FILE;CONFIG.WORKSPACES_FILE=path.join(dir,'partial-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const file=path.join(dir,'partial-publication.db');const store=new SessionStore(file,'codex');
  let draftReady=false;const replies:string[]=[];
  const sender={send:async(_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager(),{
    checkDuplicate:async()=>({file:'/tmp/local-ledgers',duplicate:true,wechatError:'40164'}),
    verifyPublication:async()=>({slug:'test',blogUrl:'https://blog.mushroom.cv/blog/test/',mediaId:draftReady?'draft':'',banner:'test.jpg',wechatError:draftReady?'':'{"errcode":40164,"errmsg":"invalid ip 203.0.113.8, not in whitelist"}'}),
  });
  (router as any).kb={insert:()=>({id:1,tags:[],title:'source'})};
  (router as any).contextTokens.set('user','test');
  const log=path.join(dir,'partial-cli.jsonl'),prompt=JSON.stringify({log}),ctx={rawText:prompt,rawPaths:[],urls:[],hasMedia:false};
  try {
    await (router as any).runTask('user',prompt,ctx);
    const job=store.failedJobs('user')[0];assert.equal(job.status,'blocked');
    assert.equal(JSON.parse(job.result_json).blogUrl,'https://blog.mushroom.cv/blog/test/');
    assert(replies.at(-1)?.startsWith('是不是发布了博客？是'));assert(replies.at(-1)?.includes('✅ KB'));assert(replies.at(-1)?.includes('❌ 公众号草稿'));
    draftReady=true;await (router as any).runTask('user',prompt,ctx,job.id);
    assert.equal(store.job(job.id)?.status,'complete');assert(replies.at(-1)?.includes('media_id: draft'));
    assert(replies.at(-1)?.includes('https://blog.mushroom.cv/blog/test/'));
  } finally {CONFIG.WORKSPACES_FILE=oldWs;store.close();}
});

test('publication reports survive a restart and delivery failure without replaying the completed publication', async () => {
  const file=path.join(dir,'reply-outbox.db');let store=new SessionStore(file,'codex');
  store.saveReplyContext('user','first-context');store.queueReply('completed-job','user','是不是发布了博客？是\nhttps://blog.mushroom.cv/blog/test/');store.close();
  store=new SessionStore(file,'codex');let fail=true;const sent:string[]=[];
  const sender={send:async(_u:string,_c:string,text:string)=>{if(fail)throw new Error('network');sent.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager());
  try {
    await (router as any).flushReplies('user');assert.equal(store.pendingReplies('user').length,1);assert.equal(store.replyContext('user'),'first-context');
    fail=false;await router.handle({message_id:77,from_user_id:'user',context_token:'new-context',item_list:[{type:1,text_item:{text:'/status'}}]} as WeixinMessage);
    assert.equal(store.pendingReplies('user').length,0);assert.equal(store.replyContext('user'),'new-context');assert(sent[0].startsWith('是不是发布了博客？是'));
    await (router as any).flushReplies('user');assert.equal(sent.filter(x=>x.startsWith('是不是发布了博客？')).length,1);
  } finally {store.close();}
});

test('a failed initial acknowledgement cannot block KB or publication and the final result is sent later without replay', async () => {
  const oldWs=CONFIG.WORKSPACES_FILE;CONFIG.WORKSPACES_FILE=path.join(dir,'ack-failure-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const store=new SessionStore(path.join(dir,'ack-failure.db'),'codex');let deliveryFails=true;const sent:string[]=[],steps:string[]=[];
  const sender={send:async(_u:string,_c:string,text:string)=>{if(deliveryFails)throw new Error('ret=-2: prepare failed');sent.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager(),{
    checkDuplicate:async()=>{steps.push('dedup');return {file:'/tmp/dedup',duplicate:false};},
    verifyPublication:async()=>({slug:'test',blogUrl:'https://blog.mushroom.cv/blog/test/',mediaId:'actual-draft',banner:'banner.jpg'}),
  });
  (router as any).kb={insert:()=>{steps.push('kb');return {id:1,title:'test',tags:[]};}};
  (router as any).contextTokens.set('user','old-context');store.saveReplyContext('user','old-context');
  const log=path.join(dir,'ack-failure.jsonl'),prompt=JSON.stringify({log});
  try {
    await (router as any).runTask('user',prompt,{rawText:prompt,rawPaths:[],urls:[],hasMedia:false});
    const job=store.recentJobs('user')[0];assert.equal(job.status,'complete');assert.equal(job.kb_confirmed,1);assert.equal(job.attempts,1);
    assert.deepEqual(steps.slice(0,2),['dedup','kb']);assert.equal(store.pendingReplies('user').length,1);assert(fs.existsSync(log));
    deliveryFails=false;(router as any).contextTokens.set('user','fresh-context');await (router as any).flushReplies('user');
    assert.equal(store.pendingReplies('user').length,0);assert.equal(sent.length,1);assert(sent[0].startsWith('是不是发布了博客？是'));
    assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,1);
  } finally {CONFIG.WORKSPACES_FILE=oldWs;store.close();}
});

test('real verifier validates live Blog independently and rejects a forged WeChat media ID', async () => {
  const oldRoot=CONFIG.BLOG_WORKSPACE,oldFetch=globalThis.fetch;
  const root=path.join(dir,'partial-verifier'),slug='example-topic';CONFIG.BLOG_WORKSPACE=root;
  fs.mkdirSync(path.join(root,'src/content/blog'),{recursive:true});fs.mkdirSync(path.join(root,'src/assets/images'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/content/blog',slug+'.md'),'---\nheroImage: "../../assets/images/example-banner.jpg"\n---\nbody');
  fs.writeFileSync(path.join(root,'src/assets/images/example-banner.jpg'),'image');
  globalThis.fetch=async()=>new Response('<meta property="og:image" content="https://site/example-banner.abc.webp">',{status:200});
  const data={slug,blogUrl:`https://blog.mushroom.cv/blog/${slug}/`,mediaId:'',wechatError:'40164'};
  const block=(d:unknown)=>'```publication-result\n'+JSON.stringify(d)+'\n```';
  try {
    const proof=await verifyPublication(block(data));assert.equal(proof.mediaId,'');assert.equal(proof.blogUrl,data.blogUrl);
    fs.mkdirSync(path.join(root,'pipeline/m2/output'),{recursive:true});fs.writeFileSync(path.join(root,'pipeline/m2/output',slug+'.json'),JSON.stringify({mediaId:'actual'}));
    await assert.rejects(verifyPublication(block({...data,mediaId:'forged'})),/公众号草稿记录未核验/);
    const archived=await verifyPublication(block({...data,mediaId:'actual',wechatStatus:'recorded',wechatError:'旧草稿不在当前草稿箱；已发布列表 48001'}));
    assert.equal(archived.wechatStatus,'recorded');assert.equal(archived.mediaId,'');assert.equal(archived.archivedMediaId,'actual');assert.match(archived.wechatError!,/48001/);
    await assert.rejects(verifyPublication(block({...data,mediaId:'actual',wechatStatus:'recorded',wechatError:''})),/未核验原因/);
  } finally {CONFIG.BLOG_WORKSPACE=oldRoot;globalThis.fetch=oldFetch;}
});

test('archived WeChat receipts preserve uncertainty and never claim a current draft exists', () => {
  const reply=publicationReply(true,{blogUrl:'https://blog.mushroom.cv/blog/anatomy/',mediaId:'old-media',wechatStatus:'recorded',wechatError:'当前草稿未找到，已发布列表 48001'});
  assert(reply.startsWith('是不是发布了博客？是'));assert.match(reply,/保留旧创建凭证/);assert.match(reply,/未重新创建/);
  assert(!reply.includes('✅ 公众号草稿：已创建'));assert.match(reply,/48001/);
});

test('publication jobs dedup and ingest before CLI, persist partial failure, then resume and verify completion', async () => {
  const oldWs=CONFIG.WORKSPACES_FILE;
  CONFIG.WORKSPACES_FILE=path.join(dir,'workflow-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const file=path.join(dir,'workflow.db');const store=new SessionStore(file,'codex');
  const replies:string[]=[];const steps:string[]=[];let verifyCalls=0;
  const sender={send:async (_u:string,_c:string,text:string)=>{replies.push(text);},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager(),{
    checkDuplicate:async()=>{steps.push('dedup');return {file:'/tmp/dedup.json',duplicate:verifyCalls>0};},
    verifyPublication:async()=>{steps.push('verify');if (++verifyCalls===1) throw new Error('公众号草稿缺失');return {slug:'test',blogUrl:'https://blog.mushroom.cv/blog/test/',mediaId:'draft',banner:'test.jpg'};},
  });
  (router as any).kb={insert:(draft:any)=>{steps.push('kb');assert(draft.idempotency_key);return {id:1,tags:[],title:'test'};}};
  const log=path.join(dir,'workflow.jsonl');const prompt=JSON.stringify({log});
  const ctx={rawText:prompt,rawPaths:[],urls:[],hasMedia:false};
  try {
    (router as any).contextTokens.set('user','test');
    await (router as any).runTask('user',prompt,ctx);
    const job=store.failedJobs('user')[0];assert(job);assert.equal(job.kb_confirmed,1);
    assert.deepEqual(JSON.parse(job.context_json),ctx);assert.equal(job.session_uuid,'codex-thread');
    assert.deepEqual(steps.slice(0,2),['dedup','kb']);assert(!replies.at(-1)?.includes('✅ Blog'));
    const reopen=new SessionStore(file,'codex');try {assert.equal(reopen.failedJobs('user')[0].id,job.id);} finally {reopen.close();}
    await (router as any).runTask('user',prompt,ctx,job.id);
    assert.equal(store.job(job.id)?.status,'complete');assert.equal(store.job(job.id)?.attempts,2);
    assert.equal((router as any).lastFailed.has('user'),false);
    const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x));
    assert(calls[0].args.includes('gpt-6.1-sol'));assert(calls[1].args.includes('resume'));
    assert(calls[0].input.includes('写作前查重'));assert(calls[1].input.includes('只补缺失步骤'));
    assert.equal(store.failedJobs('other').length,0);
  } finally {CONFIG.WORKSPACES_FILE=oldWs;store.close();}
});

test('KB failure blocks writing and keeps complete content for retry', async () => {
  const oldWs=CONFIG.WORKSPACES_FILE;CONFIG.WORKSPACES_FILE=path.join(dir,'kb-fail-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const store=new SessionStore(path.join(dir,'kb-fail.db'),'codex');
  const sender={send:async()=>{},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager(),{checkDuplicate:async()=>({file:'/tmp/check',duplicate:false}),verifyPublication:async()=>{throw new Error('unexpected');}});
  (router as any).kb={insert:()=>{throw new Error('KB unavailable');}};
  const log=path.join(dir,'blocked-writing.jsonl');const prompt=JSON.stringify({log});
  try {
    await (router as any).runTask('user',prompt,{rawText:prompt,rawPaths:[],urls:[],hasMedia:false});
    assert(!fs.existsSync(log));const job=store.failedJobs('user')[0];assert.equal(job.prompt,prompt);assert.equal(job.kb_confirmed,0);
    store.updateJob(job.id,{next_retry:0});assert.equal(store.failedJobs('user',true).length,1);
    for (let i=0;i<2;i++){assert(store.claimJob(job.id));store.updateJob(job.id,{status:'failed'});}
    assert.equal(store.failedJobs('user',true).length,0); // three attempts, retained for manual retry
  } finally {CONFIG.WORKSPACES_FILE=oldWs;store.close();}
});

test('received messages survive a crash during turn buffering, dedup redelivery, and attach atomically to a job', async () => {
  const oldWs=CONFIG.WORKSPACES_FILE;CONFIG.WORKSPACES_FILE=path.join(dir,'inbox-workspaces.json');
  fs.writeFileSync(CONFIG.WORKSPACES_FILE,JSON.stringify({default:'blog',workspaces:{blog:{path:dir,description:'test'}}}));
  const file=path.join(dir,'inbox.db');let store=new SessionStore(file,'codex');
  const sender={send:async()=>{},sendTyping:async()=>{}} as unknown as Sender;
  const message={message_id:42,from_user_id:'user',context_token:'test',item_list:[{type:1,text_item:{text:'incoming content'}}]} as WeixinMessage;
  const first=new Router(sender,store,new WorkspaceManager());
  try {
    await first.handle(message);
    const receipt=store.pendingInbox()[0];assert(receipt);
    clearTimeout((first as any).turns.get('user').timer);(first as any).turns.clear();store.close();
    store=new SessionStore(file,'codex');const restarted=new Router(sender,store,new WorkspaceManager());
    await (restarted as any).restoreInbox();
    assert.equal((restarted as any).turns.get('user').items[0].text,'incoming content');
    await restarted.handle(message);
    assert.equal((restarted as any).turns.get('user').items.length,1);
    const context={rawText:'incoming content',rawPaths:[],urls:[],hasMedia:false};
    store.createJob('durable','user','blog','incoming content',context,[receipt.id]);
    assert.equal(store.pendingInbox().length,0);
    store.recoverInterruptedJobs();assert.equal(store.failedJobs('user')[0].id,'durable');
    await restarted.handle({...message,item_list:[{type:1,text_item:{text:'/stop'}}]});
  } finally {CONFIG.WORKSPACES_FILE=oldWs;store.close();}
});

test('explicit failure compensation takes priority over new queued material and an occupied slot retains its queue', async () => {
  const file=path.join(dir,'compensation-priority.db'),store=new SessionStore(file,'codex');
  const job=store.createJob('old-failure','user','blog','Old content',{rawText:'Old content',rawPaths:[],urls:[],hasMedia:false});
  store.updateJob(job.id,{status:'blocked'});store.requestRetry(job.id);
  const sender={send:async()=>{},sendTyping:async()=>{}} as unknown as Sender;
  const router=new Router(sender,store,new WorkspaceManager()),calls:string[]=[];
  (router as any).queued.set('user',[{type:1,text:'New material',rawItem:{type:1,text_item:{text:'New material'}}}]);
  (router as any).runTask=async(_u:string,_p:string,_c:unknown,id:string)=>{calls.push(id);store.updateJob(id,{status:'complete'});};
  try {
    await (router as any).retryFailed('user');assert.deepEqual(calls,['old-failure']);
    (router as any).running.add('user');await (router as any).runQueued('user');
    assert.equal((router as any).queued.get('user')[0].text,'New material');
  } finally {store.close();}
});
