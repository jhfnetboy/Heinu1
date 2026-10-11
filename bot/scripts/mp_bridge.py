#!/usr/bin/env python3
"""
MemPalace JSON bridge for Heinu1 bot.

Provides a JSON-in / JSON-out CLI so TypeScript can shell out to MemPalace
without depending on it at compile time.

Commands (first CLI arg):
  add     - file a KB record into the palace
  search  - semantic search within the heinu1 wing
  recent  - list most recent drawers (heinu1 wing)
  get     - fetch one drawer by drawer_id
  count   - count drawers in heinu1 wing

Input:  JSON object on stdin (or empty object if stdin is a TTY)
Output: JSON object on stdout

Exit codes: 0 = success, 1 = error
"""

import sys
import json
import os
from datetime import datetime
JSON_OUTPUT = os.fdopen(os.dup(sys.stdout.fileno()), 'w')  # MCP import redirects fd 1 too

# MemPalace lives in its own venv; this bridge is run via MEMPALACE_PYTHON
# so the package is already on sys.path. If running standalone for testing,
# insert the source tree explicitly.
_mp_src = os.environ.get("MEMPALACE_SOURCE_DIR")
if _mp_src and _mp_src not in sys.path:
    sys.path.insert(0, _mp_src)

from mempalace.config import MempalaceConfig
from mempalace.mcp_server import tool_add_drawer
from mempalace.backends.chroma import ChromaBackend

_config = MempalaceConfig()
_backend = ChromaBackend()

WING = "heinu1"


# ─── helpers ─────────────────────────────────────────────────────────────────

def _get_collection():
    # Share MemPalace's writer lock and freshness handling with its CLI/MCP writers.
    return _backend.get_collection(_config.palace_path, _config.collection_name, False)


def _parse_record_content(content: str, drawer_id: str, meta: dict) -> dict:
    """Extract KbRecord fields from drawer content markdown."""
    lines = content.splitlines()
    title = lines[0].lstrip("# ").strip() if lines else drawer_id

    summary = ""
    tags: list[str] = []
    entities: list[str] = []
    user_openid = ""
    workspace = "default"
    source_session = ""
    raw_files: list[str] = []
    raw_text_lines: list[str] = []
    in_raw = False

    for line in lines[1:]:
        if line.startswith("---"):
            in_raw = True
            continue
        if in_raw:
            raw_text_lines.append(line)
            continue
        if line.startswith("**Summary**: "):
            summary = line[len("**Summary**: "):]
        elif line.startswith("**Tags**: "):
            raw = line[len("**Tags**: "):]
            tags = [t.strip() for t in raw.split(",") if t.strip()]
        elif line.startswith("**Entities**: "):
            raw = line[len("**Entities**: "):]
            entities = [e.strip() for e in raw.split(",") if e.strip()]
        elif line.startswith("**User**: "):
            user_openid = line[len("**User**: "):]
        elif line.startswith("**Workspace**: "):
            workspace = line[len("**Workspace**: "):]
        elif line.startswith("**Session**: "):
            source_session = line[len("**Session**: "):]
        elif line.startswith("**Files**: "):
            raw = line[len("**Files**: "):]
            raw_files = [f.strip() for f in raw.split(",") if f.strip()]

    filed_at_str = meta.get("filed_at", "")
    try:
        from datetime import timezone
        dt = datetime.fromisoformat(filed_at_str)
        created_at = int(dt.timestamp() * 1000)
    except Exception:
        created_at = 0

    return {
        "drawer_id": drawer_id,
        "title": title,
        "summary": summary,
        "content_type": meta.get("room", "text"),
        "tags": tags,
        "entities": entities,
        "user_openid": user_openid,
        "workspace": workspace,
        "source_session": source_session,
        "raw_files": raw_files,
        "raw_text": "\n".join(raw_text_lines).strip(),
        "created_at": created_at,
        "filed_at": filed_at_str,
    }


# ─── commands ────────────────────────────────────────────────────────────────

def cmd_add(data: dict) -> dict:
    title = data.get("title", "")
    summary = data.get("summary", "")
    content_type = data.get("content_type", "text")
    tags = data.get("tags", [])
    entities = data.get("entities", [])
    raw_text = data.get("raw_text", "")
    workspace = data.get("workspace", "default")
    user_openid = data.get("user_openid", "")
    source_session = data.get("source_session", "")
    raw_files = data.get("raw_files", [])
    job_key = data.get("idempotency_key", "")

    # Format as rich markdown so semantic search finds the right things
    lines = [f"# {title}", ""]
    if summary:
        lines.append(f"**Summary**: {summary}")
    lines.append(f"**Type**: {content_type}")
    if tags:
        lines.append(f"**Tags**: {', '.join(tags)}")
    if entities:
        lines.append(f"**Entities**: {', '.join(entities)}")
    if user_openid:
        lines.append(f"**User**: {user_openid}")
    if workspace:
        lines.append(f"**Workspace**: {workspace}")
    if source_session:
        lines.append(f"**Session**: {source_session}")
    if raw_files:
        lines.append(f"**Files**: {', '.join(raw_files)}")
    if raw_text:
        lines += ["", "---", "", raw_text]

    content = "\n".join(lines)
    if job_key:
        import hashlib
        drawer_id = "drawer_heinu1_job_" + hashlib.sha256(job_key.encode()).hexdigest()[:24]
        col = _get_collection()
        col.upsert(ids=[drawer_id], documents=[content], metadatas=[{
            "wing": WING, "room": content_type, "added_by": "heinu1",
            "filed_at": datetime.now().isoformat(), "idempotency_key": job_key,
        }])
        result = {"success": True, "drawer_id": drawer_id}
    else:
        result = tool_add_drawer(wing=WING, room=content_type, content=content, added_by="heinu1")
    if not result.get("success") or not result.get("drawer_id"):
        raise RuntimeError(result.get("error") or result.get("reason") or "MemPalace write unconfirmed")
    stored = _get_collection().get(ids=[result["drawer_id"]], include=["documents"])
    if not stored.get("ids") or stored["documents"][0] != content:
        raise RuntimeError("MemPalace read-back verification failed")
    return result


def cmd_search(data: dict) -> dict:
    """Semantic search returning full records (same shape as `recent`).

    We query ChromaDB directly instead of using mempalace's search_memories()
    because that helper drops the drawer ids, and without an id the caller
    cannot fetch a hit's detail later (`/kb <n>` would 404).
    """
    query = data.get("query", "")
    limit = int(data.get("limit", 10))
    col = _get_collection()
    if not col:
        return {"results": []}
    try:
        res = col.query(
            query_texts=[query],
            n_results=limit,
            where={"wing": WING},
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        return {"results": [], "error": str(e)}

    def first(key: str) -> list:
        rows = res.get(key) or []
        return rows[0] if rows else []

    ids, docs, metas, dists = first("ids"), first("documents"), first("metadatas"), first("distances")
    items = []
    for i, drawer_id in enumerate(ids):
        doc = docs[i] if i < len(docs) else ""
        meta = metas[i] if i < len(metas) else {}
        rec = _parse_record_content(doc, drawer_id, meta)
        rec["similarity"] = round(1 - dists[i], 3) if i < len(dists) else 0.0
        items.append(rec)
    return {"results": items}


def cmd_recent(data: dict) -> dict:
    limit = int(data.get("limit", 10))
    col = _get_collection()
    if not col:
        return {"results": []}
    try:
        # ChromaDB get() with where filter; no ORDER BY, sort in Python
        res = col.get(
            where={"wing": WING},
            include=["documents", "metadatas"],
            limit=500,  # fetch more, then sort+slice
        )
        items = []
        for i, drawer_id in enumerate(res.get("ids", [])):
            meta = res["metadatas"][i] if res.get("metadatas") else {}
            doc = res["documents"][i] if res.get("documents") else ""
            items.append(_parse_record_content(doc, drawer_id, meta))
        items.sort(key=lambda x: x["filed_at"], reverse=True)
        return {"results": items[:limit]}
    except Exception as e:
        return {"results": [], "error": str(e)}


def cmd_get(data: dict) -> dict | None:
    drawer_id = data.get("drawer_id", "")
    col = _get_collection()
    if not col:
        return None
    try:
        res = col.get(ids=[drawer_id], include=["documents", "metadatas"])
        if not res.get("ids"):
            return None
        meta = res["metadatas"][0] if res.get("metadatas") else {}
        doc = res["documents"][0] if res.get("documents") else ""
        return _parse_record_content(doc, drawer_id, meta)
    except Exception:
        raise


def cmd_count(data: dict) -> dict:
    col = _get_collection()
    if not col:
        return {"count": 0}
    try:
        res = col.get(where={"wing": WING}, include=[])
        return {"count": len(res.get("ids", []))}
    except Exception as e:
        return {"error": str(e)}


# ─── entrypoint ──────────────────────────────────────────────────────────────

COMMANDS = {
    "add": cmd_add,
    "search": cmd_search,
    "recent": cmd_recent,
    "get": cmd_get,
    "count": cmd_count,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"error": f"Usage: mp_bridge.py <{'|'.join(COMMANDS)}>"}), file=JSON_OUTPUT)
        sys.exit(1)

    cmd_name = sys.argv[1]
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else "{}"
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    try:
        result = COMMANDS[cmd_name](payload)
        print(json.dumps(result), file=JSON_OUTPUT)
        if isinstance(result, dict) and result.get("error"):
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=JSON_OUTPUT)
        sys.exit(1)
