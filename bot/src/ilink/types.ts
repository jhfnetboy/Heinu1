// message type in item_list.type
export enum ItemType {
  TEXT  = 1,
  IMAGE = 3,
  VOICE = 34,
  VIDEO = 43,
  FILE  = 49,
}

export interface TextItem { text: string; }

export interface MessageItem {
  type:       ItemType;
  text_item?: TextItem;
}

// Inbound message from user (inside getupdates response)
export interface ILinkMessage {
  from_user_id:  string;
  to_user_id:    string;
  message_type:  number;   // 1 = user, 2 = bot own message (skip these)
  message_state: number;
  context_token: string;
  item_list:     MessageItem[];
  create_time?:  number;
}

export interface UpdateResponse {
  ret?:                 number;
  errmsg?:              string;
  msgs:                 ILinkMessage[];
  get_updates_buf:      string;
  longpolling_timeout_ms?: number;
}

export interface QRCodeResponse {
  qrcode:             string;  // polling key
  qrcode_img_content: string;  // URL to display as QR image
  errmsg?:            string;
}

export interface QRStatusResponse {
  status:         'wait' | 'scanned' | 'confirmed';
  bot_token?:     string;
  baseurl?:       string;  // may override ILINK_DEFAULT_BASE
  ilink_bot_id?:  string;
  ilink_user_id?: string;
  errmsg?:        string;
}

export interface TokenData {
  bot_token: string;
  baseurl:   string;
  saved_at:  number;
}

// Outbound message to user
export interface SendMessageBody {
  msg: {
    from_user_id:  string;
    to_user_id:    string;
    client_id:     string;
    message_type:  2;
    message_state: 2;
    context_token: string;
    item_list:     MessageItem[];
  };
  base_info: { channel_version: string };
}
