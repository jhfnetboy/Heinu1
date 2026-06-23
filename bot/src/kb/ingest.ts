import fs from 'fs';
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

/**
 * Extract and parse the ```kb-record JSON block from Claude's response text.
 * Returns null if absent or unparseable.
 */
export function parseKbRecord(text: string): ParsedKbRecord | null {
  const m = text.match(/```kb-record\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    return {
      title:        String(obj.title ?? '').slice(0, 80),
      summary:      String(obj.summary ?? ''),
      tags:         toStringArray(obj.tags),
      entities:     toStringArray(obj.entities),
      content_type: normalizeType(obj.content_type),
    };
  } catch {
    return null;
  }
}

/** Strip the ```kb-record block out of the reply shown to the user. */
export function stripKbRecord(text: string): string {
  return text.replace(/```kb-record\s*[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
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
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String).map(s => s.trim()).filter(Boolean).slice(0, 12);
}

function normalizeType(v: unknown): string {
  const t = String(v ?? '').toLowerCase();
  return ['text', 'image', 'file', 'mixed'].includes(t) ? t : 'text';
}
