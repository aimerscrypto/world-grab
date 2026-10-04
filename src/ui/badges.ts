import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Board } from '../render/board';
import type { CameraRig } from '../render/cameraRig';
import { flagUrl } from './flags';

interface Badge {
  el: HTMLDivElement;
  num: HTMLSpanElement;
  flag: HTMLImageElement | null;
  shown: number; // displayed (rolling) value
  text: number;
  owner: number; // -1 neutral
  visible: boolean;
  x: number;
  y: number;
  s: number;
  sx: number; // last screen pos
  sy: number;
  onScreen: boolean;
  w: number;
  h: number;
}

const v3 = new THREE.Vector3();
const scr = { x: 0, y: 0, z: 0 };

/**
 * Troop-count pills drawn as DOM elements over the canvas. Positions follow the
 * camera; low-priority badges hide when they would overlap or are too small.
 */
export class BadgeLayer {
  readonly root: HTMLDivElement;
  private badges: Badge[] = [];
  private layoutTimer = 0;
  private colors: string[] = [];

  constructor(container: HTMLElement, private board: Board, private rig: CameraRig, ownerColors: string[]) {
    this.colors = ownerColors;
    this.root = document.createElement('div');
    this.root.className = 'badges';
    container.appendChild(this.root);
    const map = board.map;
    for (let i = 0; i < map.playableCount; i++) {
      const el = document.createElement('div');
      el.className = 'badge neutral';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = '0';
      el.appendChild(num);
      this.root.appendChild(el);
      this.badges.push({ el, num, flag: null, shown: 0, text: -1, owner: -1, visible: true, x: 0, y: 0, s: 1, sx: -1, sy: -1, onScreen: true, w: 40, h: 22 });
    }
  }

  setOwnerColors(colors: string[]) { this.colors = colors; }

  setOwner(i: number, owner: number) {
    const b = this.badges[i];
    if (!b || b.owner === owner) return;
    b.owner = owner;
    if (owner < 0) {
      b.el.className = 'badge neutral';
      b.el.style.removeProperty('--c');
      if (b.flag) { b.flag.remove(); b.flag = null; }
    } else {
      b.el.className = 'badge owned' + (owner === 0 ? ' mine' : '');
      b.el.style.setProperty('--c', this.colors[owner] ?? '#888');
      if (!b.flag) {
        const img = document.createElement('img');
        img.className = 'flag';
        img.alt = '';
        img.decoding = 'async';
        img.src = flagUrl(this.board.map.countries[i].a2);
        img.onerror = () => { img.style.display = 'none'; };
        b.el.insertBefore(img, b.num);
        b.flag = img;
      }
      b.el.animate([{ transform: `${this.transformOf(b)} scale(1.5)` }, { transform: this.transformOf(b) }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' });
    }
    this.layoutTimer = 0;
  }

  /** Bump animation (troops arrived / big change). */
  bump(i: number) {
    const b = this.badges[i];
    if (!b || !b.visible) return;
    b.num.animate([{ transform: 'scale(1.45)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
  }

  private transformOf(b: Badge) {
    return `translate3d(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${b.s.toFixed(3)})`;
  }

  /** values = troops per country */
  update(dt: number, values: ArrayLike<number>) {
    const map = this.board.map;
    const rig = this.rig;
    const vw = window.innerWidth, vh = window.innerHeight;
    const ppu = rig.pixelsPerUnit();
    const zoomScale = Math.min(1.25, Math.max(0.72, 0.72 + rig.zoomLevel * 0.6)) * (Math.min(vw, vh) < 500 ? 0.88 : 1);
    const k = 1 - Math.exp(-dt * CONFIG.fx.badgeLerp);
    this.layoutTimer -= dt;
    const relayout = this.layoutTimer <= 0 || rig.changed;
    if (relayout) this.layoutTimer = 0.2;

    for (let i = 0; i < this.badges.length; i++) {
      const b = this.badges[i];
      const c = map.countries[i];
      // number roll-up
      const target = values[i] ?? 0;
      if (Math.abs(target - b.shown) > 2.5) b.shown += (target - b.shown) * k;
      else b.shown = target;
      const t = Math.max(0, Math.floor(b.shown + 0.0001));
      if (t !== b.text) { b.text = t; b.num.textContent = String(t); }

      v3.set(c.anchor[0], c.anchor[1], this.board.topZ[i] + 0.02);
      rig.worldToScreen(v3, scr);
      b.x = scr.x;
      b.y = scr.y;
      b.onScreen = scr.z < 1 && scr.x > -60 && scr.y > -40 && scr.x < vw + 60 && scr.y < vh + 40;
      b.s = zoomScale * (b.owner === 0 ? 1.04 : b.owner < 0 ? 0.9 : 1);
    }

    if (relayout) this.resolveVisibility(ppu);

    for (const b of this.badges) {
      const show = b.visible && b.onScreen;
      if (show !== (b.el.style.display !== 'none')) b.el.style.display = show ? '' : 'none';
      if (!show) continue;
      if (Math.abs(b.x - b.sx) > 0.2 || Math.abs(b.y - b.sy) > 0.2 || relayout) {
        b.sx = b.x; b.sy = b.y;
        b.el.style.transform = this.transformOf(b);
      }
    }
  }

  private resolveVisibility(ppu: number) {
    const map = this.board.map;
    const order: number[] = [];
    for (let i = 0; i < this.badges.length; i++) {
      const b = this.badges[i];
      const c = map.countries[i];
      b.visible = b.onScreen;
      if (!b.onScreen) continue;
      const sizePx = c.tiny ? CONFIG.slab.tokenRadius * map.unit * 2 * ppu * 1.6 : Math.sqrt(c.area) * ppu;
      if (b.owner < 0 && sizePx < CONFIG.perf.neutralBadgeMinPx) { b.visible = false; continue; }
      b.w = (b.owner >= 0 ? 52 : 30) * b.s;
      b.h = 24 * b.s;
      order.push(i);
    }
    const pri = (i: number) => {
      const b = this.badges[i];
      return (b.owner === 0 ? 3e9 : b.owner > 0 ? 2e9 : 0) + map.countries[i].area * 1e3;
    };
    order.sort((a, z) => pri(z) - pri(a));
    const placed: number[] = [];
    for (const i of order) {
      const b = this.badges[i];
      let ok = true;
      for (const j of placed) {
        const o = this.badges[j];
        const ox = Math.min(b.x + b.w / 2, o.x + o.w / 2) - Math.max(b.x - b.w / 2, o.x - o.w / 2);
        const oy = Math.min(b.y + b.h / 2, o.y + o.h / 2) - Math.max(b.y - b.h / 2, o.y - o.h / 2);
        if (ox > b.w * 0.35 && oy > b.h * 0.45) { ok = false; break; }
      }
      // your own countries are always shown
      if (!ok && b.owner !== 0) { b.visible = false; continue; }
      placed.push(i);
    }
  }

  /** Screen position of a badge (for floating texts etc.). */
  screenPos(i: number): { x: number; y: number } {
    const b = this.badges[i];
    return { x: b.x, y: b.y };
  }

  setVisible(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  dispose() { this.root.remove(); this.badges = []; }
}
