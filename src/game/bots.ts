import { CONFIG, type BotProfile, type Difficulty } from '../config';
import { NEUTRAL, PLAYER, type Game } from './game';

interface Plan {
  target: number;
  sources: number[];
  score: number;
}

const rr = (g: Game, r: number[]) => r[0] + g.rand() * (r[1] - r[0]);

/**
 * Rule-based bot. Every few seconds it looks at its frontier and picks:
 *  - weak neutral neighbours to grab,
 *  - enemy border countries it clearly out-guns (bots fight each other too),
 *  - extra pressure on the leader when someone runs away with the map,
 *  - reinforcements from safe interior countries to threatened borders.
 * Actions are delayed by a small random "reaction time" so it feels human.
 */
export class BotBrain {
  private timer: number;
  private queue: { at: number; run: () => void }[] = [];
  private clock = 0;
  private profile: BotProfile;
  private lastCount = 0;
  private lastGain = 0;

  constructor(private game: Game, readonly faction: number, difficulty: Difficulty) {
    this.profile = CONFIG.bots[difficulty];
    // stagger the first decision so bots don't move in lockstep
    this.timer = rr(game, this.profile.thinkInterval) * (0.4 + game.rand() * 0.8);
  }

  update(dt: number) {
    const g = this.game;
    this.clock += dt;
    // run due actions
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].at <= this.clock) {
        const a = this.queue[i];
        this.queue.splice(i, 1);
        try { a.run(); } catch { /* never let a bot crash the match */ }
      }
    }
    if (!g.factions[this.faction].alive || g.over) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = rr(g, this.profile.thinkInterval);
    try { this.think(); } catch { /* keep thinking next time */ }
  }

  private schedule(run: () => void) {
    this.queue.push({ at: this.clock + rr(this.game, this.profile.reactionDelay), run });
  }

  private think() {
    const g = this.game;
    const me = this.faction;
    const map = g.map;
    const p = this.profile;
    const mine: number[] = [];
    for (let i = 0; i < g.n; i++) if (g.owner[i] === me) mine.push(i);
    if (!mine.length) return;

    const minutes = g.time / 60;
    const ramp = 1 + CONFIG.bots.aggressionRamp * minutes;
    // stalemate breaker: a bot that hasn't grown for a while gets bolder
    if (mine.length > this.lastCount) this.lastGain = this.clock;
    this.lastCount = mine.length;
    const desperate = this.clock - this.lastGain > CONFIG.bots.stalemateSeconds;
    const attackReq = desperate ? 1.0 : Math.max(1.05, p.attackAdvantage / ramp);
    const neutralReq = desperate ? 1.0 : Math.max(1.02, p.neutralAdvantage / ramp);
    const maxSources = desperate ? 6 : Math.min(6, 1 + p.maxActionsPerThink + Math.floor(minutes / 3));

    // leader pressure
    const leader = g.leader();
    const leaderShare = leader >= 0 ? g.factions[leader].count / g.n : 0;
    const gangUp = leader >= 0 && leader !== me && leaderShare >= p.gangUpThreshold;

    // frontier targets
    const comps = g.components(me);
    const targets = new Set<number>();
    for (const c of mine) for (const nb of map.countries[c].neighbours) if (g.owner[nb] !== me) targets.add(nb);

    const plans: Plan[] = [];
    for (const t of targets) {
      // sources: my countries in a component touching t, nearest first
      const touching = new Set<number>();
      for (const nb of map.countries[t].neighbours) if (comps[nb] >= 0) touching.add(comps[nb]);
      const ta = map.countries[t].anchor;
      const cands = mine
        .filter((s) => touching.has(comps[s]) && g.sendable(s) >= 2)
        .map((s) => {
          const a = map.countries[s].anchor;
          return { s, d: Math.hypot(a[0] - ta[0], a[1] - ta[1]) };
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, maxSources * 2);
      if (!cands.length) continue;
      const owner = g.owner[t];
      const travel = cands[0].d / g.speedUnits;
      let defense = g.troops[t] + 1;
      if (owner !== NEUTRAL && g.troops[t] < g.cap[t]) defense += Math.min(g.cap[t] - g.troops[t], g.rate[t] * g.growthMul[owner] * travel);
      defense -= g.incomingFriendly(t, me);
      const req = owner === NEUTRAL ? neutralReq : attackReq;
      let available = 0;
      const used: number[] = [];
      for (const c of cands) {
        if (used.length >= maxSources) break;
        // keep threatened sources home
        if (!desperate && used.length > 0 && this.threatOn(c.s) > g.troops[c.s] * 0.9) continue;
        used.push(c.s);
        available += g.sendable(c.s);
        if (available >= defense * req) break;
      }
      if (defense <= 0) {
        // already winning there: don't pile on
        continue;
      }
      if (available < defense * req) continue;
      let value = owner === NEUTRAL ? 1 + g.rate[t] * 0.6 : 1.25;
      if (owner === PLAYER) value += 0.05;
      if (gangUp && owner === leader) value += 1.1;
      // finishing off a weakened faction is attractive
      if (owner >= 0 && g.factions[owner].count <= 2) value += 0.4;
      const score = value * Math.min(3, available / Math.max(1, defense)) / (1 + travel * 0.15);
      plans.push({ target: t, sources: used, score: score * (0.85 + g.rand() * 0.3) });
    }

    plans.sort((a, b) => b.score - a.score);
    const busy = new Set<number>();
    let actions = 0;
    for (const plan of plans) {
      if (actions >= p.maxActionsPerThink) break;
      if (plan.sources.some((s) => busy.has(s))) continue;
      plan.sources.forEach((s) => busy.add(s));
      actions++;
      const { target, sources } = plan;
      this.schedule(() => {
        if (g.over || g.owner[target] === me) return;
        for (const s of sources) if (g.owner[s] === me && g.canSend(s, target)) g.send(s, target);
      });
    }

    // reinforcement / flow of troops from the interior to the frontier
    if (g.rand() < p.reinforceChance || actions === 0) this.reinforce(mine, comps, busy);
  }

  /** enemy troops that could hit this country soon */
  private threatOn(c: number): number {
    const g = this.game;
    const t = g.incomingThreat(c);
    let maxNb = 0;
    for (const nb of g.map.countries[c].neighbours) {
      const o = g.owner[nb];
      if (o !== NEUTRAL && o !== this.faction) maxNb = Math.max(maxNb, g.troops[nb] * CONFIG.game.sendFraction);
    }
    return t + maxNb;
  }

  private reinforce(mine: number[], comps: Int32Array, busy: Set<number>) {
    const g = this.game;
    const map = g.map;
    const me = this.faction;
    const isBorder = (c: number) => map.countries[c].neighbours.some((nb) => g.owner[nb] !== me);
    const borders = mine.filter(isBorder);
    const interior = mine.filter((c) => !isBorder(c) && !busy.has(c));
    if (!borders.length) return;
    // most threatened border country
    let worst = -1, worstGap = 0;
    for (const b of borders) {
      const gap = this.threatOn(b) - g.troops[b];
      if (gap > worstGap) { worstGap = gap; worst = b; }
    }
    const pickSource = (target: number) => {
      let best = -1, bestT = 0;
      for (const s of interior.length ? interior : mine) {
        if (s === target || comps[s] !== comps[target] || busy.has(s)) continue;
        const t = g.sendable(s);
        if (t > bestT) { bestT = t; best = s; }
      }
      return bestT >= 5 ? best : -1;
    };
    if (worst >= 0) {
      const s = pickSource(worst);
      if (s >= 0) {
        busy.add(s);
        this.schedule(() => { if (g.owner[s] === me && g.owner[worst] === me) g.send(s, worst); });
        return;
      }
    }
    // push full interior countries towards the nearest border
    for (const s of interior) {
      if (g.troops[s] < g.cap[s] * 0.85 || busy.has(s)) continue;
      const sa = map.countries[s].anchor;
      let best = -1, bd = Infinity;
      for (const b of borders) {
        if (comps[b] !== comps[s]) continue;
        const a = map.countries[b].anchor;
        const d = Math.hypot(a[0] - sa[0], a[1] - sa[1]);
        if (d < bd) { bd = d; best = b; }
      }
      if (best >= 0) {
        busy.add(s);
        const target = best;
        this.schedule(() => { if (g.owner[s] === me && g.owner[target] === me) g.send(s, target); });
        break;
      }
    }
  }
}

export function createBots(game: Game, difficulty: Difficulty): BotBrain[] {
  const bots: BotBrain[] = [];
  for (const f of game.factions) if (f.isBot) bots.push(new BotBrain(game, f.id, difficulty));
  return bots;
}
