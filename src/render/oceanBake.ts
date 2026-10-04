import * as THREE from 'three';
import type { RegionMap } from '../map/types';

/**
 * Bakes the static parts of the ocean look into one RGBA texture:
 *   R = soft drop shadow of the slabs (offset away from the key light)
 *   G = shallow-water halo around coasts
 *   B = latitude / longitude graticule
 *   A = narrow foam band hugging the coast
 * Blurs use the canvas shadowBlur trick (works in every browser, incl. Safari).
 */
export function bakeOceanTexture(map: RegionMap, maxW: number): { texture: THREE.DataTexture; rect: [number, number, number, number] } {
  const mx = map.width * 0.14, my = map.height * 0.14;
  const x0 = -map.width / 2 - mx, y0 = -map.height / 2 - my;
  const tw = map.width + 2 * mx, th = map.height + 2 * my;
  let cw = maxW;
  let ch = Math.round((cw * th) / tw);
  if (ch > 2048) { ch = 2048; cw = Math.round((ch * tw) / th); }
  const s = cw / tw; // px per unit
  const u = map.unit;

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const OFF = cw * 3;

  const landPath = () => {
    ctx.beginPath();
    for (const c of map.countries) {
      for (const p of c.polygons) {
        for (const ring of [p.outer, ...p.holes]) {
          for (let i = 0; i < ring.length; i += 2) {
            const x = (ring[i] - x0) * s - OFF, y = (ring[i + 1] - y0) * s;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
      }
    }
  };

  const blurred = (blurPx: number, dx: number, dy: number, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = Math.max(0.5, blurPx);
    ctx.shadowOffsetX = OFF + dx;
    ctx.shadowOffsetY = dy;
    ctx.fillStyle = '#fff';
    landPath();
    ctx.fill('evenodd');
    ctx.restore();
  };

  const channel = (draw: () => void): Uint8ClampedArray => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'lighter';
    draw();
    return ctx.getImageData(0, 0, cw, ch).data;
  };

  // shadow: key light from the north-west, so shadows fall south-east
  const shadow = channel(() => {
    blurred(0.9 * u * s, 0.55 * u * s, -0.65 * u * s, 0.75);
    blurred(0.22 * u * s, 0.14 * u * s, -0.18 * u * s, 0.5);
  });
  const shallow = channel(() => {
    blurred(3.2 * u * s, 0, 0, 0.75);
    blurred(1.2 * u * s, 0, 0, 0.55);
  });
  const grid = channel(() => {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, cw / 1400);
    ctx.globalAlpha = 0.9;
    for (const line of map.graticule) {
      ctx.beginPath();
      for (let i = 0; i < line.length; i += 2) {
        const x = (line[i] - x0) * s, y = (line[i + 1] - y0) * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
  const foam = channel(() => {
    blurred(0.28 * u * s, 0, 0, 0.9);
  });

  const data = new Uint8Array(cw * ch * 4);
  for (let i = 0, n = cw * ch; i < n; i++) {
    data[i * 4] = shadow[i * 4];
    data[i * 4 + 1] = shallow[i * 4];
    data[i * 4 + 2] = grid[i * 4];
    data[i * 4 + 3] = foam[i * 4];
  }
  canvas.width = canvas.height = 1; // release canvas memory
  const texture = new THREE.DataTexture(data, cw, ch, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, rect: [x0, y0, tw, th] };
}
