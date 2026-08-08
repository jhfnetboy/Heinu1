import path from 'path';
import os from 'os';

export const CONFIG = {
  DATA_DIR:        path.join(os.homedir(), '.heinu1-bot'),
  TOKEN_FILE:      path.join(os.homedir(), '.heinu1-bot', 'token.json'),
  DB_FILE:         path.join(os.homedir(), '.heinu1-bot', 'sessions.db'),
  WORKSPACES_FILE: path.join(os.homedir(), '.heinu1-bot', 'workspaces.json'),
  MEDIA_DIR:       path.join(os.homedir(), '.heinu1-bot', 'media'),

  // Knowledge base — backed by the global MemPalace at ~/.mempalace/palace
  // Raw media files are still kept locally under .heinu1-bot/kb/raw/
  KB_DIR:     path.join(os.homedir(), '.heinu1-bot', 'kb'),
  KB_RAW_DIR: path.join(os.homedir(), '.heinu1-bot', 'kb', 'raw'),

  // Python interpreter inside the MemPalace venv — runs bot/scripts/mp_bridge.py
  MEMPALACE_PYTHON: process.env.MEMPALACE_PYTHON ||
    path.join(os.homedir(), '.mempalace', 'venv', 'bin', 'python'),

  // Domain only — /ilink/bot/* prefix is in each endpoint path
  ILINK_DEFAULT_BASE: 'https://ilinkai.weixin.qq.com',

  POLL_TIMEOUT_MS:    40_000,   // match reference: 40s
  RECONNECT_DELAY_MS: 3_000,

  // Liveness watchdog: if no getupdates has returned successfully within
  // WATCHDOG_TIMEOUT_MS, the long-poll is wedged (process alive but not
  // receiving) — exit(1) so launchd (KeepAlive) restarts with a fresh poll.
  // Healthy polls return every ~40s, so 180s is ~4.5 cycles of slack.
  WATCHDOG_TIMEOUT_MS: Number(process.env.WATCHDOG_TIMEOUT_MS) || 180_000,
  WATCHDOG_CHECK_MS:   Number(process.env.WATCHDOG_CHECK_MS)   || 30_000,
  TURN_TIMEOUT_MS:    30_000,   // 30s silence = turn complete, start executing

  CLAUDE_BIN:             process.env.CLAUDE_BIN || 'claude',
  CLAUDE_MODEL:           process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  CLAUDE_PERMISSION_MODE: process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',

  MAX_MSG_LEN: 1800,
};

// channel_version from reference implementation
export const BASE_INFO = { channel_version: '1.0.0' };
