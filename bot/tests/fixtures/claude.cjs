#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const request = JSON.parse(args[args.indexOf('--print')+1]);
if (request.log) fs.appendFileSync(request.log,JSON.stringify({args,backend:'claude'})+'\n');
const resume = args.indexOf('--resume');
const sid = resume>=0 ? args[resume+1] : 'claude-thread';
const event = ev=>process.stdout.write(JSON.stringify(ev)+'\n');
event({type:'system',subtype:'init',session_id:sid});
if (request.mode === 'quota') {
  event({type:'result',is_error:true,result:"You've hit your weekly limit",session_id:sid});
  process.exitCode = 1;
  return;
}
event({type:'result',result:'CLAUDE_DONE',session_id:sid});
