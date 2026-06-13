// Exact enum values from weixin-bot-ilink/nodejs/src/types.ts (ground truth — do not reorder)

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

export interface CDNMedia {
  encrypt_query_param: string;
  aes_key:             string;
  encrypt_type?:       0 | 1;
}

export interface TextItem { text: string; }

export interface ImageItem {
  media:         CDNMedia;
  aeskey?:       string;          // direct hex key (legacy field on some servers)
  url?:          string;
  mid_size?:     string | number;
  thumb_size?:   string | number;
  thumb_height?: number;
  thumb_width?:  number;
  hd_size?:      string | number;
}

export interface VoiceItem {
  media:        CDNMedia;
  encode_type?: number;           // SILK codec
  text?:        string;           // WeChat server auto-transcription (may be empty)
  playtime?:    number;           // milliseconds
}

export interface FileItem {
  media:      CDNMedia;
  file_name?: string;
  md5?:       string;
  len?:       string;             // bytes as string
}

export interface VideoItem {
  media:        CDNMedia;
  video_size?:  string | number;
  play_length?: number;
  thumb_media?: CDNMedia;
}

export interface RefMessage {
  title?:        string;
  message_item?: MessageItem;
}

export interface MessageItem {
  type:        MessageItemType;
  text_item?:  TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?:  FileItem;
  video_item?: VideoItem;
  ref_msg?:    RefMessage;
}

export interface WeixinMessage {
  message_id:     number;
  from_user_id:   string;
  to_user_id:     string;
  client_id:      string;
  create_time_ms: number;
  message_type:   MessageType;
  message_state:  MessageState;
  context_token:  string;
  item_list:      MessageItem[];
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
  bot_token: string;
  baseurl:   string;
  saved_at:  number;
}

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
