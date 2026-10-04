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
import { Menus, type ScreenName } from './ui/menus';
import { Loading } from './ui/loading';
import { Picker } from './map/picker';
import { buildRegion, regionCount, regionSilhouette } from './map/mapData';
import { regionById, type RegionId } from './map/regions';
import type { RegionMap } from './map/types';
import { InputController } from './input';
import { flagUrl } from './ui/flags';
import { Match } from './match';
import { NEUTRAL, type GameEvent } from './game/game';
import { createBots } from './game/bots';
import { recordMatch, resetStats, saveSettings, settings } from './game/stats';
import { Tutorial } from './ui/tutorial';

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export interface StartOptions {
  region: RegionId;
  bots: number;
  difficulty: Difficulty;
  playerStart: number;
  attract?: boolean;
}

type AppState = 'boot' | 'loading' | 'menu' | 'playing' | 'results';

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
  readonly menus: Menus;
  readonly loading: Loading;
  map: RegionMap | null = null;
  board: Board | null = null;
  badges: BadgeLayer | null = null;
  picker: Picker | null = null;
  match: Match | null = null;
  state: AppState = 'boot';
  private lastStart: StartOptions | null = null;
  private time = 0;
  private last = performance.now();
  private infoCard: HTMLDivElement;
  private infoCountry = -1;
  private infoTimer = 0;
  private infoRefresh = 0;
  private hovered = -1;
  private edgePulse: HTMLDivElement;
  private pausedTag: HTMLDivElement;
  private tmpV = new THREE.Vector3();
  private scr = { x: 0, y: 0, z: 0 };
  readonly ownerColors = [CONFIG.colors.player, ...CONFIG.colors.bots].map(hex);
  private loadToken = 0;
  /** extra per-frame hooks (tutorial, audio) */
  onFrame: ((dt: number) => void)[] = [];
  onGameEvent: ((e: GameEvent, m: Match) => void)[] = [];
  onPlayerSend: ((r: { sources: number[]; target: number; troops: number }) => void)[] = [];
  private tutorial: Tutorial | null = null;
  /** sound hooks, filled in by the audio layer */
  sfx: (name: string, arg?: number) => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.stage = new Stage(root);
    this.stage.setQuality(settings.quality);
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
      onMute: () => this.toggleMute(),
      onRecenter: () => this.rig.resetView(),
      onClick: () => this.sfx('click'),
    });
    this.hud.setMuted(settings.muted);

    this.infoCard = document.createElement('div');
    this.infoCard.className = 'info-card glass';
    root.appendChild(this.infoCard);
    this.pausedTag = document.createElement('div');
    this.pausedTag.className = 'paused-tag';
    this.pausedTag.textContent = 'PAUSED';
    this.pausedTag.style.display = 'none';
    root.appendChild(this.pausedTag);

    this.menus = new Menus(root, {
      click: () => this.sfx('click'),
      play: () => this.play(),
      goTitle: () => this.goTitle(),
      openMaps: () => this.openMaps(),
      startMatch: (o) => this.startFromMenu({ ...o }),
      resume: () => this.setPaused(false),
      restart: () => this.lastStart && this.startFromMenu(this.lastStart),
      quit: () => this.goTitle(),
      playAgain: () => this.lastStart && this.startFromMenu(this.lastStart),
      setSound: (on) => { settings.muted = !on; saveSettings(); this.hud.setMuted(!on); this.sfx('mute', on ? 0 : 1); },
      setMusic: (on) => { settings.music = on; saveSettings(); this.sfx('music', on ? 1 : 0); },
      setQuality: (q) => { settings.quality = q; saveSettings(); this.stage.setQuality(q); },
      replayTutorial: () => this.startTutorial(),
      resetStats: () => { resetStats(); settings.tutorialDone = false; saveSettings(); },
      countryList: async (region) => {
        const map = await buildRegion(region);
        return map.countries.slice(0, map.playableCount).map((c) => ({ idx: c.idx, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
      },
      regionCount: (region) => regionCount(region),
      silhouette: (region) => regionSilhouette(region, 160, 100),
    });
    this.loading = new Loading(root);

    this.input = new InputController(this.stage.canvas, this.rig, {
      pickAt: (x, y) => this.pickAt(x, y),
      canDragFrom: (c) => this.state === 'playing' && !!this.match && this.match.canDragFrom(c),
      dragStart: (c, x, y) => { this.hideInfo(); this.match?.dragStart(c, x, y); this.sfx('select'); },
      dragMove: (x, y, c) => this.match?.dragMove(x, y, c),
      dragEnd: (x, y, c) => {
        const r = this.match?.dragEnd(x, y, c);
        if (r && r.troops > 0) this.sfx('send', r.troops);
        else this.sfx('cancel');
        if (r) for (const h of this.onPlayerSend) h(r);
      },
      dragCancel: () => this.match?.dragCancel(),
      tap: (c) => { if (this.state === 'playing') this.showInfo(c); },
      hover: (c) => this.setHover(this.state === 'playing' ? c : -1),
      anyDown: () => this.hud.closeDrawer(),
    });

    window.addEventListener('keydown', (e) => {
      if (this.state !== 'playing' || !this.match) return;
      if (e.code === 'Space' || e.code === 'KeyP' || e.code === 'Escape') { e.preventDefault(); this.togglePause(); }
      if (e.code === 'KeyF') this.cycleSpeed();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing' && this.match && !this.match.game.paused && !this.match.game.over) this.setPaused(true);
    });

    requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------ flow
  async boot() {
    await this.loading.show('Building the world…');
    await this.startAttract();
    this.loading.hide();
    this.menus.refreshTitle();
    this.menus.show('title');
    this.state = 'menu';
  }

  private async startAttract() {
    await this.startMatch({ region: 'world', bots: 5, difficulty: CONFIG.bots.attractDifficulty, playerStart: -1, attract: true });
  }

  play() {
    if (!settings.tutorialDone) this.startTutorial();
    else this.openMaps();
  }

  openMaps() {
    this.menus.openMaps();
  }

  async goTitle() {
    this.state = 'loading';
    this.setPausedTag(false);
    this.hud.show(false);
    this.hideInfo();
    this.input.reset();
    if (!this.match || !this.match.attract) {
      this.endMatch();
      if (this.map?.def.id !== 'world') await this.loading.show('Building the world…');
      await this.startAttract();
      this.loading.hide();
    }
    this.state = 'menu';
    this.menus.refreshTitle();
    this.menus.show('title');
  }

  async startFromMenu(o: StartOptions) {
    this.lastStart = { ...o, attract: false };
    this.state = 'loading';
    saveSettings();
    this.menus.show('none');
    this.input.reset();
    if (this.map?.def.id !== o.region) await this.loading.show(`Preparing ${regionById(o.region).name}…`);
    const ok = await this.startMatch(this.lastStart);
    this.loading.hide();
    if (!ok) { this.goTitle(); return; }
    this.state = 'playing';
  }

  /** Interactive first-time tutorial (Europe vs one passive easy bot). */
  startTutorial() {
    this.tutorial?.dispose();
    this.tutorial = new Tutorial(this);
    this.tutorial.start();
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
    // keep floaters / HUD above the badges
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

  async startMatch(opts: StartOptions): Promise<boolean> {
    const ok = await this.ensureRegion(opts.region);
    if (!ok || !this.board || !this.badges || !this.map) return false;
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
    const match = new Match(ctx, { map: this.map, bots: opts.bots, difficulty: opts.difficulty, playerStart: opts.playerStart, attract: opts.attract }, {
      onEnd: (win) => this.onMatchEnd(win),
      onPlayerHit: () => this.pulseEdge(),
      onEvent: (e) => { for (const h of this.onGameEvent) h(e, match); },
      onCombo: (n) => this.sfx('combo', n),
    });
    this.match = match;
    match.onSourceAdded = () => this.sfx('select');
    match.onTargetChanged = (_t, valid) => this.sfx(valid ? 'hover' : 'invalid');
    match.thinkers = createBots(match.game, opts.attract ? CONFIG.bots.attractDifficulty : opts.difficulty);
    if (opts.attract) match.game.speed = CONFIG.bots.attractSpeed;
    this.rig.attract = !!opts.attract;
    this.hud.show(!opts.attract);
    this.hud.setPaused(false);
    this.hud.setSpeed(1);
    this.setPausedTag(false);
    if (!opts.attract) {
      // swoop from overview to the player's start
      this.rig.setBoard(this.map.width, this.map.height, this.map.unit, this.board.slabH);
      const s = match.playerStart;
      if (s >= 0) {
        const a = this.map.countries[s].anchor;
        this.rig.flyTo(a[0] * 0.55, a[1] * 0.55, 0.8, 1.4);
      }
      this.sfx('start');
    }
    return true;
  }

  endMatch() {
    this.match?.dispose();
    this.match = null;
    this.hideInfo();
    this.hud.show(false);
  }

  private onMatchEnd(win: boolean) {
    const m = this.match;
    if (!m || m.attract || !this.map) return;
    const g = m.game;
    const opts = this.lastStart!;
    const a2s = g.stats.capturedList.map((i) => this.map!.countries[i].a2);
    const record = recordMatch(opts.region, opts.difficulty, win, g.time, a2s, g.stats.captured);
    this.state = 'results';
    this.input.reset();
    this.hideInfo();
    this.hud.show(false);
    this.setPausedTag(false);
    this.sfx(win ? 'victory' : 'defeat');
    this.menus.openResults({
      win,
      region: this.map.def.name,
      difficulty: opts.difficulty,
      seconds: g.time,
      captured: g.stats.captured,
      troopsSent: g.stats.troopsSent,
      biggestBattle: g.stats.biggestBattle,
      record: win && record,
    });
    m.startReplay();
    this.rig.resetView(1.2);
  }

  togglePause() {
    if (!this.match || this.match.game.over || this.state !== 'playing') return;
    this.setPaused(!this.match.game.paused);
  }

  setPaused(p: boolean) {
    if (!this.match) return;
    this.match.game.paused = p;
    this.hud.setPaused(p);
    this.setPausedTag(false);
    if (p) {
      this.input.reset();
      this.menus.show('pause');
    } else this.menus.show('none');
    this.sfx('pause', p ? 1 : 0);
  }

  private setPausedTag(v: boolean) { this.pausedTag.style.display = v ? '' : 'none'; }

  cycleSpeed() {
    if (!this.match) return;
    const speeds = CONFIG.game.speeds;
    const g = this.match.game;
    g.speed = speeds[(speeds.indexOf(g.speed) + 1) % speeds.length];
    this.hud.setSpeed(g.speed);
  }

  toggleMute() {
    settings.muted = !settings.muted;
    saveSettings();
    this.hud.setMuted(settings.muted);
    this.sfx('mute', settings.muted ? 1 : 0);
  }

  pulseEdge() {
    this.edgePulse.classList.remove('on');
    void this.edgePulse.offsetWidth;
    this.edgePulse.classList.add('on');
    this.sfx('alarm');
  }

  get screen(): ScreenName { return this.menus.current; }

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
    this.sfx('click');
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
    const m = this.match;
    if (m) {
      if (m.replaying) this.menus.setReplayProgress(m.updateReplay(realDt));
      else m.update(realDt, this.time);
      if (m.attract && (m.game.over || m.game.time > CONFIG.bots.attractMaxSeconds) && this.state === 'menu') {
        this.startAttract();
      }
    } else this.fx.update(realDt, this.map?.unit ?? 1);
    if (this.board) this.board.update(realDt, this.time);
    if (m?.replaying && this.badges) this.badges.update(realDt, m.game.troops);
    this.floaters.update(realDt);
    for (const f of this.onFrame) f(realDt);
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
