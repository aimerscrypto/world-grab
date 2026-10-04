import * as THREE from 'three';
import { CONFIG } from './config';
import { Game, NEUTRAL, PLAYER, type GameEvent, type MatchOptions } from './game/game';
import type { Board } from './render/board';
import type { BadgeLayer } from './ui/badges';
import type { CameraRig } from './render/cameraRig';
import type { UnitRenderer } from './render/units';
import type { FxSystem } from './render/fx';
import type { ArrowSystem } from './render/arrows';
import type { FloaterLayer } from './ui/floaters';
import type { Hud } from './ui/hud';
import { flagUrl } from './ui/flags';

export interface MatchCtx {
  root: HTMLElement;
  board: Board;
  badges: BadgeLayer;
  rig: CameraRig;
  units: UnitRenderer;
  fx: FxSystem;
  arrows: ArrowSystem;
  floaters: FloaterLayer;
  hud: Hud;
  /** screen projection helper */
  screenOf(x: number, y: number, z: number): { x: number; y: number; z: number };
}

export interface MatchHooks {
  onEnd?(win: boolean): void;
  onEvent?(e: GameEvent): void;
  onCombo?(n: number): void;
  onPlayerHit?(): void;
}

const COMBO_WORDS = ['', '', 'DOUBLE GRAB!', 'TRIPLE GRAB!', 'QUAD GRAB!', 'MEGA GRAB!', 'ULTRA GRAB!', 'WORLD GRAB!'];
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/**
 * One match: the game simulation plus everything that turns its events into
 * visuals (colours, badges, units, sparks, texts) and the drag-to-send input.
 */
export class Match {
  readonly game: Game;
  readonly attract: boolean;
  /** extra per-frame updaters (bots) */
  thinkers: { update(dt: number): void }[] = [];
  private sources: number[] = [];
  private target = -1;
  private targetValid = false;
  private pointer = { x: 0, y: 0 };
  private pointerWorld = new THREE.Vector3();
  private hasPointerWorld = false;
  private comboCount = 0;
  private lastCapture = -99;
  private sparkBudget = 0;
  private bumpTimers: Float32Array;
  private ended = false;
  private endDelay = -1;
  private hitPulseTimer = 0;
  private seenHit = -99;

  constructor(private ctx: MatchCtx, opts: MatchOptions & { attract?: boolean }, private hooks: MatchHooks = {}) {
    this.attract = !!opts.attract;
    this.game = new Game({ ...opts, noPlayer: this.attract });
    this.bumpTimers = new Float32Array(this.game.n);
    const { board, badges, hud } = ctx;
    board.resetAll();
    board.clearInteraction();
    for (let i = 0; i < this.game.n; i++) badges.setOwner(i, NEUTRAL);
    for (let i = 0; i < this.game.n; i++) {
      const o = this.game.owner[i];
      if (o >= 0) {
        board.setColorAnimated(i, this.game.factions[o].color, true);
        board.setOwned(i, true);
        badges.setOwner(i, o);
      }
    }
    ctx.units.clear();
    ctx.fx.clear();
    ctx.floaters.clear();
    badges.setVisible(true);
    hud.setFactions(this.game);
  }

  get playerStart(): number {
    for (let i = 0; i < this.game.n; i++) if (this.game.owner[i] === PLAYER) return i;
    return -1;
  }

  // ------------------------------------------------------------ input
  canDragFrom(c: number): boolean {
    return !this.attract && !this.game.over && !this.game.paused && c >= 0 && c < this.game.n && this.game.owner[c] === PLAYER;
  }

  dragStart(c: number, sx: number, sy: number) {
    this.sources = [c];
    this.ctx.board.setSelected(c, 1);
    this.dragMove(sx, sy, c);
  }

  dragMove(sx: number, sy: number, c: number) {
    if (!this.sources.length) return;
    this.pointer.x = sx;
    this.pointer.y = sy;
    this.hasPointerWorld = this.ctx.rig.screenToGround(sx, sy, this.pointerWorld, this.ctx.board.slabH);
    const g = this.game;
    if (c >= 0 && c < g.n && g.owner[c] === PLAYER && !this.sources.includes(c)) {
      this.sources.push(c);
      this.ctx.board.setSelected(c, 1);
      this.onSourceAdded?.(c);
    }
    this.computeTarget(c);
  }

  onSourceAdded: ((c: number) => void) | null = null;

  private effectiveSources(): number[] {
    return this.target >= 0 ? this.sources.filter((s) => s !== this.target) : this.sources;
  }

  private computeTarget(under: number) {
    const g = this.game;
    let t = -1;
    let valid = false;
    if (under >= 0 && under < g.n) {
      t = under;
      const srcs = this.sources.filter((s) => s !== t);
      valid = srcs.some((s) => g.canSend(s, t));
      if (g.owner[t] === PLAYER && !srcs.length) t = -1; // hovering the only source
    }
    if (!valid) {
      // snap to the nearest valid target close to the pointer
      const snapPx = 46;
      let best = -1, bestD = snapPx;
      const map = g.map;
      for (let i = 0; i < g.n; i++) {
        const a = map.countries[i].anchor;
        const s = this.ctx.screenOf(a[0], a[1], this.ctx.board.topZ[i]);
        const d = Math.hypot(s.x - this.pointer.x, s.y - this.pointer.y);
        if (d >= bestD) continue;
        if (!this.sources.some((src) => src !== i && g.canSend(src, i))) continue;
        if (g.owner[i] === PLAYER && this.sources.length === 1 && this.sources[0] === i) continue;
        best = i;
        bestD = d;
      }
      if (best >= 0) { t = best; valid = true; }
    }
    if (t !== this.target) {
      if (this.target >= 0) this.ctx.board.setTarget(this.target, 0);
      this.target = t;
      if (t >= 0) this.onTargetChanged?.(t, valid);
    }
    this.targetValid = valid;
    if (t >= 0) this.ctx.board.setTarget(t, valid ? 1 : -1);
  }

  onTargetChanged: ((t: number, valid: boolean) => void) | null = null;

  dragEnd(sx: number, sy: number, c: number): { sources: number[]; target: number; troops: number } | null {
    if (!this.sources.length) return null;
    this.dragMove(sx, sy, c);
    let result: { sources: number[]; target: number; troops: number } | null = null;
    if (this.target >= 0 && this.targetValid) {
      const srcs = this.effectiveSources().filter((s) => this.game.canSend(s, this.target));
      const troops = this.game.sendMany(srcs, this.target);
      result = { sources: srcs, target: this.target, troops };
    }
    this.clearDrag();
    return result;
  }

  dragCancel() { this.clearDrag(); }

  private clearDrag() {
    for (const s of this.sources) this.ctx.board.setSelected(s, 0);
    if (this.target >= 0) this.ctx.board.setTarget(this.target, 0);
    this.sources = [];
    this.target = -1;
    this.targetValid = false;
  }

  // ------------------------------------------------------------ update
  update(dt: number, time: number) {
    const g = this.game;
    const { board, badges, units, fx, hud } = this.ctx;
    if (!g.paused && !g.over) {
      const gdt = dt * g.speed;
      for (const t of this.thinkers) t.update(gdt);
    }
    g.update(dt);
    this.sparkBudget = 14;
    for (let i = 0; i < this.bumpTimers.length; i++) if (this.bumpTimers[i] > 0) this.bumpTimers[i] -= dt;
    if (g.events.length) {
      const evs = g.events;
      g.events = [];
      for (const e of evs) this.handle(e);
    }
    units.update(g, board, time);
    badges.update(dt, g.troops);
    if (!this.attract) hud.update(g, dt);
    this.drawArrows(time);
    if (this.hitPulseTimer > 0) this.hitPulseTimer -= dt;
    if (!this.attract && g.lastHitOnPlayer > this.seenHit) {
      this.seenHit = g.lastHitOnPlayer;
      if (this.hitPulseTimer <= 0) {
        this.hitPulseTimer = CONFIG.fx.attackPulseCooldown;
        this.hooks.onPlayerHit?.();
      }
    }
    fx.update(dt, g.map.unit);
    if (this.endDelay >= 0) {
      this.endDelay -= dt;
      if (this.endDelay < 0) this.hooks.onEnd?.(g.won);
    }
  }

  private drawArrows(time: number) {
    const { arrows, board } = this.ctx;
    arrows.begin(time);
    if (this.sources.length && (this.target >= 0 || this.hasPointerWorld)) {
      const map = this.game.map;
      const u = map.unit;
      let ex: number, ey: number, ez: number;
      if (this.target >= 0 && this.targetValid) {
        const a = map.countries[this.target].anchor;
        ex = a[0]; ey = a[1]; ez = board.topZ[this.target];
      } else {
        ex = this.pointerWorld.x; ey = this.pointerWorld.y; ez = board.slabH;
      }
      const color = this.target >= 0 ? (this.targetValid ? 0x7fc0ff : CONFIG.colors.invalid) : 0xcfe6ff;
      for (const s of this.effectiveSources()) {
        const a = map.countries[s].anchor;
        if (Math.hypot(ex - a[0], ey - a[1]) < u * 0.6) continue;
        arrows.draw(a[0], a[1], board.topZ[s] + u * 0.1, ex, ey, ez + u * 0.1, u, color, this.targetValid ? 1 : 0.75);
      }
    }
    arrows.end();
  }

  private handle(e: GameEvent) {
    const g = this.game;
    const { board, badges, fx, floaters, hud, rig } = this.ctx;
    const map = g.map;
    const u = map.unit;
    this.hooks.onEvent?.(e);
    switch (e.type) {
      case 'clash': {
        const a = map.countries[e.country].anchor;
        if (this.sparkBudget-- > 0) {
          fx.sparks(a[0], a[1], board.topZ[e.country] + u * 0.2, g.factions[e.attacker].color, CONFIG.fx.sparksPerClash, u, 0.8);
        }
        board.flash(e.country, 0.35);
        if (this.bumpTimers[e.country] <= 0) { badges.bump(e.country); this.bumpTimers[e.country] = 0.18; }
        break;
      }
      case 'reinforce':
        if (this.bumpTimers[e.country] <= 0) { badges.bump(e.country); this.bumpTimers[e.country] = 0.25; }
        break;
      case 'capture': {
        const c = map.countries[e.country];
        const col = g.factions[e.to].color;
        board.setColorAnimated(e.country, col, true);
        board.setOwned(e.country, true);
        badges.setOwner(e.country, e.to);
        const z = board.topZ[e.country];
        const big = Math.max(c.radius * 1.15, u * 3);
        fx.shockwave(c.anchor[0], c.anchor[1], z + u * 0.15, big, col);
        fx.sparks(c.anchor[0], c.anchor[1], z + u * 0.3, col, 16, u, 1.3);
        if (this.attract) break;
        const involved = e.to === PLAYER || e.from === PLAYER;
        if (involved && (e.battle >= CONFIG.fx.bigCaptureTroops || c.areaKm2 > 1_000_000)) rig.shake(CONFIG.fx.shakeBigCapture);
        if (e.to === PLAYER) {
          floaters.spawn(`<img class="fl" src="${flagUrl(c.a2)}" alt="">${esc(c.name)} captured!`, c.anchor[0], c.anchor[1], z + u * 0.8, { cls: 'capture', dur: CONFIG.fx.floatTextSeconds, rise: 70 });
          hud.addCollected(c);
          if (g.time - this.lastCapture < CONFIG.game.comboWindow) this.comboCount++;
          else this.comboCount = 1;
          this.lastCapture = g.time;
          if (this.comboCount >= 2) this.showCombo(this.comboCount);
        } else if (e.from === PLAYER) {
          floaters.spawn(`${esc(c.name)} lost!`, c.anchor[0], c.anchor[1], z + u * 0.8, { cls: 'capture', dur: 1.3, rise: 50, color: '#ff8a8a' });
        }
        break;
      }
      case 'eliminated': {
        if (this.attract) break;
        const f = g.factions[e.faction];
        if (f.isBot) this.banner(`<span style="color:${f.css}">${f.name}</span> has been eliminated!`);
        break;
      }
      case 'end':
        if (!this.ended) {
          this.ended = true;
          this.clearDrag();
          this.endDelay = this.attract ? 0.01 : 1.4;
          if (!this.attract && e.win) {
            // celebratory bursts over the board
            for (let i = 0; i < Math.min(12, g.n); i++) {
              const c = map.countries[Math.floor(Math.random() * g.n)];
              fx.sparks(c.anchor[0], c.anchor[1], board.topZ[c.idx] + u, CONFIG.colors.player, 10, u, 1.6);
            }
          }
        }
        break;
      default:
        break;
    }
  }

  private showCombo(n: number) {
    const word = COMBO_WORDS[Math.min(n, COMBO_WORDS.length - 1)];
    const el = document.createElement('div');
    el.className = 'combo';
    el.textContent = word;
    this.ctx.root.appendChild(el);
    el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.3) rotate(-8deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.15) rotate(3deg)', opacity: 1, offset: 0.25 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1, offset: 0.7 },
        { transform: 'translate(-50%, -80%) scale(0.9)', opacity: 0 },
      ],
      { duration: 1300, easing: 'ease-out' },
    ).onfinish = () => el.remove();
    this.hooks.onCombo?.(n);
  }

  banner(html: string, dur = 2600) {
    const el = document.createElement('div');
    el.className = 'banner glass';
    el.innerHTML = html;
    this.ctx.root.appendChild(el);
    el.animate(
      [
        { opacity: 0, transform: 'translate(-50%, -16px)' },
        { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.12 },
        { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.85 },
        { opacity: 0, transform: 'translate(-50%, -10px)' },
      ],
      { duration: dur },
    ).onfinish = () => el.remove();
  }

  /** Colour helper used by the replay. */
  factionColor(f: number): number {
    return f < 0 ? CONFIG.colors.neutral : this.game.factions[f].color;
  }

  // ------------------------------------------------------------ timelapse replay
  private replay: { idx: number; timer: number; step: number; hold: number; shown: Int8Array } | null = null;

  get replaying() { return !!this.replay; }

  /** Plays the recorded ownership snapshots back as a fast timelapse (loops). */
  startReplay() {
    const snaps = this.game.snapshots;
    if (snaps.length < 2) return;
    this.clearDrag();
    this.ctx.units.clear();
    this.ctx.badges.setVisible(false);
    const step = Math.min(0.25, Math.max(0.05, 7 / snaps.length));
    this.replay = { idx: 0, timer: 0, step, hold: 0, shown: snaps[0].slice() };
    this.applySnapshot(snaps[0], true);
  }

  private applySnapshot(s: Int8Array, instant: boolean) {
    const { board } = this.ctx;
    const r = this.replay!;
    for (let i = 0; i < s.length; i++) {
      if (!instant && r.shown[i] === s[i]) continue;
      r.shown[i] = s[i];
      const col = this.factionColor(s[i]);
      if (instant) board.setColorInstant(i, col);
      else board.setColorAnimated(i, col, false);
      board.setOwned(i, s[i] >= 0);
    }
  }

  /** Returns replay progress 0..1. */
  updateReplay(dt: number): number {
    const r = this.replay;
    if (!r) return 0;
    const snaps = this.game.snapshots;
    if (r.hold > 0) {
      r.hold -= dt;
      if (r.hold <= 0) {
        r.idx = 0;
        this.applySnapshot(snaps[0], true);
      }
      return 1;
    }
    r.timer += dt;
    while (r.timer >= r.step && r.idx < snaps.length - 1) {
      r.timer -= r.step;
      r.idx++;
      this.applySnapshot(snaps[r.idx], false);
    }
    if (r.idx >= snaps.length - 1) r.hold = 2.5;
    this.ctx.fx.update(dt, this.game.map.unit);
    return r.idx / (snaps.length - 1);
  }

  stopReplay() {
    this.replay = null;
    this.ctx.badges.setVisible(true);
  }

  dispose() {
    this.replay = null;
    this.ctx.badges.setVisible(true);
    this.clearDrag();
    this.ctx.units.clear();
    this.ctx.arrows.begin(0);
    this.ctx.arrows.end();
  }
}
