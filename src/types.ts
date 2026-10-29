import type { TriggerMode } from 'cortico/core/types.ts';

/** Common shape after bridge adapters. */
export interface BridgeMessage {
  method: string;
  id?: string;
  content?: string;
  user?: {
    id?: string;
    name?: string;
    avatar?: string;
  };
  gift?: {
    id?: string;
    name?: string;
    price?: number;
    count?: number;
  };
  room?: {
    audienceCount?: number | string;
    likeCount?: number | string;
    followCount?: number | string;
    totalUserCount?: number | string;
    status?: number;
    title?: string;
  };
  raw?: unknown;
}

export interface LiveEvent {
  kind: 'event';
  type: string;
  trigger: TriggerMode;
  text: string;
  senderKey?: string;
  meta?: Record<string, unknown>;
  coalesce?:
    | { kind: 'danmaku'; key: string; body: string }
    | { kind: 'gift'; key: string; gift: string; num: number; yuan: number | null };
}

export type CountField = 'enter' | 'like' | 'freeGift' | 'follow';
export type GaugeField = 'online' | 'likeTotal' | 'totalUser';

export interface LiveCount {
  kind: 'count';
  field: CountField;
  by: number;
}

export interface LiveGauge {
  kind: 'gauge';
  field: GaugeField;
  value: number;
}

export type Normalized = LiveEvent | LiveCount | LiveGauge;

export type BridgePhase = 'idle' | 'connecting' | 'connected' | 'retrying' | 'stopped';

export interface BridgeStatus {
  phase: BridgePhase;
  url: string;
  adapter: string;
  lastMessageAt: number | null;
  lastError: string | null;
  messages: number;
  reconnects: number;
  roomTitle: string | null;
  roomId: string | null;
}

export interface LogLine {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}
