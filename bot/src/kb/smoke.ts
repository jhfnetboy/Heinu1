// Phase-1 KB smoke test. Run with a temp HOME so it never touches real data:
//   HOME=/tmp/kb-smoke npx tsx src/kb/smoke.ts
import { KbStore } from './store';
import {
  parseKbRecord, stripKbRecord, fallbackRecord, archiveRawFiles,
  extractUrls, buildUrlInstruction,
} from './ingest';
import { CONFIG } from '../config';
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
assert(Array.isArray(fb.saved_files) && fb.saved_files.length === 0, 'fallback saved_files empty');

// ── extractUrls ──
assert(extractUrls('看这个 https://xhslink.com/abc 不错').length === 1, 'extract one url');
assert(extractUrls('https://a.com https://a.com').length === 1, 'extract dedupes');
assert(extractUrls('纯文字没有链接').length === 0, 'no url → empty');
assert(extractUrls('链接：https://mp.weixin.qq.com/s/xyz。后面').includes('https://mp.weixin.qq.com/s/xyz'),
  'url stops at CJK punctuation');
assert(buildUrlInstruction(['https://a.com']).includes('agent-reach'), 'url instruction mentions agent-reach');

// ── saved_files path safety (parseKbRecord) ──
const okPath = path.join(CONFIG.MEDIA_DIR, 'pic.jpg');
const goodBlock = '```kb-record\n' + JSON.stringify({
  title: 't', summary: 's', tags: [], entities: [], content_type: 'url',
  saved_files: [okPath, '/etc/passwd', '../../secret', 'relative.jpg'],
}) + '\n```';
// the accepted path is realpath'd; on macOS MEDIA_DIR under $HOME has no
// symlink components, so realpath(okPath) === okPath. Create the file first.
fs.mkdirSync(CONFIG.MEDIA_DIR, { recursive: true });
fs.writeFileSync(okPath, 'img');
const sf = parseKbRecord(goodBlock)!.saved_files;
assert(sf.length === 1 && sf[0] === fs.realpathSync.native(okPath),
  'only in-MEDIA_DIR saved_file accepted, traversal rejected');
assert(parseKbRecord(goodBlock)!.content_type === 'url', 'url content_type accepted');

// ── symlink bypass must be rejected (High #1) ──
// A symlink planted UNDER MEDIA_DIR whose target is outside all allowed roots
// must not be archived (realpath resolves it to the out-of-root target).
const outTarget = path.join(os.homedir(), '.kb-smoke-fake-secret');
fs.writeFileSync(outTarget, 'pretend id_rsa');
const evilLink = path.join(CONFIG.MEDIA_DIR, 'innocent.jpg');
try { fs.unlinkSync(evilLink); } catch {}
fs.symlinkSync(outTarget, evilLink);
const evilBlock = '```kb-record\n' + JSON.stringify({
  title: 't', summary: 's', tags: [], entities: [], content_type: 'url',
  saved_files: [evilLink],
}) + '\n```';
assert(parseKbRecord(evilBlock)!.saved_files.length === 0,
  'symlink under MEDIA_DIR pointing outside roots is rejected');
fs.unlinkSync(outTarget);

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
