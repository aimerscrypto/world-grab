import * as THREE from 'three';
import { arrowVert, arrowFrag } from './shaders';

const SEG = 28;

interface Arrow {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  mat: THREE.ShaderMaterial;
  pos: Float32Array;
}

/** Glowing curved drag arrows (one per selected source country). */
export class ArrowSystem {
  readonly group = new THREE.Group();
  private arrows: Arrow[] = [];
  private used = 0;
  private uTime = { value: 0 };

  private make(): Arrow {
    const verts = (SEG + 1) * 2 + 3;
    const pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const idx: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const h = (SEG + 1) * 2;
    idx.push(h, h + 2, h + 1);
    for (let i = 0; i <= SEG; i++) {
      const u = (i / SEG) * 0.86;
      uv[i * 4] = u; uv[i * 4 + 1] = -1;
      uv[i * 4 + 2] = u; uv[i * 4 + 3] = 1;
    }
    uv[h * 2] = 0.86; uv[h * 2 + 1] = -1;
    uv[h * 2 + 2] = 0.86; uv[h * 2 + 3] = 1;
    uv[h * 2 + 4] = 1; uv[h * 2 + 5] = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aUV', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: arrowVert,
      fragmentShader: arrowFrag,
      uniforms: { uColor: { value: new THREE.Color() }, uTime: this.uTime, uLen: { value: 4 }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.visible = false;
    this.group.add(mesh);
    const a = { mesh, geo, mat, pos };
    this.arrows.push(a);
    return a;
  }

  begin(time: number) {
    this.used = 0;
    this.uTime.value = time;
  }

  /** Draw one arrow from (ax,ay,az) to (bx,by,bz). */
  draw(ax: number, ay: number, az: number, bx: number, by: number, bz: number, unit: number, hex: number, opacity = 1) {
    const a = this.arrows[this.used] ?? this.make();
    this.used++;
    a.mesh.visible = true;
    (a.mat.uniforms.uColor.value as THREE.Color).setHex(hex);
    a.mat.uniforms.uOpacity.value = opacity;
    const dx = bx - ax, dy = by - ay;
    const len = Math.max(1e-3, Math.hypot(dx, dy));
    a.mat.uniforms.uLen.value = len / (unit * 1.1);
    const px = -dy / len, py = dx / len;
    const bulge = len * 0.12;
    const cx = (ax + bx) / 2 + px * bulge, cy = (ay + by) / 2 + py * bulge;
    const lift = Math.min(len * 0.22, unit * 4);
    const cz = (az + bz) / 2 + lift;
    const headLen = Math.min(unit * 1.0, len * 0.4);
    const tEnd = Math.max(0.2, 1 - headLen / len);
    const w = unit * 0.3;
    const p = a.pos;
    let lx = 0, ly = 0, lz = 0;
    const point = (t: number) => {
      const it = 1 - t;
      lx = it * it * ax + 2 * it * t * cx + t * t * bx;
      ly = it * it * ay + 2 * it * t * cy + t * t * by;
      lz = it * it * az + 2 * it * t * cz + t * t * bz;
    };
    let tx = 0, ty = 0;
    const tangent = (t: number) => {
      const it = 1 - t;
      tx = 2 * it * (cx - ax) + 2 * t * (bx - cx);
      ty = 2 * it * (cy - ay) + 2 * t * (by - cy);
      const l = Math.hypot(tx, ty) || 1;
      tx /= l; ty /= l;
    };
    for (let i = 0; i <= SEG; i++) {
      const t = (i / SEG) * tEnd;
      point(t);
      tangent(t);
      const ww = w * (0.55 + 0.45 * (i / SEG));
      const o = i * 6;
      p[o] = lx - ty * ww; p[o + 1] = ly + tx * ww; p[o + 2] = lz;
      p[o + 3] = lx + ty * ww; p[o + 4] = ly - tx * ww; p[o + 5] = lz;
    }
    const h = (SEG + 1) * 6;
    point(tEnd);
    tangent(tEnd);
    const hw = unit * 0.78;
    p[h] = lx - ty * hw; p[h + 1] = ly + tx * hw; p[h + 2] = lz;
    p[h + 3] = lx + ty * hw; p[h + 4] = ly - tx * hw; p[h + 5] = lz;
    point(1);
    p[h + 6] = lx; p[h + 7] = ly; p[h + 8] = lz;
    a.geo.getAttribute('position').needsUpdate = true;
  }

  end() {
    for (let i = this.used; i < this.arrows.length; i++) this.arrows[i].mesh.visible = false;
  }

  dispose() {
    for (const a of this.arrows) { a.geo.dispose(); a.mat.dispose(); }
    this.arrows = [];
    this.group.removeFromParent();
  }
}
