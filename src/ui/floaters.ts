import * as THREE from 'three';
import type { CameraRig } from '../render/cameraRig';

interface Floater {
  el: HTMLElement;
  world: THREE.Vector3;
  age: number;
  dur: number;
  rise: number;
}

const scr = { x: 0, y: 0, z: 0 };

/** DOM texts / flags that float up from a point on the map and fade out. */
export class FloaterLayer {
  readonly root: HTMLDivElement;
  private items: Floater[] = [];

  constructor(container: HTMLElement, private rig: CameraRig) {
    this.root = document.createElement('div');
    this.root.className = 'floaters';
    container.appendChild(this.root);
  }

  spawn(html: string, x: number, y: number, z: number, opts: { cls?: string; dur?: number; rise?: number; color?: string } = {}) {
    const el = document.createElement('div');
    el.className = 'floater ' + (opts.cls ?? '');
    el.innerHTML = html;
    if (opts.color) el.style.color = opts.color;
    this.root.appendChild(el);
    const f: Floater = { el, world: new THREE.Vector3(x, y, z), age: 0, dur: opts.dur ?? 1.4, rise: opts.rise ?? 60 };
    this.items.push(f);
    this.place(f);
    // keep the DOM bounded
    if (this.items.length > 40) this.remove(0);
  }

  private place(f: Floater) {
    this.rig.worldToScreen(f.world, scr);
    const k = f.age / f.dur;
    const ease = 1 - Math.pow(1 - Math.min(1, k), 3);
    const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.55 : k < 0.3 ? 1.15 - ((k - 0.15) / 0.15) * 0.15 : 1;
    const y = scr.y - ease * f.rise;
    f.el.style.transform = `translate3d(${scr.x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
    f.el.style.opacity = k > 0.7 ? String(Math.max(0, 1 - (k - 0.7) / 0.3)) : '1';
  }

  private remove(i: number) {
    this.items[i].el.remove();
    this.items.splice(i, 1);
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const f = this.items[i];
      f.age += dt;
      if (f.age >= f.dur) { this.remove(i); continue; }
      this.place(f);
    }
  }

  clear() {
    for (const f of this.items) f.el.remove();
    this.items = [];
  }

  dispose() {
    this.clear();
    this.root.remove();
  }
}
