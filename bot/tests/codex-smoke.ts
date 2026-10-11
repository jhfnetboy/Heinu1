// Manual live CLI check, independent of iLink: npm run smoke:codex
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCodex } from '../src/codex/runner';
import type { RunEvent } from '../src/agent/runner';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'heinu1-live-'));
  const marker = randomUUID();
  const signal = AbortSignal.timeout(120_000);
  const events: RunEvent[] = [];
  try {
    const sid = await runCodex(`This is a local integration test. Run a shell command to write the exact text ${marker} to token.txt in the current directory, read it back, and reply SMOKE_OK followed by that text. Do not change anything else.`,
      {sessionId:null,cwd:dir,extraDirs:[dir],signal},ev=>events.push(ev));
    assert(sid);
    assert(events.some(ev=>ev.type==='tool'));
    assert(events.find(ev=>ev.type==='result')?.text?.includes(marker));
    assert.equal(fs.readFileSync(path.join(dir,'token.txt'),'utf8').trim(),marker);
    const resumed: RunEvent[] = [];
    const next = await runCodex('Without reading files or using tools, return the exact random text from our previous turn. Only that text.',
      {sessionId:sid,cwd:dir,extraDirs:[dir],signal},ev=>resumed.push(ev));
    assert.equal(next,sid);
    assert(resumed.find(ev=>ev.type==='result')?.text?.includes(marker));
    console.log(JSON.stringify({newTurn:true,toolAndFileWrite:true,resume:true,sameThread:true}));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
main().catch(err=>{ console.error(err.message); process.exitCode=1; });
