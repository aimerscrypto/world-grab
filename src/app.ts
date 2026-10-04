import * as THREE from 'three';
import { CONFIG, type Difficulty } from './config';
import { Stage } from './render/stage';
import { CameraRig } from './render/cameraRig';
import { Board } from './render/board';
import { UnitRenderer } from './render/units';
import { FxSystem } from './render/fx';
import { ArrowSystem } from './render/arrows';
import { BadgeLayer } from './ui/badges';
import { FloaterLayer } from './ui/floaters';
import { Hud } from './ui/hud';
import { Picker } from './map/picker';
import { buildRegion } from './map/mapData';
import type { RegionId } from './map/regions';
import type { RegionMap } from './map/types';
import { InputController } from './input';
import { flagUrl } from './ui/flags';
import { Match } from './match';
import { NEUTRAL } from './game/game';
import { createBots } from './game/bots';

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export interface StartOptions {
  region: RegionId;
  bots: number;
  difficulty: Difficulty;
  playerStart: number;
  attract?: boolean;
}

export class App {
  readonly root: HTMLElement;
  readonly stage: Stage;
  readonly rig: CameraRig;
  readonly input: InputController;
  readonly units: UnitRenderer;
  readonly fx: FxSystem;
  readonly arrows: ArrowSystem;
  readonly floaters: FloaterLayer;
  readonly hud: Hud;
  map: RegionMap | null = null;
  board: Board | null = null;
  badges: BadgeLayer | null = null;
  picker: Picker | null = null;
  match: Match | null = null;
  private time = 0;
  private last = performance.now();
  private infoCard: HTMLDivElement;
  private infoCountry = -1;
  private infoTimer = 0;
  private infoRefresh = 0;
  private hovered = -1;
  private edgePulse: HTMLDivElement;
  private tmpV = new THREE.Vector3();
  private scr = { x: 0, y: 0, z: 0 };
  readonly ownerColors = [CONFIG.colors.player, ...CONFIG.colors.bots].map(hex);
  private loadToken = 0;

  constructor(root: HTMLElement) {
    this.root = root;
    this.stage = new Stage(root);
    this.rig = new CameraRig(this.stage.camera);
    this.fx = new FxSystem();
    this.units = new UnitRenderer(CONFIG.game.maxUnits, [CONFIG.colors.player, ...CONFIG.colors.bots]);
    this.arrows = new ArrowSystem();
    this.stage.scene.add(this.units.group, this.fx.group, this.arrows.group);
    const onResize = () => {
      this.rig.setViewport(this.stage.width, this.stage.height);
      this.fx.setViewport(this.stage.height, this.stage.pxRatio, CONFIG.camera.fov);
    };
    this.stage.onResize = onResize;
    onResize();

    const vignette = document.createElement('div');
    vignette.className = 'vignette';
    root.appendChild(vignette);
    this.edgePulse = document.createElement('div');
    this.edgePulse.className = 'edge-pulse';
    root.appendChild(this.edgePulse);

    this.floaters = new FloaterLayer(root, this.rig);
    this.hud = new Hud(root, {
      onPause: () => this.togglePause(),
      onSpeed: () => this.cycleSpeed(),
      onMute: () => {},
      onRecenter: () => this.rig.resetView(),
    });

    this.infoCard = document.createElement('div');
    this.infoCard.className = 'info-card glass';
    root.appendChild(this.infoCard);

    this.input = new InputController(this.stage.canvas, this.rig, {
      pickAt: (x, y) => this.pickAt(x, y),
      canDragFrom: (c) => !!this.match && this.match.canDragFrom(c),
      dragStart: (c, x, y) => { this.hideInfo(); this.match?.dragStart(c, x, y); },
      dragMove: (x, y, c) => this.match?.dragMove(x, y, c),
      dragEnd: (x, y, c) => { this.match?.dragEnd(x, y, c); },
      dragCancel: () => this.match?.dragCancel(),
      tap: (c) => this.showInfo(c),
      hover: (c) => this.setHover(c),
      anyDown: () => this.hud.closeDrawer(),
    });

    window.addEventListener('keydown', (e) => {
      if (!this.match || this.match.attract) return;
      if (e.code === 'Space' || e.code === 'KeyP') { e.preventDefault(); this.togglePause(); }
      if (e.code === 'KeyF') this.cycleSpeed();
    });

    requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------ boards
  async ensureRegion(id: RegionId): Promise<boolean> {
    const token = ++this.loadToken;
    if (this.map?.def.id === id && this.board) return true;
    const map = await buildRegion(id);
    if (token !== this.loadToken) return false;
    this.endMatch();
    this.disposeBoard();
    this.map = map;
    this.board = new Board(map, this.stage.pxRatio < 1.5);
    this.stage.scene.add(this.board.group);
    this.picker = new Picker(map);
    this.badges = new BadgeLayer(this.root, this.board, this.rig, this.ownerColors);
    // keep floaters / info card above the badges
    this.root.insertBefore(this.badges.root, this.floaters.root);
    this.rig.setBoard(map.width, map.height, map.unit, this.board.slabH);
    return true;
  }

  private disposeBoard() {
    this.board?.dispose();
    this.badges?.dispose();
    this.board = null;
    this.badges = null;
    this.picker = null;
    this.map = null;
    this.hovered = -1;
  }

  async startMatch(opts: StartOptions) {
    const ok = await this.ensureRegion(opts.region);
    if (!ok || !this.board || !this.badges || !this.map) return;
    this.endMatch();
    const ctx = {
      root: this.root,
      board: this.board,
      badges: this.badges,
      rig: this.rig,
      units: this.units,
      fx: this.fx,
      arrows: this.arrows,
      floaters: this.floaters,
      hud: this.hud,
      screenOf: (x: number, y: number, z: number) => {
        this.tmpV.set(x, y, z);
        this.rig.worldToScreen(this.tmpV, this.scr);
        return this.scr;
      },
    };
    this.match = new Match(ctx, { map: this.map, bots: opts.bots, difficulty: opts.difficulty, playerStart: opts.playerStart, attract: opts.attract }, {
      onEnd: (win) => this.onMatchEnd(win),
      onPlayerHit: () => this.pulseEdge(),
    });
    this.match.thinkers = createBots(this.match.game, opts.attract ? CONFIG.bots.attractDifficulty : opts.difficulty);
    if (opts.attract) this.match.game.speed = CONFIG.bots.attractSpeed;
    this.rig.attract = !!opts.attract;
    this.hud.show(!opts.attract);
    this.hud.setPaused(false);
    this.hud.setSpeed(1);
    if (!opts.attract) {
      const s = this.match.playerStart;
      if (s >= 0) {
        const a = this.map.countries[s].anchor;
        this.rig.flyTo(a[0] * 0.5, a[1] * 0.5, 0.85, 1.2);
      }
    }
  }

  endMatch() {
    this.match?.dispose();
    this.match = null;
    this.hideInfo();
    this.hud.show(false);
  }

  private onMatchEnd(win: boolean) {
    // Phase 2: simple restart prompt (full results screen comes later)
    if (!this.match || this.match.attract) return;
    this.match.banner(win ? 'Victory! Tap to play again.' : 'Defeat! Tap to try again.', 4000);
    const region = this.map!.def.id;
    setTimeout(() => this.startMatch({ region, bots: CONFIG.game.defaultBots, difficulty: 'normal', playerStart: -1 }), 4200);
  }

  togglePause() {
    if (!this.match || this.match.game.over) return;
    const g = this.match.game;
    g.paused = !g.paused;
    this.hud.setPaused(g.paused);
    if (g.paused) this.input.reset();
  }

  cycleSpeed() {
    if (!this.match) return;
    const speeds = CONFIG.game.speeds;
    const g = this.match.game;
    g.speed = speeds[(speeds.indexOf(g.speed) + 1) % speeds.length];
    this.hud.setSpeed(g.speed);
  }

  pulseEdge() {
    this.edgePulse.classList.remove('on');
    void this.edgePulse.offsetWidth;
    this.edgePulse.classList.add('on');
  }

  // ------------------------------------------------------------ picking / info
  pickAt(sx: number, sy: number): number {
    if (!this.board || !this.map || !this.picker) return -1;
    const map = this.map;
    let best = -1, bestD = Infinity;
    const ppu = this.rig.pixelsPerUnit();
    const tokenPx = Math.max(16, CONFIG.slab.tokenRadius * map.unit * ppu * 1.3);
    for (let i = 0; i < map.playableCount; i++) {
      const c = map.countries[i];
      if (!c.tiny) continue;
      this.tmpV.set(c.anchor[0], c.anchor[1], this.board.topZ[i]);
      this.rig.worldToScreen(this.tmpV, this.scr);
      const d = Math.hypot(this.scr.x - sx, this.scr.y - sy);
      if (d < tokenPx && d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) return best;
    const g = this.input.groundAt(sx, sy, this.board.slabH + this.board.ownedH * 0.5);
    return g ? this.picker.pick(g.x, g.y) : -1;
  }

  private setHover(c: number) {
    if (c === this.hovered || !this.board) return;
    this.board.setHover(this.hovered, 0);
    this.hovered = c;
    this.board.setHover(c, 1);
    this.stage.canvas.style.cursor = c >= 0 ? 'pointer' : '';
  }

  showInfo(c: number) {
    if (c < 0 || !this.map || !this.match || this.match.attract) { this.hideInfo(); return; }
    this.infoCountry = c;
    this.infoTimer = 4;
    this.renderInfo();
    this.infoCard.classList.add('show');
  }

  private renderInfo() {
    const c = this.infoCountry;
    if (c < 0 || !this.map || !this.match) return;
    const g = this.match.game;
    const country = this.map.countries[c];
    const o = g.owner[c];
    const ownerName = o === NEUTRAL ? 'Neutral' : g.factions[o].name;
    const ownerCss = o === NEUTRAL ? hex(CONFIG.colors.neutral) : g.factions[o].css;
    this.infoCard.innerHTML = `
      <img src="${flagUrl(country.a2)}" alt="">
      <div>
        <div class="t">${esc(country.name)}</div>
        <div class="d">Capital <b>${esc(country.capital)}</b><br>
        <span class="owner-chip" style="background:${ownerCss}"></span><b>${esc(ownerName)}</b> · <b>${Math.floor(g.troops[c])}</b> troops</div>
      </div>`;
  }

  hideInfo() {
    this.infoCountry = -1;
    this.infoCard.classList.remove('show');
  }

  // ------------------------------------------------------------ loop
  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const realDt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.time += realDt;
    this.stage.trackFrame(realDt);
    this.rig.update(realDt);
    if (this.match) this.match.update(realDt, this.time);
    else this.fx.update(realDt, this.map?.unit ?? 1);
    if (this.board) this.board.update(realDt, this.time);
    if (!this.match && this.badges) this.badges.update(realDt, []);
    this.floaters.update(realDt);
    if (this.infoCountry >= 0) {
      this.infoTimer -= realDt;
      this.infoRefresh -= realDt;
      if (this.infoRefresh <= 0) { this.infoRefresh = 0.25; this.renderInfo(); }
      if (this.infoTimer <= 0) this.hideInfo();
    }
    this.rig.changed = false;
    this.stage.render();
  };
}
