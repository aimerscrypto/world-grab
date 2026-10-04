import * as THREE from 'three';
import { CONFIG } from '../config';

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Tilted top-down camera over the board (map plane = XY, Z up).
 * Supports drag-pan with inertia, smooth zoom towards a screen point,
 * pinch, fly-to tweens, attract-mode drift and a small shake.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  dist = 100;
  private targetDist = 100;
  private fitDist = 100;
  private halfW = 50;
  private halfH = 50;
  private unit = 1;
  private viewW = 1;
  private viewH = 1;
  private tilt = (CONFIG.camera.tiltDeg * Math.PI) / 180;
  private groundZ = 0.6;

  private panning = false;
  private panAnchor = new THREE.Vector3();
  private velocity = new THREE.Vector2();
  private lastPanTime = 0;

  private zoomScreen: [number, number] | null = null;
  private zoomWorld = new THREE.Vector3();

  private fly: { from: THREE.Vector3; to: THREE.Vector3; d0: number; d1: number; t: number; dur: number } | null = null;
  private shakeAmt = 0;
  private shakeOffset = new THREE.Vector3();
  attract = false;
  private attractT = 0;
  /** set whenever the view changed this frame */
  changed = true;

  private ray = new THREE.Ray();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private ndc = new THREE.Vector2();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  setViewport(w: number, h: number) {
    this.viewW = w;
    this.viewH = h;
    if (this.halfW) this.computeFit();
    this.changed = true;
  }

  setBoard(width: number, height: number, unit: number, groundZ: number) {
    this.halfW = width / 2;
    this.halfH = height / 2;
    this.unit = unit;
    this.groundZ = groundZ;
    this.computeFit();
    this.target.set(0, 0, 0);
    this.dist = this.targetDist = this.fitDist;
    this.fly = null;
    this.velocity.set(0, 0);
    this.apply();
  }

  private computeFit() {
    const t = Math.tan(((CONFIG.camera.fov / 2) * Math.PI) / 180);
    const aspect = this.viewW / this.viewH;
    const dH = (this.halfH * Math.cos(this.tilt) + 0) / t;
    const dW = this.halfW / (t * aspect);
    // portrait phones leave room for HUD at the top and bottom
    this.fitDist = Math.max(dH, dW) * CONFIG.camera.fitPadding * (aspect < 0.8 ? 1.06 : 1);
    this.targetDist = this.clampDist(this.targetDist);
  }

  get minDist() { return this.fitDist * CONFIG.camera.minZoomFrac; }
  get maxDist() { return this.fitDist * CONFIG.camera.maxZoomFrac; }
  /** 0 = fully zoomed out (fit), 1 = closest */
  get zoomLevel() { return 1 - (this.dist - this.minDist) / Math.max(1e-6, this.fitDist - this.minDist); }
  get fitDistance() { return this.fitDist; }

  private clampDist(d: number) { return Math.min(this.maxDist, Math.max(this.minDist, d)); }

  private clampTarget() {
    // allow less panning when zoomed out
    const z = Math.max(0, Math.min(1, (this.fitDist - this.dist) / this.fitDist + 0.25));
    const hw = this.halfW * z, hh = this.halfH * z;
    this.target.x = Math.max(-hw, Math.min(hw, this.target.x));
    this.target.y = Math.max(-hh, Math.min(hh, this.target.y));
  }

  private apply() {
    const s = Math.sin(this.tilt), c = Math.cos(this.tilt);
    this.camera.position.set(this.target.x, this.target.y - this.dist * s, this.target.z + this.dist * c).add(this.shakeOffset);
    this.tmp.copy(this.target).add(this.shakeOffset);
    this.camera.lookAt(this.tmp);
    this.camera.updateMatrixWorld();
  }

  /** Intersects the ray through a screen point with the plane z = groundZ. */
  screenToGround(sx: number, sy: number, out: THREE.Vector3, z = this.groundZ): boolean {
    this.ndc.set((sx / this.viewW) * 2 - 1, -(sy / this.viewH) * 2 + 1);
    this.ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
    this.ray.direction.set(this.ndc.x, this.ndc.y, 0.5).unproject(this.camera).sub(this.ray.origin).normalize();
    const dz = this.ray.direction.z;
    if (Math.abs(dz) < 1e-6) return false;
    const t = (z - this.ray.origin.z) / dz;
    if (t < 0) return false;
    out.copy(this.ray.direction).multiplyScalar(t).add(this.ray.origin);
    return true;
  }

  worldToScreen(v: THREE.Vector3, out: { x: number; y: number; z: number }) {
    this.tmp2.copy(v).project(this.camera);
    out.x = (this.tmp2.x * 0.5 + 0.5) * this.viewW;
    out.y = (-this.tmp2.y * 0.5 + 0.5) * this.viewH;
    out.z = this.tmp2.z;
  }

  /** screen pixels per world unit at the target (approx.) */
  pixelsPerUnit(): number {
    const t = Math.tan(((CONFIG.camera.fov / 2) * Math.PI) / 180);
    return this.viewH / (2 * this.dist * t);
  }

  // ------------------------------------------------------------- pan
  beginPan(sx: number, sy: number) {
    this.fly = null;
    this.panning = true;
    this.velocity.set(0, 0);
    this.screenToGround(sx, sy, this.panAnchor);
    this.lastPanTime = performance.now();
  }

  movePan(sx: number, sy: number) {
    if (!this.panning) return;
    if (!this.screenToGround(sx, sy, this.tmp)) return;
    const dx = this.panAnchor.x - this.tmp.x, dy = this.panAnchor.y - this.tmp.y;
    this.target.x += dx;
    this.target.y += dy;
    this.clampTarget();
    const now = performance.now();
    const dt = Math.max(1, now - this.lastPanTime) / 1000;
    this.lastPanTime = now;
    this.velocity.x = this.velocity.x * 0.6 + (dx / dt) * 0.4;
    this.velocity.y = this.velocity.y * 0.6 + (dy / dt) * 0.4;
    this.apply();
    this.changed = true;
  }

  endPan() {
    if (!this.panning) return;
    this.panning = false;
    if (performance.now() - this.lastPanTime > 80) this.velocity.set(0, 0);
  }

  get isPanning() { return this.panning; }

  // ------------------------------------------------------------- zoom
  zoomAt(sx: number, sy: number, factor: number) {
    this.fly = null;
    this.targetDist = this.clampDist(this.targetDist * factor);
    this.zoomScreen = [sx, sy];
    this.screenToGround(sx, sy, this.zoomWorld);
  }

  /** Immediate zoom (pinch) keeping a screen point fixed. */
  pinchTo(sx: number, sy: number, dist: number) {
    this.fly = null;
    this.screenToGround(sx, sy, this.zoomWorld);
    this.dist = this.targetDist = this.clampDist(dist);
    this.apply();
    if (this.screenToGround(sx, sy, this.tmp)) {
      this.target.x += this.zoomWorld.x - this.tmp.x;
      this.target.y += this.zoomWorld.y - this.tmp.y;
      this.clampTarget();
    }
    this.apply();
    this.changed = true;
  }

  flyTo(x: number, y: number, distFrac: number, duration = CONFIG.camera.flyDuration) {
    this.velocity.set(0, 0);
    this.zoomScreen = null;
    const d1 = this.clampDist(this.fitDist * distFrac);
    this.fly = { from: this.target.clone(), to: new THREE.Vector3(x, y, 0), d0: this.dist, d1, t: 0, dur: Math.max(0.01, duration) };
  }

  resetView(duration = CONFIG.camera.flyDuration) { this.flyTo(0, 0, 1, duration); }

  shake(amount: number) { this.shakeAmt = Math.min(1.5, this.shakeAmt + amount); }

  update(dt: number) {
    let moved = false;
    if (this.fly) {
      const f = this.fly;
      f.t += dt;
      const k = easeInOut(Math.min(1, f.t / f.dur));
      this.target.lerpVectors(f.from, f.to, k);
      this.dist = this.targetDist = f.d0 + (f.d1 - f.d0) * k;
      if (f.t >= f.dur) this.fly = null;
      moved = true;
    } else if (this.attract) {
      this.attractT += dt * CONFIG.camera.attractDriftSpeed;
      const tx = Math.sin(this.attractT) * this.halfW * 0.35;
      const ty = Math.sin(this.attractT * 0.7 + 1) * this.halfH * 0.2;
      const td = this.fitDist * (0.62 + 0.08 * Math.sin(this.attractT * 0.5));
      const k = 1 - Math.exp(-dt * 0.8);
      this.target.x += (tx - this.target.x) * k;
      this.target.y += (ty - this.target.y) * k;
      this.dist += (td - this.dist) * k;
      this.targetDist = this.dist;
      moved = true;
    } else {
      if (Math.abs(this.targetDist - this.dist) > this.dist * 1e-4) {
        const k = 1 - Math.exp(-dt * CONFIG.camera.damping);
        this.dist += (this.targetDist - this.dist) * k;
        this.apply();
        if (this.zoomScreen && this.screenToGround(this.zoomScreen[0], this.zoomScreen[1], this.tmp)) {
          this.target.x += this.zoomWorld.x - this.tmp.x;
          this.target.y += this.zoomWorld.y - this.tmp.y;
        }
        this.clampTarget();
        moved = true;
      } else this.zoomScreen = null;
      if (!this.panning && this.velocity.lengthSq() > 1e-6) {
        this.target.x += this.velocity.x * dt;
        this.target.y += this.velocity.y * dt;
        const k = Math.exp(-dt * CONFIG.camera.inertiaDamping);
        this.velocity.multiplyScalar(k);
        if (this.velocity.lengthSq() < (this.unit * 0.02) ** 2) this.velocity.set(0, 0);
        this.clampTarget();
        moved = true;
      }
    }
    if (this.shakeAmt > 0.001) {
      const a = this.shakeAmt * this.unit * 0.6;
      this.shakeOffset.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, 0);
      this.shakeAmt *= Math.exp(-dt * CONFIG.camera.shakeDecay);
      moved = true;
    } else if (this.shakeOffset.lengthSq() > 0) {
      this.shakeOffset.set(0, 0, 0);
      moved = true;
    }
    if (moved) {
      this.apply();
      this.changed = true;
    }
  }
}
