import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AudienceAdmissionTuning {
  onlineRankOn: number;
  onlineRankOff: number;
  releaseHoldSec: number;
  signalFreshSec: number;
  activeStaleHoldSec: number;
  eventLineBudget: number;
  eventTokenBudget: number;
  importantShare: number;
}

export interface ImportantAudienceParticipant {
  senderKey: string;
  uname?: string;
  count: number;
}

export interface AudienceAdmissionCandidate {
  id: string;
  text: string;
  critical: boolean;
  participants: ImportantAudienceParticipant[];
  /** Estimated tokens ≈ ceil(text.length / 2) */
  tokens?: number;
}

interface LedgerEntry {
  uid: string;
  giftYuan30d: number;
  lastGiftAt: number;
  activeMinutes: number;
  lastActiveAt: number;
  fansclubUntil: number;
  fairDebt: number;
}

export interface AdmissionResult<T extends AudienceAdmissionCandidate> {
  accepted: T[];
  dropped: number;
  crowded: boolean;
  importantCount: number;
}

const GIFT_IMPORTANT_SINGLE = 30;
const GIFT_IMPORTANT_CUMUL = 50;
const DAY_MS = 86_400_000;

export class AudienceAdmission {
  private ledger = new Map<string, LedgerEntry>();
  private crowded = false;
  private online: number | null = null;
  private onlineAt = 0;
  private belowOffSince: number | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private droppedTotal = 0;

  constructor(
    private readonly file: string | undefined,
    private readonly tuning: () => AudienceAdmissionTuning,
    private readonly onPersistError?: (err: unknown) => void,
  ) {
    this.load();
  }

  state() {
    return {
      crowded: this.crowded,
      online: this.online,
      importantUids: [...this.ledger.values()].filter((e) => this.isImportant(e, Date.now())).length,
      droppedTotal: this.droppedTotal,
      ledgerSize: this.ledger.size,
    };
  }

  setOnline(value: number, now = Date.now()): void {
    this.online = value;
    this.onlineAt = now;
    const t = this.tuning();
    if (value >= t.onlineRankOn) {
      this.crowded = true;
      this.belowOffSince = null;
      return;
    }
    if (!this.crowded) return;
    if (value <= t.onlineRankOff) {
      if (this.belowOffSince == null) this.belowOffSince = now;
      else if (now - this.belowOffSince >= t.releaseHoldSec * 1000) {
        this.crowded = false;
        this.belowOffSince = null;
      }
    } else {
      this.belowOffSince = null;
    }
    if (now - this.onlineAt > t.activeStaleHoldSec * 1000) {
      this.crowded = false;
    }
  }

  clearSession(): void {
    this.online = null;
    this.crowded = false;
    this.belowOffSince = null;
  }

  noteGift(senderKey: string | undefined, yuan: number | null, now = Date.now()): void {
    const uid = uidFromSender(senderKey);
    if (!uid || yuan == null || yuan <= 0) return;
    const e = this.ensure(uid);
    e.giftYuan30d += yuan;
    e.lastGiftAt = now;
    this.touchActive(e, now);
    this.markDirty();
  }

  noteFansclub(senderKey: string | undefined, now = Date.now()): void {
    const uid = uidFromSender(senderKey);
    if (!uid) return;
    const e = this.ensure(uid);
    e.fansclubUntil = now + 35 * DAY_MS;
    this.touchActive(e, now);
    this.markDirty();
  }

  noteInteraction(senderKey: string | undefined, now = Date.now()): void {
    const uid = uidFromSender(senderKey);
    if (!uid) return;
    const e = this.ensure(uid);
    this.touchActive(e, now);
    this.markDirty();
  }

  filter<T extends AudienceAdmissionCandidate>(candidates: T[], now = Date.now()): AdmissionResult<T> {
    const t = this.tuning();
    if (this.online != null && now - this.onlineAt > t.signalFreshSec * 1000 && now - this.onlineAt > t.activeStaleHoldSec * 1000) {
      this.crowded = false;
    }

    const totalTokens = candidates.reduce((s, c) => s + (c.tokens ?? estimateTokens(c.text)), 0);
    const needFilter = this.crowded
      && (candidates.length > t.eventLineBudget || totalTokens > t.eventTokenBudget);

    if (!needFilter) {
      return {
        accepted: candidates,
        dropped: 0,
        crowded: this.crowded,
        importantCount: this.state().importantUids,
      };
    }

    const critical: T[] = [];
    const important: T[] = [];
    const ordinary: T[] = [];

    for (const c of candidates) {
      if (c.critical) {
        critical.push(c);
        continue;
      }
      const importantHit = c.participants.some((p) => {
        const uid = uidFromSender(p.senderKey);
        if (!uid) return false;
        const e = this.ledger.get(uid);
        return e ? this.isImportant(e, now) : false;
      });
      if (importantHit) important.push(c);
      else ordinary.push(c);
    }

    const accepted: T[] = [...critical];
    let lines = accepted.length;
    let tokens = accepted.reduce((s, c) => s + (c.tokens ?? estimateTokens(c.text)), 0);

    const importantBudgetLines = Math.floor(t.eventLineBudget * t.importantShare);
    const importantBudgetTokens = Math.floor(t.eventTokenBudget * t.importantShare);
    let impLines = 0;
    let impTokens = 0;

    important.sort((a, b) => maxDebt(b, this) - maxDebt(a, this));
    for (const c of important) {
      const tok = c.tokens ?? estimateTokens(c.text);
      if (lines >= t.eventLineBudget || tokens + tok > t.eventTokenBudget) break;
      if (impLines >= importantBudgetLines || impTokens + tok > importantBudgetTokens) break;
      accepted.push(c);
      lines += 1;
      tokens += tok;
      impLines += 1;
      impTokens += tok;
      for (const p of c.participants) {
        const uid = uidFromSender(p.senderKey);
        if (!uid) continue;
        const e = this.ledger.get(uid);
        if (e) e.fairDebt = Math.max(0, e.fairDebt - 1);
      }
    }

    // Deterministic sample of ordinary by private salt (uid hash)
    const remaining = ordinary
      .map((c, i) => ({ c, i, score: sampleScore(c) }))
      .sort((a, b) => a.score - b.score || a.i - b.i);

    for (const { c } of remaining) {
      const tok = c.tokens ?? estimateTokens(c.text);
      if (lines >= t.eventLineBudget || tokens + tok > t.eventTokenBudget) {
        for (const p of c.participants) {
          const uid = uidFromSender(p.senderKey);
          if (!uid) continue;
          const e = this.ensure(uid);
          e.fairDebt += 1;
        }
        continue;
      }
      accepted.push(c);
      lines += 1;
      tokens += tok;
    }

    const dropped = candidates.length - accepted.length;
    this.droppedTotal += dropped;
    this.markDirty();
    return {
      accepted,
      dropped,
      crowded: this.crowded,
      importantCount: this.state().importantUids,
    };
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  private isImportant(e: LedgerEntry, now: number): boolean {
    if (e.fansclubUntil > now) return true;
    if (e.lastGiftAt > now - 30 * DAY_MS && e.giftYuan30d >= GIFT_IMPORTANT_CUMUL) return true;
    // Single large gift tracked via cumulative; also treat recent big bump
    if (e.lastGiftAt > now - DAY_MS && e.giftYuan30d >= GIFT_IMPORTANT_SINGLE) return true;
    if (e.activeMinutes >= 25 && e.lastActiveAt > now - 30 * DAY_MS) return true;
    return false;
  }

  private touchActive(e: LedgerEntry, now: number): void {
    const minute = Math.floor(now / 60_000);
    const lastMinute = Math.floor(e.lastActiveAt / 60_000);
    if (minute !== lastMinute) e.activeMinutes += 1;
    e.lastActiveAt = now;
  }

  private ensure(uid: string): LedgerEntry {
    let e = this.ledger.get(uid);
    if (!e) {
      e = {
        uid,
        giftYuan30d: 0,
        lastGiftAt: 0,
        activeMinutes: 0,
        lastActiveAt: 0,
        fansclubUntil: 0,
        fairDebt: 0,
      };
      this.ledger.set(uid, e);
    }
    return e;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 30_000);
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { entries?: LedgerEntry[] };
      for (const e of parsed.entries ?? []) {
        if (e?.uid) this.ledger.set(e.uid, e);
      }
    } catch {
      // missing or corrupt — start empty
    }
  }

  private saveNow(): void {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({
        version: 1,
        entries: [...this.ledger.values()],
      }, null, 2));
      this.dirty = false;
    } catch (err) {
      this.onPersistError?.(err);
    }
  }
}

function uidFromSender(senderKey: string | undefined): string | null {
  if (!senderKey) return null;
  const m = /^douyin:(.+)$/.exec(senderKey);
  return m?.[1] || senderKey;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

function maxDebt(c: AudienceAdmissionCandidate, adm: AudienceAdmission): number {
  let max = 0;
  for (const p of c.participants) {
    const uid = uidFromSender(p.senderKey);
    if (!uid) continue;
    const e = (adm as unknown as { ledger: Map<string, LedgerEntry> }).ledger.get(uid);
    if (e && e.fairDebt > max) max = e.fairDebt;
  }
  return max;
}

function sampleScore(c: AudienceAdmissionCandidate): number {
  const key = c.participants.map((p) => p.senderKey).join(',') || c.id;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
