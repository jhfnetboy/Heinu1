#!/usr/bin/env node
/**
 * 工作区配置 CLI
 * 用法见下方 USAGE
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { CONFIG } from './config';
import { loadWorkspaces, saveWorkspaces, WorkspaceFile } from './workspace';

const USAGE = `
🦞 Heinu1 Bot — 工作区配置工具

用法:
  npm run ws list                            列出所有工作区
  npm run ws add <名称> <路径> [描述]         添加工作区
  npm run ws rm  <名称>                      删除工作区
  npm run ws default <名称>                  设为默认工作区
  npm run ws show                            显示配置文件路径和内容

示例:
  npm run ws add main    ~/Dev/myproject    "主项目"
  npm run ws add web     ~/Dev/frontend     "前端 React"
  npm run ws add scripts ~/Dev/tools        "工具脚本"
  npm run ws default main
  npm run ws list

配置文件: ${CONFIG.WORKSPACES_FILE}
`.trim();

function resolvePath(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

function ensureConfig(): WorkspaceFile {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  return loadWorkspaces();
}

function printTable(wf: WorkspaceFile) {
  const entries = Object.entries(wf.workspaces);
  if (!entries.length) {
    console.log('（暂无工作区）');
    return;
  }

  console.log(`\n默认工作区: ${wf.default}\n`);
  console.log('名称'.padEnd(16) + '路径'.padEnd(40) + '描述');
  console.log('─'.repeat(72));
  for (const [name, def] of entries) {
    const marker  = name === wf.default ? ' ★' : '  ';
    const exists  = fs.existsSync(def.path) ? '' : ' ⚠️ 路径不存在';
    const nameCol = (marker + name).padEnd(16);
    const pathCol = def.path.padEnd(40);
    console.log(`${nameCol}${pathCol}${def.description}${exists}`);
    if (def.extra_dirs?.length) {
      for (const d of def.extra_dirs) {
        console.log(' '.repeat(16) + `+ ${d}`);
      }
    }
  }
  console.log('');
}

// ── Subcommands ───────────────────────────────────────────────────────────────

function cmdList() {
  const wf = ensureConfig();
  printTable(wf);
}

function cmdAdd(args: string[]) {
  const [name, rawPath, ...descParts] = args;
  if (!name || !rawPath) {
    console.error('❌ 用法: npm run ws add <名称> <路径> [描述]');
    process.exit(1);
  }

  const resolved = resolvePath(rawPath);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ 路径不存在: ${resolved}`);
    process.exit(1);
  }

  const wf = ensureConfig();

  if (wf.workspaces[name]) {
    console.error(`❌ 工作区 "${name}" 已存在，先用 npm run ws rm ${name} 删除`);
    process.exit(1);
  }

  const desc = descParts.join(' ') || name;
  wf.workspaces[name] = { path: resolved, description: desc };

  // 如果是第一个工作区，自动设为默认
  if (Object.keys(wf.workspaces).length === 1 ||
      !wf.workspaces[wf.default]) {
    wf.default = name;
    console.log(`  → 自动设为默认工作区`);
  }

  saveWorkspaces(wf);
  console.log(`✅ 已添加工作区 "${name}"`);
  console.log(`   路径: ${resolved}`);
  console.log(`   描述: ${desc}`);
  printTable(wf);
}

function cmdRemove(args: string[]) {
  const [name] = args;
  if (!name) {
    console.error('❌ 用法: npm run ws rm <名称>');
    process.exit(1);
  }

  const wf = ensureConfig();
  if (!wf.workspaces[name]) {
    console.error(`❌ 工作区 "${name}" 不存在`);
    process.exit(1);
  }
  if (name === wf.default) {
    console.error(`❌ 不能删除默认工作区 "${name}"，先用 default 命令换一个默认`);
    process.exit(1);
  }

  delete wf.workspaces[name];
  saveWorkspaces(wf);
  console.log(`✅ 已删除工作区 "${name}"`);
  printTable(wf);
}

function cmdDefault(args: string[]) {
  const [name] = args;
  if (!name) {
    console.error('❌ 用法: npm run ws default <名称>');
    process.exit(1);
  }

  const wf = ensureConfig();
  if (!wf.workspaces[name]) {
    const available = Object.keys(wf.workspaces).join(', ');
    console.error(`❌ 工作区 "${name}" 不存在，可用: ${available}`);
    process.exit(1);
  }

  wf.default = name;
  saveWorkspaces(wf);
  console.log(`✅ 默认工作区已设为 "${name}"`);
  printTable(wf);
}

function cmdShow() {
  const wf = ensureConfig();
  console.log(`配置文件: ${CONFIG.WORKSPACES_FILE}\n`);
  console.log(JSON.stringify(wf, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [,, sub, ...rest] = process.argv;

switch (sub) {
  case 'list':    cmdList();           break;
  case 'add':     cmdAdd(rest);        break;
  case 'rm':
  case 'remove':  cmdRemove(rest);     break;
  case 'default': cmdDefault(rest);    break;
  case 'show':    cmdShow();           break;
  default:
    console.log(USAGE);
    if (sub) {
      console.error(`\n❌ 未知子命令: ${sub}`);
      process.exit(1);
    }
}
