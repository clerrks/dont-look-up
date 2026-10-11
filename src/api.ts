import type { Elements } from './sim/orbit';
import type { ActionLog } from './game';
import { FALLBACK_CATALOG } from './data/fallback';

export interface Approach { date: string; distKm: number; vRel?: number; vInf?: number }
export interface Detail {
  des: string;
  spk?: string;
  name: string;
  shortName: string;
  orbitClass?: string;
  pha?: boolean;
  H?: number;
  diameterM?: number;
  diameterMeasured?: boolean;
  albedo?: number;
  elements: Elements | null;
  approaches: Approach[];
  blurb?: string;
  source?: string;
}
export interface WeekObject {
  id: string; des: string; name: string; date: string;
  diameterMinM?: number; diameterMaxM?: number; H?: number;
  hazardous?: boolean; sentry?: boolean; vKms?: number; missKm?: number; lunar?: number;
}
export interface UpcomingObject {
  des: string; name: string; date: string; distKm: number; vRel: number; vInf: number; H: number; diameterM: number;
}

async function getJson<T>(url: string, ms = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCatalog(): Promise<{ objects: Detail[]; live: boolean }> {
  try {
    const j = await getJson<{ objects: Detail[] }>('/api/catalog?v=2');
    if (j.objects?.length) return { objects: j.objects, live: true };
  } catch { /* use cache below */ }
  return { objects: FALLBACK_CATALOG, live: false };
}

export async function fetchWeek(): Promise<{ objects: WeekObject[]; source: string; degraded?: string } | null> {
  try { return await getJson('/api/week'); } catch { return null; }
}

export async function fetchUpcoming(): Promise<{ objects: UpcomingObject[]; source: string } | null> {
  try { return await getJson('/api/upcoming'); } catch { return null; }
}

export async function fetchObject(des: string, spk?: string): Promise<Detail | null> {
  try { return await getJson<Detail>(`/api/object?des=${encodeURIComponent(des)}${spk ? `&spk=${encodeURIComponent(spk)}` : ''}`); } catch { return null; }
}

export async function health(): Promise<{ ai: string; nasaKey: boolean } | null> {
  try { return await getJson('/api/health', 6000); } catch { return null; }
}

export async function postAI(path: string, body: unknown): Promise<{ text: string | null; provider: string } | null> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status === 429) return { text: j.text ?? 'The advisor is busy. Try again shortly.', provider: 'rate-limited' };
    if (!r.ok) return null;
    return j;
  } catch {
    return null;
  }
}

// ---- Daily Challenge leaderboard (Cloudflare D1 behind the Worker)

export interface BoardRow { id: number; name: string; score: number; grade: string; hit: number; spent: number }
export interface Board { day: string; today?: string; budgetB?: number; top: BoardRow[]; total: number; unavailable?: boolean }
export interface DailyRun { id: number; day: string; name: string; score: number; grade: string; hit: boolean; spent: number; actions: ActionLog[] }
export interface SubmitResult { ok: boolean; id: number; rank: number; total: number; best: number; improved: boolean; board: Board }

export async function fetchBoard(day?: string): Promise<Board | null> {
  try { return await getJson<Board>(`/api/daily/board${day ? `?day=${day}` : ''}`, 8000); } catch { return null; }
}

export async function fetchRun(id: number): Promise<DailyRun | null> {
  try { return await getJson<DailyRun>(`/api/daily/run?id=${id}`, 8000); } catch { return null; }
}

export async function submitRun(body: {
  day: string; name: string; score: number; grade: string; lives: number; thrift: number; prudence: number; spent: number; hit: boolean; actions: ActionLog[];
}): Promise<SubmitResult | null> {
  try {
    const r = await fetch('/api/daily/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    return (await r.json()) as SubmitResult;
  } catch {
    return null;
  }
}
