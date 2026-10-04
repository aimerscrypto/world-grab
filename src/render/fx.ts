import * as THREE from 'three';
import { CONFIG } from '../config';
import { sparkVert, sparkFrag, ringVert, ringFrag } from './shaders';

/** Pooled spark particles + shockwave rings. */
export class FxSystem {
  readonly group = new THREE.Group();
  private max = CONFIG.fx.maxSparks;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private life: Float32Array;
  private decay: Float32Array;
  private size: Float32Array;
  private sparkGeo: THREE.BufferGeometry;
  private sparkMat: THREE.ShaderMaterial;
  private cursor = 0;
  private alive = 0;

  private rings: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; t: number; dur: number; active: boolean }[] = [];
  private ringGeo = new THREE.PlaneGeometry(2, 2);
  private tmpColor = new THREE.Color();

  constructor() {
    const m = this.max;
    this.pos = new Float32Array(m * 3);
    this.vel = new Float32Array(m * 3);
    this.col = new Float32Array(m * 3);
    this.life = new Float32Array(m);
    this.decay = new Float32Array(m);
    this.size = new Float32Array(m);
    this.sparkGeo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    const ca = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    const la = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    const sa = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.sparkGeo.setAttribute('position', pa);
    this.sparkGeo.setAttribute('aColor', ca);
    this.sparkGeo.setAttribute('aLife', la);
    this.sparkGeo.setAttribute('aSize', sa);
    this.sparkMat = new THREE.ShaderMaterial({
      vertexShader: sparkVert,
      fragmentShader: sparkFrag,
      uniforms: { uPx: { value: 300 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(this.sparkGeo, this.sparkMat);
    pts.frustumCulled = false;
    pts.renderOrder = 8;
    this.group.add(pts);

    for (let i = 0; i < 10; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: ringVert,
        fragmentShader: ringFrag,
        uniforms: { uT: { value: 0 }, uColor: { value: new THREE.Color() } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t: 0, dur: 1, active: false });
    }
  }

  /** viewport height in px, for point size attenuation */
  setViewport(h: number, pixelRatio: number, fov: number) {
    this.sparkMat.uniforms.uPx.value = (h * pixelRatio) / (2 * Math.tan((fov * Math.PI) / 360));
  }

  sparks(x: number, y: number, z: number, hex: number, count: number, unit: number, power = 1) {
    this.tmpColor.setHex(hex);
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.8 + Math.random() * 2.2) * unit * power;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(a) * sp;
      this.vel[i * 3 + 1] = Math.sin(a) * sp;
      this.vel[i * 3 + 2] = (1.5 + Math.random() * 2.5) * unit * power;
      const w = Math.random() < 0.35 ? 1 : 0;
      this.col[i * 3] = w ? 1 : this.tmpColor.r;
      this.col[i * 3 + 1] = w ? 0.85 : this.tmpColor.g;
      this.col[i * 3 + 2] = w ? 0.5 : this.tmpColor.b;
      this.life[i] = 1;
      this.decay[i] = 1.6 + Math.random() * 1.6;
      this.size[i] = unit * (0.25 + Math.random() * 0.35) * Math.sqrt(power);
    }
    this.alive = this.max;
  }

  shockwave(x: number, y: number, z: number, radius: number, hex: number, dur = CONFIG.fx.shockwaveSeconds) {
    const r = this.rings.find((q) => !q.active) ?? this.rings.reduce((a, b) => (a.t / a.dur > b.t / b.dur ? a : b));
    r.active = true;
    r.t = 0;
    r.dur = dur;
    r.mesh.visible = true;
    r.mesh.position.set(x, y, z);
    r.mesh.scale.setScalar(radius);
    (r.mat.uniforms.uColor.value as THREE.Color).setHex(hex);
    r.mat.uniforms.uT.value = 0;
  }

  update(dt: number, unit: number) {
    if (this.alive > 0) {
      let any = 0;
      const g = -9 * unit;
      for (let i = 0; i < this.max; i++) {
        if (this.life[i] <= 0) continue;
        any++;
        this.life[i] = Math.max(0, this.life[i] - dt * this.decay[i]);
        this.vel[i * 3 + 2] += g * dt;
        this.pos[i * 3] += this.vel[i * 3] * dt;
        this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
        this.pos[i * 3 + 2] = Math.max(0.05, this.pos[i * 3 + 2] + this.vel[i * 3 + 2] * dt);
      }
      this.alive = any;
      for (const name of ['position', 'aLife', 'aColor', 'aSize']) this.sparkGeo.getAttribute(name).needsUpdate = true;
    }
    for (const r of this.rings) {
      if (!r.active) continue;
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) { r.active = false; r.mesh.visible = false; continue; }
      r.mat.uniforms.uT.value = 1 - Math.pow(1 - k, 2.2);
    }
  }

  clear() {
    this.life.fill(0);
    this.alive = 1;
    for (const r of this.rings) { r.active = false; r.mesh.visible = false; }
  }

  dispose() {
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.ringGeo.dispose();
    for (const r of this.rings) r.mat.dispose();
    this.group.removeFromParent();
  }
}
