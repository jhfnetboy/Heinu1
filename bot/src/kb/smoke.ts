// Phase-1 KB smoke test. Run with a temp HOME so it never touches real data:
//   HOME=/tmp/kb-smoke npx tsx src/kb/smoke.ts
import { KbStore } from './store';
import { parseKbRecord, stripKbRecord, fallbackRecord, archiveRawFiles } from './ingest';
import fs from 'fs';
import os from 'os';
import path from 'path';

function assert(cond: any, msg: string) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exit(1); }
  console.log('✅', msg);
}

// ── parseKbRecord ──
const reply = `好的，这是西湖的樱花照片。

\`\`\`kb-record
{"title":"杭州西湖樱花","summary":"西湖边樱花盛开。","tags":["旅行","赏花"],"entities":["西湖"],"content_type":"image"}
\`\`\``;
const parsed = parseKbRecord(reply);
assert(parsed, 'parseKbRecord returns object');
assert(parsed!.title === '杭州西湖樱花', 'title parsed');
assert(parsed!.tags.length === 2, 'tags parsed');
assert(parsed!.content_type === 'image', 'content_type parsed');

// ── stripKbRecord ──
const stripped = stripKbRecord(reply);
assert(!stripped.includes('kb-record'), 'kb-record block stripped from reply');
assert(stripped.includes('西湖的樱花照片'), 'human text preserved');

// ── parse failure → null ──
assert(parseKbRecord('no block here') === null, 'missing block returns null');
assert(parseKbRecord('```kb-record\n{bad json}\n```') === null, 'bad json returns null');

// ── last block wins (claude may quote the example first) ──
const twoBlocks = '```kb-record\n{"title":"示例"}\n```\n实际结果\n```kb-record\n{"title":"真实标题"}\n```';
assert(parseKbRecord(twoBlocks)!.title === '真实标题', 'last kb-record block wins');

// ── oversized block rejected ──
const huge = '```kb-record\n{"title":"' + 'x'.repeat(20000) + '"}\n```';
assert(parseKbRecord(huge) === null, 'oversized block rejected');

// ── unclosed fence stripped (never leak malformed block) ──
const unclosed = '这是结果\n```kb-record\n{"title":"没闭合';
assert(!stripKbRecord(unclosed).includes('kb-record'), 'unclosed fence stripped');
assert(stripKbRecord(unclosed).includes('这是结果'), 'text before unclosed fence kept');

// ── fallbackRecord ──
const fb = fallbackRecord('第一行内容\n第二行', true);
assert(fb.title === '第一行内容', 'fallback title = first line');
assert(fb.content_type === 'mixed', 'fallback type mixed when media');

// ── archiveRawFiles ──
const tmpSrc = path.join(os.tmpdir(), 'kb-smoke-src.txt');
fs.writeFileSync(tmpSrc, 'hello');
const archived = archiveRawFiles([tmpSrc], new Date('2026-06-23'));
assert(archived.length === 1, 'one file archived');
assert(archived[0].includes('2026-06-23'), 'archived under date dir');
assert(fs.existsSync(archived[0]), 'archived file exists');

// ── KbStore insert + search + recent ──
const kb = new KbStore();
const rec = kb.insert({
  user_openid: 'user1', workspace: 'home',
  title: '杭州西湖樱花', summary: '西湖边樱花盛开，适合赏花。',
  content_type: 'image', tags: ['旅行', '赏花'], entities: ['西湖'],
  raw_text: '看西湖樱花', raw_files: archived, source_session: 'sess-abc',
});
assert(rec.id > 0, 'record inserted with id');
assert(rec.tags.length === 2, 'tags hydrated back');

const rec2 = kb.insert({
  user_openid: 'user1', workspace: 'home',
  title: '北京烤鸭', summary: '全聚德烤鸭味道不错。',
  content_type: 'text', tags: ['美食'], entities: ['全聚德'],
  raw_text: '烤鸭好吃', raw_files: [], source_session: 'sess-def',
});

const hits = kb.search('user1', '西湖');
assert(hits.length === 1 && hits[0].id === rec.id, 'FTS search finds 西湖 record');

const hits2 = kb.search('user1', '烤鸭');
assert(hits2.length === 1 && hits2[0].id === rec2.id, 'FTS search finds 烤鸭 record');

const recent = kb.recent('user1');
assert(recent.length === 2 && recent[0].id === rec2.id, 'recent newest-first');
assert(kb.count('user1') === 2, 'count = 2');

// isolation by user
assert(kb.search('user2', '西湖').length === 0, 'search isolated per user');

// ── control chars (NUL) must not throw FTS5 "unterminated string" ──
let nulOk = true;
try { kb.search('user1', 'a\u0000b'); } catch { nulOk = false; }
assert(nulOk, 'NUL char in query does not throw');
let ctrlOk = true;
try { kb.search('user1', '\u0001\u0002西湖\u0000烤鸭'); } catch { ctrlOk = false; }
assert(ctrlOk, 'control chars mixed with CJK do not throw');
// NUL between two CJK terms still matches (NUL -> space -> two terms)
assert(kb.search('user1', '\u0000西湖\u0000').length >= 1, 'NUL-wrapped CJK term still matches');

console.log('\n🎉 ALL KB SMOKE TESTS PASSED');
