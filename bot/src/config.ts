import path from 'path';
import os from 'os';

export const CONFIG = {
  DATA_DIR:   path.join(os.homedir(), '.heinu1-bot'),
  TOKEN_FILE: path.join(os.homedir(), '.heinu1-bot', 'token.json'),
  DB_FILE:    path.join(os.homedir(), '.heinu1-bot', 'sessions.db'),

  ILINK_BASE:        'https://ilinkai.weixin.qq.com',
  POLL_TIMEOUT_MS:   35_000,
  RECONNECT_DELAY_MS: 3_000,

  // Claude Code CLI
  CLAUDE_BIN:             process.env.CLAUDE_BIN || 'claude',
  // bypassPermissions = 家用机全自动; acceptEdits = 只自动批准编辑; default = 每次询问
  CLAUDE_PERMISSION_MODE: process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',

  MAX_MSG_LEN: 1800,
};
