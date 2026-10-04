import type { Difficulty } from '../config';
import type { Quality } from '../render/stage';

/** Persistent player progress (localStorage, every access wrapped in try/catch). */
export interface SavedStats {
  wins: Record<string, number>; // "region:difficulty"
  plays: Record<string, number>;
  fastest: Record<string, number>; // seconds
  totalCaptured: number;
  flags: string[]; // alpha-2 codes collected across all matches
  matches: number;
}

export interface Settings {
  muted: boolean;
  music: boolean;
  quality: Quality;
  tutorialDone: boolean;
  lastDifficulty: Difficulty;
  lastBots: number;
}

const STATS_KEY = 'worldgrab.stats.v1';
const SETTINGS_KEY = 'worldgrab.settings.v1';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / disabled: ignore */
  }
}

export const defaultStats = (): SavedStats => ({ wins: {}, plays: {}, fastest: {}, totalCaptured: 0, flags: [], matches: 0 });
export const defaultSettings = (): Settings => ({ muted: false, music: true, quality: 'auto', tutorialDone: false, lastDifficulty: 'normal', lastBots: 3 });

export const stats: SavedStats = read(STATS_KEY, defaultStats());
export const settings: Settings = read(SETTINGS_KEY, defaultSettings());

export function saveStats() { write(STATS_KEY, stats); }
export function saveSettings() { write(SETTINGS_KEY, settings); }

export function resetStats() {
  Object.assign(stats, defaultStats());
  saveStats();
}

/** Records a finished match. Returns true when it is a new fastest win. */
export function recordMatch(region: string, difficulty: Difficulty, win: boolean, seconds: number, capturedA2: string[], captured: number): boolean {
  const key = `${region}:${difficulty}`;
  stats.matches++;
  stats.plays[key] = (stats.plays[key] ?? 0) + 1;
  stats.totalCaptured += captured;
  const set = new Set(stats.flags);
  for (const a of capturedA2) set.add(a);
  stats.flags = [...set];
  let record = false;
  if (win) {
    stats.wins[key] = (stats.wins[key] ?? 0) + 1;
    if (!stats.fastest[key] || seconds < stats.fastest[key]) {
      record = true;
      stats.fastest[key] = Math.round(seconds);
    }
  }
  saveStats();
  return record;
}

const DIFFS: Difficulty[] = ['hard', 'normal', 'easy'];

/** Best result on a region: hardest difficulty won and its fastest time. */
export function bestFor(region: string): { difficulty: Difficulty; seconds: number } | null {
  for (const d of DIFFS) {
    const t = stats.fastest[`${region}:${d}`];
    if (t) return { difficulty: d, seconds: t };
  }
  return null;
}

export function totalWins(): number {
  return Object.values(stats.wins).reduce((a, b) => a + b, 0);
}
