// KbStore is no longer used; all KB operations go through MempalaceStore.
// This file is kept only for the KbRecord / KbDraft type exports.

export interface KbRecord {
  id:             number;
  user_openid:    string;
  workspace:      string;
  title:          string;
  summary:        string;
  content_type:   string;       // text | image | file | mixed
  tags:           string[];     // parsed from JSON column
  entities:       string[];     // parsed from JSON column
  raw_text:       string;       // original message text
  raw_files:      string[];     // archived file paths under kb/raw/
  source_session: string;       // claude session uuid that produced the analysis
  created_at:     number;
}

/** Shape written by the ingest step (before DB assigns id/timestamps). */
export interface KbDraft {
  user_openid:    string;
  workspace:      string;
  title:          string;
  summary:        string;
  content_type:   string;
  tags:           string[];
  entities:       string[];
  raw_text:       string;
  raw_files:      string[];
  source_session: string;
}

