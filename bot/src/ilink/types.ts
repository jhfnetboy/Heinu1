export enum MsgType {
  TEXT  = 1,
  IMAGE = 3,
  VOICE = 34,
  VIDEO = 43,
  FILE  = 49,
}

export interface ILinkMessage {
  msg_id:           string;
  from_user_openid: string;
  to_user_openid?:  string;
  msg_type:         MsgType;
  content:          string;
  context_token:    string;
  create_time:      number;
  media_id?:        string;
}

export interface UpdateResponse {
  ret:                    number;
  errmsg?:                string;
  msg_list:               ILinkMessage[];
  next_get_updates_buf:   string;
}

export interface QRCodeResponse {
  ret:         number;
  errmsg?:     string;
  qrcode_url:  string;
  qrcode_key:  string;
}

export interface QRStatusResponse {
  ret:        number;
  errmsg?:    string;
  status:     'wait' | 'scanned' | 'confirmed';
  bot_token?: string;
}

export interface SendRequest {
  to_user_openid: string;
  context_token:  string;
  msg_type:       MsgType;
  content:        string;
}

export interface TokenData {
  bot_token: string;
  saved_at:  number;
}
