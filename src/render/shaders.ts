// GLSL sources. Written GLSL1-style; three.js adds the WebGL2 compatibility
// defines (texture2D -> texture, gl_FragColor -> pc_fragColor, ...).

/** Shared per-country state fetch. The state texture is N x 5 RGBA floats:
 *  row0 cur.rgb, extraHeight | row1 prev.rgb, wipe | row2 anchor.xy, radius, kind
 *  row3 hover, selected, target(+valid/-invalid), glow | row4 flash, bounce, shake, - */
const STATE_FETCH = /* glsl */ `
uniform sampler2D uState;
uniform vec2 uStateSize;
uniform float uTime;
uniform float uUnit;
uniform float uHoverLift;
attribute float aCountry;
vec4 st(float row) {
  return texture2D(uState, vec2((aCountry + 0.5) / uStateSize.x, (row + 0.5) / uStateSize.y));
}
float liftOf(vec4 s0, vec4 s3, vec4 s4) {
  return s0.a + s3.x * uHoverLift + s4.y;
}
vec2 shakeOf(vec4 s4) {
  return vec2(sin(uTime * 55.0), cos(uTime * 41.0)) * s4.z * 0.12 * uUnit;
}
`;

export const countryVert = /* glsl */ `
${STATE_FETCH}
uniform float uTopZ;
varying vec3 vNormal;
varying vec2 vMap;
varying float vZ;
varying vec3 vCur;
varying vec3 vPrev;
varying float vWipe;
varying vec4 vInfo;
varying vec4 vFx;
varying float vFlash;
void main() {
  vec4 s0 = st(0.0); vec4 s1 = st(1.0); vec4 s2 = st(2.0); vec4 s3 = st(3.0); vec4 s4 = st(4.0);
  vec3 p = position;
  float top = step(uTopZ, p.z);
  p.z += top * liftOf(s0, s3, s4);
  p.xy += shakeOf(s4);
  vCur = s0.rgb; vPrev = s1.rgb; vWipe = s1.a; vInfo = s2; vFx = s3; vFlash = s4.x;
  vNormal = normal;
  vMap = position.xy;
  vZ = position.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const countryFrag = /* glsl */ `
uniform vec3 uKeyDir;
uniform vec3 uKeyCol;
uniform vec3 uFillDir;
uniform vec3 uFillCol;
uniform vec3 uAmb;
uniform vec3 uInvalid;
uniform float uTime;
uniform float uSlabH;
uniform float uUnit;
varying vec3 vNormal;
varying vec2 vMap;
varying float vZ;
varying vec3 vCur;
varying vec3 vPrev;
varying float vWipe;
varying vec4 vInfo;
varying vec4 vFx;
varying float vFlash;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec3 n = normalize(vNormal);
  float isTop = smoothstep(0.55, 0.95, n.z);
  float d = length(vMap - vInfo.xy) / max(vInfo.z, 1e-3);
  float w = vWipe * 1.06;
  float inside = 1.0 - smoothstep(w - 0.05, w, d);
  vec3 base = mix(vPrev, vCur, inside);
  float front = (1.0 - smoothstep(0.0, 0.08, abs(d - w))) * (1.0 - step(0.999, vWipe));

  // soft radial gradient on the top face + fine grain
  float grain = vnoise(vMap * 3.0 / uUnit) * 0.5 + vnoise(vMap * 9.0 / uUnit) * 0.5;
  base *= mix(1.0, (1.09 - 0.17 * clamp(d, 0.0, 1.0)) * (0.965 + 0.07 * grain), isTop);

  float kd = max(dot(n, uKeyDir), 0.0);
  float fd = max(dot(n, uFillDir), 0.0);
  vec3 col = base * (uAmb + uKeyCol * kd + uFillCol * fd);

  // walls darken towards the water (fake ambient occlusion)
  float h01 = clamp(vZ / uSlabH, 0.0, 1.0);
  col *= mix(1.0, 0.42 + 0.58 * h01 * h01, 1.0 - isTop);
  // background land is subdued
  col = mix(col * 0.75, col, vInfo.w);

  float pulse = 0.75 + 0.25 * sin(uTime * 7.0);
  col += base * vFx.y * 0.38 * pulse;                       // selected source
  col += (base * 0.28 + vec3(0.05)) * max(vFx.z, 0.0) * isTop; // valid target
  col = mix(col, uInvalid, max(-vFx.z, 0.0) * 0.5);           // invalid target
  col += base * vFx.x * 0.12;                                // hover
  col += vec3(1.0, 0.85, 0.6) * vFlash * 0.45;               // hit flash
  col += vCur * front * 1.4;                                 // capture wavefront
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export const outlineVert = /* glsl */ `
${STATE_FETCH}
uniform vec3 uNeutral;
varying vec3 vCol;
varying float vAlpha;
void main() {
  vec4 s0 = st(0.0); vec4 s2 = st(2.0); vec4 s3 = st(3.0); vec4 s4 = st(4.0);
  vec3 p = position;
  p.z += liftOf(s0, s3, s4);
  p.xy += shakeOf(s4);
  float glow = s3.w;
  vCol = mix(uNeutral, s0.rgb * 1.6 + vec3(0.15), glow);
  vCol = mix(vCol, vec3(1.0), s3.y * 0.6);
  vAlpha = mix(0.22, mix(0.55, 1.0, glow), s2.w);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const outlineFrag = /* glsl */ `
varying vec3 vCol;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vCol, vAlpha);
  #include <colorspace_fragment>
}
`;

export const ribbonVert = /* glsl */ `
${STATE_FETCH}
attribute float aEdge;
varying float vEdge;
varying vec3 vCol;
varying vec4 vFx;
void main() {
  vec4 s0 = st(0.0); vec4 s3 = st(3.0); vec4 s4 = st(4.0);
  vec3 p = position;
  p.z += liftOf(s0, s3, s4);
  p.xy += shakeOf(s4);
  vEdge = aEdge;
  vCol = s0.rgb;
  vFx = s3;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const ribbonFrag = /* glsl */ `
uniform float uTime;
uniform vec3 uInvalid;
varying float vEdge;
varying vec3 vCol;
varying vec4 vFx;
void main() {
  float e = 1.0 - vEdge;
  float glow = vFx.w;
  float a = pow(e, 2.4) * glow * 0.85;
  vec3 col = vCol * 1.25 + vec3(0.12);
  float sel = vFx.y * (0.65 + 0.35 * sin(uTime * 8.0));
  a += pow(e, 1.6) * sel;
  col = mix(col, vec3(1.0), clamp(vFx.y, 0.0, 1.0) * 0.55);
  float tv = max(vFx.z, 0.0);
  a += pow(e, 1.8) * tv * (0.7 + 0.3 * sin(uTime * 10.0));
  col = mix(col, vec3(1.0, 0.98, 0.9), tv * 0.6);
  float ti = max(-vFx.z, 0.0);
  a += pow(e, 1.8) * ti * 0.8;
  col = mix(col, uInvalid * 1.4, ti);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

export const oceanVert = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xy;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const oceanFrag = /* glsl */ `
uniform sampler2D uTex;
uniform vec4 uRect;
uniform vec2 uHalf;
uniform float uTime;
uniform float uUnit;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uGrid;
varying vec2 vWorld;

float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 3; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 3.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

void main() {
  vec2 uv = (vWorld - uRect.xy) / uRect.zw;
  vec4 t = vec4(0.0);
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) t = texture2D(uTex, uv);
  float shadow = t.r;
  float shallow = t.g;
  float grid = t.b;
  float foam = t.a;
  vec2 q = vWorld / uHalf;
  float edge = length(q * vec2(0.85, 1.0));
  vec3 col = mix(uMid, uDeep, smoothstep(0.5, 1.6, edge));
  col = mix(col, uShallow, shallow * 0.62);
  float c = caustic(vWorld / (uUnit * 2.6) - 250.0, uTime * 0.32);
  col += mix(uShallow, vec3(0.8, 1.0, 1.0), 0.35) * c * (0.035 + 0.2 * shallow);
  col += uGrid * grid * 0.13 * (1.0 - smoothstep(0.9, 1.6, edge));
  float fo = foam * (0.6 + 0.4 * sin(uTime * 1.5 + shallow * 16.0));
  col += vec3(0.7, 0.95, 1.0) * fo * 0.2;
  col *= 1.0 - shadow * 0.62;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export const seaRouteVert = /* glsl */ `
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const seaRouteFrag = /* glsl */ `
uniform float uTime;
uniform float uSpacing;
uniform float uHalfW;
uniform vec3 uColor;
varying vec2 vUV;
void main() {
  float f = fract(vUV.x / uSpacing - uTime * 0.6);
  vec2 lp = vec2((f - 0.5) * uSpacing, vUV.y * uHalfW);
  float d = length(lp);
  float a = 1.0 - smoothstep(uHalfW * 0.55, uHalfW, d);
  gl_FragColor = vec4(uColor, a * 0.6);
  #include <colorspace_fragment>
}
`;

/** Instanced soldier body. iPos = (x, y, z, heading), iColor rgb, iScale. */
export const unitVert = /* glsl */ `
attribute vec4 iPos;
attribute vec3 iColor;
attribute float iScale;
varying vec3 vColor;
varying vec3 vN;
void main() {
  float c = cos(iPos.w), s = sin(iPos.w);
  vec3 p = position * iScale;
  p.xy = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  vec3 n = normal;
  n.xy = vec2(n.x * c - n.y * s, n.x * s + n.y * c);
  vN = n;
  vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(p + iPos.xyz, 1.0);
}
`;

export const unitFrag = /* glsl */ `
varying vec3 vColor;
varying vec3 vN;
void main() {
  vec3 n = normalize(vN);
  float l = 0.55 + 0.6 * max(dot(n, normalize(vec3(-0.4, 0.5, 0.8))), 0.0);
  vec3 col = vColor * l + vColor * 0.45 + vec3(0.06);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Instanced glow + trail quad drawn under each unit. */
export const unitGlowVert = /* glsl */ `
attribute vec4 iPos;
attribute vec3 iColor;
attribute float iScale;
varying vec2 vQ;
varying vec3 vColor;
void main() {
  float c = cos(iPos.w), s = sin(iPos.w);
  // local quad: x across (-1..1), y along (+1 ahead .. -1 tail)
  vQ = position.xy;
  vec2 lp = vec2(position.y > 0.0 ? position.y * 1.2 : position.y * 5.0, position.x * 1.4) * iScale;
  lp = vec2(lp.x * c - lp.y * s, lp.x * s + lp.y * c);
  vColor = iColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xy + lp, iPos.z - iScale * 0.6, 1.0);
}
`;

export const unitGlowFrag = /* glsl */ `
varying vec2 vQ;
varying vec3 vColor;
void main() {
  float head = exp(-dot(vQ, vQ) * 3.5);
  float tail = vQ.y < 0.0 ? (1.0 + vQ.y) * exp(-vQ.x * vQ.x * 6.0) * 0.55 : 0.0;
  float a = max(head, tail);
  gl_FragColor = vec4(vColor * 1.4 + vec3(0.1), a * 0.8);
  #include <colorspace_fragment>
}
`;

export const sparkVert = /* glsl */ `
attribute vec3 aColor;
attribute float aLife;
attribute float aSize;
uniform float uPx;
varying vec3 vColor;
varying float vLife;
void main() {
  vColor = aColor;
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * aLife * uPx / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const sparkFrag = /* glsl */ `
varying vec3 vColor;
varying float vLife;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = 1.0 - smoothstep(0.0, 0.5, length(c));
  gl_FragColor = vec4(vColor * 1.6 + vec3(0.4), a * vLife);
  #include <colorspace_fragment>
}
`;

export const ringVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const ringFrag = /* glsl */ `
uniform float uT;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float t = uT;
  float w = 0.06 + 0.1 * t;
  float ring = 1.0 - smoothstep(0.0, w, abs(r - t));
  float inner = (1.0 - smoothstep(0.0, max(t, 0.001), r)) * 0.25 * (1.0 - t);
  float a = (ring + inner) * (1.0 - t) * step(r, 1.0);
  gl_FragColor = vec4(uColor * 1.5 + vec3(0.2), a);
  #include <colorspace_fragment>
}
`;

export const arrowVert = /* glsl */ `
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const arrowFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uLen;
uniform float uOpacity;
varying vec2 vUV;
void main() {
  float across = abs(vUV.y);
  float core = 1.0 - smoothstep(0.25, 1.0, across);
  float chev = fract((vUV.x * uLen) - across * 0.35 - uTime * 2.2);
  float stripes = smoothstep(0.0, 0.15, chev) * (1.0 - smoothstep(0.45, 0.6, chev));
  float a = core * (0.55 + 0.45 * stripes);
  float tailFade = smoothstep(0.0, 0.12, vUV.x);
  vec3 col = mix(uColor * 1.3, vec3(1.0), stripes * 0.5 * core);
  gl_FragColor = vec4(col, a * tailFade * uOpacity);
  #include <colorspace_fragment>
}
`;
