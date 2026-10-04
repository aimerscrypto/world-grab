import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../game/game';
import type { Board } from './board';
import { unitVert, unitFrag, unitGlowVert, unitGlowFrag } from './shaders';

/**
 * Draws every travelling unit as a tiny glowing soldier (InstancedBufferGeometry)
 * plus an additive glow/trail quad. Positions are derived from the game's unit
 * pool each frame — nothing is allocated per frame.
 */
export class UnitRenderer {
  readonly group = new THREE.Group();
  private bodyGeo: THREE.InstancedBufferGeometry;
  private glowGeo: THREE.InstancedBufferGeometry;
  private bodyMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private iPos: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  private iScale: THREE.InstancedBufferAttribute;
  private factionRGB: Float32Array;
  private max: number;

  constructor(max: number, factionColors: number[]) {
    this.max = max;
    // soldier: body + head + little backpack, base at z = 0, facing +x
    const body = new THREE.CylinderGeometry(0.26, 0.34, 0.72, 7, 1);
    body.rotateX(Math.PI / 2);
    body.translate(0, 0, 0.36);
    const head = new THREE.SphereGeometry(0.25, 8, 6);
    head.translate(0.02, 0, 0.94);
    const pack = new THREE.BoxGeometry(0.2, 0.36, 0.34);
    pack.translate(-0.26, 0, 0.5);
    const merged = mergeGeometries([body.toNonIndexed(), head.toNonIndexed(), pack.toNonIndexed()])!;
    body.dispose(); head.dispose(); pack.dispose();

    this.bodyGeo = new THREE.InstancedBufferGeometry();
    this.bodyGeo.setAttribute('position', merged.getAttribute('position'));
    this.bodyGeo.setAttribute('normal', merged.getAttribute('normal'));
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.iScale = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    for (const a of [this.iPos, this.iColor, this.iScale]) a.setUsage(THREE.DynamicDrawUsage);
    this.bodyGeo.setAttribute('iPos', this.iPos);
    this.bodyGeo.setAttribute('iColor', this.iColor);
    this.bodyGeo.setAttribute('iScale', this.iScale);
    this.bodyGeo.instanceCount = 0;

    const quad = new THREE.PlaneGeometry(2, 2);
    this.glowGeo = new THREE.InstancedBufferGeometry();
    this.glowGeo.setIndex(quad.getIndex());
    this.glowGeo.setAttribute('position', quad.getAttribute('position'));
    this.glowGeo.setAttribute('iPos', this.iPos);
    this.glowGeo.setAttribute('iColor', this.iColor);
    this.glowGeo.setAttribute('iScale', this.iScale);
    this.glowGeo.instanceCount = 0;

    this.bodyMat = new THREE.ShaderMaterial({ vertexShader: unitVert, fragmentShader: unitFrag });
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: unitGlowVert,
      fragmentShader: unitGlowFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const body3 = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    const glow = new THREE.Mesh(this.glowGeo, this.glowMat);
    body3.frustumCulled = glow.frustumCulled = false;
    body3.renderOrder = 5;
    glow.renderOrder = 6;
    this.group.add(glow, body3);

    this.factionRGB = new Float32Array(factionColors.length * 3);
    const c = new THREE.Color();
    factionColors.forEach((hex, i) => {
      c.setHex(hex);
      this.factionRGB[i * 3] = c.r; this.factionRGB[i * 3 + 1] = c.g; this.factionRGB[i * 3 + 2] = c.b;
    });
  }

  update(game: Game, board: Board, time: number) {
    const map = game.map;
    const unit = map.unit;
    const scale = unit * 0.3;
    const pos = this.iPos.array as Float32Array;
    const col = this.iColor.array as Float32Array;
    const scl = this.iScale.array as Float32Array;
    let n = 0;
    for (let u = 0; u < game.uHigh && n < this.max; u++) {
      if (!game.uActive[u]) continue;
      const from = game.uFrom[u], to = game.uTo[u];
      const A = map.countries[from].anchor, B = map.countries[to].anchor;
      const t = game.uT[u];
      const dx = B[0] - A[0], dy = B[1] - A[1];
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      const side = from < to ? 1 : -1;
      const bulge = len * 0.16 * side;
      const cx = (A[0] + B[0]) / 2 + px * bulge, cy = (A[1] + B[1]) / 2 + py * bulge;
      const it = 1 - t;
      // quadratic bezier + derivative
      let x = it * it * A[0] + 2 * it * t * cx + t * t * B[0];
      let y = it * it * A[1] + 2 * it * t * cy + t * t * B[1];
      const tx = 2 * it * (cx - A[0]) + 2 * t * (B[0] - cx);
      const ty = 2 * it * (cy - A[1]) + 2 * t * (B[1] - cy);
      const tl = Math.hypot(tx, ty) || 1;
      // marching lanes (3 abreast), merging at both ends
      const lane = game.uLane[u] * unit * 0.22 * Math.min(1, Math.sin(Math.PI * t) * 3);
      x += (-ty / tl) * lane;
      y += (tx / tl) * lane;
      const ph = game.uPhase[u];
      const bob = Math.abs(Math.sin(time * 13 + ph)) * unit * 0.07;
      const z0 = board.topZ[from] * it + board.topZ[to] * t;
      const z = z0 + Math.sin(Math.PI * t) * Math.min(len * 0.06, unit * 1.2) + bob + unit * 0.02;
      const o = n * 4;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z; pos[o + 3] = Math.atan2(ty, tx);
      const f = game.uOwner[u];
      col[n * 3] = this.factionRGB[f * 3];
      col[n * 3 + 1] = this.factionRGB[f * 3 + 1];
      col[n * 3 + 2] = this.factionRGB[f * 3 + 2];
      // pop in at the start and shrink as they arrive
      scl[n] = scale * Math.min(1, t * 12) * (t > 0.94 ? Math.max(0.3, (1 - t) / 0.06) : 1);
      n++;
    }
    this.bodyGeo.instanceCount = n;
    this.glowGeo.instanceCount = n;
    if (n > 0) {
      this.iPos.clearUpdateRanges(); this.iPos.addUpdateRange(0, n * 4); this.iPos.needsUpdate = true;
      this.iColor.clearUpdateRanges(); this.iColor.addUpdateRange(0, n * 3); this.iColor.needsUpdate = true;
      this.iScale.clearUpdateRanges(); this.iScale.addUpdateRange(0, n); this.iScale.needsUpdate = true;
    }
  }

  clear() {
    this.bodyGeo.instanceCount = 0;
    this.glowGeo.instanceCount = 0;
  }

  dispose() {
    this.bodyGeo.dispose();
    this.glowGeo.dispose();
    this.bodyMat.dispose();
    this.glowMat.dispose();
    this.group.removeFromParent();
  }
}
