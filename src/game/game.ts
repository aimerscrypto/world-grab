import { CONFIG, type Difficulty } from '../config';
import type { RegionMap } from '../map/types';

export const NEUTRAL = -1;
export const PLAYER = 0;

export interface Faction {
  id: number;
  name: string;
  color: number;
  css: string;
  isBot: boolean;
  alive: boolean;
  /** countries owned (kept up to date) */
  count: number;
  eliminatedAt: number;
}

export type GameEvent =
  | { type: 'send'; from: number; to: number; owner: number; troops: number }
  | { type: 'clash'; country: number; attacker: number; defender: number; troops: number }
  | { type: 'reinforce'; country: number; owner: number; troops: number }
  | { type: 'capture'; country: number; from: number; to: number; battle: number }
  | { type: 'eliminated'; faction: number }
  | { type: 'end'; win: boolean };

export interface MatchOptions {
  map: RegionMap;
  bots: number;
  difficulty: Difficulty;
  /** player's chosen start country (-1 = random). Ignored when noPlayer. */
  playerStart: number;
  /** attract mode: only bots */
  noPlayer?: boolean;
  /** fixed RNG seed (optional) */
  seed?: number;
}

export interface MatchStats {
  troopsSent: number;
  captured: number;
  biggestBattle: number;
  capturedList: number[];
  lost: number;
}

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

/**
 * Pure game simulation: ownership, troops, growth, sends and travelling units.
 * Rendering reads the public typed arrays; events are drained by the app.
 */
export class Game {
  readonly map: RegionMap;
  readonly n: number;
  readonly owner: Int8Array;
  readonly troops: Float32Array;
  readonly rate: Float32Array;
  readonly cap: Float32Array;
  readonly factions: Faction[];
  readonly difficulty: Difficulty;
  readonly noPlayer: boolean;
  time = 0;
  speed = 1;
  paused = false;
  over = false;
  won = false;
  events: GameEvent[] = [];
  stats: MatchStats = { troopsSent: 0, captured: 0, biggestBattle: 0, capturedList: [], lost: 0 };
  snapshots: Int8Array[] = [];
  private snapTimer = 0;
  /** incremented on every ownership change (cache key) */
  version = 0;
  /** extra growth multiplier per faction (bots get difficulty multiplier) */
  readonly growthMul: Float32Array;
  /** battle accumulator per country (for "biggest battle") */
  private battle: Float32Array;
  /** for the "under attack" pulse: last time an enemy unit hit a player country */
  lastHitOnPlayer = -99;

  // ---- unit pool (structure of arrays) ----
  readonly maxUnits = CONFIG.game.maxUnits;
  readonly uActive = new Uint8Array(CONFIG.game.maxUnits);
  readonly uOwner = new Int8Array(CONFIG.game.maxUnits);
  readonly uFrom = new Int16Array(CONFIG.game.maxUnits);
  readonly uTo = new Int16Array(CONFIG.game.maxUnits);
  readonly uTroops = new Float32Array(CONFIG.game.maxUnits);
  readonly uT = new Float32Array(CONFIG.game.maxUnits);
  readonly uRate = new Float32Array(CONFIG.game.maxUnits);
  readonly uLane = new Float32Array(CONFIG.game.maxUnits);
  readonly uPhase = new Float32Array(CONFIG.game.maxUnits);
  private free: number[] = [];
  uHigh = 0; // highest active slot + 1
  inFlight: Int32Array; // units in flight per faction
  private streams: { from: number; to: number; owner: number; left: number; per: number; acc: number; lane: number; rate: number }[] = [];
  readonly speedUnits: number;

  private rngState: number;
  private compCache = new Map<number, { v: number; comp: Int32Array }>();

  constructor(opts: MatchOptions) {
    const map = (this.map = opts.map);
    const n = (this.n = map.playableCount);
    this.difficulty = opts.difficulty;
    this.noPlayer = !!opts.noPlayer;
    this.rngState = (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0 || 1;
    this.owner = new Int8Array(n).fill(NEUTRAL);
    this.troops = new Float32Array(n);
    this.rate = new Float32Array(n);
    this.cap = new Float32Array(n);
    this.battle = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tier = tierOf(map.countries[i].areaKm2);
      this.rate[i] = tier.rate;
      this.cap[i] = tier.cap;
      this.troops[i] = Math.round(tier.garrison * (0.85 + this.rand() * 0.3));
    }
    for (let i = this.maxUnits - 1; i >= 0; i--) this.free.push(i);
    this.speedUnits = map.typicalDist / CONFIG.game.typicalTravelSeconds;

    const botCount = Math.max(1, Math.min(5, opts.bots));
    this.factions = [];
    this.factions.push({ id: 0, name: CONFIG.faction.playerName, color: CONFIG.colors.player, css: hex(CONFIG.colors.player), isBot: false, alive: !this.noPlayer, count: 0, eliminatedAt: -1 });
    for (let b = 0; b < botCount; b++) {
      const color = CONFIG.colors.bots[b % CONFIG.colors.bots.length];
      this.factions.push({ id: b + 1, name: CONFIG.faction.botNames[b], color, css: hex(color), isBot: true, alive: true, count: 0, eliminatedAt: -1 });
    }
    this.inFlight = new Int32Array(this.factions.length);
    this.growthMul = new Float32Array(this.factions.length).fill(1);
    const prof = CONFIG.bots[opts.difficulty];
    for (let f = 1; f < this.factions.length; f++) this.growthMul[f] = prof.growthMultiplier;

    // starting countries, spread apart
    const starts = this.pickStarts(this.noPlayer ? -2 : opts.playerStart);
    starts.forEach((c, k) => {
      const f = this.noPlayer ? k + 1 : k;
      this.owner[c] = f;
      this.troops[c] = CONFIG.game.startTroops;
      this.factions[f].count = 1;
    });
    this.snapshots.push(this.owner.slice());
  }

  rand(): number {
    // mulberry32
    let t = (this.rngState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private pickStarts(playerStart: number): number[] {
    const map = this.map;
    const need = this.factions.length - (this.noPlayer ? 1 : 0);
    let cands: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const a = map.countries[i].areaKm2;
      if (a >= 20_000 && a <= 2_500_000 && map.countries[i].neighbours.length >= 1) cands.push(i);
    }
    if (cands.length < need * 2) cands = Array.from({ length: this.n }, (_, i) => i);
    const chosen: number[] = [];
    if (playerStart >= 0 && playerStart < this.n) chosen.push(playerStart);
    else chosen.push(cands[Math.floor(this.rand() * cands.length)]);
    while (chosen.length < need && chosen.length < this.n) {
      const dist = this.bfsMulti(chosen);
      let best: number[] = [];
      let bestD = -1;
      for (const c of cands) {
        if (chosen.includes(c)) continue;
        const d = dist[c] < 0 ? 999 : dist[c];
        if (d > bestD) { bestD = d; best = [c]; } else if (d === bestD) best.push(c);
      }
      if (!best.length) {
        for (let i = 0; i < this.n; i++) if (!chosen.includes(i)) { best = [i]; break; }
      }
      chosen.push(best[Math.floor(this.rand() * best.length)]);
    }
    return chosen;
  }

  /** hop distance from a set of countries over land + sea links */
  bfsMulti(sources: number[]): Int32Array {
    const dist = new Int32Array(this.n).fill(-1);
    const q: number[] = [];
    for (const s of sources) { dist[s] = 0; q.push(s); }
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      for (const nb of this.map.countries[c].neighbours) {
        if (dist[nb] < 0) { dist[nb] = dist[c] + 1; q.push(nb); }
      }
    }
    return dist;
  }

  // ------------------------------------------------------------ territory
  /** connected components of a faction's territory (-1 = not owned) */
  components(f: number): Int32Array {
    const cached = this.compCache.get(f);
    if (cached && cached.v === this.version) return cached.comp;
    const comp = new Int32Array(this.n).fill(-1);
    let id = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.owner[i] !== f || comp[i] >= 0) continue;
      const stack = [i];
      comp[i] = id;
      while (stack.length) {
        const c = stack.pop()!;
        for (const nb of this.map.countries[c].neighbours) {
          if (this.owner[nb] === f && comp[nb] < 0) { comp[nb] = id; stack.push(nb); }
        }
      }
      id++;
    }
    this.compCache.set(f, { v: this.version, comp });
    return comp;
  }

  /** Can `from` send troops to `to`? */
  canSend(from: number, to: number): boolean {
    if (from === to || from < 0 || to < 0 || from >= this.n || to >= this.n) return false;
    const f = this.owner[from];
    if (f < 0) return false;
    const nbs = this.map.countries[to].neighbours;
    if (!CONFIG.game.sendThroughTerritory) return nbs.includes(from);
    const comp = this.components(f);
    const k = comp[from];
    if (this.owner[to] === f) return comp[to] === k;
    for (const nb of nbs) if (comp[nb] === k) return true;
    return false;
  }

  sendable(from: number): number {
    const t = this.troops[from];
    const amt = Math.floor(t * CONFIG.game.sendFraction);
    return Math.min(amt, Math.floor(t - CONFIG.game.minKeep));
  }

  /** Send from one country. Returns troops sent. */
  send(from: number, to: number, fraction = CONFIG.game.sendFraction): number {
    if (this.over || !this.canSend(from, to)) return 0;
    const t = this.troops[from];
    const amt = Math.min(Math.floor(t * fraction), Math.floor(t - CONFIG.game.minKeep));
    if (amt < 1) return 0;
    this.troops[from] -= amt;
    const owner = this.owner[from];
    const units = Math.max(1, Math.min(CONFIG.game.maxUnitsPerSend, amt));
    const a = this.map.countries[from].anchor, b = this.map.countries[to].anchor;
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.08; // curved path is a bit longer
    const rate = this.speedUnits / Math.max(0.001, dist);
    this.streams.push({ from, to, owner, left: units, per: amt / units, acc: 1, lane: 0, rate });
    this.inFlight[owner] += units;
    if (owner === PLAYER) this.stats.troopsSent += amt;
    this.events.push({ type: 'send', from, to, owner, troops: amt });
    return amt;
  }

  sendMany(sources: number[], to: number): number {
    let total = 0;
    for (const s of sources) if (s !== to) total += this.send(s, to);
    return total;
  }

  // ------------------------------------------------------------ update
  update(dtReal: number) {
    if (this.paused || this.over) return;
    const dt = dtReal * this.speed;
    this.time += dt;

    // growth
    for (let i = 0; i < this.n; i++) {
      const o = this.owner[i];
      if (o < 0) continue;
      const cap = this.cap[i];
      if (this.troops[i] < cap) this.troops[i] = Math.min(cap, this.troops[i] + this.rate[i] * this.growthMul[o] * dt);
      else if (this.troops[i] > cap) this.troops[i] = Math.max(cap, this.troops[i] - CONFIG.game.overCapDecay * dt);
    }

    // emit units from streams
    for (let s = this.streams.length - 1; s >= 0; s--) {
      const st = this.streams[s];
      st.acc += dt * CONFIG.game.unitsPerSecond;
      while (st.acc >= 1 && st.left > 0) {
        st.acc -= 1;
        st.left--;
        this.spawnUnit(st.owner, st.from, st.to, st.per, st.rate, ((st.lane++ % 3) - 1));
      }
      if (st.left <= 0) this.streams.splice(s, 1);
    }

    // move units
    let high = 0;
    for (let u = 0; u < this.uHigh; u++) {
      if (!this.uActive[u]) continue;
      this.uT[u] += this.uRate[u] * dt;
      if (this.uT[u] >= 1) {
        this.arrive(u);
        continue;
      }
      high = u + 1;
    }
    this.uHigh = high;

    // snapshots for the timelapse
    this.snapTimer += dt;
    if (this.snapTimer >= CONFIG.game.snapshotInterval) {
      this.snapTimer = 0;
      this.snapshots.push(this.owner.slice());
    }

    this.checkEnd();
  }

  private spawnUnit(owner: number, from: number, to: number, troops: number, rate: number, lane: number) {
    const u = this.free.pop();
    if (u === undefined) {
      // pool exhausted: resolve instantly
      this.inFlight[owner]--;
      this.applyArrival(owner, to, troops);
      return;
    }
    this.uActive[u] = 1;
    this.uOwner[u] = owner;
    this.uFrom[u] = from;
    this.uTo[u] = to;
    this.uTroops[u] = troops;
    this.uT[u] = 0;
    this.uRate[u] = rate * (0.97 + this.rand() * 0.06);
    this.uLane[u] = lane;
    this.uPhase[u] = this.rand() * Math.PI * 2;
    if (u + 1 > this.uHigh) this.uHigh = u + 1;
  }

  private arrive(u: number) {
    this.uActive[u] = 0;
    this.free.push(u);
    const owner = this.uOwner[u];
    this.inFlight[owner]--;
    this.applyArrival(owner, this.uTo[u], this.uTroops[u]);
  }

  private applyArrival(owner: number, to: number, troops: number) {
    const def = this.owner[to];
    if (def === owner) {
      this.troops[to] += troops;
      this.events.push({ type: 'reinforce', country: to, owner, troops });
      return;
    }
    const defT = this.troops[to];
    this.battle[to] += Math.min(troops, Math.max(0, defT)) * 2;
    this.events.push({ type: 'clash', country: to, attacker: owner, defender: def, troops });
    if (def === PLAYER) this.lastHitOnPlayer = this.time;
    const left = defT - troops;
    if (left < 0) {
      this.troops[to] = -left;
      this.setOwner(to, owner);
      const battle = Math.round(this.battle[to]);
      this.battle[to] = 0;
      if (owner === PLAYER || def === PLAYER) this.stats.biggestBattle = Math.max(this.stats.biggestBattle, battle);
      if (owner === PLAYER) {
        this.stats.captured++;
        if (!this.stats.capturedList.includes(to)) this.stats.capturedList.push(to);
      }
      if (def === PLAYER) this.stats.lost++;
      this.events.push({ type: 'capture', country: to, from: def, to: owner, battle });
    } else this.troops[to] = left;
  }

  setOwner(c: number, f: number) {
    const prev = this.owner[c];
    if (prev === f) return;
    if (prev >= 0) this.factions[prev].count--;
    this.owner[c] = f;
    if (f >= 0) this.factions[f].count++;
    this.version++;
  }

  private checkEnd() {
    for (const f of this.factions) {
      if (!f.alive) continue;
      if (f.count === 0 && this.inFlight[f.id] <= 0 && !this.streams.some((s) => s.owner === f.id)) {
        f.alive = false;
        f.eliminatedAt = this.time;
        this.events.push({ type: 'eliminated', faction: f.id });
      }
    }
    if (this.noPlayer) {
      const alive = this.factions.filter((f) => f.alive);
      if (alive.length <= 1 || alive.some((f) => f.count === this.n)) this.finish(false);
      return;
    }
    if (this.factions[PLAYER].count === this.n) this.finish(true);
    else if (!this.factions[PLAYER].alive) this.finish(false);
  }

  private finish(win: boolean) {
    if (this.over) return;
    this.over = true;
    this.won = win;
    this.snapshots.push(this.owner.slice());
    this.events.push({ type: 'end', win });
  }

  /** Troops in flight toward a country by factions other than its owner. */
  incomingThreat(c: number): number {
    let t = 0;
    const o = this.owner[c];
    for (let u = 0; u < this.uHigh; u++) {
      if (this.uActive[u] && this.uTo[u] === c && this.uOwner[u] !== o) t += this.uTroops[u];
    }
    for (const s of this.streams) if (s.to === c && s.owner !== o) t += s.left * s.per;
    return t;
  }

  /** Friendly troops already heading to a country. */
  incomingFriendly(c: number, f: number): number {
    let t = 0;
    for (let u = 0; u < this.uHigh; u++) {
      if (this.uActive[u] && this.uTo[u] === c && this.uOwner[u] === f) t += this.uTroops[u];
    }
    for (const s of this.streams) if (s.to === c && s.owner === f) t += s.left * s.per;
    return t;
  }

  leader(): number {
    let best = -1, bc = -1;
    for (const f of this.factions) if (f.alive && f.count > bc) { bc = f.count; best = f.id; }
    return best;
  }
}

export function tierOf(areaKm2: number) {
  const tiers = CONFIG.game.tiers;
  for (const t of tiers) if (areaKm2 <= t.maxArea) return t;
  return tiers[tiers.length - 1];
}
