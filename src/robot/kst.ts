/**
 * KST(+09:00) 고정 계산 — 서머타임이 없으므로 UTC+9 오프셋 산술로 충분하다.
 * 로봇은 호스트 로컬 타임존에 의존하지 않는다(설계 §5-6).
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type KstWeekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

const WEEKDAYS: KstWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export interface KstParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: KstWeekday;
  /** 0=일 … 6=토 (JS getUTCDay와 동일 규칙) */
  weekdayIndex: number;
}

export function kstParts(date: Date = new Date()): KstParts {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: WEEKDAYS[shifted.getUTCDay()],
    weekdayIndex: shifted.getUTCDay(),
  };
}

export function kstDateString(date: Date = new Date()): string {
  const p = kstParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** `2026-09-15T21:10:00+09:00` — DB에 저장하는 시각 표기. */
export function kstIso(date: Date = new Date()): string {
  const p = kstParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+09:00`;
}

/** 슬롯 id용 압축 표기: `20260922T211000+0900`. */
export function kstCompact(date: Date = new Date()): string {
  const p = kstParts(date);
  return `${p.year}${pad(p.month)}${pad(p.day)}T${pad(p.hour)}${pad(p.minute)}${pad(p.second)}+0900`;
}

/** 해당 시각이 속한 KST 주의 월요일 00:00 (KST). */
export function kstWeekStart(date: Date = new Date()): Date {
  const p = kstParts(date);
  // 월요일까지의 일수: 일(0)→6, 월(1)→0, 화(2)→1 …
  const daysSinceMonday = (p.weekdayIndex + 6) % 7;
  const midnightKst = Date.UTC(p.year, p.month - 1, p.day) - KST_OFFSET_MS;
  return new Date(midnightKst - daysSinceMonday * DAY_MS);
}

/** `2026-W38` 형태의 주 키(로그·증거용). */
export function kstWeekKey(date: Date = new Date()): string {
  const start = kstWeekStart(date);
  const p = kstParts(start);
  const jan1 = Date.UTC(p.year, 0, 1);
  const week = Math.floor((Date.UTC(p.year, p.month - 1, p.day) - jan1) / DAY_MS / 7) + 1;
  return `${p.year}-W${pad(week)}`;
}

/** KST 기준 특정 주(월요일 시작)의 [start, end)ms — 주간 상한 계산에 쓴다. */
export function kstWeekRange(date: Date = new Date()): { startMs: number; endMs: number } {
  const startMs = kstWeekStart(date).getTime();
  return { startMs, endMs: startMs + 7 * DAY_MS };
}

/** `day`(mon…) + `HH:MM` 슬롯 시각을 해당 주의 실제 시각(ms)으로 바꾼다. 기준 주는 `weekStart`. */
export function slotTimeMs(weekStart: Date, day: KstWeekday, time: string): number {
  const [hh, mm] = (time || '').split(':').map((v) => parseInt(v, 10));
  const dayIndex = WEEKDAYS.indexOf(day);
  // weekStart는 월요일이므로 월(1) 기준 오프셋을 취한다.
  const offsetDays = (dayIndex - 1 + 7) % 7;
  return weekStart.getTime() + offsetDays * DAY_MS + (hh || 0) * 3_600_000 + (mm || 0) * 60_000;
}

export function parseKstIso(value: string): Date | null {
  const ms = Date.parse(value || '');
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** now 이후(포함) 가장 가까운 슬롯 시각들 — 최대 8주 전방 탐색. */
export function upcomingSlots(
  now: Date,
  slots: Array<{ day: KstWeekday; time: string }>,
  count: number,
): Date[] {
  const out: Date[] = [];
  if (!slots?.length) return out;
  for (let week = 0; week <= 8 && out.length < count; week += 1) {
    const weekStart = new Date(kstWeekStart(now).getTime() + week * 7 * DAY_MS);
    const times = slots
      .map((s) => slotTimeMs(weekStart, s.day, s.time))
      .filter((ms) => ms >= now.getTime())
      .sort((a, b) => a - b);
    for (const ms of times) {
      if (out.length >= count) break;
      out.push(new Date(ms));
    }
  }
  return out;
}
