/**
 * MempalaceStore — drop-in replacement for KbStore that writes to the global
 * MemPalace at ~/.mempalace/palace instead of a local SQLite file.
 *
 * The public interface is identical to KbStore so router.ts needs a one-line
 * import swap. Integer IDs are generated sequentially in-memory and reset on
 * daemon restart (acceptable: /kb <id> is only useful within a session).
 *
 * Under the hood every operation shells out to bot/scripts/mp_bridge.py via
 * CONFIG.MEMPALACE_PYTHON. The bridge returns JSON and exits 0 on success.
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { CONFIG } from '../config';
import { KbRecord, KbDraft } from './store';

// Re-export types so callers that import from here still compile
export { KbRecord, KbDraft } from './store';

const BRIDGE = path.join(__dirname, '../../scripts/mp_bridge.py');

/** Run the bridge script; return parsed JSON. Throws on non-zero exit. */
function bridge<T>(cmd: string, payload: object = {}): T {
  const input  = JSON.stringify(payload);
  const stdout = execFileSync(
    CONFIG.MEMPALACE_PYTHON,
    [BRIDGE, cmd],
    { input, encoding: 'utf8', timeout: 30_000 },
  );
  return JSON.parse(stdout) as T;
}

interface BridgeRecord {
  drawer_id:      string;
  title:          string;
  summary:        string;
  content_type:   string;
  tags:           string[];
  entities:       string[];
  user_openid:    string;
  workspace:      string;
  source_session: string;
  raw_files:      string[];
  raw_text:       string;
  created_at:     number;
  filed_at:       string;
}

export class MempalaceStore {
  private nextId    = 1;
  private idMap     = new Map<number, string>();     // localId → drawerId
  private recordMap = new Map<number, KbRecord>();   // localId → hydrated record

  /** Assign or reuse a stable local integer ID for a drawerId. */
  private localId(drawerId: string): number {
    for (const [id, did] of this.idMap) {
      if (did === drawerId) return id;
    }
    const id = this.nextId++;
    this.idMap.set(id, drawerId);
    return id;
  }

  private toKbRecord(br: BridgeRecord, localId: number): KbRecord {
    return {
      id:             localId,
      user_openid:    br.user_openid,
      workspace:      br.workspace,
      title:          br.title,
      summary:        br.summary,
      content_type:   br.content_type,
      tags:           br.tags,
      entities:       br.entities,
      raw_text:       br.raw_text,
      raw_files:      br.raw_files,
      source_session: br.source_session,
      created_at:     br.created_at || Date.now(),
    };
  }

  insert(draft: KbDraft): KbRecord {
    const result = bridge<{ success?: boolean; drawer_id?: string; reason?: string; error?: string }>(
      'add', draft,
    );

    if (result.error) throw new Error(`MemPalace add failed: ${result.error}`);

    // Duplicate: MemPalace rejected it — synthesise a minimal record so the
    // caller still gets something back and the reply shows "已入库".
    const drawerId = result.drawer_id ?? `dup_${Date.now()}`;
    const id = this.localId(drawerId);
    const rec: KbRecord = {
      id,
      user_openid:    draft.user_openid,
      workspace:      draft.workspace,
      title:          draft.title,
      summary:        draft.summary,
      content_type:   draft.content_type,
      tags:           draft.tags,
      entities:       draft.entities,
      raw_text:       draft.raw_text,
      raw_files:      draft.raw_files,
      source_session: draft.source_session,
      created_at:     Date.now(),
    };
    this.recordMap.set(id, rec);
    return rec;
  }

  get(id: number): KbRecord | undefined {
    // First check the in-memory cache (covers records inserted this session)
    const cached = this.recordMap.get(id);
    if (cached) return cached;

    const drawerId = this.idMap.get(id);
    if (!drawerId) return undefined;

    const br = bridge<BridgeRecord | null>('get', { drawer_id: drawerId });
    if (!br) return undefined;

    const rec = this.toKbRecord(br, id);
    this.recordMap.set(id, rec);
    return rec;
  }

  search(userOpenid: string, query: string, limit = 10): KbRecord[] {
    const { results } = bridge<{ results: Array<{ text: string; room: string; similarity: number }> }>(
      'search', { query, limit },
    );
    // search results carry text but not structured fields — synthesise minimal records
    return results.map((hit, idx) => {
      const id = this.nextId++;
      return {
        id,
        user_openid:    userOpenid,
        workspace:      'default',
        title:          firstLine(hit.text),
        summary:        firstLine(hit.text, 120),
        content_type:   hit.room,
        tags:           [],
        entities:       [],
        raw_text:       hit.text,
        raw_files:      [],
        source_session: '',
        created_at:     Date.now(),
      } satisfies KbRecord;
    });
  }

  recent(userOpenid: string, limit = 10): KbRecord[] {
    const { results } = bridge<{ results: BridgeRecord[] }>('recent', { limit });
    return results.map(br => {
      const id = this.localId(br.drawer_id);
      const rec = this.toKbRecord(br, id);
      this.recordMap.set(id, rec);
      return rec;
    });
  }

  count(_userOpenid: string): number {
    const { count } = bridge<{ count: number }>('count');
    return count;
  }
}

/** Extract the first non-empty line from text, optionally truncated. */
function firstLine(text: string, maxLen = 60): string {
  const line = text.split('\n').find(l => l.trim().replace(/^#\s*/, '').trim()) ?? '';
  const clean = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
  return clean.length <= maxLen ? clean : clean.slice(0, maxLen - 1) + '…';
}
