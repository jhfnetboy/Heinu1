import path from 'path';
import os from 'os';

export const CONFIG = {
  DATA_DIR:   path.join(os.homedir(), '.heinu1-bot'),
  TOKEN_FILE: path.join(os.homedir(), '.heinu1-bot', 'token.json'),
  DB_FILE:    path.join(os.homedir(), '.heinu1-bot', 'sessions.db'),

  // All iLink Bot API paths live under /ilink/bot/
  ILINK_DEFAULT_BASE: 'https://ilinkai.weixin.qq.com/ilink/bot',

  POLL_TIMEOUT_MS:    35_000,
  RECONNECT_DELAY_MS: 3_000,

  CLAUDE_BIN:             process.env.CLAUDE_BIN || 'claude',
  CLAUDE_PERMISSION_MODE: process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',

  MAX_MSG_LEN: 1800,
};

// base_info is required on every request body per the iLink protocol
export const BASE_INFO = { channel_version: '1.0.2' };
