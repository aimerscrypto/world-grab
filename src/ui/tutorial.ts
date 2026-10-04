import * as THREE from 'three';
import type { App } from '../app';
import type { Match } from '../match';
import { PLAYER, NEUTRAL, type GameEvent } from '../game/game';
import { createBots } from '../game/bots';
import { saveSettings, settings } from '../game/stats';
import { buildRegion } from '../map/mapData';

type Step = 'attack' | 'capture' | 'multi' | 'reinforce' | 'done';

const TEXT: Record<Step, { msg: string; sub: string }> = {
  attack: { msg: 'Drag from your blue country to a neighbour', sub: 'Release to send 60% of its troops into battle.' },
  capture: { msg: 'Nice! Watch your troops march…', sub: 'If more attackers arrive than defenders, the country is yours.' },
  multi: { msg: 'Drag THROUGH both your countries, then onto a target', sub: 'Every country you pass over joins the attack.' },
  reinforce: { msg: 'Now drop troops on your OWN country', sub: 'Reinforce borders before an enemy attacks them.' },
  done: { msg: 'You’re ready! Conquer Europe!', sub: 'A rival empire has woken up. Own every country to win.' },
};
const ORDER: Step[] = ['attack', 'capture', 'multi', 'reinforce', 'done'];

/**
 * First-time interactive tutorial on the Europe map against one passive bot.
 * Each step shows an animated hand and waits for the player to do it.
 */
export class Tutorial {
  private step: Step = 'attack';
  private box: HTMLDivElement;
  private hand: HTMLDivElement;
  private match: Match | null = null;
  private path: number[] = []; // country indices the hand travels through
  private t = 0;
  private doneTimer = -1;
  private v = new THREE.Vector3();
  private s = { x: 0, y: 0, z: 0 };
  private frameHook = (dt: number) => this.update(dt);
  private eventHook = (e: GameEvent, m: Match) => this.onEvent(e, m);
  private sendHook = (r: { sources: number[]; target: number; troops: number }) => this.onSend(r);
  private active = false;

  constructor(private app: App) {
    this.box = document.createElement('div');
    this.box.className = 'tut-box glass';
    this.hand = document.createElement('div');
    this.hand.className = 'tut-hand';
    this.hand.textContent = '👆';
  }

  async start() {
    const app = this.app;
    const map = await buildRegion('europe');
    const start = Math.max(0, map.countries.findIndex((c) => c.key === '276')); // Germany
    await app.startFromMenu({ region: 'europe', bots: 1, difficulty: 'easy', playerStart: start });
    const m = app.match;
    if (!m) return;
    this.match = m;
    m.thinkers = []; // the rival stays passive until the tutorial is finished
    this.active = true;
    app.root.appendChild(this.box);
    app.root.appendChild(this.hand);
    app.onFrame.push(this.frameHook);
    app.onGameEvent.push(this.eventHook);
    app.onPlayerSend.push(this.sendHook);
    const a = map.countries[start].anchor;
    app.rig.flyTo(a[0], a[1], 0.42, 1.6);
    this.setStep('attack');
  }

  private setStep(step: Step) {
    this.step = step;
    this.t = 0;
    const k = ORDER.indexOf(step);
    const txt = TEXT[step];
    this.box.innerHTML = `
      <div class="step">${step === 'done' ? 'Tutorial complete' : `Step ${Math.min(k + 1, 3)} of 3`}</div>
      <div class="msg">${txt.msg}</div>
      <div class="sub">${txt.sub}</div>
      ${step === 'done' ? '' : '<div class="row"><button class="btn small ghost skip">Skip tutorial</button></div>'}`;
    this.box.style.animation = 'none';
    void this.box.offsetWidth;
    this.box.style.animation = '';
    const skip = this.box.querySelector<HTMLButtonElement>('.skip');
    if (skip) skip.onclick = () => { this.app.sfx('click'); this.finish(); };
    this.planPath();
    if (step === 'done') {
      this.doneTimer = 4;
      this.app.sfx('capture');
    }
  }

  /** Picks the countries the hand demonstrates on for the current step. */
  private planPath() {
    const m = this.match;
    if (!m) return;
    const g = m.game;
    const map = g.map;
    const mine: number[] = [];
    for (let i = 0; i < g.n; i++) if (g.owner[i] === PLAYER) mine.push(i);
    const weakestEnemyNb = (c: number, avoid: number[] = []) => {
      let best = -1, bt = Infinity;
      for (const nb of map.countries[c].neighbours) {
        if (g.owner[nb] === PLAYER || avoid.includes(nb)) continue;
        const t = g.troops[nb] + (map.countries[nb].tiny ? 50 : 0) + (g.owner[nb] === NEUTRAL ? 0 : 30);
        if (t < bt) { bt = t; best = nb; }
      }
      return best;
    };
    this.path = [];
    if (this.step === 'attack' && mine.length) {
      const t = weakestEnemyNb(mine[0]);
      if (t >= 0) this.path = [mine[0], t];
    } else if (this.step === 'multi' && mine.length >= 2) {
      // two adjacent own countries + a target next to the second one
      for (const a of mine) {
        for (const b of map.countries[a].neighbours) {
          if (g.owner[b] !== PLAYER) continue;
          const t = weakestEnemyNb(b, [a]);
          if (t >= 0) { this.path = [a, b, t]; return; }
        }
      }
    } else if (this.step === 'reinforce' && mine.length >= 2) {
      for (const a of mine) {
        const b = map.countries[a].neighbours.find((n) => g.owner[n] === PLAYER);
        if (b !== undefined) { this.path = [a, b]; return; }
      }
      this.path = [mine[0], mine[1]];
    }
  }

  private onSend(r: { sources: number[]; target: number; troops: number }) {
    const g = this.match?.game;
    if (!g || !this.active) return;
    const own = g.owner[r.target] === PLAYER;
    if (this.step === 'attack' && !own) this.setStep('capture');
    else if (this.step === 'multi' && r.sources.length >= 2 && !own) this.setStep('reinforce');
    else if (this.step === 'reinforce' && own) this.setStep('done');
  }

  private onEvent(e: GameEvent, m: Match) {
    if (!this.active || m !== this.match) return;
    if (e.type === 'capture' && e.to === PLAYER && (this.step === 'capture' || this.step === 'attack')) {
      setTimeout(() => { if (this.active && (this.step === 'capture' || this.step === 'attack')) this.setStep('multi'); }, 700);
    }
  }

  private update(dt: number) {
    const app = this.app;
    if (!this.active) return;
    if (app.match !== this.match || !this.match) { this.dispose(); return; }
    const g = this.match.game;
    if (this.doneTimer > 0) {
      this.doneTimer -= dt;
      if (this.doneTimer <= 0) this.finish();
    }
    // multi / reinforce need 2 countries; re-plan if ownership changed under us
    if ((this.step === 'multi' || this.step === 'reinforce') && this.path.length < 2) this.planPath();
    if (this.path.some((c) => c < 0) || this.path.length < 2 || g.paused || app.screen !== 'none') {
      this.hand.style.opacity = '0';
      return;
    }
    // hand animation along the path, looping
    this.t += dt;
    const cycle = 1 + this.path.length * 0.7;
    const k = (this.t % cycle) / cycle;
    const pts = this.path.map((c) => {
      const a = g.map.countries[c].anchor;
      this.v.set(a[0], a[1], app.board!.topZ[c]);
      app.rig.worldToScreen(this.v, this.s);
      return { x: this.s.x, y: this.s.y };
    });
    // 0..0.15 press, 0.15..0.8 move, 0.8..1 release + fade
    let x: number, y: number, scale = 1, op = 1;
    if (k < 0.15) { x = pts[0].x; y = pts[0].y; scale = 1.15 - (k / 0.15) * 0.25; op = k / 0.15; }
    else if (k < 0.8) {
      const mk = (k - 0.15) / 0.65;
      const seg = Math.min(pts.length - 2, Math.floor(mk * (pts.length - 1)));
      const lk = mk * (pts.length - 1) - seg;
      const e = lk * lk * (3 - 2 * lk);
      x = pts[seg].x + (pts[seg + 1].x - pts[seg].x) * e;
      y = pts[seg].y + (pts[seg + 1].y - pts[seg].y) * e;
      scale = 0.9;
    } else {
      const last = pts[pts.length - 1];
      x = last.x; y = last.y;
      scale = 0.9 + ((k - 0.8) / 0.2) * 0.3;
      op = 1 - (k - 0.8) / 0.2;
    }
    this.hand.style.opacity = String(op);
    this.hand.style.transform = `translate3d(${(x - 12).toFixed(1)}px, ${(y - 4).toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
  }

  /** Ends the tutorial: the rival wakes up and the match continues. */
  finish() {
    if (!this.active) return;
    settings.tutorialDone = true;
    saveSettings();
    const m = this.match;
    if (m && this.app.match === m && !m.game.over) {
      m.thinkers = createBots(m.game, 'easy');
      this.app.rig.resetView(1.4);
    }
    this.dispose();
  }

  dispose() {
    this.active = false;
    this.box.remove();
    this.hand.remove();
    const app = this.app;
    app.onFrame = app.onFrame.filter((f) => f !== this.frameHook);
    app.onGameEvent = app.onGameEvent.filter((f) => f !== this.eventHook);
    app.onPlayerSend = app.onPlayerSend.filter((f) => f !== this.sendHook);
  }
}
