import * as THREE from 'three';
import { CONFIG } from './config';
import { Stage } from './render/stage';
import { CameraRig } from './render/cameraRig';
import { Board } from './render/board';
import { BadgeLayer } from './ui/badges';
import { Picker } from './map/picker';
import { buildRegion } from './map/mapData';
import type { RegionId } from './map/regions';
import { REGIONS } from './map/regions';
import type { RegionMap } from './map/types';
import { InputController } from './input';
import { flagUrl } from './ui/flags';

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

export class App {
  readonly root: HTMLElement;
  readonly stage: Stage;
  readonly rig: CameraRig;
  readonly input: InputController;
  map: RegionMap | null = null;
  board: Board | null = null;
  badges: BadgeLayer | null = null;
  picker: Picker | null = null;
  private time = 0;
  private last = performance.now();
  private placeholder: Float32Array = new Float32Array(0);
  private infoCard: HTMLDivElement;
  private infoTimer = 0;
  private hovered = -1;
  private tmpV = new THREE.Vector3();
  private scr = { x: 0, y: 0, z: 0 };
  readonly ownerColors = [CONFIG.colors.player, ...CONFIG.colors.bots].map(hex);

  constructor(root: HTMLElement) {
    this.root = root;
    this.stage = new Stage(root);
    this.rig = new CameraRig(this.stage.camera);
    this.rig.setViewport(this.stage.width, this.stage.height);
    this.stage.onResize = () => this.rig.setViewport(this.stage.width, this.stage.height);
    const vignette = document.createElement('div');
    vignette.className = 'vignette';
    root.appendChild(vignette);

    this.infoCard = document.createElement('div');
    this.infoCard.className = 'info-card glass';
    root.appendChild(this.infoCard);

    this.input = new InputController(this.stage.canvas, this.rig, {
      pickAt: (x, y) => this.pickAt(x, y),
      canDragFrom: () => false,
      dragStart: () => {},
      dragMove: () => {},
      dragEnd: () => {},
      dragCancel: () => {},
      tap: (c) => this.showInfo(c),
      hover: (c) => this.setHover(c),
      anyDown: () => {},
    });

    // temporary region switcher (replaced by the real menus later)
    const bar = document.createElement('div');
    bar.className = 'hud-bottom';
    for (const r of REGIONS) {
      const b = document.createElement('button');
      b.className = 'btn small ghost';
      b.textContent = r.name;
      b.onclick = () => this.loadRegion(r.id);
      bar.appendChild(b);
    }
    root.appendChild(bar);

    requestAnimationFrame(this.frame);
  }

  async loadRegion(id: RegionId) {
    const map = await buildRegion(id);
    this.disposeBoard();
    this.map = map;
    this.board = new Board(map, this.stage.pxRatio < 1.5);
    this.stage.scene.add(this.board.group);
    this.picker = new Picker(map);
    this.badges = new BadgeLayer(this.root, this.board, this.rig, this.ownerColors);
    this.rig.setBoard(map.width, map.height, map.unit, this.board.slabH);
    this.placeholder = new Float32Array(map.playableCount);
    for (let i = 0; i < map.playableCount; i++) {
      this.placeholder[i] = 5 + Math.floor(Math.random() * 40);
      const owner = Math.random() < 0.3 ? Math.floor(Math.random() * 6) : -1;
      if (owner >= 0) {
        this.board.setColorInstant(i, owner === 0 ? CONFIG.colors.player : CONFIG.colors.bots[owner - 1]);
        this.board.setOwned(i, true);
        this.badges.setOwner(i, owner);
      }
    }
  }

  private disposeBoard() {
    this.board?.dispose();
    this.badges?.dispose();
    this.board = null;
    this.badges = null;
    this.picker = null;
  }

  pickAt(sx: number, sy: number): number {
    if (!this.board || !this.map || !this.picker) return -1;
    // tokens first (tiny countries)
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
    if (c < 0 || !this.map) { this.infoCard.classList.remove('show'); return; }
    const country = this.map.countries[c];
    this.infoCard.innerHTML = `
      <img src="${flagUrl(country.a2)}" alt="">
      <div>
        <div class="t">${country.name}</div>
        <div class="d">Capital <b>${country.capital}</b><br>${country.subregion} · <b>${Math.round(this.placeholder[c])}</b> troops</div>
      </div>`;
    this.infoCard.classList.add('show');
    this.infoTimer = 3.5;
  }

  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const realDt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += realDt;
    this.stage.trackFrame(realDt);
    this.rig.update(realDt);
    if (this.board) this.board.update(realDt, this.time);
    if (this.badges) this.badges.update(realDt, this.placeholder);
    if (this.infoTimer > 0) {
      this.infoTimer -= realDt;
      if (this.infoTimer <= 0) this.infoCard.classList.remove('show');
    }
    this.rig.changed = false;
    this.stage.render();
  };
}
