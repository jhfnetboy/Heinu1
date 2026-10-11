#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (request.log) fs.appendFileSync(request.log, JSON.stringify({args, input}) + '\n');
  const event = ev => process.stdout.write(JSON.stringify(ev) + '\n');
  if (args.includes('missing-thread') || request.mode === 'missing-after-tool') {
    if (request.mode === 'missing-after-tool') event({type:'item.started',item:{id:'tool',type:'command_execution',command:'publish'}});
    process.stderr.write('no rollout found for thread id missing-thread');
    process.exitCode = 1;
    return;
  }
  event({type:'thread.started',thread_id:'codex-thread'});
  if (request.mode === 'wait') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    fs.writeFileSync(request.pidFile, String(child.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (request.mode === 'failed') {
    event({type:'turn.failed',error:{message:'Authentication token expired'}});
    return; // even exit 0 must be treated as failure
  }
  if (request.mode === 'incomplete') return;
  event({type:'error',message:'Reconnecting...'});
  event({type:'item.started',item:{id:'tool',type:'command_execution',command:'printf ok'}});
  event({type:'item.completed',item:{id:'tool',type:'command_execution',command:'printf ok'}});
  event({type:'item.completed',item:{id:'msg1',type:'agent_message',text:'progress'}});
  const bytes = Buffer.from(JSON.stringify({type:'item.completed',item:{id:'msg2',type:'agent_message',text:'完成🍄'}}) + '\n');
  const cut = bytes.indexOf(Buffer.from('🍄')) + 1;
  process.stdout.write(bytes.subarray(0,cut));
  setTimeout(() => {
    process.stdout.write(bytes.subarray(cut));
    process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  },10);
});
