import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG } from '../config';

/**
 * Phase-1 knowledge-base ingest helpers.
 *
 * Design: ingest piggybacks on the single `claude` run the bot already does
 * per turn — no extra LLM call. We append KB_INSTRUCTION to the prompt asking
 * Claude to emit a fenced ```kb-record JSON block; after the run we parse that
 * block, archive the raw files, and write one SQLite record. If the block is
 * missing/malformed we fall back to a record built from the raw text so an
 * ingest turn is never silently dropped.
 */

export interface ParsedKbRecord {
  title:        string;
  summary:      string;
  tags:         string[];
  entities:     string[];
  content_type: string;
  saved_files:  string[];   // image/file paths Claude downloaded (URL ingest)
}

/** Appended to the user's prompt when the turn is ingest-worthy. */
export const KB_INSTRUCTION = `

---
[知识库录入] 这条消息要存入知识库。请正常完成上面的请求，然后在回复的最末尾追加一个 \`\`\`kb-record 代码块，内含一个 JSON 对象，字段如下：
- title: 一句话标题（≤30字）
- summary: 2-4句话的要点摘要
- tags: 主题标签数组（3-6个，如 ["美食","旅行"]）
- entities: 出现的人名/地名/品牌/项目数组（没有则空数组）
- content_type: 内容主体类型，取值 text | image | file | mixed

示例：
\`\`\`kb-record
{"title":"杭州西湖樱花","summary":"西湖边樱花盛开，适合周末赏花。游客较多，建议早上去。","tags":["旅行","赏花","杭州"],"entities":["西湖"],"content_type":"image"}
\`\`\``;

/**
 * Instruction for turns whose text contains a URL (XiaoHongShu / 公众号 /
 * web article). Tells Claude to fetch via the agent-reach skill, download
 * images into MEDIA_DIR, and report their absolute paths in `saved_files` so
 * the bot can archive them. Appended INSTEAD of KB_INSTRUCTION for URL turns.
 */
export function buildUrlInstruction(urls: string[]): string {
  return `

---
[知识库录入·链接抓取] 这条消息包含链接，需要抓取内容后存入知识库。请按以下步骤：
1. 用 agent-reach skill 抓取这些链接的正文内容（小红书/公众号/网页都用 agent-reach，按它的 doctor 选对应后端；网页可用 Jina Reader）：
${urls.map(u => `   - ${u}`).join('\n')}
2. 如果有配图，把图片下载到目录 ${CONFIG.MEDIA_DIR}/ 下（文件名随意，保留扩展名）。
3. 用抓取到的正文做摘要和信息提取。
4. 在回复的最末尾追加一个 \`\`\`kb-record 代码块，JSON 字段：
- title: 一句话标题（≤30字）
- summary: 2-4句话的要点摘要（基于抓取的正文）
- tags: 主题标签数组（3-6个）
- entities: 人名/地名/品牌/项目数组（没有则空数组）
- content_type: 固定填 "url"
- saved_files: 你下载的图片的绝对路径数组（没有下载图片则空数组 []）

示例：
\`\`\`kb-record
{"title":"小红书：杭州咖啡探店","summary":"博主推荐了3家杭州小众咖啡馆，主打手冲和氛围感。人均40-60元。","tags":["咖啡","探店","杭州"],"entities":["杭州"],"content_type":"url","saved_files":["${CONFIG.MEDIA_DIR}/abc.jpg"]}
\`\`\`
注意：抓取失败时也要输出 kb-record（summary 写明抓取失败 + 链接本身），不要中断。`;
}

/** Extract http/https URLs from free text. */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s，。、）)】\]]+/g) ?? [];
  // de-dup, cap to a sane number
  return [...new Set(matches)].slice(0, 5);
}

/**
 * Archive downloaded media (currently in MEDIA_DIR) into the KB raw store,
 * grouped by date: kb/raw/YYYY-MM-DD/<filename>. Returns the new paths.
 * Copies (not moves) so the original media flow is untouched.
 */
export function archiveRawFiles(localPaths: string[], date = new Date()): string[] {
  if (!localPaths.length) return [];
  const day    = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const destDir = path.join(CONFIG.KB_RAW_DIR, day);
  fs.mkdirSync(destDir, { recursive: true });

  const archived: string[] = [];
  for (const src of localPaths) {
    try {
      const dest = path.join(destDir, path.basename(src));
      fs.copyFileSync(src, dest);
      archived.push(dest);
    } catch (err: any) {
      console.error(`[kb] 归档原始文件失败 ${src}: ${err.message}`);
    }
  }
  return archived;
}

const MAX_BLOCK_LEN = 10_000;   // cap to avoid pathologically large JSON.parse

/**
 * Extract and parse the kb-record JSON block from Claude's response text.
 * Uses the LAST fenced block (Claude may quote the instruction's example
 * earlier; the real record is appended at the end). Returns null if absent,
 * oversized, or unparseable.
 */
export function parseKbRecord(text: string): ParsedKbRecord | null {
  const matches = [...text.matchAll(/```kb-record\s*([\s\S]*?)```/g)];
  if (!matches.length) return null;
  const raw = matches[matches.length - 1][1].trim();
  if (!raw || raw.length > MAX_BLOCK_LEN) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    return {
      title:        String(obj.title ?? '').slice(0, 80),
      summary:      String(obj.summary ?? '').slice(0, 1000),
      tags:         toStringArray(obj.tags),
      entities:     toStringArray(obj.entities),
      content_type: normalizeType(obj.content_type),
      saved_files:  safeSavedFiles(obj.saved_files),
    };
  } catch {
    return null;
  }
}

/**
 * Strip kb-record blocks from the reply shown to the user. Removes both
 * properly-fenced blocks AND a trailing unclosed ```kb-record fragment
 * (malformed output must never leak to the user).
 */
export function stripKbRecord(text: string): string {
  return text
    .replace(/```kb-record\s*[\s\S]*?```/g, '')  // closed blocks
    .replace(/```kb-record[\s\S]*$/, '')          // trailing unclosed fragment
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Fallback record built from raw text when no/invalid kb-record block. */
export function fallbackRecord(rawText: string, hasMedia: boolean): ParsedKbRecord {
  const firstLine = (rawText.split('\n').find(l => l.trim()) ?? '').trim();
  return {
    title:        firstLine.slice(0, 30) || (hasMedia ? '(媒体记录)' : '(无标题记录)'),
    summary:      rawText.slice(0, 200),
    tags:         [],
    entities:     [],
    content_type: hasMedia ? 'mixed' : 'text',
    saved_files:  [],
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12);
}

function normalizeType(v: unknown): string {
  const t = String(v ?? '').toLowerCase();
  return ['text', 'image', 'file', 'mixed', 'url'].includes(t) ? t : 'text';
}

/**
 * Validate Claude-reported downloaded file paths before the bot copies them.
 * Only absolute paths that (after symlink-resolving the parent) live under an
 * allowed root — MEDIA_DIR, KB_DIR, or the OS temp dir — are accepted. This
 * stops a confused/poisoned model from making the bot archive arbitrary files
 * (e.g. ~/.ssh/id_rsa) via path traversal or absolute paths.
 */
function safeSavedFiles(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const roots = [CONFIG.MEDIA_DIR, CONFIG.KB_DIR, os.tmpdir()]
    .map(r => path.resolve(r) + path.sep);
  const out: string[] = [];
  for (const item of v.slice(0, 20)) {
    const p = String(item).trim();
    if (!p || !path.isAbsolute(p)) continue;
    const resolved = path.resolve(p);
    if (roots.some(root => (resolved + path.sep).startsWith(root))) {
      out.push(resolved);
    } else {
      console.error(`[kb] 拒绝归档越界文件: ${p}`);
    }
  }
  return out;
}
