import * as THREE from 'three';
import { CONFIG } from '../config';
import type { RegionMap, Poly } from '../map/types';
import { signedArea } from '../map/geom';
import {
  countryVert, countryFrag, outlineVert, outlineFrag, ribbonVert, ribbonFrag,
  oceanVert, oceanFrag, seaRouteVert, seaRouteFrag,
} from './shaders';
import { bakeOceanTexture } from './oceanBake';

const ROWS = 5;
const tmpColor = new THREE.Color();

/** Animated per-country render state, uploaded to a float texture each frame. */
interface Anim {
  heightTarget: number;
  height: number;
  glowTarget: number;
  glow: number;
  hoverTarget: number;
  hover: number;
  wipe: number; // 0..1, 1 = done
  bounceT: number; // seconds since bounce start, <0 = idle
  bounceAmp: number;
  flash: number;
  shake: number;
  selected: number;
  target: number;
}

/**
 * The 3D diorama for one region: extruded countries (one merged mesh), borders,
 * owner glow ribbons, sea routes and the ocean. Owns all GPU resources and
 * releases them in dispose().
 */
export class Board {
  readonly group = new THREE.Group();
  readonly map: RegionMap;
  readonly unit: number;
  readonly slabH: number;
  readonly ownedH: number;
  readonly tokenH: number;
  /** current top surface height for each country (for badges / units) */
  readonly topZ: Float32Array;

  private stateData: Float32Array;
  private stateTex: THREE.DataTexture;
  private anims: Anim[];
  private materials: THREE.ShaderMaterial[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private textures: THREE.Texture[] = [];
  private uniformsTime: { value: number }[] = [];
  private oceanUniforms: Record<string, THREE.IUniform>;

  constructor(map: RegionMap, lowQuality: boolean) {
    this.map = map;
    const u = (this.unit = map.unit);
    this.slabH = CONFIG.slab.height * u;
    this.ownedH = CONFIG.slab.ownedExtra * u;
    this.tokenH = 0.2 * u;
    const n = map.countries.length;
    this.topZ = new Float32Array(n);

    // ---------------- state texture ----------------
    this.stateData = new Float32Array(n * ROWS * 4);
    this.stateTex = new THREE.DataTexture(this.stateData, n, ROWS, THREE.RGBAFormat, THREE.FloatType);
    this.stateTex.minFilter = THREE.NearestFilter;
    this.stateTex.magFilter = THREE.NearestFilter;
    this.stateTex.needsUpdate = true;
    this.textures.push(this.stateTex);
    this.anims = map.countries.map(() => ({
      heightTarget: 0, height: 0, glowTarget: 0, glow: 0, hoverTarget: 0, hover: 0,
      wipe: 1, bounceT: -1, bounceAmp: 0, flash: 0, shake: 0, selected: 0, target: 0,
    }));
    const neutral = new THREE.Color(CONFIG.colors.neutral);
    const bg = new THREE.Color(CONFIG.colors.background);
    map.countries.forEach((c, i) => {
      const col = c.playable ? neutral : bg;
      this.writeRow(i, 0, col.r, col.g, col.b, 0);
      this.writeRow(i, 1, col.r, col.g, col.b, 1);
      this.writeRow(i, 2, c.anchor[0], c.anchor[1], c.radius, c.playable ? 1 : 0);
      this.topZ[i] = c.playable ? this.slabH + (c.tiny ? this.tokenH : 0) : CONFIG.slab.backgroundHeight * u;
    });

    const common = {
      uState: { value: this.stateTex },
      uStateSize: { value: new THREE.Vector2(n, ROWS) },
      uTime: { value: 0 },
      uUnit: { value: u },
    };
    this.uniformsTime.push(common.uTime);

    // ---------------- countries ----------------
    const countryGeo = this.buildCountryGeometry();
    const countryMat = new THREE.ShaderMaterial({
      vertexShader: countryVert,
      fragmentShader: countryFrag,
      uniforms: {
        ...common,
        uTopZ: { value: 0.08 * u },
        uSlabH: { value: this.slabH },
        uKeyDir: { value: new THREE.Vector3(-0.45, 0.55, 0.75).normalize() },
        uKeyCol: { value: new THREE.Color(0xfff1d6).multiplyScalar(0.62) },
        uFillDir: { value: new THREE.Vector3(0.6, -0.4, 0.5).normalize() },
        uFillCol: { value: new THREE.Color(0x9cc8ff).multiplyScalar(0.22) },
        uAmb: { value: new THREE.Color(0xc9d6ea).multiplyScalar(0.36) },
        uInvalid: { value: new THREE.Color(CONFIG.colors.invalid) },
      },
    });
    this.addMesh(new THREE.Mesh(countryGeo, countryMat), countryMat, countryGeo, 2);

    // ---------------- outlines ----------------
    const outlineGeo = this.buildOutlineGeometry();
    const outlineMat = new THREE.ShaderMaterial({
      vertexShader: outlineVert,
      fragmentShader: outlineFrag,
      uniforms: { ...common, uNeutral: { value: new THREE.Color(CONFIG.colors.outlineNeutral) } },
      transparent: true,
      depthWrite: false,
    });
    this.addMesh(new THREE.LineSegments(outlineGeo, outlineMat), outlineMat, outlineGeo, 4);

    // ---------------- glow ribbons ----------------
    const ribbonGeo = this.buildRibbonGeometry();
    const ribbonMat = new THREE.ShaderMaterial({
      vertexShader: ribbonVert,
      fragmentShader: ribbonFrag,
      uniforms: { ...common, uInvalid: { value: new THREE.Color(CONFIG.colors.invalid) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.addMesh(new THREE.Mesh(ribbonGeo, ribbonMat), ribbonMat, ribbonGeo, 3);

    // ---------------- ocean ----------------
    const bake = bakeOceanTexture(map, lowQuality ? 1024 : 2048);
    this.textures.push(bake.texture);
    const oceanGeo = new THREE.PlaneGeometry(map.width * 9, map.width * 9);
    this.oceanUniforms = {
      uTex: { value: bake.texture },
      uRect: { value: new THREE.Vector4(...bake.rect) },
      uHalf: { value: new THREE.Vector2(map.width / 2, map.height / 2) },
      uTime: { value: 0 },
      uUnit: { value: u },
      uDeep: { value: new THREE.Color(CONFIG.colors.oceanDeep) },
      uMid: { value: new THREE.Color(CONFIG.colors.oceanMid) },
      uShallow: { value: new THREE.Color(CONFIG.colors.oceanShallow) },
      uGrid: { value: new THREE.Color(CONFIG.colors.grid) },
    };
    this.uniformsTime.push(this.oceanUniforms.uTime as { value: number });
    const oceanMat = new THREE.ShaderMaterial({ vertexShader: oceanVert, fragmentShader: oceanFrag, uniforms: this.oceanUniforms });
    this.addMesh(new THREE.Mesh(oceanGeo, oceanMat), oceanMat, oceanGeo, 0);

    // ---------------- sea routes ----------------
    if (map.seaRoutes.length) {
      const routeGeo = this.buildSeaRouteGeometry();
      const routeMat = new THREE.ShaderMaterial({
        vertexShader: seaRouteVert,
        fragmentShader: seaRouteFrag,
        uniforms: {
          uTime: { value: 0 },
          uSpacing: { value: 0.42 * u },
          uHalfW: { value: 0.09 * u },
          uColor: { value: new THREE.Color(0xd8f6ff) },
        },
        transparent: true,
        depthWrite: false,
      });
      this.uniformsTime.push(routeMat.uniforms.uTime as { value: number });
      this.addMesh(new THREE.Mesh(routeGeo, routeMat), routeMat, routeGeo, 1);
    }
  }

  private addMesh(obj: THREE.Object3D, mat: THREE.ShaderMaterial, geo: THREE.BufferGeometry, order: number) {
    obj.renderOrder = order;
    obj.frustumCulled = false;
    this.group.add(obj);
    this.materials.push(mat);
    this.geometries.push(geo);
  }

  private writeRow(i: number, row: number, a: number, b: number, c: number, d: number) {
    const o = (row * this.map.countries.length + i) * 4;
    this.stateData[o] = a;
    this.stateData[o + 1] = b;
    this.stateData[o + 2] = c;
    this.stateData[o + 3] = d;
  }

  // ------------------------------------------------------------------------
  // Geometry builders
  // ------------------------------------------------------------------------

  private tokenRing(c: { anchor: [number, number] }): number[] {
    const r = CONFIG.slab.tokenRadius * this.unit;
    const ring: number[] = [];
    const seg = 22;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      ring.push(c.anchor[0] + Math.cos(a) * r, c.anchor[1] + Math.sin(a) * r);
    }
    return ring;
  }

  private buildCountryGeometry(): THREE.BufferGeometry {
    const pos: number[] = [];
    const nor: number[] = [];
    const cid: number[] = [];
    const u = this.unit;
    const bs = CONFIG.slab.bevelSize * u;
    const bt = CONFIG.slab.bevelThickness * u;
    const minBevelArea = (bs * 9) ** 2;

    const extrude = (outer: number[], holes: number[][], h: number, bevel: boolean, ci: number) => {
      const shape = new THREE.Shape();
      for (let i = 0; i < outer.length; i += 2) {
        if (i === 0) shape.moveTo(outer[0], outer[1]);
        else shape.lineTo(outer[i], outer[i + 1]);
      }
      for (const hole of holes) {
        if (hole.length < 6) continue;
        const path = new THREE.Path();
        for (let i = 0; i < hole.length; i += 2) {
          if (i === 0) path.moveTo(hole[0], hole[1]);
          else path.lineTo(hole[i], hole[i + 1]);
        }
        shape.holes.push(path);
      }
      let geo: THREE.ExtrudeGeometry;
      try {
        geo = new THREE.ExtrudeGeometry(shape, bevel
          ? { depth: h - bt, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelOffset: -bs, bevelSegments: 1, steps: 1, curveSegments: 1 }
          : { depth: h, bevelEnabled: false, steps: 1, curveSegments: 1 });
      } catch {
        return;
      }
      const p = geo.attributes.position.array as Float32Array;
      const nn = geo.attributes.normal.array as Float32Array;
      for (let t = 0; t < p.length; t += 9) {
        // drop the bottom cap / bottom bevel: never visible
        if (p[t + 2] <= 1e-4 && p[t + 5] <= 1e-4 && p[t + 8] <= 1e-4) continue;
        for (let k = 0; k < 9; k++) {
          pos.push(k % 3 === 2 ? Math.max(0, p[t + k]) : p[t + k]);
          nor.push(nn[t + k]);
        }
        cid.push(ci, ci, ci);
      }
      geo.dispose();
    };

    this.map.countries.forEach((c, ci) => {
      const h = c.playable ? this.slabH : CONFIG.slab.backgroundHeight * u;
      for (const poly of c.polygons) {
        extrude(poly.outer, poly.holes, h, poly.area > minBevelArea, ci);
      }
      if (c.tiny) extrude(this.tokenRing(c), [], h + this.tokenH, true, ci);
    });

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aCountry', new THREE.Float32BufferAttribute(cid, 1));
    return g;
  }

  private ringsOf(poly: Poly): { ring: number[]; hole: boolean }[] {
    return [{ ring: poly.outer, hole: false }, ...poly.holes.map((r) => ({ ring: r, hole: true }))];
  }

  private buildOutlineGeometry(): THREE.BufferGeometry {
    const pos: number[] = [];
    const cid: number[] = [];
    const eps = 0.004 * this.unit;
    const pushRing = (r: number[], z: number, ci: number) => {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        pos.push(r[i * 2], r[i * 2 + 1], z, r[j * 2], r[j * 2 + 1], z);
        cid.push(ci, ci);
      }
    };
    this.map.countries.forEach((c, ci) => {
      const h = (c.playable ? this.slabH : CONFIG.slab.backgroundHeight * this.unit) + eps;
      for (const poly of c.polygons) for (const { ring } of this.ringsOf(poly)) pushRing(ring, h, ci);
      if (c.tiny) pushRing(this.tokenRing(c), h + this.tokenH, ci);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCountry', new THREE.Float32BufferAttribute(cid, 1));
    return g;
  }

  private buildRibbonGeometry(): THREE.BufferGeometry {
    const pos: number[] = [];
    const cid: number[] = [];
    const edge: number[] = [];
    const baseW = CONFIG.slab.edgeGlowWidth * this.unit;
    const eps = 0.01 * this.unit;

    const pushRing = (r: number[], hole: boolean, z: number, w: number, ci: number) => {
      const n = r.length / 2;
      if (n < 3) return;
      const sign = (signedArea(r) > 0 ? 1 : -1) * (hole ? -1 : 1);
      // inward unit normals per segment i -> i+1
      const nx = new Float64Array(n), ny = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const dx = r[j * 2] - r[i * 2], dy = r[j * 2 + 1] - r[i * 2 + 1];
        const l = Math.hypot(dx, dy) || 1;
        nx[i] = (-dy / l) * sign;
        ny[i] = (dx / l) * sign;
      }
      const ix = new Float64Array(n), iy = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const p = (i - 1 + n) % n;
        let mx = nx[p] + nx[i], my = ny[p] + ny[i];
        const ml = Math.hypot(mx, my);
        if (ml < 1e-6) { mx = nx[i]; my = ny[i]; } else { mx /= ml; my /= ml; }
        const dot = Math.max(0.4, mx * nx[i] + my * ny[i]);
        ix[i] = r[i * 2] + (mx * w) / dot;
        iy[i] = r[i * 2 + 1] + (my * w) / dot;
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1];
        pos.push(ax, ay, z, bx, by, z, ix[j], iy[j], z, ax, ay, z, ix[j], iy[j], z, ix[i], iy[i], z);
        edge.push(0, 0, 1, 0, 1, 1);
        cid.push(ci, ci, ci, ci, ci, ci);
      }
    };

    for (let ci = 0; ci < this.map.playableCount; ci++) {
      const c = this.map.countries[ci];
      for (const poly of c.polygons) {
        const w = Math.min(baseW, Math.sqrt(poly.area) * 0.16);
        for (const { ring, hole } of this.ringsOf(poly)) pushRing(ring, hole, this.slabH + eps, w, ci);
      }
      if (c.tiny) pushRing(this.tokenRing(c), false, this.slabH + this.tokenH + eps, CONFIG.slab.tokenRadius * this.unit * 0.45, ci);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCountry', new THREE.Float32BufferAttribute(cid, 1));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    return g;
  }

  private buildSeaRouteGeometry(): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const hw = 0.09 * this.unit;
    const z = 0.03 * this.unit;
    for (const r of this.map.seaRoutes) {
      const [ax, ay] = r.pa, [bx, by] = r.pb;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-4) continue;
      const nx = (-(by - ay) / len) * hw, ny = ((bx - ax) / len) * hw;
      pos.push(ax + nx, ay + ny, z, bx + nx, by + ny, z, bx - nx, by - ny, z, ax + nx, ay + ny, z, bx - nx, by - ny, z, ax - nx, ay - ny, z);
      uv.push(0, 1, len, 1, len, -1, 0, 1, len, -1, 0, -1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  }

  // ------------------------------------------------------------------------
  // State API (called by the game / input layers)
  // ------------------------------------------------------------------------

  /** Instantly set the colour of a country (no animation). */
  setColorInstant(i: number, hex: number) {
    tmpColor.setHex(hex);
    this.writeRow(i, 0, tmpColor.r, tmpColor.g, tmpColor.b, this.anims[i].height);
    this.writeRow(i, 1, tmpColor.r, tmpColor.g, tmpColor.b, 1);
    this.anims[i].wipe = 1;
  }

  /** Flood the new colour out from the country centre. */
  setColorAnimated(i: number, hex: number, bounce = true) {
    const o0 = i * 4;
    const o1 = (this.map.countries.length + i) * 4;
    const a = this.anims[i];
    // the previous colour is whatever is currently visible
    const done = a.wipe >= 1;
    if (done) {
      this.stateData[o1] = this.stateData[o0];
      this.stateData[o1 + 1] = this.stateData[o0 + 1];
      this.stateData[o1 + 2] = this.stateData[o0 + 2];
    }
    tmpColor.setHex(hex);
    this.stateData[o0] = tmpColor.r;
    this.stateData[o0 + 1] = tmpColor.g;
    this.stateData[o0 + 2] = tmpColor.b;
    a.wipe = 0;
    if (bounce) { a.bounceT = 0; a.bounceAmp = CONFIG.slab.captureBounce * this.unit; }
  }

  setOwned(i: number, owned: boolean) {
    this.anims[i].heightTarget = owned ? this.ownedH : 0;
    this.anims[i].glowTarget = owned ? 1 : 0;
  }

  setHover(i: number, v: number) { if (i >= 0) this.anims[i].hoverTarget = v; }
  setSelected(i: number, v: number) { if (i >= 0) this.anims[i].selected = v; }
  /** +1 valid target, -1 invalid, 0 none */
  setTarget(i: number, v: number) {
    if (i < 0) return;
    if (v < 0 && this.anims[i].target >= 0) this.anims[i].shake = 1;
    this.anims[i].target = v;
  }
  flash(i: number, amount = 1) { this.anims[i].flash = Math.max(this.anims[i].flash, amount); }

  clearInteraction() {
    for (const a of this.anims) { a.selected = 0; a.target = 0; a.hoverTarget = 0; }
  }

  /** Reset every playable country to neutral (for a new match on the same board). */
  resetAll() {
    for (let i = 0; i < this.map.playableCount; i++) {
      this.setColorInstant(i, CONFIG.colors.neutral);
      const a = this.anims[i];
      a.heightTarget = a.height = a.glowTarget = a.glow = 0;
      a.bounceT = -1; a.flash = 0; a.shake = 0; a.selected = 0; a.target = 0;
    }
  }

  // ------------------------------------------------------------------------

  update(dt: number, time: number) {
    for (const t of this.uniformsTime) t.value = time;
    const n = this.map.countries.length;
    const k = 1 - Math.exp(-dt * 8);
    const kHover = 1 - Math.exp(-dt * 14);
    const wipeRate = 1 / CONFIG.fx.captureWipeSeconds;
    const d = this.stateData;
    for (let i = 0; i < this.map.playableCount; i++) {
      const a = this.anims[i];
      a.height += (a.heightTarget - a.height) * k;
      a.glow += (a.glowTarget - a.glow) * k;
      a.hover += (a.hoverTarget - a.hover) * kHover;
      if (a.wipe < 1) a.wipe = Math.min(1, a.wipe + dt * wipeRate);
      let bounce = 0;
      if (a.bounceT >= 0) {
        a.bounceT += dt;
        const t = a.bounceT;
        bounce = a.bounceAmp * Math.exp(-t * 4.2) * Math.sin(t * 13) ;
        if (t > 1.6) a.bounceT = -1;
      }
      a.flash = Math.max(0, a.flash - dt * 3.5);
      a.shake = Math.max(0, a.shake - dt * 3);
      d[i * 4 + 3] = a.height;
      d[(n + i) * 4 + 3] = a.wipe;
      const o3 = (3 * n + i) * 4;
      d[o3] = a.hover; d[o3 + 1] = a.selected; d[o3 + 2] = a.target; d[o3 + 3] = a.glow;
      const o4 = (4 * n + i) * 4;
      d[o4] = a.flash; d[o4 + 1] = bounce; d[o4 + 2] = a.shake;
      const c = this.map.countries[i];
      this.topZ[i] = this.slabH + (c.tiny ? this.tokenH : 0) + a.height + bounce + a.hover * 0.12 * this.unit;
    }
    this.stateTex.needsUpdate = true;
  }

  /** Current visible colour of a country (linear rgb) — used by FX. */
  colorOf(i: number, out: THREE.Color): THREE.Color {
    return out.setRGB(this.stateData[i * 4], this.stateData[i * 4 + 1], this.stateData[i * 4 + 2]);
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
