import * as THREE from 'three';
import type { CameraRig } from './render/cameraRig';

export interface InputHandlers {
  /** country under a screen point (or -1) */
  pickAt(sx: number, sy: number): number;
  /** may a drag-to-send start on this country? */
  canDragFrom(country: number): boolean;
  dragStart(country: number, sx: number, sy: number): void;
  dragMove(sx: number, sy: number, country: number): void;
  dragEnd(sx: number, sy: number, country: number): void;
  dragCancel(): void;
  tap(country: number, sx: number, sy: number): void;
  hover(country: number): void;
  /** any interaction (used to dismiss popups) */
  anyDown?(): void;
}

interface Ptr { id: number; x: number; y: number; sx: number; sy: number; t: number; type: string }

const TAP_PX = 9;

/**
 * Unified mouse + touch input: drag from your country to send troops,
 * drag elsewhere to pan, wheel / pinch to zoom, tap for info.
 */
export class InputController {
  private ptrs = new Map<number, Ptr>();
  private mode: 'none' | 'pan' | 'drag' | 'pinch' = 'none';
  private pinchStartDist = 1;
  private pinchStartCam = 1;
  private moved = false;
  private dragCountry = -1;
  enabled = true;
  /** when false, pan/zoom are disabled too (e.g. menus) */
  cameraEnabled = true;
  private tmp = new THREE.Vector3();

  constructor(private el: HTMLElement, private rig: CameraRig, private h: InputHandlers) {
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerleave', () => { if (this.ptrs.size === 0) this.h.hover(-1); });
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.h.anyDown?.();
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    this.el.setPointerCapture?.(e.pointerId);
    const p: Ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), type: e.pointerType };
    this.ptrs.set(e.pointerId, p);
    if (this.ptrs.size === 2) {
      // switch to pinch: cancel whatever the first finger was doing
      if (this.mode === 'drag') this.h.dragCancel();
      if (this.mode === 'pan') this.rig.endPan();
      this.startPinch();
      return;
    }
    if (this.ptrs.size > 2) return;
    this.moved = false;
    const c = this.h.pickAt(e.clientX, e.clientY);
    if (e.button === 0 && c >= 0 && this.h.canDragFrom(c)) {
      this.mode = 'drag';
      this.dragCountry = c;
      this.h.dragStart(c, e.clientX, e.clientY);
    } else if (this.cameraEnabled) {
      this.mode = 'pan';
      this.rig.beginPan(e.clientX, e.clientY);
    } else this.mode = 'none';
  };

  private startPinch() {
    const [a, b] = [...this.ptrs.values()];
    this.mode = this.cameraEnabled ? 'pinch' : 'none';
    this.pinchStartDist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    this.pinchStartCam = this.rig.dist;
    this.moved = true;
    if (this.mode === 'pinch') this.rig.beginPan((a.x + b.x) / 2, (a.y + b.y) / 2);
  }

  private onMove = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      // mouse hover
      if (e.pointerType === 'mouse' && this.enabled && e.target === this.el) this.h.hover(this.h.pickAt(e.clientX, e.clientY));
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > TAP_PX) this.moved = true;
    if (this.mode === 'pinch' && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.rig.pinchTo(mx, my, this.pinchStartCam * (this.pinchStartDist / d));
      this.rig.movePan(mx, my);
    } else if (this.mode === 'pan') {
      this.rig.movePan(e.clientX, e.clientY);
    } else if (this.mode === 'drag') {
      this.h.dragMove(e.clientX, e.clientY, this.h.pickAt(e.clientX, e.clientY));
    }
  };

  private onUp = (e: PointerEvent) => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    if (this.mode === 'pinch') {
      if (this.ptrs.size === 0) { this.rig.endPan(); this.mode = 'none'; }
      else if (this.ptrs.size === 1) {
        // continue as a pan with the remaining finger
        const rest = [...this.ptrs.values()][0];
        this.rig.endPan();
        this.rig.beginPan(rest.x, rest.y);
        this.mode = 'pan';
      }
      return;
    }
    if (this.ptrs.size > 0) return;
    const isTap = !this.moved && performance.now() - p.t < 450;
    const c = this.h.pickAt(e.clientX, e.clientY);
    if (this.mode === 'drag') {
      if (isTap) { this.h.dragCancel(); this.h.tap(this.dragCountry, e.clientX, e.clientY); }
      else this.h.dragEnd(e.clientX, e.clientY, c);
    } else if (this.mode === 'pan') {
      this.rig.endPan();
      if (isTap) this.h.tap(c, e.clientX, e.clientY);
    } else if (isTap) this.h.tap(c, e.clientX, e.clientY);
    this.mode = 'none';
    this.dragCountry = -1;
  };

  private onCancel = (e: PointerEvent) => {
    this.ptrs.delete(e.pointerId);
    if (this.mode === 'drag') this.h.dragCancel();
    if (this.mode === 'pan' || this.mode === 'pinch') this.rig.endPan();
    if (this.ptrs.size === 0) this.mode = 'none';
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.enabled || !this.cameraEnabled) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    this.rig.zoomAt(e.clientX, e.clientY, Math.exp(Math.max(-200, Math.min(200, dy)) * 0.0015));
  };

  /** Cancels any in-progress gesture (e.g. when a menu opens). */
  reset() {
    if (this.mode === 'drag') this.h.dragCancel();
    if (this.mode === 'pan' || this.mode === 'pinch') this.rig.endPan();
    this.ptrs.clear();
    this.mode = 'none';
  }

  get dragging() { return this.mode === 'drag'; }

  groundAt(sx: number, sy: number, z: number): THREE.Vector3 | null {
    return this.rig.screenToGround(sx, sy, this.tmp, z) ? this.tmp : null;
  }
}
