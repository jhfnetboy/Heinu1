// Exact values from weixin-bot-ilink/nodejs/src/types.ts (ground truth)

export enum MessageType {
  USER = 1,
  BOT  = 2,
}

export enum MessageState {
  NEW        = 0,
  GENERATING = 1,
  FINISH     = 2,
}

export enum MessageItemType {
  TEXT  = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE  = 4,
  VIDEO = 5,
}

export interface TextItem { text: string; }

export interface MessageItem {
  type:       MessageItemType;
  text_item?: TextItem;
  // (image/voice/file/video items omitted — not needed for text bot)
}

export interface WeixinMessage {
  message_id:    number;
  from_user_id:  string;
  to_user_id:    string;
  client_id:     string;
  create_time_ms: number;
  message_type:  MessageType;
  message_state: MessageState;
  context_token: string;
  item_list:     MessageItem[];
}

export interface GetUpdatesResp {
  ret?:                    number;
  errcode?:                number;
  errmsg?:                 string;
  msgs:                    WeixinMessage[];
  get_updates_buf:         string;
  longpolling_timeout_ms?: number;
}

export interface TokenData {
  bot_token:  string;
  baseurl:    string;   // domain only, e.g. https://ilinkai.weixin.qq.com
  saved_at:   number;
}
