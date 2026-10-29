import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface VideoQueueItem {
  id: string;
  note: string;
}

export interface VideoQueueState {
  items: VideoQueueItem[];
}

export class AgentAnnouncementStore {
  private text = '';

  constructor(private readonly file?: string) {
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { text?: string };
        this.text = String(raw.text ?? '');
      } catch {
        this.text = '';
      }
    }
  }

  get(): string {
    return this.text;
  }

  set(text: string): void {
    this.text = text;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ text }, null, 2));
  }
}

export class VideoQueueStore {
  private state: VideoQueueState = { items: [] };

  constructor(private readonly file?: string) {
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as VideoQueueState;
        this.state = { items: Array.isArray(raw.items) ? raw.items : [] };
      } catch {
        this.state = { items: [] };
      }
    }
  }

  get(): VideoQueueState {
    return { items: this.state.items.map((i) => ({ ...i })) };
  }

  set(state: VideoQueueState): void {
    this.state = { items: state.items.map((i) => ({ ...i })) };
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}

/** Extract a Douyin video id or keep the raw link/id. */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = /(?:www\.)?douyin\.com\/video\/(\d+)/i.exec(s)
    || /v\.douyin\.com\/([A-Za-z0-9]+)/i.exec(s)
    || /^(\d{10,})$/.exec(s);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{4,}$/.test(s)) return s;
  return s.slice(0, 200);
}
