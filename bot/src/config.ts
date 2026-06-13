import path from 'path';
import os from 'os';

export const CONFIG = {
  DATA_DIR:        path.join(os.homedir(), '.heinu1-bot'),
  TOKEN_FILE:      path.join(os.homedir(), '.heinu1-bot', 'token.json'),
  DB_FILE:         path.join(os.homedir(), '.heinu1-bot', 'sessions.db'),
  WORKSPACES_FILE: path.join(os.homedir(), '.heinu1-bot', 'workspaces.json'),
  MEDIA_DIR:       path.join(os.homedir(), '.heinu1-bot', 'media'),

  // Domain only — /ilink/bot/* prefix is in each endpoint path
  ILINK_DEFAULT_BASE: 'https://ilinkai.weixin.qq.com',

  POLL_TIMEOUT_MS:    40_000,   // match reference: 40s
  RECONNECT_DELAY_MS: 3_000,
  TURN_TIMEOUT_MS:    30_000,   // 30s silence = turn complete, start executing

  CLAUDE_BIN:             process.env.CLAUDE_BIN || 'claude',
  CLAUDE_PERMISSION_MODE: process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',

  MAX_MSG_LEN: 1800,
};

// channel_version from reference implementation
export const BASE_INFO = { channel_version: '1.0.0' };
