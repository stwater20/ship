import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* =========================================================
   Tidebreaker — 戰艦大和 open-ocean battleship game
   ========================================================= */

// ---------- helpers ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261107);
const rand = (a, b) => a + (b - a) * rng();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const $ = (id) => document.getElementById(id);

// ---------- renderer / scene ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbfd8ea, 0.0007);
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 9000);

// ---------- waves (shared CPU / GPU) ----------
const WAVES = [
  [1, 0.25, 0.16, 118],
  [0.9, 0.62, 0.135, 73],
  [1, -0.38, 0.12, 44],
  [0.55, 0.95, 0.09, 29.5],
  [1, 0.07, 0.08, 19.3],
  [-0.22, 1, 0.06, 13.1],
  [0.86, -0.7, 0.05, 9.4],
  [0.38, 0.47, 0.04, 6.7],
].map(([dx, dz, s, L]) => {
  const l = Math.hypot(dx, dz);
  const k = (2 * Math.PI) / L;
  return { dx: dx / l, dz: dz / l, s, L, k, c: Math.sqrt(9.8 / k) };
});
let waveAmp = 0.42;
let time = 0;
const _d = { x: 0, y: 0, z: 0 };
function disp(x, z, out) {
  let ox = 0, oy = 0, oz = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    const f = w.k * (w.dx * x + w.dz * z - w.c * time);
    const a = (w.s * waveAmp) / w.k;
    const cf = Math.cos(f);
    ox += w.dx * a * cf; oz += w.dz * a * cf; oy += a * Math.sin(f);
  }
  out.x = ox; out.y = oy; out.z = oz;
  return out;
}
function waterHeight(x, z) {
  let px = x, pz = z;
  for (let i = 0; i < 4; i++) { disp(px, pz, _d); px = x - _d.x; pz = z - _d.z; }
  disp(px, pz, _d);
  return _d.y;
}
function maxWaveHeight() { let h = 0; for (const w of WAVES) h += (w.s * waveAmp) / w.k; return h; }

// ---------- world layout: course + islands ----------
const N_GATES = 12;
const GATE_R = 30;
const gates = [];
for (let i = 0; i < N_GATES; i++) {
  const th = (i / N_GATES) * Math.PI * 2;
  const R = (330 + 70 * Math.sin(3 * th + 0.6)) * 1.75;
  gates.push({ x: Math.cos(th) * R * 1.2, z: Math.sin(th) * R });
}
gates.forEach((g, i) => {
  const a = gates[(i - 1 + N_GATES) % N_GATES], b = gates[(i + 1) % N_GATES];
  const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz);
  g.tx = tx / l; g.tz = tz / l; g.yaw = Math.atan2(g.tx, g.tz);
});
function distToSeg(px, pz, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z;
  const t = clamp(((px - a.x) * vx + (pz - a.z) * vz) / (vx * vx + vz * vz), 0, 1);
  return Math.hypot(px - (a.x + vx * t), pz - (a.z + vz * t));
}
function distToCourse(x, z) {
  let d = Infinity;
  for (let i = 0; i < N_GATES; i++) d = Math.min(d, distToSeg(x, z, gates[i], gates[(i + 1) % N_GATES]));
  return d;
}
const START = { x: gates[0].x - gates[0].tx * 160, z: gates[0].z - gates[0].tz * 160, yaw: gates[0].yaw };

const WORLD_X = 1900, WORLD_Z = 1600;
const islands = [];
{
  const g = gates[3];
  const ol = Math.hypot(g.x, g.z);
  islands.push({ x: g.x + (g.x / ol) * 120, z: g.z + (g.z / ol) * 120, r: 26, h: 8, s1: 1, s2: 2, s3: 3, lighthouse: true });
  islands.push({ x: 0, z: 0, r: 150, h: 48, s1: rand(0, 6), s2: rand(0, 6), s3: rand(0, 6) });
  let tries = 0;
  while (islands.length < 19 && tries++ < 4000) {
    const r = rand(22, 90);
    const x = rand(-WORLD_X, WORLD_X), z = rand(-WORLD_Z, WORLD_Z);
    if (distToCourse(x, z) < r * 1.3 + 80) continue;
    if (Math.hypot(x - START.x, z - START.z) < r + 200) continue;
    if (islands.some((o) => Math.hypot(o.x - x, o.z - z) < (o.r + r) * 1.3 + 60)) continue;
    islands.push({ x, z, r, h: rand(6, 9) + r * rand(0.15, 0.42), s1: rand(0, 6), s2: rand(0, 6), s3: rand(0, 6) });
  }
}
function islandR(is, a) {
  return is.r * (1 + 0.12 * Math.sin(3 * a + is.s1) + 0.07 * Math.sin(5 * a + is.s2) + 0.04 * Math.sin(9 * a + is.s3));
}
const rocks = [];
for (let i = 0; i < 12; i++) {
  for (let t = 0; t < 300; t++) {
    const x = rand(-WORLD_X, WORLD_X), z = rand(-WORLD_Z, WORLD_Z), r = rand(4, 10);
    if (distToCourse(x, z) < 70 || Math.hypot(x - START.x, z - START.z) < 150) continue;
    if (islands.some((o) => Math.hypot(o.x - x, o.z - z) < o.r * 1.3 + r + 25)) continue;
    rocks.push({ x, z, r }); break;
  }
}
function freeSpot(margin = 20) {
  for (let t = 0; t < 200; t++) {
    const x = rand(-WORLD_X * 0.9, WORLD_X * 0.9), z = rand(-WORLD_Z * 0.9, WORLD_Z * 0.9);
    if (islands.some((o) => Math.hypot(o.x - x, o.z - z) < o.r * 1.3 + margin)) continue;
    if (rocks.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + margin)) continue;
    return { x, z };
  }
  return { x: 0, z: 600 };
}

// ---------- canvas textures ----------
function softTexture(size = 64) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function puffTexture(seed) {
  const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  const r = mulberry32(seed);
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, d = r() * s * 0.25;
    const x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d, rad = s * (0.12 + r() * 0.16);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const softTex = softTexture();
const foamTex = (() => {
  // white foam on transparent: alpha carries the lacy pattern
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), r = mulberry32(7);
  const base = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  base.addColorStop(0, 'rgba(255,255,255,0.45)'); base.addColorStop(0.5, 'rgba(255,255,255,0.25)'); base.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 1100; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * s * 0.46;
    const fall = Math.pow(1 - d / (s * 0.48), 1.4);
    const x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d, rad = 1.5 + r() * 6 * fall;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(255,255,255,${(0.35 + r() * 0.6) * fall})`); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const smokeTex = puffTexture(11);

// ---------- shared GLSL ----------
const NOISE_GLSL = /* glsl */ `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float hash3(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
// value noise + analytic gradient: vec3(value, d/dx, d/dy)
vec3 noised(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f), du=6.0*f*(1.0-f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  float k=a-b-c+d;
  return vec3(a+(b-a)*u.x+(c-a)*u.y+k*u.x*u.y, du*(vec2(b-a,c-a)+k*u.yx)); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*vnoise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return v; }
`;

// ---------- sky dome ----------
const skyUniforms = {
  uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() },
  uTime: { value: 0 }, uNight: { value: 0 }, uCloud: { value: 0.35 }, uCloudCol: { value: new THREE.Color(1, 1, 1) }, uFlash: { value: 0 },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(4000, 48, 24),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHor, uSunDir, uSunCol, uCloudCol; uniform float uTime, uNight, uCloud, uFlash;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main(){
        vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(uHor, uTop, pow(smoothstep(0.0, 1.0, max(h, 0.0)), 0.55));
        float sd = max(dot(d, uSunDir), 0.0);
        float above = smoothstep(-0.08, 0.02, uSunDir.y);
        col += uSunCol * (pow(sd, 6.0)*0.22 + pow(sd, 120.0)*0.9) * above;
        col += uSunCol * smoothstep(0.9994, 0.99965, sd) * 18.0 * above;
        float md = max(dot(d, -uSunDir), 0.0);
        col += vec3(0.85,0.9,1.0) * (smoothstep(0.99935, 0.9996, md)*2.2 + pow(md, 40.0)*0.08) * uNight;
        if (h > 0.0) {
          vec3 p = d*260.0; vec3 id = floor(p); float r = hash3(id);
          if (r > 0.9965) { float s = 1.0 - smoothstep(0.0, 0.22, length(fract(p)-0.5));
            col += vec3(s) * uNight * (0.55 + 0.45*sin(uTime*2.5 + r*400.0)) * smoothstep(0.0, 0.2, h); }
          vec2 uv = d.xz/(h+0.12)*0.9 + vec2(uTime*0.006, uTime*0.0025);
          float c = fbm(uv*1.4);
          float cov = smoothstep(1.0-uCloud, 1.0-uCloud+0.28, c);
          float shade = 0.75 + 0.25*fbm(uv*2.8 + 3.0);
          vec3 cc = uCloudCol*shade + uSunCol*pow(sd, 4.0)*0.35*above;
          col = mix(col, cc, cov*smoothstep(0.0, 0.12, h)*0.92);
        }
        col += vec3(uFlash);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -10;
sky.frustumCulled = false;
scene.add(sky);

// ---------- lights ----------
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x2a4a5a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera; sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 700;
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);
const flashLight = new THREE.PointLight(0xffa040, 0, 260, 1.2);
scene.add(flashLight);

// ---------- ocean ----------
const MAX_ISL = 36;
const islUniform = [], islParam = [];
for (let i = 0; i < MAX_ISL; i++) { islUniform.push(new THREE.Vector4(0, 0, 0, 0)); islParam.push(new THREE.Vector4(0, 0, 0, 0)); }
[...islands, ...rocks.map((r) => ({ x: r.x, z: r.z, r: r.r * 0.9, s1: 0, s2: 0, s3: 0, rock: true }))].slice(0, MAX_ISL).forEach((is, i) => {
  islUniform[i].set(is.x, is.z, is.r, is.rock ? 10 : 45);
  islParam[i].set(is.s1, is.s2, is.s3, is.rock ? 0 : 1);
});
const oceanUniforms = {
  uTime: { value: 0 }, uAmp: { value: waveAmp },
  uWaves: { value: WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, w.s, w.L)) },
  uCam: { value: new THREE.Vector3() },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSpecCol: { value: new THREE.Color() },
  uTop: skyUniforms.uTop, uHor: skyUniforms.uHor,
  uDeep: { value: new THREE.Color() }, uShallow: { value: new THREE.Color() },
  uFogCol: { value: new THREE.Color() }, uFogDen: { value: 0.0007 },
  uIsl: { value: islUniform }, uIslP: { value: islParam }, uIslN: { value: Math.min(MAX_ISL, islands.length + rocks.length) },
  uMaxH: { value: 1 }, uLight: { value: 1 },
  uHeadPos: { value: new THREE.Vector3() }, uHeadDir: { value: new THREE.Vector3(0, 0, 1) }, uHeadOn: { value: 0 },
};
const WAVE_GLSL = /* glsl */ `
  uniform float uTime, uAmp; uniform vec4 uWaves[8]; uniform vec3 uCam;
  float waveFade(vec4 w, float dist){ return 1.0 - smoothstep(w.w * 12.0, w.w * 32.0, dist); }
`;
const oceanMat = new THREE.ShaderMaterial({
  uniforms: oceanUniforms,
  vertexShader: /* glsl */ `
    ${WAVE_GLSL}
    varying vec3 vWorld; varying vec2 vOrig; varying float vH;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec2 p = wp.xz; float dist = length(p - uCam.xz);
      vec3 d = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        vec4 w = uWaves[i]; float k = 6.2831853 / w.w; float c = sqrt(9.8 / k);
        float a = w.z * uAmp / k * waveFade(w, dist);
        float f = k * (dot(w.xy, p) - c * uTime);
        d.x += w.x * a * cos(f); d.z += w.y * a * cos(f); d.y += a * sin(f);
      }
      wp.xyz += d; vWorld = wp.xyz; vOrig = p; vH = d.y;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    ${WAVE_GLSL}
    uniform vec3 uSunDir, uSpecCol, uTop, uHor, uDeep, uShallow, uFogCol, uHeadPos, uHeadDir;
    uniform float uFogDen, uMaxH, uLight, uHeadOn; uniform vec4 uIsl[${MAX_ISL}]; uniform vec4 uIslP[${MAX_ISL}]; uniform int uIslN;
    varying vec3 vWorld; varying vec2 vOrig; varying float vH;
    ${NOISE_GLSL}
    void main(){
      float dist = length(vOrig - uCam.xz);
      vec3 T = vec3(1.0, 0.0, 0.0), B = vec3(0.0, 0.0, 1.0);
      for (int i = 0; i < 8; i++) {
        vec4 w = uWaves[i]; float k = 6.2831853 / w.w; float c = sqrt(9.8 / k);
        float st = w.z * uAmp * waveFade(w, dist);
        float f = k * (dot(w.xy, vOrig) - c * uTime); float sf = sin(f), cf = cos(f);
        T += vec3(-w.x*w.x*st*sf, w.x*st*cf, -w.x*w.y*st*sf);
        B += vec3(-w.x*w.y*st*sf, w.y*st*cf, -w.y*w.y*st*sf);
      }
      vec3 n = normalize(cross(B, T));
      float jac = T.x * B.z - T.z * B.x;
      // small-scale chop: 5 octaves of rotated value noise, each scrolling with the wind
      // and faded out before it gets smaller than a pixel (no moire / shimmering)
      vec2 g = vec2(0.0); float amp = 1.0, fr = 0.085;
      mat2 M = mat2(1.0, 0.0, 0.0, 1.0);
      const mat2 ROT = mat2(0.80, -0.60, 0.60, 0.80);
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        vec2 drift = vec2(0.9, 0.3 - 0.25 * fi) * uTime * (0.9 + 0.35 * fi);
        vec2 qp = M * (vOrig + drift) * fr + vec2(fi * 17.3, fi * 5.1);
        vec3 nd = noised(qp);
        float lod = 1.0 - smoothstep(18.0 / fr, 60.0 / fr, dist);
        g += (nd.yz * M) * fr * amp * lod;
        amp *= 0.58; fr *= 1.93; M = ROT * M;
      }
      n.xz -= g * (0.55 + 0.35 * uAmp);
      n = normalize(n);

      vec3 v = normalize(cameraPosition - vWorld);
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
      vec3 r = reflect(-v, n); r.y = abs(r.y);
      vec3 skyc = mix(uHor, uTop, pow(clamp(r.y, 0.0, 1.0), 0.45)) * 0.92;
      fres = min(fres, 0.82);

      float shallow = 0.0, shore = 0.0;
      for (int i = 0; i < ${MAX_ISL}; i++) {
        if (i >= uIslN) break;
        vec4 is = uIsl[i]; vec4 ip = uIslP[i];
        vec2 dv = vWorld.xz - is.xy;
        float l = length(dv);
        if (l > is.z * 1.3 + is.w) continue;
        float a = atan(dv.y, dv.x);
        float R = is.z * (1.0 + ip.w*(0.12*sin(3.0*a+ip.x) + 0.07*sin(5.0*a+ip.y) + 0.04*sin(9.0*a+ip.z)));
        float dd = l - R;
        shallow = max(shallow, 1.0 - smoothstep(-2.0, is.w, dd));
        float nz = vnoise(vWorld.xz*0.25 + uTime*0.4);
        shore = max(shore, (1.0 - smoothstep(0.0, 8.0, dd + nz*5.0 - 1.5 + 2.0*sin(uTime*1.3 + l*0.35))) * step(-6.0, dd));
      }

      float hgt = clamp(vH / max(uMaxH, 0.01) * 0.5 + 0.5, 0.0, 1.0);
      vec3 body = mix(uDeep, uShallow, clamp(shallow*0.85 + hgt*0.12, 0.0, 1.0));
      // light through thin wave crests, seen against the sun
      float sss = pow(max(dot(v, -vec3(uSunDir.x, 0.0, uSunDir.z)), 0.0), 4.0) * smoothstep(0.55, 1.0, hgt);
      body += uShallow * sss * 0.45;
      body *= uLight;
      vec3 col = mix(body, skyc, fres);

      vec3 hv = normalize(uSunDir + v);
      float shin = mix(700.0, 160.0, smoothstep(50.0, 700.0, dist));
      float spec = pow(max(dot(n, hv), 0.0), shin) * mix(4.0, 1.4, smoothstep(50.0, 700.0, dist)) + pow(max(dot(n, hv), 0.0), 60.0) * 0.12;
      col += uSpecCol * spec * smoothstep(-0.05, 0.05, uSunDir.y + 0.1);

      vec2 wq = vec2(dot(vOrig, vec2(0.97, 0.24)), dot(vOrig, vec2(-0.24, 0.97)));
      float fn = vnoise(wq * vec2(0.22, 0.6) + vec2(uTime * 0.25, 0.0)) * 0.6 + vnoise(wq * vec2(0.7, 1.6) - vec2(uTime * 0.4, uTime * 0.1)) * 0.4;
      float crest = smoothstep(0.9, 0.45, jac) * smoothstep(0.6, 0.95, hgt);
      float foam = crest * smoothstep(0.3, 0.8, fn) * 0.9;
      foam += shore * smoothstep(0.1, 0.55, fn + 0.25);
      foam = clamp(foam, 0.0, 1.0) * (1.0 - smoothstep(400.0, 1100.0, dist));
      col = mix(col, vec3(0.92, 0.96, 1.0) * (uLight*0.9 + 0.1), foam * 0.85);

      if (uHeadOn > 0.001) {
        vec3 L = uHeadPos - vWorld; float ld = length(L); vec3 Ln = L / ld;
        float cone = smoothstep(0.965, 0.99, dot(-Ln, uHeadDir));
        col += vec3(1.0, 0.94, 0.8) * cone * (0.25 + max(dot(n, Ln), 0.0)) * 6.0 / (1.0 + ld*ld*0.0012) * uHeadOn;
      }

      float fd = length(cameraPosition - vWorld);
      col = mix(col, uFogCol, 1.0 - exp(-fd*fd*uFogDen*uFogDen));
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const oceanGeo = (() => {
  const SEG = 460, R = 3200;
  const g = new THREE.PlaneGeometry(2, 2, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const f = (u) => Math.sign(u) * (0.1 * Math.abs(u) + 0.9 * Math.abs(u) ** 3) * R;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, f(p.getX(i)), 0, f(p.getZ(i)));
  g.computeBoundingSphere();
  return g;
})();
const ocean = new THREE.Mesh(oceanGeo, oceanMat);
ocean.frustumCulled = false;
scene.add(ocean);

// ---------- islands ----------
const COL_SAND = new THREE.Color('#e9d6a0'), COL_WETSAND = new THREE.Color('#bba26e');
const COL_GRASS = new THREE.Color('#4c9a3c'), COL_GRASS2 = new THREE.Color('#2f7a33'), COL_ROCK = new THREE.Color('#8d8a80');
function islandProfile(is) {
  const h = is.h;
  return [[1.35, -12], [1.0, 0], [0.9, 1.0], [0.77, 1.8], [0.58, h * 0.42], [0.35, h * 0.82], [0.13, h], [0, h * 1.02]];
}
function profileY(prof, f) {
  for (let i = 0; i < prof.length - 1; i++) {
    const [f0, y0] = prof[i], [f1, y1] = prof[i + 1];
    if (f <= f0 && f >= f1) return lerp(y0, y1, (f0 - f) / (f0 - f1));
  }
  return f > prof[0][0] ? prof[0][1] : prof[prof.length - 1][1];
}
function islandNoise(is, f, a, y) {
  if (y < 2.2) return 0;
  return Math.sin(a * 7 + is.s1) * Math.sin(f * 11 + is.s2) * is.h * 0.07 + Math.sin(a * 13 + is.s3) * is.h * 0.025;
}
function islandSurface(is, f, a) { const prof = islandProfile(is); const y = profileY(prof, f); return y + islandNoise(is, f, a, y); }
// height of terrain at a world point (or -Infinity)
function terrainHeight(x, z) {
  let best = -Infinity;
  for (const is of islands) {
    const dx = x - is.x, dz = z - is.z;
    if (Math.abs(dx) > is.r * 1.4 || Math.abs(dz) > is.r * 1.4) continue;
    const a = Math.atan2(dz, dx), f = Math.hypot(dx, dz) / islandR(is, a);
    if (f < 1.3) best = Math.max(best, islandSurface(is, f, a));
  }
  for (const r of rocks) if (Math.hypot(x - r.x, z - r.z) < r.r) best = Math.max(best, r.r * 0.8);
  return best;
}

const islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, side: THREE.DoubleSide });
const trunkGeos = [], leafGeos = [];
function addPalm(x, y, z, s) {
  const L = rand(5.5, 8.5) * s, bend = rand(0.6, 1.8) * s, rot = rand(0, Math.PI * 2);
  const trunk = new THREE.CylinderGeometry(0.2 * s, 0.36 * s, L, 6, 5);
  trunk.translate(0, L / 2, 0);
  const p = trunk.attributes.position;
  for (let i = 0; i < p.count; i++) { const t = p.getY(i) / L; p.setX(i, p.getX(i) + t * t * bend); }
  trunk.rotateY(rot); trunk.translate(x, y - 0.4, z);
  trunkGeos.push(trunk);
  const tx = x + Math.cos(-rot) * bend, tz = z + Math.sin(-rot) * bend, ty = y - 0.4 + L;
  const n = 7;
  for (let k = 0; k < n; k++) {
    const leaf = new THREE.ConeGeometry(0.75 * s, 4.4 * s, 4, 1);
    leaf.scale(1, 1, 0.22);
    leaf.translate(0, 2.2 * s, 0);
    leaf.rotateX(Math.PI / 2 + rand(0.25, 0.7));
    leaf.rotateY((k / n) * Math.PI * 2 + rand(-0.2, 0.2));
    leaf.translate(tx, ty, tz);
    leafGeos.push(leaf);
  }
}
for (const is of islands) {
  const prof = islandProfile(is);
  const geo = new THREE.LatheGeometry(prof.map(([f, y]) => new THREE.Vector2(f, y)), 44).toNonIndexed();
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = Math.hypot(x, z), a = Math.atan2(z, x);
    const R = islandR(is, a);
    p.setXYZ(i, Math.cos(a) * f * R, y + islandNoise(is, f, a, y), Math.sin(a) * f * R);
  }
  const colors = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const j = 0.9 + rng() * 0.2;
    if (y < -0.3) c.copy(COL_WETSAND);
    else if (y < 2.1) c.copy(COL_SAND);
    else if (is.h > 18 && y > is.h * 0.72) c.copy(COL_ROCK);
    else c.copy(rng() < 0.5 ? COL_GRASS : COL_GRASS2);
    c.multiplyScalar(j);
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, islandMat);
  m.position.set(is.x, 0, is.z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  if (!is.lighthouse) {
    const n = Math.floor(is.r / 5) + 3;
    for (let k = 0; k < n; k++) {
      const f = rand(0.42, 0.82), a = rand(-Math.PI, Math.PI);
      const R = islandR(is, a);
      const y = islandSurface(is, f, a);
      if (is.h > 18 && y > is.h * 0.65) continue;
      addPalm(is.x + Math.cos(a) * f * R, y, is.z + Math.sin(a) * f * R, rand(1.0, 1.6));
    }
  }
}
if (trunkGeos.length) {
  const tm = new THREE.Mesh(mergeGeometries(trunkGeos), new THREE.MeshStandardMaterial({ color: '#8a6a45', roughness: 1, flatShading: true }));
  const lm = new THREE.Mesh(mergeGeometries(leafGeos), new THREE.MeshStandardMaterial({ color: '#3f9a3a', roughness: 0.8, flatShading: true, side: THREE.DoubleSide }));
  tm.castShadow = lm.castShadow = true;
  scene.add(tm, lm);
}
{
  const geos = rocks.map((r) => {
    const g = new THREE.DodecahedronGeometry(r.r, 0);
    g.scale(1, 0.75, 1); g.rotateY(rand(0, 6)); g.translate(r.x, r.r * 0.15, r.z);
    return g;
  });
  if (geos.length) {
    const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: '#6d6a64', roughness: 1, flatShading: true }));
    m.castShadow = true; scene.add(m);
  }
}
const lighthouse = (() => {
  const is = islands.find((i) => i.lighthouse);
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.6 });
  const red = new THREE.MeshStandardMaterial({ color: '#c8322b', roughness: 0.6 });
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.4, 24, 16), white); tower.position.y = 12; g.add(tower);
  for (let i = 0; i < 3; i++) {
    const y0 = 3 + i * 7;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(lerp(3.4, 2.2, (y0 + 1.4) / 24) + 0.05, lerp(3.4, 2.2, (y0 - 1.4) / 24) + 0.05, 2.8, 16), red);
    s.position.y = y0; g.add(s);
  }
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.3, 0.5, 16), red); deck.position.y = 24.2; g.add(deck);
  const lampMat = new THREE.MeshStandardMaterial({ color: '#fff7d0', emissive: '#ffe9a0', emissiveIntensity: 1 });
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 2.8, 12), lampMat); lamp.position.y = 25.9; g.add(lamp);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.6, 2.4, 12), red); cap.position.y = 28.5; g.add(cap);
  const beamGeo = new THREE.ConeGeometry(14, 220, 24, 1, true); beamGeo.translate(0, -110, 0); beamGeo.rotateZ(Math.PI / 2);
  const beamMat = new THREE.MeshBasicMaterial({ color: '#fff1b8', transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const beam = new THREE.Group(); beam.position.y = 25.9;
  const b1 = new THREE.Mesh(beamGeo, beamMat), b2 = new THREE.Mesh(beamGeo, beamMat); b2.rotation.y = Math.PI;
  beam.add(b1, b2); g.add(beam);
  tower.castShadow = true;
  g.position.set(is.x, is.h - 0.3, is.z);
  scene.add(g);
  return { beam, beamMat, lampMat };
})();

// ---------- battleship Yamato ----------
const SHIP_LEN = 72;
const ship = new THREE.Group();
const parts = { turrets: [], muzzles: [] };
{
  const M = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...extra });
  const gray = M('#8e979f'), grayD = M('#737b83'), grayL = M('#a4acb3');
  const deckM = M('#a68b5f', { roughness: 0.9, metalness: 0 });
  const redM = M('#7d2b23', { roughness: 0.8 });
  const black = M('#1b1e22', { roughness: 0.7 });
  const add = (geo, mat, x, y, z, parent = ship) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cyl = (rt, rb, h, s = 12) => new THREE.CylinderGeometry(rt, rb, h, s);

  // planform — Yamato's wide beam and long, flared bow
  const outline = new THREE.Shape();
  outline.moveTo(0, 36);
  outline.quadraticCurveTo(3.6, 27, 5.0, 14);
  outline.lineTo(5.4, 2);
  outline.lineTo(5.2, -16);
  outline.quadraticCurveTo(4.9, -30, 2.6, -35);
  outline.quadraticCurveTo(0, -36.6, -2.6, -35);
  outline.quadraticCurveTo(-4.9, -30, -5.2, -16);
  outline.lineTo(-5.4, 2);
  outline.lineTo(-5.0, 14);
  outline.quadraticCurveTo(-3.6, 27, 0, 36);
  const sheer = (z) => (z > 6 ? Math.pow((z - 6) / 30, 2) * 2.6 : 0) + (z < -24 ? -0.6 * ((-24 - z) / 12) : 0);

  // upper hull (grey), vertical sides with bow sheer
  const upper = new THREE.ExtrudeGeometry(outline, { depth: 4.6, bevelEnabled: false, curveSegments: 18 });
  upper.rotateX(Math.PI / 2); upper.translate(0, 4.6, 0);
  {
    const p = upper.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 2) p.setY(i, p.getY(i) + sheer(p.getZ(i)));
    upper.computeVertexNormals();
  }
  add(upper, gray, 0, 0, 0);
  // lower hull (anti-fouling red), narrowing to the keel
  const lower = new THREE.ExtrudeGeometry(outline, { depth: 3.8, bevelEnabled: false, curveSegments: 18 });
  lower.rotateX(Math.PI / 2); lower.translate(0, 0.02, 0);
  {
    const p = lower.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < -1) { p.setX(i, p.getX(i) * 0.72); p.setZ(i, p.getZ(i) * 0.96); }
    lower.computeVertexNormals();
  }
  add(lower, redM, 0, 0, 0);
  // deck: a subdivided strip that follows the sheer
  {
    const pts = outline.getSpacedPoints(160);
    const rows = 90, g = new THREE.PlaneGeometry(1, 1, 8, rows);
    const p = g.attributes.position;
    const halfW = (z) => {
      let w = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if ((a.y - z) * (b.y - z) <= 0 && a.y !== b.y) w = Math.max(w, Math.abs(lerp(a.x, b.x, (z - a.y) / (b.y - a.y))));
      }
      return w;
    };
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) * 2, v = p.getY(i) + 0.5; // u -1..1, v 0..1
      const z = lerp(-36.4, 35.8, v);
      const w = halfW(z) * 0.985;
      p.setXYZ(i, u * w, 4.62 + sheer(z), z);
    }
    g.computeVertexNormals();
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    const deck = new THREE.Mesh(g, deckM); deck.receiveShadow = true;
    deck.material.side = THREE.DoubleSide;
    ship.add(deck);
  }
  // breakwater + anchor chain area
  add(box(7.2, 0.8, 0.3), gray, 0, 5.2 + sheer(24), 24);
  // chrysanthemum crest on the bow
  const crest = add(cyl(0.55, 0.55, 0.15, 16), M('#e0b03a', { metalness: 0.8, roughness: 0.3, emissive: '#5a3c00', emissiveIntensity: 0.4 }), 0, 6.2, 35.4);
  crest.rotation.x = Math.PI / 2 - 0.35;

  // main armament turret (46cm triple)
  function turret(z, y, base, scale = 1, main = true) {
    const grp = new THREE.Group(); grp.position.set(0, y, z); ship.add(grp);
    const s = scale;
    add(cyl(3.3 * s, 3.4 * s, (y - 4.6) + 0.9, 20), grayD, 0, -((y - 4.6) + 0.9) / 2 + 0.45, 0, grp);
    const yawG = new THREE.Group(); yawG.rotation.y = base; grp.add(yawG);
    // turret house with sloped front
    const shape = new THREE.Shape();
    shape.moveTo(-3.6 * s, 0); shape.lineTo(3.0 * s, 0); shape.lineTo(3.9 * s, 1.0 * s); shape.lineTo(3.9 * s, 1.5 * s); shape.lineTo(2.0 * s, 2.5 * s); shape.lineTo(-3.6 * s, 2.5 * s); shape.closePath();
    const hg = new THREE.ExtrudeGeometry(shape, { depth: 5.8 * s, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 1 });
    hg.translate(0, 0, -2.9 * s); hg.rotateY(-Math.PI / 2);
    add(hg, gray, 0, 0.5, 0, yawG);
    if (main) add(box(7.5 * s, 0.35, 0.8), grayL, 0, 2.6 * s + 0.6, -2.4 * s, yawG); // rangefinder arms
    const pitch = new THREE.Group(); pitch.position.set(0, 1.3 * s + 0.5, 3.2 * s); yawG.add(pitch);
    const bl = main ? 11 : 6;
    const bgeo = new THREE.CylinderGeometry(0.2 * s + 0.04, 0.34 * s + 0.04, bl, 10); bgeo.rotateX(Math.PI / 2); bgeo.translate(0, 0, bl / 2);
    const muzzles = [];
    for (const bx of [-1.6, 0, 1.6]) {
      add(bgeo, grayD, bx * s, 0, 0, pitch);
      const mz = new THREE.Object3D(); mz.position.set(bx * s, 0, bl + 0.3); pitch.add(mz); muzzles.push(mz);
    }
    const t = { grp, yawG, pitch, base, yaw: 0, elev: 0.05, main, muzzles };
    parts.turrets.push(t);
    return t;
  }
  turret(19.5, 4.6 + sheer(19.5) * 0.9, 0);
  turret(11.5, 7.0, 0);
  turret(-20.5, 4.6, Math.PI);
  turret(4.8, 9.6, 0, 0.55, false);
  turret(-13.8, 8.4, Math.PI, 0.55, false);

  // central superstructure
  add(box(9.5, 3.6, 26), gray, 0, 6.4, -4);
  add(box(8, 1.0, 22), grayL, 0, 8.6, -4.5);
  // AA platforms + guns along the sides
  for (const sx of [-1, 1]) {
    add(box(2.2, 0.4, 24), grayL, sx * 5.3, 8.4, -4.5);
    for (let z = -15; z <= 6; z += 3) {
      const tub = add(cyl(0.6, 0.7, 0.6, 8), grayD, sx * 5.6, 8.9, z);
      for (const bz of [-0.18, 0.18]) {
        const b = add(cyl(0.05, 0.06, 1.6, 5), black, sx * 5.6 + bz, 9.5, z + 0.5, ship);
        b.rotation.x = Math.PI / 2 - 0.6;
      }
      void tub;
    }
    // 12.7cm twin AA mounts
    for (const z of [-9, -3, 3]) {
      const m = add(box(1.6, 1.0, 1.8), gray, sx * 4.6, 9.6, z);
      for (const bz of [-0.3, 0.3]) { const b = add(cyl(0.08, 0.1, 2.2, 6), grayD, sx * 4.6 + bz, 9.9, z + 1.6); b.rotation.x = Math.PI / 2 - 0.25; }
      void m;
    }
  }
  // pagoda tower
  add(box(6.2, 3.0, 6.0), gray, 0, 10.6, 2.4);
  add(box(5.0, 3.0, 4.6), gray, 0, 13.6, 2.6);
  add(box(4.0, 2.6, 3.8), grayL, 0, 16.4, 2.8);
  add(box(4.6, 1.5, 3.2), gray, 0, 18.4, 3.0);
  add(box(4.65, 0.45, 3.25), black, 0, 18.6, 3.0); // bridge windows
  add(box(3.0, 1.4, 2.4), gray, 0, 19.9, 2.6);
  add(box(10.5, 0.8, 1.0), grayL, 0, 21.0, 2.4); // 15m rangefinder
  add(cyl(1.3, 1.4, 1.4, 12), gray, 0, 21.0, 2.4);
  add(cyl(0.12, 0.18, 6, 6), black, 0, 24.5, 1.8); // mast
  add(box(3.4, 0.08, 0.08), black, 0, 25.6, 1.8);
  // funnel, raked aft
  const funnel = add(cyl(1.7, 2.3, 8.5, 18), gray, 0, 12.0, -5.6);
  funnel.scale.set(0.82, 1, 1); funnel.rotation.x = -0.32;
  const cap = add(cyl(1.75, 1.75, 0.6, 18), black, 0, 16.0, -7.0);
  cap.scale.set(0.82, 1, 1); cap.rotation.x = -0.32;
  parts.funnelTop = new THREE.Object3D(); parts.funnelTop.position.set(0, 16.6, -7.3); ship.add(parts.funnelTop);
  // aft tripod mast + secondary bridge
  add(box(4.2, 2.2, 4), gray, 0, 9.6, -16.4);
  add(cyl(0.18, 0.28, 13, 6), black, 0, 15.0, -11.5);
  for (const sx of [-1, 1]) { const leg = add(cyl(0.1, 0.16, 11, 6), black, sx * 1.4, 13.4, -12.6); leg.rotation.z = sx * 0.13; leg.rotation.x = 0.1; }
  add(box(4.2, 0.08, 0.08), black, 0, 19.5, -11.5);
  // ship's boats
  for (const sx of [-1, 1]) {
    const b = add(new THREE.CapsuleGeometry(0.6, 3.0, 3, 8), M('#e8e6de'), sx * 3.6, 9.4, -9.5);
    b.rotation.x = Math.PI / 2;
  }
  // stern: catapults + crane
  for (const sx of [-1, 1]) {
    const cat = add(box(0.6, 0.35, 9), black, sx * 2.8, 4.7, -31);
    cat.rotation.y = sx * 0.35;
  }
  const crane = add(cyl(0.18, 0.25, 6.5, 6), black, 0, 7.6, -33.4); crane.rotation.x = 0.5;
  // small floatplane on the catapult
  {
    const pl = new THREE.Group(); pl.position.set(2.8, 5.4, -31); pl.rotation.y = 0.35; ship.add(pl);
    const pm = M('#6a8a5a');
    add(new THREE.CapsuleGeometry(0.35, 2.4, 3, 8), pm, 0, 0.3, 0, pl).rotation.x = Math.PI / 2;
    add(box(5.6, 0.08, 0.9), pm, 0, 0.55, 0.2, pl);
    add(box(0.25, 0.5, 2.6), M('#d0d0c8'), 0, -0.3, 0.2, pl);
  }
  // ensign (hinomaru) at the stern
  {
    const c = document.createElement('canvas'); c.width = 96; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#f5f5f0'; g.fillRect(0, 0, 96, 64);
    g.fillStyle = '#c8102e'; g.beginPath(); g.arc(48, 32, 19, 0, Math.PI * 2); g.fill();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    add(cyl(0.06, 0.08, 4.5, 6), black, 0, 6.6, -35.6);
    const fg = new THREE.PlaneGeometry(2.4, 1.6, 8, 1); fg.translate(-1.2, 0, 0);
    const flag = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 }));
    flag.position.set(0, 8.1, -35.6); flag.rotation.y = Math.PI / 2;
    ship.add(flag); parts.flag = flag;
  }
  // nav lights + searchlight
  const navMat = (c) => new THREE.SpriteMaterial({ map: softTex, color: c, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
  parts.navGlow = [navMat('#ff4040'), navMat('#40ff80'), navMat('#ffffff')];
  [[5.2, 9.0, 3.5], [-5.2, 9.0, 3.5], [0, 26.0, 1.8]].forEach((p, i) => { const s = new THREE.Sprite(parts.navGlow[i]); s.scale.setScalar(3); s.position.set(...p); ship.add(s); });
  const spot = new THREE.SpotLight(0xfff1d0, 0, 500, 0.28, 0.5, 1.0);
  spot.position.set(0, 17.2, 5.2); spot.target.position.set(0, -6, 120);
  ship.add(spot, spot.target); parts.searchlight = spot;
  ship.traverse((o) => { if (o.isMesh) o.castShadow = true; });
}
ship.rotation.order = 'YXZ';
scene.add(ship);

// aim reticle on the water
const reticle = new THREE.Mesh(
  (() => { const g = new THREE.RingGeometry(7, 9, 40); g.rotateX(-Math.PI / 2); return g; })(),
  new THREE.MeshBasicMaterial({ color: '#ff5a3d', transparent: true, opacity: 0.8, depthWrite: false, fog: false })
);
const reticleIn = new THREE.Mesh(
  (() => { const g = new THREE.RingGeometry(0.8, 1.8, 20); g.rotateX(-Math.PI / 2); return g; })(),
  reticle.material
);
reticle.add(reticleIn);
scene.add(reticle);

// next-gate arrow
const arrow = new THREE.Mesh(
  (() => { const g = new THREE.ConeGeometry(2.2, 6, 4); g.rotateX(Math.PI / 2); return g; })(),
  new THREE.MeshBasicMaterial({ color: '#39e1ff', transparent: true, opacity: 0.85, fog: false })
);
scene.add(arrow);

// ---------- gates ----------
const gateMeshes = gates.map((g, i) => {
  const grp = new THREE.Group();
  const isStart = i === 0;
  const mat = new THREE.MeshStandardMaterial({ color: isStart ? '#ffcf4a' : '#ffffff', emissive: isStart ? '#ff9d00' : '#39e1ff', emissiveIntensity: 0.2, roughness: 0.4 });
  grp.add(new THREE.Mesh(new THREE.TorusGeometry(GATE_R, 1.1, 12, 64), mat));
  const buoyMat = new THREE.MeshStandardMaterial({ color: '#e2362f', roughness: 0.5 });
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.4, 4.4, 14), buoyMat); b.position.set(s * (GATE_R + 1.5), 0.8, 0); grp.add(b);
    const t = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffe680' })); t.position.set(s * (GATE_R + 1.5), 3.6, 0); grp.add(t);
  }
  const beamMat = new THREE.MeshBasicMaterial({ color: isStart ? '#ffcf4a' : '#39e1ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 400, 16, 1, true), beamMat); beam.position.y = 200;
  grp.add(beam);
  grp.rotation.order = 'YXZ';
  grp.position.set(g.x, 0, g.z); grp.rotation.y = g.yaw;
  scene.add(grp);
  return { grp, mat, beamMat };
});

// ---------- coins (supply drops) ----------
const coinGeo = new THREE.CylinderGeometry(2.6, 2.6, 0.6, 24); coinGeo.rotateX(Math.PI / 2);
const coinMat = new THREE.MeshStandardMaterial({ color: '#ffcc33', emissive: '#a86a00', emissiveIntensity: 0.6, metalness: 0.55, roughness: 0.3 });
const coinGlowMat = new THREE.SpriteMaterial({ map: softTex, color: '#ffd35a', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 });
const coins = [];
for (let i = 0; i < 40; i++) {
  const m = new THREE.Mesh(coinGeo, coinMat); m.castShadow = true;
  const glow = new THREE.Sprite(coinGlowMat); glow.scale.setScalar(12); m.add(glow);
  let p;
  if (i < 16) {
    const a = gates[i % N_GATES], b = gates[(i + 1) % N_GATES];
    p = { x: lerp(a.x, b.x, 0.5) + rand(-25, 25), z: lerp(a.z, b.z, 0.5) + rand(-25, 25) };
  } else p = freeSpot();
  m.position.set(p.x, 0, p.z);
  scene.add(m);
  coins.push({ m, x: p.x, z: p.z, alive: true, respawn: 0, phase: rand(0, 6) });
}

// ---------- target barges ----------
const targets = [];
{
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let i = 5; i > 0; i--) { g.fillStyle = i % 2 ? '#d22' : '#fff'; g.beginPath(); g.arc(64, 64, i * 12.5, 0, Math.PI * 2); g.fill(); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const boardMat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 });
  const hullMat = new THREE.MeshStandardMaterial({ color: '#3d4a3a', roughness: 0.8 });
  const frameMat = new THREE.MeshStandardMaterial({ color: '#222', roughness: 0.8 });
  for (let i = 0; i < 12; i++) {
    const grp = new THREE.Group();
    const h = new THREE.Mesh(new THREE.BoxGeometry(8, 2.2, 16), hullMat); h.position.y = 0.4; grp.add(h);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), boardMat); board.position.y = 7; grp.add(board);
    const board2 = board.clone(); board2.rotation.y = Math.PI / 2; grp.add(board2);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 12, 6), frameMat); post.position.y = 6; grp.add(post);
    grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    grp.rotation.order = 'YXZ';
    scene.add(grp);
    const p = freeSpot(40);
    targets.push({ grp, x: p.x, z: p.z, yaw: rand(0, 6), alive: true, respawn: 0, sink: 0, vx: rand(-1, 1), vz: rand(-1, 1) });
  }
}

// ---------- particles: wake (instanced foam decals) ----------
const WAKE_N = 1100;
const wakeMesh = new THREE.InstancedMesh(
  (() => { const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); return g; })(),
  (() => {
    // instance colour r = opacity, g = brightness (so overlapping decals settle at white, never blow out)
    const m = new THREE.MeshBasicMaterial({ map: foamTex, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2 });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        #if defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR )
          diffuseColor = vec4(vec3(0.93, 0.96, 1.0) * vColor.g, sampledDiffuseColor.a * vColor.r);
        #endif`);
    };
    return m;
  })(),
  WAKE_N
);
wakeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
wakeMesh.frustumCulled = false;
const wake = [];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);
for (let i = 0; i < WAKE_N; i++) {
  wake.push({ x: 0, z: 0, vx: 0, vz: 0, age: 1e10, life: 1, s0: 1, grow: 1, a: 0, rot: 0 });
  wakeMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
  wakeMesh.setColorAt(i, _c.setRGB(0, 0, 0));
}
scene.add(wakeMesh);
let wakeIdx = 0;
function spawnWake(x, z, vx, vz, s0, grow, life, a) {
  const w = wake[wakeIdx]; wakeIdx = (wakeIdx + 1) % WAKE_N;
  w.x = x; w.z = z; w.vx = vx; w.vz = vz; w.age = 0; w.life = life; w.s0 = s0; w.grow = grow; w.a = a; w.rot = rng() * 6.28;
}

// ---------- particles: spray (points) ----------
const SPRAY_N = 3200;
const sprayPos = new Float32Array(SPRAY_N * 3), sprayCol = new Float32Array(SPRAY_N * 3);
const sprayGeo = new THREE.BufferGeometry();
sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3).setUsage(THREE.DynamicDrawUsage));
sprayGeo.setAttribute('color', new THREE.BufferAttribute(sprayCol, 3).setUsage(THREE.DynamicDrawUsage));
const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({ size: 1.8, map: softTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
spray.frustumCulled = false;
scene.add(spray);
const sprayP = [];
for (let i = 0; i < SPRAY_N; i++) sprayP.push({ x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 1, r: 1, g: 1, b: 1, drag: 0 });
let sprayIdx = 0;
function spawnSpray(x, y, z, vx, vy, vz, life = 1, r = 0.9, g = 0.95, b = 1, drag = 0) {
  const p = sprayP[sprayIdx]; sprayIdx = (sprayIdx + 1) % SPRAY_N;
  p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.age = 0; p.life = life; p.r = r; p.g = g; p.b = b; p.drag = drag;
}
function splashBurst(x, z, n, power, ring = 5) {
  const y = waterHeight(x, z);
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), s = rand(0.3, 1) * power;
    spawnSpray(x + rand(-1.5, 1.5), y + 0.3, z + rand(-1.5, 1.5), Math.cos(a) * s * 0.5, rand(0.6, 1.2) * power, Math.sin(a) * s * 0.5, rand(0.8, 1.6));
  }
  for (let i = 0; i < ring; i++) spawnWake(x + rand(-3, 3), z + rand(-3, 3), rand(-2, 2), rand(-2, 2), 6, 6, 4, 0.7);
}
// shell impact column — the iconic tall white splash
function shellSplash(x, z) {
  const y = waterHeight(x, z);
  for (let i = 0; i < 140; i++) {
    const a = rand(0, Math.PI * 2), r = rand(0, 3.5);
    spawnSpray(x + Math.cos(a) * r, y, z + Math.sin(a) * r, Math.cos(a) * rand(0.5, 4), rand(14, 34), Math.sin(a) * rand(0.5, 4), rand(1.6, 3.2), 0.95, 0.97, 1, 0.4);
  }
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; spawnWake(x, z, Math.cos(a) * 7, Math.sin(a) * 7, 6, 5, 5, 0.9); }
}

// ---------- smoke / fire sprites ----------
const SMOKE_N = 260;
const smoke = [];
for (let i = 0; i < SMOKE_N; i++) {
  const mat = new THREE.SpriteMaterial({ map: smokeTex, color: '#555', transparent: true, opacity: 0, depthWrite: false });
  const s = new THREE.Sprite(mat); s.visible = false; scene.add(s);
  smoke.push({ s, mat, age: 1, life: 1, vx: 0, vy: 0, vz: 0, s0: 1, grow: 1, op: 0.5, add: false });
}
let smokeIdx = 0;
function spawnSmoke(x, y, z, vx, vy, vz, s0, grow, life, op, color = '#555', additive = false) {
  const p = smoke[smokeIdx]; smokeIdx = (smokeIdx + 1) % SMOKE_N;
  p.s.position.set(x, y, z); p.vx = vx; p.vy = vy; p.vz = vz; p.s0 = s0; p.grow = grow; p.life = life; p.age = 0; p.op = op;
  p.mat.color.set(color); p.mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending; p.mat.rotation = rng() * 6.28;
  p.s.visible = true;
}
function explosion(x, y, z, big = 1) {
  for (let i = 0; i < 6; i++) spawnSmoke(x + rand(-2, 2), y + rand(0, 3), z + rand(-2, 2), rand(-3, 3), rand(3, 9), rand(-3, 3), 6 * big, 10 * big, 0.6, 1, '#ffb040', true);
  for (let i = 0; i < 8; i++) spawnSmoke(x + rand(-3, 3), y + rand(0, 4), z + rand(-3, 3), rand(-2, 2), rand(2, 5), rand(-2, 2), 6 * big, 9 * big, rand(4, 7), 0.75, '#3a3a3a');
  for (let i = 0; i < 60; i++) spawnSpray(x, y + 1, z, rand(-14, 14), rand(5, 22), rand(-14, 14), rand(0.8, 1.8), 1, rand(0.4, 0.7), 0.15);
  flashLight.position.set(x, y + 6, z); flashLight.intensity = 60000 * big;
}

// ---------- shells ----------
const shells = [];
{
  const geo = new THREE.SphereGeometry(0.5, 8, 6);
  const mat = new THREE.MeshBasicMaterial({ color: '#ffd28a', fog: false });
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(geo, mat); m.visible = false;
    const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: '#ffaa55', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
    g.scale.setScalar(4); m.add(g);
    scene.add(m);
    shells.push({ m, alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0 });
  }
}
const SHELL_V = 150, G = 9.8;

// ---------- rain ----------
const RAIN_N = 2200;
const rainPos = new Float32Array(RAIN_N * 6);
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3).setUsage(THREE.DynamicDrawUsage));
const rainMat = new THREE.LineBasicMaterial({ color: '#b8c8d8', transparent: true, opacity: 0, fog: false });
const rain = new THREE.LineSegments(rainGeo, rainMat);
rain.frustumCulled = false;
scene.add(rain);
const rainDrops = [];
for (let i = 0; i < RAIN_N; i++) rainDrops.push({ x: rand(-80, 80), y: rand(-20, 50), z: rand(-80, 80), v: rand(30, 42) });

// ---------- dolphins ----------
function makeDolphin() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#5f7c96', roughness: 0.35 });
  const belly = new THREE.MeshStandardMaterial({ color: '#c9d6df', roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), mat); body.scale.set(0.42, 0.42, 1.55); g.add(body);
  const bel = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), belly); bel.scale.set(0.36, 0.3, 1.3); bel.position.y = -0.14; g.add(bel);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 4), mat); fin.position.set(0, 0.5, -0.1); fin.rotation.x = -0.5; g.add(fin);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.35), mat); tail.position.set(0, 0, -1.6); g.add(tail);
  const snout = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 6), mat); snout.rotation.x = Math.PI / 2; snout.position.set(0, -0.08, 1.7); g.add(snout);
  g.rotation.order = 'YXZ'; g.visible = false; g.scale.setScalar(1.3);
  scene.add(g);
  return g;
}
const pod = { active: false, t: 0, x: 0, z: 0, dx: 0, dz: 1, speed: 12, members: [] };
for (let i = 0; i < 5; i++) pod.members.push({ mesh: makeDolphin(), lat: (i - 2) * 3.5, fwd: rand(-5, 5), phase: rand(0, 6), prevUp: false });
let podTimer = 8;

// ---------- gulls ----------
const gulls = [];
{
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.25, 1.3, 0, -0.1, 0, 0, -0.35], 3));
  wingGeo.computeVertexNormals();
  const wm = new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.DoubleSide, roughness: 0.9 });
  for (let i = 0; i < 16; i++) {
    const is = islands[i % islands.length];
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.5, 2, 6), wm); body.rotation.x = Math.PI / 2; g.add(body);
    const l = new THREE.Mesh(wingGeo, wm), r = new THREE.Mesh(wingGeo, wm); r.scale.x = -1;
    g.add(l, r); g.scale.setScalar(1.5); scene.add(g);
    gulls.push({ g, l, r, cx: is.x, cz: is.z, rad: is.r + rand(10, 50), h: is.h + rand(8, 28), sp: rand(0.12, 0.3) * (rng() < 0.5 ? -1 : 1), a: rand(0, 6.28), ph: rand(0, 6) });
  }
}

// ---------- audio ----------
const sfx = {
  ctx: null, muted: store.get('tb_muted', false),
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const c = (this.ctx = new C());
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.6; this.master.connect(c.destination);
    const comp = c.createDynamicsCompressor(); comp.connect(this.master); this.out = comp;
    // engine: deep turbine rumble
    this.elp = c.createBiquadFilter(); this.elp.type = 'lowpass'; this.elp.frequency.value = 200; this.elp.Q.value = 1.5;
    this.eg = c.createGain(); this.eg.gain.value = 0;
    this.o1 = c.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = c.createOscillator(); this.o2.type = 'triangle';
    const g2 = c.createGain(); g2.gain.value = 0.6;
    this.o1.connect(this.elp); this.o2.connect(g2).connect(this.elp);
    this.elp.connect(this.eg).connect(this.out);
    this.o1.start(); this.o2.start();
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const mkLoop = (type, f, gain) => {
      const s = c.createBufferSource(); s.buffer = buf; s.loop = true;
      const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f;
      const g = c.createGain(); g.gain.value = gain;
      s.connect(fl).connect(g).connect(this.out); s.start();
      return { fl, g };
    };
    this.sea = mkLoop('lowpass', 420, 0.08);
    this.rain = mkLoop('highpass', 2500, 0);
    this.hiss = mkLoop('bandpass', 900, 0);
  },
  update(speed, throttle, boost, storm) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 26 + speed * 1.4 + Math.abs(throttle) * 10 + boost * 10;
    this.o1.frequency.setTargetAtTime(f, t, 0.3);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.3);
    this.eg.gain.setTargetAtTime(0.08 + Math.abs(throttle) * 0.1 + boost * 0.06, t, 0.3);
    this.elp.frequency.setTargetAtTime(140 + speed * 12 + boost * 300 + Math.abs(throttle) * 80, t, 0.3);
    this.sea.g.gain.setTargetAtTime(0.07 + storm * 0.22, t, 0.5);
    this.sea.fl.frequency.setTargetAtTime(380 + storm * 600, t, 0.5);
    this.hiss.g.gain.setTargetAtTime(Math.min(speed / 22, 1) * 0.1, t, 0.3);
    this.rain.g.gain.setTargetAtTime(storm > 0.5 ? (storm - 0.5) * 0.25 : 0, t, 0.6);
  },
  burst(dur, freq, vol, type = 'lowpass', delay = 0) {
    if (!this.ctx || vol < 0.005) return;
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource(); s.buffer = this.noise;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl).connect(g).connect(this.out); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  },
  tone(freq, dur, vol, type = 'sine', delay = 0, slide = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.05);
  },
  cannon(main) {
    if (main) { this.burst(2.2, 260, 1.0); this.burst(0.25, 2200, 0.5, 'highpass'); this.tone(48, 1.0, 0.9, 'sine', 0, 0.45); }
    else { this.burst(0.9, 600, 0.6); this.tone(90, 0.4, 0.4, 'sine', 0, 0.5); }
  },
  distSplash(dist) { this.burst(1.2, 500, clamp(0.5 - dist / 3000, 0.03, 0.5), 'lowpass', dist / 340 * 0.5); },
  boom(dist) { this.burst(1.8, 300, clamp(0.9 - dist / 2500, 0.05, 0.9), 'lowpass', dist / 340 * 0.5); },
  splash(v) { this.burst(0.6 + v * 0.6, 500 + v * 500, 0.15 + v * 0.35); },
  crash() { this.burst(1.2, 200, 0.9); this.tone(40, 0.8, 0.7, 'sine', 0, 0.5); this.burst(0.6, 1500, 0.3, 'bandpass'); },
  coin() { this.tone(988, 0.12, 0.25, 'square'); this.tone(1318, 0.3, 0.22, 'square', 0.08); },
  gate() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.25, 0.18, 'triangle', i * 0.06)); },
  lap() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.3, 0.2, 'triangle', i * 0.1)); },
  horn() { this.tone(110, 1.6, 0.35, 'sawtooth'); this.tone(165, 1.6, 0.2, 'sawtooth'); },
  enemyGun(dist) { this.burst(1.1, 360, clamp(0.6 - dist / 2600, 0.04, 0.55), 'lowpass', (dist / 340) * 0.5); this.tone(70, 0.6, clamp(0.4 - dist / 3000, 0.02, 0.4), 'sine', (dist / 340) * 0.5, 0.5); },
  whistle() { this.tone(1500, 1.15, 0.07, 'sine', 0, 0.3); },
  hit() { this.burst(1.5, 700, 1.0); this.tone(55, 1.0, 0.9, 'sine', 0, 0.4); this.burst(0.35, 3000, 0.45, 'highpass'); },
  alarm() { [880, 660, 880].forEach((f, i) => this.tone(f, 0.16, 0.1, 'square', i * 0.18)); },
  launch(dist) { this.burst(0.5, 1200, clamp(0.35 - dist / 2500, 0.02, 0.35), 'bandpass', (dist / 340) * 0.5); },
  thunder(delay) { this.burst(3.5, 160, 0.9, 'lowpass', delay); this.burst(1.2, 600, 0.3, 'lowpass', delay); },
  toggle() {
    this.muted = !this.muted; store.set('tb_muted', this.muted);
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.05);
    $('soundBtn').classList.toggle('off', this.muted);
  },
};
$('soundBtn').classList.toggle('off', sfx.muted);

// ---------- input ----------
const keys = {};
const touch = { active: false, steer: 0, thr: 0, boost: false };
const mouse = { x: 0, y: 0.15, has: false };
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) { keys[e.code] = true; return; }
  keys[e.code] = true;
  if (state.mode === 'menu' && e.code === 'Enter') { startGame('battle'); return; }
  if (BT.over && e.code === 'Enter') { startGame('battle'); return; }
  if (state.mode !== 'play' && state.mode !== 'pause') return;
  switch (e.code) {
    case 'KeyC': cycleCam(); break;
    case 'KeyT': cycleWeather(); break;
    case 'KeyN': skipTime(); break;
    case 'KeyM': sfx.toggle(); break;
    case 'KeyR': if (BT.on) { if (BT.over) startGame('battle'); } else resetShip(); break;
    case 'KeyH': sfx.horn(); break;
    case 'KeyP': case 'Escape': togglePause(); break;
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  mouse.has = true;
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button === 0 && state.mode === 'play') fireMain();
  if (e.pointerType === 'mouse' && e.button === 2 && state.mode === 'play') fireSecondary();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

document.querySelectorAll('#toolbar button').forEach((b) => b.addEventListener('click', (e) => {
  e.currentTarget.blur();
  ({ cam: cycleCam, weather: cycleWeather, time: skipTime, sound: () => sfx.toggle(), reset: () => (BT.on ? startGame('battle') : resetShip()) })[b.dataset.act]();
}));

const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
if (isTouch) {
  const stick = $('stick'), knob = $('knob');
  let id = null, cx = 0, cy = 0;
  const move = (e) => {
    if (e.pointerId !== id) return;
    let dx = (e.clientX - cx) / 55, dy = (e.clientY - cy) / 55;
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    touch.active = true; touch.steer = dx; touch.thr = -dy;
    knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
  };
  stick.addEventListener('pointerdown', (e) => { id = e.pointerId; const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; stick.setPointerCapture(id); move(e); });
  stick.addEventListener('pointermove', move);
  const end = (e) => { if (e.pointerId !== id) return; id = null; touch.active = false; touch.steer = 0; touch.thr = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
  const hold = (el, k) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); touch[k] = true; el.classList.add('on'); });
    const off = () => { touch[k] = false; el.classList.remove('on'); };
    el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
  };
  hold($('tBoost'), 'boost');
  $('tFire').addEventListener('pointerdown', (e) => { e.preventDefault(); fireMain(); });
}

// ---------- game state ----------
const state = {
  mode: 'menu', game: 'battle', camMode: 0, weather: 0,
  tod: 16.4, todSpeed: 24 / 480, skip: 0,
  storm: 0, cloud: 0.35, shake: 0, flash: 0, nextLightning: 6,
  coins: 0, kills: 0, reload: 1, reload2: 1,
  race: { next: 0, started: false, startT: 0, best: store.get('tb_best_yamato', null) },
};
const WEATHERS = [
  { name: '晴朗', amp: 0.42, cloud: 0.32, storm: 0 },
  { name: '起浪', amp: 0.8, cloud: 0.6, storm: 0.25 },
  { name: '暴風雨', amp: 1.2, cloud: 0.98, storm: 1 },
];
const B = {
  x: START.x, z: START.z, y: 0, vy: 0, yaw: START.yaw, yawRate: 0,
  vx: 0, vz: 0, pitch: 0, roll: 0, rollKick: 0,
  throttle: 0, steer: 0, nitro: 1, boosting: false, speed: 0, vF: 0,
};
const aim = new THREE.Vector3(0, 0, 0);
let aimValid = false;

function resetShip() {
  Object.assign(B, { x: START.x, z: START.z, y: waterHeight(START.x, START.z) - 0.4, vy: 0, yaw: START.yaw, yawRate: 0, vx: 0, vz: 0, pitch: 0, roll: 0 });
  state.race.next = 0; state.race.started = false;
  snapCamera();
}
function cycleCam() { state.camMode = (state.camMode + 1) % 4; toast(['追蹤視角', '近距離', '艦橋視角', '電影視角'][state.camMode], '', 'cyan', 900); }
function cycleWeather() { state.weather = (state.weather + 1) % 3; toast(WEATHERS[state.weather].name, state.weather === 2 ? '小心大浪！' : '', state.weather === 2 ? 'hot' : 'cyan', 1400); }
function skipTime() { state.skip = 3; toast('時間快轉 ⏩', '', 'cyan', 900); }
function togglePause() {
  if (state.mode === 'play') { state.mode = 'pause'; $('pause').classList.remove('hidden'); if (sfx.ctx) sfx.ctx.suspend(); }
  else if (state.mode === 'pause') { state.mode = 'play'; $('pause').classList.add('hidden'); if (sfx.ctx) sfx.ctx.resume(); }
}
function setGameKind(kind) {
  state.game = kind;
  BT.on = kind === 'battle';
  $('race').classList.toggle('hidden', BT.on);
  $('battle').classList.toggle('hidden', !BT.on);
  for (const t of targets) { t.alive = !BT.on; t.sink = 0; t.respawn = 0; t.grp.visible = !BT.on; t.grp.rotation.z = 0; }
  if (!BT.on) clearBattle();
}
function startGame(kind = 'battle') {
  sfx.init();
  state.mode = 'play';
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('pause').classList.add('hidden');
  if (isTouch) $('touch').classList.remove('hidden');
  setGameKind(kind);
  if (BT.on) {
    resetBattle();
    toast('大和 出擊！', '敵艦隊來襲 · 準星靠近敵艦會自動鎖定並計算提前量', 'gold', 3200);
  } else {
    resetShip();
    toast('大和 出擊！', '穿過金色浮環開始計時 · 滑鼠瞄準、左鍵開砲', 'gold', 2600);
  }
  sfx.horn();
}
function backToMenu() {
  clearBattle();
  BT.on = false; BT.over = false;
  state.mode = 'menu';
  $('hud').classList.add('hidden');
  $('touch').classList.add('hidden');
  $('menu').classList.remove('hidden');
}
$('startBtn').addEventListener('click', () => startGame('battle'));
$('raceBtn').addEventListener('click', () => startGame('race'));
$('retryBtn').addEventListener('click', () => startGame('battle'));
$('menuBtn').addEventListener('click', backToMenu);

let toastTimer = 0;
function toast(text, sub = '', cls = '', ms = 1500) {
  const t = $('toast');
  t.className = cls; t.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
  void t.offsetWidth; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const fmt = (s) => { if (s == null) return '--'; const m = Math.floor(s / 60), r = s - m * 60; return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`; };

// ---------- environment ----------
const C = (h) => new THREE.Color(h);
const PAL = {
  dayTop: C('#1f6fd1'), dayHor: C('#bcdcf2'), setTop: C('#2d3f78'), setHor: C('#ff9e5e'),
  nightTop: C('#02050d'), nightHor: C('#0a1830'), stormTop: C('#353c44'), stormHor: C('#69737c'),
  sunDay: C('#fff3dc'), sunSet: C('#ff8a3d'), moon: C('#9fb8ff'),
  deep: C('#05263f'), shallow: C('#1d7f8a'), stormDeep: C('#17262e'), stormShallow: C('#355e62'),
};
const sunDir = new THREE.Vector3();
const tmpC = new THREE.Color(), tmpC2 = new THREE.Color(), tmpV = new THREE.Vector3();
let dayF = 1, nightF = 0;
function updateEnvironment(dt) {
  const skipRate = state.skip > 0 ? 3.2 : 0;
  if (state.skip > 0) state.skip -= skipRate * dt;
  state.tod = (state.tod + (state.todSpeed + skipRate) * dt) % 24;
  const a = ((state.tod - 6) / 12) * Math.PI;
  sunDir.set(Math.cos(a) * 0.82, Math.sin(a), 0.42).normalize();

  const W = WEATHERS[state.weather];
  waveAmp = damp(waveAmp, W.amp, 0.35, dt);
  state.cloud = damp(state.cloud, W.cloud, 0.4, dt);
  state.storm = damp(state.storm, W.storm, 0.4, dt);
  const st = state.storm;

  const e = sunDir.y;
  dayF = smooth(-0.12, 0.22, e);
  nightF = 1 - smooth(-0.2, 0.02, e);
  const setF = (1 - smooth(0.0, 0.32, Math.abs(e + 0.03))) * (1 - st * 0.8);

  const top = skyUniforms.uTop.value, hor = skyUniforms.uHor.value;
  top.copy(PAL.nightTop).lerp(PAL.dayTop, dayF).lerp(PAL.setTop, setF * 0.7);
  hor.copy(PAL.nightHor).lerp(PAL.dayHor, dayF).lerp(PAL.setHor, setF);
  tmpC.copy(PAL.stormTop).multiplyScalar(0.15 + 0.85 * dayF); top.lerp(tmpC, st * 0.9);
  tmpC.copy(PAL.stormHor).multiplyScalar(0.12 + 0.88 * dayF); hor.lerp(tmpC, st * 0.9);

  const sunCol = skyUniforms.uSunCol.value.copy(PAL.sunDay).lerp(PAL.sunSet, smooth(0.35, 0.0, e));
  skyUniforms.uSunDir.value.copy(sunDir);
  skyUniforms.uNight.value = nightF * (1 - st);
  skyUniforms.uCloud.value = state.cloud;
  skyUniforms.uCloudCol.value.setRGB(1, 1, 1).lerp(PAL.setHor, setF * 0.6).multiplyScalar(0.06 + 0.94 * dayF).lerp(tmpC2.setRGB(0.25, 0.27, 0.3).multiplyScalar(0.12 + 0.88 * dayF), st);
  skyUniforms.uTime.value = time;

  scene.fog.color.copy(hor);
  scene.fog.density = lerp(0.00062, 0.0019, st);
  oceanUniforms.uFogCol.value.copy(hor);
  oceanUniforms.uFogDen.value = scene.fog.density;

  const useMoon = e < -0.05;
  const lightDir = useMoon ? tmpV.copy(sunDir).negate() : tmpV.copy(sunDir);
  oceanUniforms.uSunDir.value.copy(lightDir);
  oceanUniforms.uSpecCol.value.copy(useMoon ? PAL.moon : sunCol).multiplyScalar((useMoon ? 0.35 * nightF : 1) * (1 - st * 0.85));
  oceanUniforms.uDeep.value.copy(PAL.deep).lerp(PAL.stormDeep, st);
  oceanUniforms.uShallow.value.copy(PAL.shallow).lerp(PAL.stormShallow, st);
  oceanUniforms.uLight.value = (0.07 + 0.93 * dayF) * (1 - st * 0.35) + state.flash * 2;
  oceanUniforms.uMaxH.value = maxWaveHeight();

  sun.position.set(B.x + lightDir.x * 300, lightDir.y * 300, B.z + lightDir.z * 300);
  sun.target.position.set(B.x, 0, B.z);
  sun.color.copy(useMoon ? PAL.moon : sunCol);
  sun.intensity = useMoon ? 0.35 * nightF * (1 - st) : 2.8 * smooth(-0.05, 0.12, e) * (1 - st * 0.7);
  hemi.color.copy(top).lerp(hor, 0.5);
  hemi.groundColor.set('#6f8a99').multiplyScalar(0.25 + 0.75 * dayF);
  hemi.intensity = (0.35 + 1.25 * dayF) * (1 - st * 0.1) + state.flash * 6;
  skyUniforms.uFlash.value = state.flash * 1.4;

  const lights = 1 - smooth(0.05, 0.3, dayF - st * 0.5);
  parts.searchlight.intensity = lights * 12000;
  parts.navGlow.forEach((m) => (m.opacity = lights));
  oceanUniforms.uHeadOn.value = lights;
  lighthouse.beamMat.opacity = lights * 0.1;
  lighthouse.lampMat.emissiveIntensity = 0.3 + lights * 3;
  lighthouse.beam.rotation.y = time * 0.7;
  renderer.toneMappingExposure = lerp(0.95, 1.15, nightF);

  rainMat.opacity = smooth(0.5, 1, st) * 0.55;
  if (st > 0.7) {
    state.nextLightning -= dt;
    if (state.nextLightning <= 0) { state.nextLightning = rand(5, 14); state.flash = 1; sfx.thunder(rand(0.3, 1.6)); }
  }
  state.flash = Math.max(0, state.flash - dt * (state.flash > 0.5 ? 3 : 1.6));

  const hh = Math.floor(state.tod), mm = Math.floor((state.tod - hh) * 60);
  $('weatherLabel').textContent = `${W.name} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ---------- ship physics ----------
// tuned for a heavy battleship: ~27 kn flank, ~40 kn on "boiler overdrive"
const ACC = 4.0, DRAG = 0.0094, LIN = 0.05;
const HULL_CIRCLES = [[-28, 4.2], [-14, 5.4], [0, 5.6], [14, 5.2], [27, 3.6]];
let wakeTimer = 0, sprayTimer = 0, smokeTimer = 0;
function updateShip(dt) {
  const playing = state.mode === 'play';
  let thrIn = 0, steerIn = 0, boostIn = false;
  if (playing && !BT.over) {
    thrIn = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    steerIn = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    boostIn = !!(keys.ShiftLeft || keys.ShiftRight || touch.boost);
    if (touch.active) { thrIn = clamp(touch.thr * 1.3, -1, 1); steerIn = clamp(touch.steer * 1.2, -1, 1); }
    if (keys.KeyF || keys.Space) fireMain();
  } else if (!playing) { thrIn = 0.6; steerIn = 0.35; }
  // engine telegraph is slow on a battleship
  B.throttle = damp(B.throttle, thrIn, 1.3, dt);
  B.steer = damp(B.steer, steerIn, 1.6, dt);

  const sy = Math.sin(B.yaw), cy = Math.cos(B.yaw);
  const fx = sy, fz = cy, rx = -cy, rz = sy;
  let vF = B.vx * fx + B.vz * fz;
  let vR = B.vx * rx + B.vz * rz;

  B.boosting = boostIn && B.nitro > 0.02 && B.throttle > 0.2;
  if (B.boosting) B.nitro = Math.max(0, B.nitro - dt * 0.12);
  else B.nitro = Math.min(1, B.nitro + dt * 0.035);

  const thrust = B.throttle > 0 ? B.throttle * ACC * (B.boosting ? 1.65 : 1) : B.throttle * ACC * 0.5;
  vF += thrust * dt;
  vF -= (DRAG * vF * Math.abs(vF) + LIN * vF) * dt;
  vR *= Math.exp(-1.4 * dt);
  B.vx = fx * vF + rx * vR; B.vz = fz * vF + rz * vR;
  const turnScale = clamp(vF / 7, -0.6, 1) * (1 - 0.25 * clamp(vF / 22, 0, 1));
  B.yawRate = damp(B.yawRate, -B.steer * 0.2 * turnScale, 1.1, dt);
  B.yaw = wrapAngle(B.yaw + B.yawRate * dt);
  B.x += B.vx * dt; B.z += B.vz * dt;
  // edge of the operational area: a current pushes you back in
  {
    const ex = Math.max(0, Math.abs(B.x) - WORLD_X * 1.02), ez = Math.max(0, Math.abs(B.z) - WORLD_Z * 1.02);
    if (ex > 0 || ez > 0) {
      B.vx -= Math.sign(B.x) * ex * 0.06 * dt * 60 * dt; B.vz -= Math.sign(B.z) * ez * 0.06 * dt * 60 * dt;
      B.x -= Math.sign(B.x) * Math.min(ex, 6 * dt); B.z -= Math.sign(B.z) * Math.min(ez, 6 * dt);
      if (playing && !state._edgeWarned) { state._edgeWarned = true; toast('離開作戰海域', '請返航', 'hot', 1200); setTimeout(() => (state._edgeWarned = false), 3000); }
    }
  }
  B.speed = Math.hypot(B.vx, B.vz); B.vF = vF;

  // collisions: hull approximated by circles along the keel
  for (const [oz, rad] of HULL_CIRCLES) {
    const px = B.x + fx * oz, pz = B.z + fz * oz;
    const solve = (cx, cz, R) => {
      const dx = px - cx, dz = pz - cz, d = Math.hypot(dx, dz);
      if (d >= R || d < 0.001) return;
      const nx = dx / d, nz = dz / d, pen = R - d;
      B.x += nx * pen; B.z += nz * pen;
      const vn = B.vx * nx + B.vz * nz;
      if (vn < 0) {
        B.vx -= nx * vn * 1.2; B.vz -= nz * vn * 1.2;
        B.vx *= 0.8; B.vz *= 0.8;
        B.yawRate += (oz > 0 ? 1 : -1) * (nx * rx + nz * rz) * vn * 0.004;
        if (-vn > 1.5) { state.shake = Math.min(1, -vn / 8); sfx.crash(); splashBurst(px - nx * 3, pz - nz * 3, 50, 7); if (playing) toast('擱淺！', '小心島嶼', 'hot', 900); }
      }
    };
    for (const is of islands) {
      const dx = px - is.x, dz = pz - is.z;
      if (Math.abs(dx) > is.r * 1.4 + 10 || Math.abs(dz) > is.r * 1.4 + 10) continue;
      solve(is.x, is.z, islandR(is, Math.atan2(dz, dx)) * 0.98 + rad);
    }
    for (const r of rocks) solve(r.x, r.z, r.r + rad);
    for (const t of targets) if (t.alive) solve(t.x, t.z, 6 + rad);
  }

  // buoyancy & orientation (long hull averages the short chop)
  const hb = waterHeight(B.x + fx * 26, B.z + fz * 26);
  const hs = waterHeight(B.x - fx * 26, B.z - fz * 26);
  const hp = waterHeight(B.x - rx * 5, B.z - rz * 5);
  const hr = waterHeight(B.x + rx * 5, B.z + rz * 5);
  const hc = waterHeight(B.x, B.z);
  const H = (hb + hs + hp + hr + hc * 2) / 6 - 0.4;
  B.vy += ((H - B.y) * 6 - B.vy * 3.2) * dt;
  B.y += B.vy * dt;

  const wavePitch = Math.atan2(hb - hs, 52);
  const waveRoll = Math.atan2(hp - hr, 10);
  B.rollKick *= Math.exp(-1.5 * dt);
  B.pitch = damp(B.pitch, wavePitch + clamp(vF / 20, 0, 1.3) * 0.008, 1.4, dt);
  B.roll = damp(B.roll, waveRoll * 0.8 - B.steer * 0.035 * clamp(vF / 16, 0, 1.2) + B.rollKick * Math.cos(time * 3.2), 1.3, dt);

  ship.position.set(B.x, B.y, B.z);
  ship.rotation.set(-B.pitch, B.yaw, B.roll);
  if (BT.over) {
    // going down by the bow, listing to port
    const k = Math.min(BT.overT, 14);
    ship.position.y -= k * k * 0.09;
    ship.rotation.z += k * 0.045;
    ship.rotation.x += k * 0.018;
  }

  // ensign flutter
  const fp = parts.flag.geometry.attributes.position;
  for (let i = 0; i < fp.count; i++) { const x = fp.getX(i); fp.setZ(i, Math.sin(x * 3 + time * (6 + B.speed * 0.3)) * 0.15 * x); }
  fp.needsUpdate = true;

  // wake, bow wave, spray, funnel smoke
  const sp = B.speed;
  if (sp > 1) {
    wakeTimer -= dt;
    while (wakeTimer <= 0) {
      wakeTimer += clamp(2.6 / sp, 0.06, 0.25);
      const a = clamp(sp / 12, 0.3, 1);
      const sxp = B.x - fx * 35, szp = B.z - fz * 35;
      // propeller wash (4 screws)
      spawnWake(sxp + rx * rand(-2, 2), szp + rz * rand(-2, 2), -fx * 1.5, -fz * 1.5, 6, 3.2, rand(6, 9), a);
      for (const s of [-1, 1]) {
        spawnWake(sxp + rx * s * 4, szp + rz * s * 4, rx * s * (0.8 + sp * 0.05), rz * s * (0.8 + sp * 0.05), 5, 2.2, rand(7, 10), a * 0.7);
        // bow wave: the classic V
        spawnWake(B.x + fx * 30 + rx * s * 3.5, B.z + fz * 30 + rz * s * 3.5, rx * s * (1.5 + sp * 0.18), rz * s * (1.5 + sp * 0.18), 3.5, 2.6, rand(6, 9), a * 0.8);
        spawnWake(B.x + fx * 10 + rx * s * 5.6, B.z + fz * 10 + rz * s * 5.6, rx * s * (0.6 + sp * 0.06), rz * s * (0.6 + sp * 0.06), 3, 1.6, rand(4, 6), a * 0.45);
      }
    }
    sprayTimer -= dt;
    while (sprayTimer <= 0) {
      sprayTimer += 0.02;
      if (sp > 4) {
        const s = rng() < 0.5 ? -1 : 1, k = sp / 16;
        const off = rand(26, 33);
        const hw = (36 - off) * 0.42 + 0.4;
        spawnSpray(B.x + fx * off + rx * s * hw, B.y + rand(0, 1.5), B.z + fz * off + rz * s * hw,
          rx * s * rand(2, 6) * k + B.vx * 0.8, rand(2, 6) * k * (1 + waveAmp * 0.6), rz * s * rand(2, 6) * k + B.vz * 0.8, rand(0.6, 1.2));
      }
      spawnSpray(B.x - fx * 36 + rx * rand(-3, 3), B.y + 0.2, B.z - fz * 36 + rz * rand(-3, 3), -fx * rand(1, 4), rand(0.5, 3) * clamp(sp / 10, 0.3, 1.4), -fz * rand(1, 4), rand(0.5, 1));
    }
  }
  smokeTimer -= dt;
  if (smokeTimer <= 0) {
    smokeTimer = B.boosting ? 0.07 : 0.16;
    parts.funnelTop.getWorldPosition(_p);
    const dark = B.boosting ? '#2a2a2a' : '#5b5d60';
    spawnSmoke(_p.x, _p.y + 1, _p.z, B.vx * 0.85 + 2.5, rand(4, 6), B.vz * 0.85 + 1.2, 2.5, B.boosting ? 3 : 2, rand(4, 6), B.boosting ? 0.6 : 0.3, dark);
  }
  sfx.update(sp, B.throttle, B.boosting ? 1 : 0, state.storm);
}

// ---------- gunnery ----------
const raycaster = new THREE.Raycaster();
const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ndc = new THREE.Vector2();
const MAX_RANGE = 1900;
function updateAim(dt) {
  aimValid = false;
  if (state.mode !== 'play') { reticle.visible = false; return; }
  if (state.camMode === 3) { reticle.visible = false; }
  if (mouse.has && !isTouch) _ndc.set(mouse.x, mouse.y); else _ndc.set(0, 0.12);
  raycaster.setFromCamera(_ndc, camera);
  const hit = raycaster.ray.intersectPlane(waterPlane, tmpV);
  let dx, dz;
  if (hit) { dx = tmpV.x - B.x; dz = tmpV.z - B.z; }
  else { dx = raycaster.ray.direction.x; dz = raycaster.ray.direction.z; const l = Math.hypot(dx, dz) || 1; dx = dx / l * MAX_RANGE; dz = dz / l * MAX_RANGE; }
  let dist = Math.hypot(dx, dz);
  if (dist > MAX_RANGE) { dx *= MAX_RANGE / dist; dz *= MAX_RANGE / dist; dist = MAX_RANGE; }
  if (dist < 80) { const l = dist || 1; dx = dx / l * 80; dz = dz / l * 80; dist = 80; }
  aim.set(B.x + dx, 0, B.z + dz);
  // lock-on: snap to the nearest enemy near the cursor and lead it
  const lockE = findLock(aim, dist);
  BT.lock = lockE;
  if (lockE) {
    leadPoint(lockE, aim);
    dist = Math.hypot(aim.x - B.x, aim.z - B.z);
  }
  aim.y = waterHeight(aim.x, aim.z) + 0.3;
  reticle.material.color.set(lockE ? '#ffcf4a' : '#ff5a3d');
  reticle.visible = state.camMode !== 3;
  reticle.position.copy(aim);
  const sc = 1 + dist / 300;
  reticle.scale.setScalar(sc);
  reticle.rotation.y += dt * 0.8;
  aimValid = true;

  // turret training
  const shipYaw = B.yaw;
  let readyCount = 0;
  for (const t of parts.turrets) {
    t.grp.getWorldPosition(_p);
    const ddx = aim.x - _p.x, ddz = aim.z - _p.z;
    const worldYaw = Math.atan2(ddx, ddz);
    let rel = wrapAngle(worldYaw - shipYaw - t.base);
    const limit = 2.55;
    const inArc = Math.abs(rel) < limit;
    rel = clamp(rel, -limit, limit);
    const step = (t.main ? 0.75 : 1.2) * dt;
    t.yaw += clamp(wrapAngle(rel - t.yaw), -step, step);
    t.yawG.rotation.y = t.base + t.yaw;
    const d = Math.hypot(ddx, ddz);
    const elev = solveElev(d, t.main ? SHELL_V : SHELL_V * 0.9, Math.max(1, _p.y + 2 - aim.y));
    t.elev = damp(t.elev, elev, 3, dt);
    t.pitch.rotation.x = -t.elev;
    t.ready = inArc && Math.abs(wrapAngle(rel - t.yaw)) < 0.05;
    if (t.main && t.ready) readyCount++;
  }
  state.mainReady = readyCount;
  $('aimInfo').textContent = `${lockE ? '🎯 鎖定 ' + lockE.T.name + ' · ' : ''}${Math.round(dist)} m · ${readyCount}/3 砲塔`;
}
function fireTurret(t) {
  const shipYaw = B.yaw;
  const yawW = shipYaw + t.base + t.yaw;
  t.muzzles.forEach((mz, i) => {
    const s = shells.find((s) => !s.alive);
    mz.getWorldPosition(_p);
    const delay = i * 0.06;
    const el = t.elev + rand(-0.004, 0.004);
    const yw = yawW + rand(-0.006, 0.006);
    const v = (t.main ? SHELL_V : SHELL_V * 0.9) * (1 + rand(-0.008, 0.008));
    if (s) {
      Object.assign(s, { alive: true, x: _p.x, y: _p.y, z: _p.z, vx: Math.sin(yw) * Math.cos(el) * v + B.vx, vy: Math.sin(el) * v, vz: Math.cos(yw) * Math.cos(el) * v + B.vz, t: -delay, main: t.main });
      s.m.position.set(_p.x, _p.y, _p.z); s.m.visible = false;
    }
    // muzzle blast: flash + smoke cloud
    const dx = Math.sin(yw), dz = Math.cos(yw);
    const big = t.main ? 1 : 0.45;
    spawnSmoke(_p.x + dx * 3, _p.y, _p.z + dz * 3, dx * 30 * big, 2, dz * 30 * big, 4 * big, 18 * big, 0.25, 1, '#ffc060', true);
    for (let k = 0; k < 3; k++) spawnSmoke(_p.x + dx * (4 + k * 4) * big, _p.y + rand(-1, 1), _p.z + dz * (4 + k * 4) * big, dx * rand(6, 14) * big + rand(-1, 1), rand(0.5, 2), dz * rand(6, 14) * big + rand(-1, 1), 5 * big, 9 * big, rand(3, 5), 0.6, '#d8d4cc');
    // pressure wave flattens the sea under the guns
    if (t.main) spawnWake(_p.x + dx * 10, _p.z + dz * 10, dx * 3, dz * 3, 12, 8, 2.5, 0.6);
  });
  flashLight.position.copy(_p); flashLight.intensity = t.main ? 80000 : 15000;
  if (t.main) {
    // recoil heels the ship away from the broadside
    const side = Math.sin(t.base + t.yaw);
    B.rollKick += side * 0.035;
    state.shake = Math.max(state.shake, 0.35);
  }
}
function fireMain() {
  if (state.mode !== 'play' || BT.over || state.reload < 1 || !aimValid) return;
  const ready = parts.turrets.filter((t) => t.main && t.ready);
  if (!ready.length) { if (!state._warned) { toast('砲塔尚未就位', '把準星移到砲塔射界內', 'hot', 900); state._warned = true; setTimeout(() => (state._warned = false), 1500); } return; }
  state.reload = 0;
  ready.forEach(fireTurret);
  sfx.cannon(true);
}
function fireSecondary() {
  if (state.mode !== 'play' || BT.over || state.reload2 < 1 || !aimValid) return;
  const ready = parts.turrets.filter((t) => !t.main && t.ready);
  if (!ready.length) return;
  state.reload2 = 0;
  ready.forEach(fireTurret);
  sfx.cannon(false);
}
function updateShells(dt) {
  state.reload = Math.min(1, state.reload + dt / 3.0);
  state.reload2 = Math.min(1, state.reload2 + dt / 1.2);
  for (const s of shells) {
    if (!s.alive) continue;
    s.t += dt;
    if (s.t < 0) continue;
    s.m.visible = true;
    s.vy -= G * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    s.m.position.set(s.x, s.y, s.z);
    if (rng() < 0.6) spawnSpray(s.x, s.y, s.z, rand(-0.5, 0.5), rand(-0.5, 0.5), rand(-0.5, 0.5), 0.5, 0.9, 0.55, 0.25);
    const dist = Math.hypot(s.x - camera.position.x, s.z - camera.position.z);
    // enemy warships & torpedoes
    let done = shellVsEnemies(s, dist);
    if (!done) for (const t of targets) {
      if (!t.alive) continue;
      const r = s.main ? 14 : 9;
      if (Math.hypot(s.x - t.x, s.z - t.z) < r && s.y < waterHeight(t.x, t.z) + 14) {
        t.alive = false; t.sink = 0; t.respawn = 25;
        explosion(t.x, waterHeight(t.x, t.z) + 2, t.z, 1.2);
        shellSplash(s.x, s.z);
        sfx.boom(dist);
        state.kills++;
        toast('命中！', `擊沉標靶 ${state.kills}`, 'gold', 1400);
        B.nitro = Math.min(1, B.nitro + 0.15);
        done = true; break;
      }
    }
    if (!done) {
      const th = terrainHeight(s.x, s.z);
      if (th > -Infinity && s.y < th) {
        explosion(s.x, th, s.z, s.main ? 1 : 0.5); sfx.boom(dist); done = true;
      } else if (s.y < waterHeight(s.x, s.z)) {
        if (s.main) shellSplash(s.x, s.z); else splashBurst(s.x, s.z, 40, 10, 4);
        sfx.distSplash(dist); done = true;
      }
    }
    if (done || s.t > 30) { s.alive = false; s.m.visible = false; }
  }
}

// ---------- naval combat (battle mode) ----------
// Elevation that lands a shell fired from height h at horizontal distance D.
function solveElev(D, v, h) {
  let lo = -0.06, hi = 0.785;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2, vs = v * Math.sin(m), vc = v * Math.cos(m);
    const R = (vc * (vs + Math.sqrt(Math.max(0, vs * vs + 2 * G * h)))) / G;
    if (R < D) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}
// distance from a point to a hull's keel line (capsule test)
function keelDist(px, pz, cx, cz, fx, fz, half) {
  const dx = px - cx, dz = pz - cz;
  const along = clamp(dx * fx + dz * fz, -half, half);
  return Math.hypot(dx - fx * along, dz - fz * along);
}
const playerKeel = (x, z) => keelDist(x, z, B.x, B.z, Math.sin(B.yaw), Math.cos(B.yaw), 33);

const ETYPES = {
  dd: { key: 'dd', name: '驅逐艦', len: 26, beam: 2.6, hp: 2, speed: 14, turn: 0.32, range: [240, 470], gunEvery: 3.6, gunN: 1, gunDmg: 3, gunV: 115, torpEvery: 12, score: 100, col: '#56606a' },
  ca: { key: 'ca', name: '巡洋艦', len: 40, beam: 3.6, hp: 5, speed: 10.5, turn: 0.2, range: [420, 720], gunEvery: 5.5, gunN: 3, gunDmg: 6, gunV: 135, torpEvery: 0, score: 250, col: '#646c73' },
  bb: { key: 'bb', name: '敵旗艦', len: 60, beam: 5.0, hp: 26, speed: 7.5, turn: 0.12, range: [520, 880], gunEvery: 6.5, gunN: 6, gunDmg: 8, gunV: 150, torpEvery: 0, score: 1500, col: '#4b5258' },
};
const enemyTemplates = {};
function enemyTemplate(T) {
  if (enemyTemplates[T.key]) return enemyTemplates[T.key];
  const grp = new THREE.Group();
  const L = T.len, W = T.beam, h = L / 2, hh = 1.6 + L * 0.04, deckY = hh - 1.2;
  const M = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const hullM = M(T.col), darkM = M('#24282c'), lightM = M('#8f979e'), redM = M('#6e2a22');
  const add = (geo, mat, x, y, z, parent = grp) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  const box = (w, hgt, d) => new THREE.BoxGeometry(w, hgt, d);
  const cyl = (a, b, hgt, s = 10) => new THREE.CylinderGeometry(a, b, hgt, s);
  const sh = new THREE.Shape();
  sh.moveTo(0, h);
  sh.quadraticCurveTo(W * 0.85, h * 0.55, W, h * 0.1);
  sh.lineTo(W * 0.95, -h * 0.7);
  sh.quadraticCurveTo(W * 0.7, -h, 0, -h);
  sh.quadraticCurveTo(-W * 0.7, -h, -W * 0.95, -h * 0.7);
  sh.lineTo(-W, h * 0.1);
  sh.quadraticCurveTo(-W * 0.85, h * 0.55, 0, h);
  const hg = new THREE.ExtrudeGeometry(sh, { depth: hh, bevelEnabled: false, curveSegments: 10 });
  hg.rotateX(Math.PI / 2); hg.translate(0, deckY, 0);
  add(hg, hullM, 0, 0, 0);
  const bg = new THREE.ExtrudeGeometry(sh, { depth: 0.5, bevelEnabled: false, curveSegments: 10 });
  bg.rotateX(Math.PI / 2); bg.scale(1.02, 1, 1.005); bg.translate(0, -0.05, 0);
  add(bg, redM, 0, 0, 0); // boot-top stripe at the waterline
  // superstructure
  const sH = L * 0.06 + 1;
  add(box(W * 1.1, sH, L * 0.24), hullM, 0, deckY + sH / 2, L * 0.06);
  add(box(W * 0.95, 1.6, L * 0.07), lightM, 0, deckY + sH + 0.8, L * 0.14);
  add(box(W * 0.97, 0.4, L * 0.072), darkM, 0, deckY + sH + 1.1, L * 0.14);
  if (T.key !== 'dd') add(box(W * 0.7, 2.6 + L * 0.03, L * 0.06), hullM, 0, deckY + sH + 2.9, L * 0.12);
  add(cyl(0.12, 0.16, L * 0.2, 6), darkM, 0, deckY + sH + L * 0.12, L * 0.11);
  const funnels = T.key === 'dd' ? [-L * 0.02, -L * 0.12] : [-L * 0.06];
  for (const fz of funnels) {
    const f = add(cyl(W * 0.26, W * 0.32, L * 0.1 + 1.5, 12), hullM, 0, deckY + sH + L * 0.03, fz);
    f.rotation.x = -0.2;
    add(cyl(W * 0.27, W * 0.27, 0.4, 12), darkM, 0, deckY + sH + L * 0.08 + 0.7, fz - 0.4).rotation.x = -0.2;
  }
  // turrets that train on the player
  const tz = T.key === 'dd' ? [h * 0.58, -h * 0.62] : [h * 0.62, h * 0.4, -h * 0.6];
  const nb = T.key === 'dd' ? 1 : T.key === 'ca' ? 2 : 3;
  const ts = T.key === 'bb' ? 1.25 : 1;
  tz.forEach((z, i) => {
    const raised = T.key !== 'dd' && i === 1 ? 1.2 : 0;
    const g = new THREE.Group(); g.position.set(0, deckY + raised, z); grp.add(g);
    g.userData.turret = true; g.userData.base = z < 0 ? Math.PI : 0;
    g.rotation.y = g.userData.base;
    add(box(W * 0.9 * ts, 1.2 * ts, W * 1.05 * ts), hullM, 0, 0.6 * ts, 0, g);
    for (let b = 0; b < nb; b++) {
      const bx = (b - (nb - 1) / 2) * 0.55 * ts;
      const bl = L * 0.07 + 2;
      const bar = add(cyl(0.12 * ts, 0.17 * ts, bl, 6), darkM, bx, 0.75 * ts, W * 0.5 * ts + bl / 2, g);
      bar.rotation.x = Math.PI / 2 - 0.05;
    }
  });
  grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  enemyTemplates[T.key] = grp;
  return grp;
}

const enemies = [];
const BT = {
  on: false, phase: 'break', timer: 0, wave: 0, hp: 100, maxHp: 100,
  score: 0, combo: 1, comboT: 0, best: store.get('tb_battle_best', 0), bestWave: store.get('tb_battle_wave', 0),
  over: false, overT: 0, hurt: 0, lock: null, ramCd: 0, fireT: 0, torpWarn: 0, alarmCd: 0, hitFlash: 0,
};

// enemy shells (red tracers) with impact-warning rings on the water
const eshells = [];
const RING_GEO = (() => { const g = new THREE.RingGeometry(0.82, 1, 36); g.rotateX(-Math.PI / 2); return g; })();
{
  const geo = new THREE.SphereGeometry(0.45, 8, 6);
  const mat = new THREE.MeshBasicMaterial({ color: '#ff9a8a', fog: false });
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(geo, mat); m.visible = false;
    const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: '#ff4a2a', blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.95 }));
    g.scale.setScalar(5); m.add(g);
    scene.add(m);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#ff3a24', transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    const ring = new THREE.Mesh(RING_GEO, ringMat); ring.visible = false; scene.add(ring);
    eshells.push({ m, ring, ringMat, alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, T: 1, dmg: 0, tx: 0, tz: 0, whistled: false });
  }
}
function fireEnemyShell(fx, fy, fz, tx, tz, v, dmg, delay) {
  const s = eshells.find((q) => !q.alive); if (!s) return;
  const dx = tx - fx, dz = tz - fz, D = Math.hypot(dx, dz);
  const el = solveElev(D, v, Math.max(1, fy));
  const yw = Math.atan2(dx, dz);
  Object.assign(s, {
    alive: true, x: fx, y: fy, z: fz, t: -delay, dmg, tx, tz, whistled: false,
    vx: Math.sin(yw) * Math.cos(el) * v, vy: Math.sin(el) * v, vz: Math.cos(yw) * Math.cos(el) * v,
    T: D / (v * Math.cos(el)) + delay,
  });
  s.m.position.set(fx, fy, fz); s.m.visible = false;
  s.ring.visible = true; s.ringMat.opacity = 0;
}
function killEShell(s) { s.alive = false; s.m.visible = false; s.ring.visible = false; }

// torpedoes: hard to see, leave a bubbling track
const torps = [];
{
  const geo = new THREE.CylinderGeometry(0.35, 0.35, 6, 8); geo.rotateX(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: '#1d2228', roughness: 0.5 });
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(geo, mat); m.visible = false; scene.add(m);
    torps.push({ m, alive: false, x: 0, z: 0, dx: 0, dz: 1, v: 17, life: 0, bub: 0, warned: false });
  }
}
function launchTorpedo(x, z, ang) {
  const t = torps.find((q) => !q.alive); if (!t) return;
  Object.assign(t, { alive: true, x, z, dx: Math.sin(ang), dz: Math.cos(ang), v: 17 + BT.wave * 0.3, life: 40, bub: 0, warned: false });
  t.m.visible = true; t.m.rotation.y = ang;
}

// DOM markers for enemies (on-screen tag or edge arrow)
const markerRoot = $('markers');
function makeMarker() {
  const d = document.createElement('div'); d.className = 'mk';
  d.innerHTML = '<div class="arr"></div><div class="tag"><span class="nm"></span> <span class="ds"></span></div><div class="hpb"><i></i></div>';
  markerRoot.appendChild(d);
  return { el: d, nm: d.querySelector('.nm'), ds: d.querySelector('.ds'), hp: d.querySelector('.hpb i'), arr: d.querySelector('.arr') };
}

function spawnEnemy(key) {
  const T = ETYPES[key];
  const grp = enemyTemplate(T).clone(true);
  grp.rotation.order = 'YXZ';
  const turrets = [];
  grp.traverse((o) => { if (o.userData.turret) turrets.push({ g: o, base: o.userData.base }); });
  let x = 0, z = 0, ok = false;
  for (let t = 0; t < 160 && !ok; t++) {
    const a = rand(0, Math.PI * 2), d = rand(780, 1100);
    x = B.x + Math.cos(a) * d; z = B.z + Math.sin(a) * d;
    if (Math.abs(x) > WORLD_X * 0.95 || Math.abs(z) > WORLD_Z * 0.95) continue;
    if (islands.some((o) => Math.hypot(o.x - x, o.z - z) < o.r * 1.35 + T.len)) continue;
    if (rocks.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + T.len)) continue;
    if (enemies.some((o) => o.alive && Math.hypot(o.x - x, o.z - z) < 120)) continue;
    ok = true;
  }
  if (!ok) { const p = freeSpot(60); x = p.x; z = p.z; }
  scene.add(grp);
  const hp = T.hp * (1 + Math.max(0, BT.wave - 5) * 0.08);
  const e = {
    T, grp, turrets, x, z, y: 0, yaw: Math.atan2(B.x - x, B.z - z), speed: T.speed * 0.6, pitch: 0, roll: 0,
    hp, maxHp: hp, alive: true, sinkT: 0, side: rng() < 0.5 ? -1 : 1, sideT: rand(15, 30),
    gunT: rand(3, T.gunEvery + 3), torpT: rand(5, 9), wakeT: 0, mk: makeMarker(),
  };
  e.mk.nm.textContent = T.name;
  if (key === 'bb') e.mk.el.classList.add('boss');
  enemies.push(e);
  return e;
}
function removeEnemy(e) {
  scene.remove(e.grp);
  if (e.mk) e.mk.el.remove();
  const i = enemies.indexOf(e); if (i >= 0) enemies.splice(i, 1);
}
function waveRoster(n) {
  if (n % 5 === 0) {
    const r = ['bb']; for (let i = 0; i < Math.min(4, 1 + n / 5); i++) r.push('dd');
    if (n >= 10) r.push('ca');
    return r;
  }
  const dd = Math.min(5, 1 + Math.floor((n + 1) / 2)), ca = Math.min(3, Math.floor(n / 2));
  const r = [];
  for (let i = 0; i < dd; i++) r.push('dd');
  for (let i = 0; i < ca; i++) r.push('ca');
  return r;
}

// player shells vs enemies / torpedoes. returns true if the shell was consumed.
function shellVsEnemies(s, camDist) {
  if (!BT.on) return false;
  const wy = waterHeight(s.x, s.z);
  for (const e of enemies) {
    if (!e.alive) continue;
    const T = e.T;
    if (Math.abs(s.x - e.x) > T.len && Math.abs(s.z - e.z) > T.len) continue;
    const kd = keelDist(s.x, s.z, e.x, e.z, Math.sin(e.yaw), Math.cos(e.yaw), T.len / 2);
    if (kd < T.beam + (s.main ? 5 : 3) && s.y < wy + T.len * 0.12 + 6) {
      damageEnemy(e, s.main ? 1 : 0.4, s.x, Math.max(wy + 2, s.y), s.z);
      sfx.boom(camDist);
      return true;
    }
  }
  if (s.y < wy + 2) {
    for (const t of torps) {
      if (!t.alive) continue;
      if (Math.hypot(t.x - s.x, t.z - s.z) < (s.main ? 14 : 10)) {
        t.alive = false; t.m.visible = false;
        splashBurst(t.x, t.z, 60, 9, 6); explosion(t.x, wy, t.z, 0.5);
        BT.score += 25; toast('擊毀魚雷', '+25', 'cyan', 800);
        return false; // shell still splashes normally
      }
    }
  }
  return false;
}
function damageEnemy(e, dmg, x, y, z) {
  e.hp -= dmg;
  explosion(x, y, z, 0.7);
  BT.hitFlash = 1;
  sfx.tone(1600, 0.08, 0.12, 'square');
  if (e.hp <= 0 && e.alive) killEnemy(e);
}
function killEnemy(e) {
  e.alive = false; e.sinkT = 0;
  const wy = waterHeight(e.x, e.z);
  explosion(e.x, wy + 4, e.z, e.T.key === 'bb' ? 2.4 : 1.6);
  setTimeout(() => explosion(e.x + rand(-8, 8), wy + 3, e.z + rand(-8, 8), 1.2), 350);
  sfx.boom(Math.hypot(e.x - camera.position.x, e.z - camera.position.z) * 0.5);
  BT.combo = BT.comboT > 0 ? Math.min(BT.combo + 1, 8) : 1;
  BT.comboT = 12;
  const pts = e.T.score * BT.combo;
  BT.score += pts; state.kills++;
  toast(`擊沉${e.T.name}！`, `+${pts}${BT.combo > 1 ? `　連擊 x${BT.combo}` : ''}`, 'gold', 1600);
  B.nitro = Math.min(1, B.nitro + 0.3);
  // drop a supply crate where she went down
  const c = coins.find((q) => !q.alive) || coins[Math.floor(rng() * coins.length)];
  c.x = e.x + rand(-6, 6); c.z = e.z + rand(-6, 6); c.alive = true; c.m.visible = true; c.respawn = 0;
  if (e.mk) e.mk.el.style.display = 'none';
}
function hurtPlayer(dmg, x, y, z) {
  if (!BT.on || BT.over) return;
  BT.hp = Math.max(0, BT.hp - dmg);
  BT.hurt = Math.min(1, BT.hurt + 0.45 + dmg / 30);
  state.shake = Math.max(state.shake, 0.45 + dmg / 25);
  B.rollKick += rand(-0.03, 0.03);
  explosion(x, y, z, 0.6 + dmg / 20);
  sfx.hit();
  if (BT.hp <= 0) gameOver();
}
function gameOver() {
  BT.over = true; BT.overT = 0; BT.lock = null;
  const rec = BT.score > BT.best;
  if (rec) { BT.best = BT.score; store.set('tb_battle_best', BT.score); }
  if (BT.wave > BT.bestWave) { BT.bestWave = BT.wave; store.set('tb_battle_wave', BT.wave); }
  $('overScore').textContent = BT.score;
  $('overWave').textContent = BT.wave;
  $('overKills').textContent = state.kills;
  $('overBest').textContent = rec ? `${BT.best}（新紀錄！）` : BT.best;
  toast('大和 沉沒…', '艦體已無法維持', 'hot', 3200);
  sfx.horn();
}
function clearBattle() {
  while (enemies.length) removeEnemy(enemies[0]);
  for (const s of eshells) killEShell(s);
  for (const t of torps) { t.alive = false; t.m.visible = false; }
  $('over').classList.add('hidden');
  $('warn').classList.add('hidden');
}
function resetBattle() {
  clearBattle();
  Object.assign(BT, { phase: 'break', timer: 3, wave: 0, hp: BT.maxHp, score: 0, combo: 1, comboT: 0, over: false, overT: 0, hurt: 0, lock: null, torpWarn: 0 });
  state.kills = 0; state.reload = 1; B.nitro = 1;
  resetShip();
}

function findLock(p, dist) {
  if (!BT.on || BT.over) return null;
  let best = null, bd = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const de = Math.hypot(e.x - B.x, e.z - B.z);
    if (de > MAX_RANGE) continue;
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    const thr = 45 + de * 0.07 + (BT.lock === e ? 45 : 0);
    if (d < thr && d < bd) { bd = d; best = e; }
  }
  void dist;
  return best;
}
// where to aim so a main-battery shell meets enemy e (shells inherit our own velocity)
function leadPoint(e, out) {
  const evx = Math.sin(e.yaw) * e.speed, evz = Math.cos(e.yaw) * e.speed;
  let px = e.x, pz = e.z;
  for (let k = 0; k < 4; k++) {
    const D = Math.hypot(px - B.x, pz - B.z);
    const el = solveElev(D, SHELL_V, 12);
    const tf = D / (SHELL_V * Math.cos(el));
    px = e.x + (evx - B.vx) * tf; pz = e.z + (evz - B.vz) * tf;
  }
  out.set(px, 0, pz);
}

function updateEnemy(e, dt) {
  const T = e.T;
  const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
  if (!e.alive) {
    e.sinkT += dt;
    e.grp.position.set(e.x, waterHeight(e.x, e.z) - 0.4 - e.sinkT * e.sinkT * 0.12, e.z);
    e.grp.rotation.set(-e.pitch - e.sinkT * 0.05, e.yaw, e.roll + e.sinkT * 0.09 * e.side);
    if (e.sinkT < 7 && rng() < 0.5) {
      spawnSmoke(e.x + fx * rand(-T.len / 3, T.len / 3), waterHeight(e.x, e.z) + 3, e.z + fz * rand(-T.len / 3, T.len / 3), rand(-1, 1), rand(3, 5), rand(-1, 1), 4, 7, rand(4, 6), 0.55, '#262626');
      if (rng() < 0.3) spawnSmoke(e.x, waterHeight(e.x, e.z) + 2, e.z, 0, 3, 0, 2, 4, 0.6, 0.9, '#ff8030', true);
    }
    if (e.sinkT > 10) removeEnemy(e);
    return;
  }
  const dx = B.x - e.x, dz = B.z - e.z, d = Math.hypot(dx, dz) || 1;
  const ux = dx / d, uz = dz / d;
  const [rmin, rmax] = T.range;
  e.sideT -= dt; if (e.sideT <= 0) { e.sideT = rand(15, 30); e.side *= -1; }
  const px = -uz * e.side, pz = ux * e.side;
  let tx, tz;
  if (BT.over) { tx = px; tz = pz; }
  else if (d > rmax) { tx = ux * 0.9 + px * 0.3; tz = uz * 0.9 + pz * 0.3; }
  else if (d < rmin) { tx = -ux * 0.6 + px * 0.8; tz = -uz * 0.6 + pz * 0.8; }
  else { const k = ((d - (rmin + rmax) / 2) / (rmax - rmin)) * 0.8; tx = px + ux * k; tz = pz + uz * k; }
  // island / rock avoidance using a look-ahead point
  const ax = e.x + fx * (T.len + 60), az = e.z + fz * (T.len + 60);
  for (const o of islands) {
    const R = o.r * 1.35 + 40 + T.len * 0.5;
    for (const [qx, qz, w] of [[e.x, e.z, 2], [ax, az, 1.4]]) {
      const ox = qx - o.x, oz = qz - o.z, od = Math.hypot(ox, oz);
      if (od < R) { const s = ((R - od) / R) * w * 3; tx += (ox / od) * s; tz += (oz / od) * s; }
    }
  }
  for (const o of rocks) {
    const ox = ax - o.x, oz = az - o.z, od = Math.hypot(ox, oz);
    if (od < o.r + 40) { tx += (ox / od) * 1.5; tz += (oz / od) * 1.5; }
  }
  for (const o of enemies) {
    if (o === e || !o.alive) continue;
    const ox = e.x - o.x, oz = e.z - o.z, od = Math.hypot(ox, oz);
    if (od < 90 && od > 0.01) { tx += (ox / od) * (90 - od) / 45; tz += (oz / od) * (90 - od) / 45; }
  }
  if (Math.abs(e.x) > WORLD_X * 0.92) tx -= Math.sign(e.x) * 2;
  if (Math.abs(e.z) > WORLD_Z * 0.92) tz -= Math.sign(e.z) * 2;
  const want = Math.atan2(tx, tz);
  const turn = T.turn * (0.4 + 0.6 * clamp(e.speed / T.speed, 0, 1));
  e.yaw = wrapAngle(e.yaw + clamp(wrapAngle(want - e.yaw), -turn * dt, turn * dt));
  e.speed = damp(e.speed, T.speed * (1 + Math.min(BT.wave, 15) * 0.015), 0.4, dt);
  e.x += Math.sin(e.yaw) * e.speed * dt; e.z += Math.cos(e.yaw) * e.speed * dt;
  // hard collision with islands
  for (const o of islands) {
    const ox = e.x - o.x, oz = e.z - o.z, od = Math.hypot(ox, oz), R = islandR(o, Math.atan2(oz, ox)) + T.beam + 4;
    if (od < R) { e.x = o.x + (ox / od) * R; e.z = o.z + (oz / od) * R; e.speed *= 0.95; }
  }
  // ramming / contact with the player
  const nfx = Math.sin(e.yaw), nfz = Math.cos(e.yaw);
  if (!BT.over) {
    for (const k of [-0.33, 0, 0.33]) {
      const cx = e.x + nfx * T.len * k, cz = e.z + nfz * T.len * k;
      const pd = playerKeel(cx, cz), R = 5.6 + T.beam + 1;
      if (pd < R) {
        const ox = cx - B.x, oz = cz - B.z, ol = Math.hypot(ox, oz) || 1;
        e.x += (ox / ol) * (R - pd) * 0.8; e.z += (oz / ol) * (R - pd) * 0.8;
        B.x -= (ox / ol) * (R - pd) * 0.2; B.z -= (oz / ol) * (R - pd) * 0.2;
        const rel = Math.hypot(B.vx - nfx * e.speed, B.vz - nfz * e.speed);
        if (BT.ramCd <= 0 && rel > 3) {
          BT.ramCd = 1.5;
          sfx.crash(); state.shake = Math.max(state.shake, 0.7);
          toast('衝撞！', `${T.name}受到重創`, 'gold', 1000);
          hurtPlayer(T.key === 'bb' ? 10 : 3, cx, waterHeight(cx, cz) + 3, cz);
          damageEnemy(e, T.key === 'bb' ? 3 : rel > 8 ? 99 : 2, cx, waterHeight(cx, cz) + 3, cz);
          if (!e.alive) return;
        }
        break;
      }
    }
  }
  // float on the waves
  const hb = waterHeight(e.x + nfx * T.len * 0.4, e.z + nfz * T.len * 0.4);
  const hs = waterHeight(e.x - nfx * T.len * 0.4, e.z - nfz * T.len * 0.4);
  const hc = waterHeight(e.x, e.z);
  e.y = damp(e.y, (hb + hs + hc) / 3 - 0.3, 5, dt);
  e.pitch = damp(e.pitch, Math.atan2(hb - hs, T.len * 0.8), 2, dt);
  e.roll = damp(e.roll, Math.sin(time * 0.9 + e.side) * 0.04 * (1 + waveAmp), 2, dt);
  e.grp.position.set(e.x, e.y, e.z);
  e.grp.rotation.set(-e.pitch, e.yaw, e.roll);
  // turrets track the player
  for (const t of e.turrets) {
    t.g.rotation.y = damp(t.g.rotation.y, t.base + wrapAngle(Math.atan2(dx, dz) - e.yaw - t.base), 2, dt);
  }
  // wake
  e.wakeT -= dt;
  if (e.wakeT <= 0 && Math.abs(e.x - camera.position.x) < 900 && Math.abs(e.z - camera.position.z) < 900) {
    e.wakeT = 0.18;
    const rx = -nfz, rz = nfx, h2 = T.len / 2;
    spawnWake(e.x - nfx * h2, e.z - nfz * h2, -nfx, -nfz, T.beam * 1.6, 2, rand(5, 7), 0.6);
    for (const s of [-1, 1]) spawnWake(e.x + nfx * h2 * 0.8 + rx * s * T.beam, e.z + nfz * h2 * 0.8 + rz * s * T.beam, rx * s * (1 + e.speed * 0.12), rz * s * (1 + e.speed * 0.12), 2.5, 1.8, rand(4, 6), 0.5);
  }
  if (BT.over) return;
  // guns
  const acc = Math.max(0.6, 1.35 - BT.wave * 0.06);
  e.gunT -= dt;
  if (e.gunT <= 0 && d < rmax * 1.3 && d > 60) {
    e.gunT = T.gunEvery * rand(0.85, 1.2);
    const v = T.gunV;
    const lead = rand(0.15, 1.1);
    for (let i = 0; i < T.gunN; i++) {
      const tr = e.turrets[i % e.turrets.length];
      tr.g.getWorldPosition(_p); _p.y += 1.5;
      let ax2 = B.x, az2 = B.z;
      for (let k = 0; k < 3; k++) {
        const D = Math.hypot(ax2 - _p.x, az2 - _p.z);
        const el = solveElev(D, v, _p.y);
        const tf = D / (v * Math.cos(el));
        ax2 = B.x + B.vx * tf * lead; az2 = B.z + B.vz * tf * lead;
      }
      const sc = (12 + d * 0.04) * acc, a = rand(0, Math.PI * 2), r = sc * Math.sqrt(rng());
      fireEnemyShell(_p.x, _p.y, _p.z, ax2 + Math.cos(a) * r, az2 + Math.sin(a) * r, v, T.gunDmg, i * 0.15);
      const yw = Math.atan2(B.x - _p.x, B.z - _p.z), mdx = Math.sin(yw), mdz = Math.cos(yw);
      spawnSmoke(_p.x + mdx * 4, _p.y, _p.z + mdz * 4, mdx * 12, 1, mdz * 12, 2.5, 8, 0.25, 1, '#ffb050', true);
      spawnSmoke(_p.x + mdx * 6, _p.y, _p.z + mdz * 6, mdx * 4, 1, mdz * 4, 3, 6, rand(2, 3), 0.5, '#cfcac0');
    }
    flashLight.position.set(e.x, e.y + 8, e.z); flashLight.intensity = Math.max(flashLight.intensity, 20000);
    sfx.enemyGun(Math.hypot(e.x - camera.position.x, e.z - camera.position.z));
  }
  // torpedoes
  if (T.torpEvery) {
    e.torpT -= dt;
    if (e.torpT <= 0 && d < 700 && d > 110) {
      e.torpT = T.torpEvery * rand(0.8, 1.25) * Math.max(0.6, 1 - BT.wave * 0.03);
      const tv = 17 + BT.wave * 0.3;
      let qx = B.x, qz = B.z;
      for (let k = 0; k < 3; k++) { const tf = Math.hypot(qx - e.x, qz - e.z) / tv; qx = B.x + B.vx * tf; qz = B.z + B.vz * tf; }
      const base = Math.atan2(qx - e.x, qz - e.z);
      const n = BT.wave >= 6 ? 4 : 3;
      for (let k = 0; k < n; k++) {
        const a = base + (k - (n - 1) / 2) * 0.07;
        launchTorpedo(e.x + Math.sin(a) * (T.beam + 3), e.z + Math.cos(a) * (T.beam + 3), a);
      }
      sfx.launch(Math.hypot(e.x - camera.position.x, e.z - camera.position.z));
    }
  }
}

function updateBattle(dt) {
  if (!BT.on) return;
  if (state.mode !== 'play') return;
  BT.hurt = Math.max(0, BT.hurt - dt * 1.4);
  BT.hitFlash = Math.max(0, BT.hitFlash - dt * 4);
  BT.ramCd -= dt; BT.alarmCd -= dt;
  if (BT.comboT > 0) { BT.comboT -= dt; if (BT.comboT <= 0) BT.combo = 1; }
  $('hurt').style.opacity = (BT.hurt * 0.85 + (BT.hp < 30 && !BT.over ? 0.18 + Math.sin(time * 5) * 0.08 : 0)).toFixed(3);

  // waves
  if (!BT.over) {
    if (BT.phase === 'break') {
      BT.timer -= dt;
      if (BT.timer <= 0) {
        BT.wave++; BT.phase = 'fight';
        const roster = waveRoster(BT.wave);
        roster.forEach(spawnEnemy);
        const boss = BT.wave % 5 === 0;
        toast(boss ? `第 ${BT.wave} 波 · 敵旗艦出現！` : `第 ${BT.wave} 波 來襲`, `敵艦 ${roster.length} 艘 · 看小地圖紅點`, boss ? 'hot' : 'cyan', 2400);
        sfx.alarm();
      }
    } else if (!enemies.some((e) => e.alive)) {
      BT.phase = 'break'; BT.timer = 7;
      const bonus = BT.wave * 200, heal = Math.min(BT.maxHp - BT.hp, 35);
      BT.score += bonus; BT.hp += heal;
      toast(`第 ${BT.wave} 波 殲滅！`, `獎勵 +${bonus}${heal > 0 ? `　艦體修復 +${Math.round(heal)}` : ''}`, 'gold', 2800);
      sfx.lap();
    }
  } else {
    BT.overT += dt;
    if (BT.overT > 3 && $('over').classList.contains('hidden')) $('over').classList.remove('hidden');
  }

  for (let i = enemies.length - 1; i >= 0; i--) updateEnemy(enemies[i], dt);

  // enemy shells
  const fx = Math.sin(B.yaw), fz = Math.cos(B.yaw);
  for (const s of eshells) {
    if (!s.alive) continue;
    s.t += dt;
    const p = clamp(s.t / s.T, 0, 1);
    s.ring.position.set(s.tx, waterHeight(s.tx, s.tz) + 0.5, s.tz);
    s.ring.scale.setScalar(lerp(34, 9, p));
    s.ringMat.opacity = 0.15 + 0.65 * p * p;
    if (s.t < 0) continue;
    s.m.visible = true;
    s.vy -= G * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    s.m.position.set(s.x, s.y, s.z);
    if (rng() < 0.5) spawnSpray(s.x, s.y, s.z, 0, 0, 0, 0.4, 1, 0.35, 0.2);
    if (!s.whistled && s.T - s.t < 1.2 && playerKeel(s.tx, s.tz) < 90) { s.whistled = true; sfx.whistle(); }
    const kd = playerKeel(s.x, s.z);
    const wy = waterHeight(s.x, s.z);
    if (!BT.over && kd < 7 && s.y < B.y + 15 && s.y > wy - 1) {
      hurtPlayer(s.dmg, s.x, Math.max(s.y, B.y + 5), s.z); killEShell(s); continue;
    }
    const th = terrainHeight(s.x, s.z);
    if (th > -Infinity && s.y < th) { explosion(s.x, th, s.z, 0.5); killEShell(s); continue; }
    if (s.y < wy) {
      if (!BT.over && kd < 9.5) hurtPlayer(Math.ceil(s.dmg * 0.6), s.x, wy + 2, s.z);
      shellSplash(s.x, s.z);
      sfx.distSplash(Math.hypot(s.x - camera.position.x, s.z - camera.position.z));
      if (kd < 40) state.shake = Math.max(state.shake, 0.25);
      killEShell(s);
    }
    if (s.t > 40) killEShell(s);
  }

  // torpedoes
  let danger = false;
  for (const t of torps) {
    if (!t.alive) continue;
    t.life -= dt;
    t.x += t.dx * t.v * dt; t.z += t.dz * t.v * dt;
    const wy = waterHeight(t.x, t.z);
    t.m.position.set(t.x, wy - 0.25, t.z);
    t.bub -= dt;
    if (t.bub <= 0) {
      t.bub = 0.06;
      spawnWake(t.x - t.dx * 3, t.z - t.dz * 3, 0, 0, 1.8, 1.4, 5, 1);
      spawnSpray(t.x, wy + 0.1, t.z, rand(-0.4, 0.4), rand(0.8, 1.6), rand(-0.4, 0.4), 0.5);
    }
    const kd = playerKeel(t.x, t.z);
    if (!BT.over && kd < 6.5) {
      t.alive = false; t.m.visible = false;
      shellSplash(t.x, t.z); shellSplash(t.x + fx * 4, t.z + fz * 4);
      toast('魚雷命中！', '', 'hot', 1000);
      hurtPlayer(15, t.x, wy + 3, t.z);
      continue;
    }
    // will it cross our path soon?
    const rx = B.x - t.x, rz = B.z - t.z, rvx = t.dx * t.v - B.vx, rvz = t.dz * t.v - B.vz;
    const rv2 = rvx * rvx + rvz * rvz || 1, tc = clamp((rx * rvx + rz * rvz) / rv2, 0, 20);
    const miss = Math.hypot(rx - rvx * tc, rz - rvz * tc);
    if (miss < 40 && tc < 14 && tc > 0) danger = true;
    if (t.life <= 0 || terrainHeight(t.x, t.z) > wy - 1 || Math.abs(t.x) > WORLD_X * 1.1 || Math.abs(t.z) > WORLD_Z * 1.1) {
      if (terrainHeight(t.x, t.z) > wy - 1) explosion(t.x, wy + 1, t.z, 0.5);
      t.alive = false; t.m.visible = false;
    }
  }
  if (danger && !BT.over) {
    BT.torpWarn = 0.5;
    if (BT.alarmCd <= 0) { BT.alarmCd = 2.5; sfx.alarm(); }
  } else BT.torpWarn -= dt;
  $('warn').classList.toggle('hidden', BT.torpWarn <= 0);

  // burning when badly damaged
  if (BT.hp < 50 || BT.over) {
    BT.fireT -= dt;
    if (BT.fireT <= 0) {
      BT.fireT = BT.over ? 0.05 : lerp(0.08, 0.4, BT.hp / 50);
      const o = rand(-28, 24);
      const x = B.x + fx * o + -fz * rand(-3, 3), z = B.z + fz * o + fx * rand(-3, 3), y = ship.position.y + 6;
      spawnSmoke(x, y, z, B.vx * 0.8 + rand(-1, 1), rand(3, 6), B.vz * 0.8 + rand(-1, 1), 3, 7, rand(3, 5), 0.6, '#1e1e1e');
      if (rng() < 0.6) spawnSmoke(x, y, z, B.vx * 0.9, rand(2, 4), B.vz * 0.9, 1.5, 3, 0.5, 0.9, '#ff7a2a', true);
    }
  }

  updateMarkers();
  updateBattleHUD();
}

const _mv = new THREE.Vector3();
function updateMarkers() {
  const W = window.innerWidth, H = window.innerHeight;
  for (const e of enemies) {
    const mk = e.mk; if (!mk) continue;
    if (!e.alive) { mk.el.style.display = 'none'; continue; }
    mk.el.style.display = '';
    _mv.set(e.x, e.y + e.T.len * 0.18 + 10, e.z).project(camera);
    let x = _mv.x, y = _mv.y;
    const behind = _mv.z > 1;
    if (behind) { x = -x; y = -y; }
    const on = !behind && Math.abs(x) < 0.94 && Math.abs(y) < 0.9;
    const d = Math.hypot(e.x - B.x, e.z - B.z);
    if (!on) {
      const m = Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.82, 1e-3); x /= m; y /= m;
      if (behind && Math.abs(y) < 0.5) { y = -0.82; }
      mk.arr.style.transform = `rotate(${Math.atan2(x, y)}rad)`;
    }
    mk.el.classList.toggle('off', !on);
    mk.el.classList.toggle('lock', BT.lock === e);
    mk.el.style.transform = `translate(${((x + 1) / 2) * W}px, ${((1 - y) / 2) * H}px)`;
    mk.ds.textContent = `${Math.round(d)}m`;
    mk.hp.style.width = `${clamp(e.hp / e.maxHp, 0, 1) * 100}%`;
  }
}
let lastHudKey = '';
function updateBattleHUD() {
  const left = enemies.filter((e) => e.alive).length;
  const key = `${BT.wave}|${BT.score}|${left}|${BT.combo}|${Math.ceil(BT.hp)}|${BT.best}|${BT.phase}|${Math.ceil(BT.timer)}`;
  if (key === lastHudKey) return;
  lastHudKey = key;
  $('waveNum').textContent = BT.wave || '-';
  $('score').textContent = BT.score;
  $('enemyLeft').textContent = BT.phase === 'break' && !BT.over ? `下一波 ${Math.max(0, Math.ceil(BT.timer))}s` : left;
  $('combo').textContent = `x${BT.combo}`;
  $('battleBest').textContent = BT.best;
  const f = BT.hp / BT.maxHp;
  $('hp').style.width = `${f * 100}%`;
  $('hp').style.background = f > 0.5 ? '' : f > 0.25 ? 'linear-gradient(90deg,#ffcf4a,#ff9b3d)' : 'linear-gradient(90deg,#ff3d3d,#ff6a3d)';
  $('hpTxt').textContent = Math.ceil(BT.hp);
}
function drawBattleMinimap(ctx, proj, sy, cyw) {
  for (const t of torps) {
    if (!t.alive) continue;
    const [x, y] = proj(t.x, t.z);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  for (const s of eshells) {
    if (!s.alive) continue;
    const [x, y] = proj(s.tx, s.tz);
    ctx.strokeStyle = 'rgba(255,80,60,0.8)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.stroke();
  }
  for (const e of enemies) {
    if (!e.alive) continue;
    const [x, y] = proj(e.x, e.z);
    const rel = e.yaw - B.yaw;
    const s = e.T.key === 'bb' ? 7 : e.T.key === 'ca' ? 5.5 : 4.5;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-rel);
    ctx.fillStyle = BT.lock === e ? '#ffcf4a' : '#ff4a3d';
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.55, s * 0.7); ctx.lineTo(-s * 0.55, s * 0.7); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  void sy; void cyw;
}

// ---------- race & pickups ----------
function updateRace() {
  if (state.mode !== 'play') return;
  const R = state.race;
  const g = gates[R.next];
  if (!BT.on && Math.hypot(B.x - g.x, B.z - g.z) < GATE_R + 2) {
    if (R.next === 0) {
      if (R.started) {
        const lt = time - R.startT;
        const rec = R.best == null || lt < R.best;
        if (rec) { R.best = lt; store.set('tb_best_yamato', lt); toast('新紀錄！', fmt(lt), 'gold', 2600); }
        else toast('完成一圈', `${fmt(lt)}  (最佳 ${fmt(R.best)})`, 'cyan', 2400);
        sfx.lap();
      } else { toast('計時開始！', '依序穿過藍色浮環', 'cyan', 1500); sfx.gate(); }
      R.started = true; R.startT = time; R.next = 1;
    } else {
      sfx.gate();
      toast(`檢查點 ${R.next}/${N_GATES - 1}`, fmt(time - R.startT), 'cyan', 900);
      R.next = (R.next + 1) % N_GATES;
    }
  }
  const fx = Math.sin(B.yaw), fz = Math.cos(B.yaw);
  for (const c of coins) {
    if (!c.alive) continue;
    // anywhere along the hull counts
    const dx = c.x - B.x, dz = c.z - B.z;
    const along = clamp(dx * fx + dz * fz, -34, 34);
    if (Math.hypot(dx - fx * along, dz - fz * along) < 10) {
      c.alive = false; c.m.visible = false; c.respawn = 15;
      state.coins++; B.nitro = Math.min(1, B.nitro + 0.25);
      sfx.coin();
      if (BT.on && !BT.over) { const before = BT.hp; BT.hp = Math.min(BT.maxHp, BT.hp + 12); if (BT.hp > before) toast('緊急修理', `艦體 +${Math.round(BT.hp - before)}`, 'cyan', 900); }
      for (let i = 0; i < 24; i++) spawnSpray(c.x, c.m.position.y, c.z, rand(-6, 6), rand(2, 9), rand(-6, 6), rand(0.6, 1.2), 1, 0.8, 0.2);
    }
  }
}
function updateWorldObjects(dt) {
  const R = state.race;
  gateMeshes.forEach((gm, i) => {
    const g = gates[i];
    gm.grp.position.y = waterHeight(g.x, g.z) - 0.8;
    gm.grp.rotation.z = Math.sin(time * 0.9 + i) * 0.03;
    gm.grp.visible = !BT.on;
    const isNext = i === R.next && state.mode === 'play';
    gm.mat.emissiveIntensity = damp(gm.mat.emissiveIntensity, isNext ? 1.6 + Math.sin(time * 6) * 0.4 : 0.15, 6, dt);
    gm.beamMat.opacity = damp(gm.beamMat.opacity, isNext ? 0.2 : 0, 4, dt);
  });
  for (const c of coins) {
    if (!c.alive) {
      c.respawn -= dt;
      if (c.respawn <= 0) { const p = freeSpot(); c.x = p.x; c.z = p.z; c.alive = true; c.m.visible = true; }
      continue;
    }
    if (Math.abs(c.x - camera.position.x) > 1200 || Math.abs(c.z - camera.position.z) > 1200) continue;
    c.m.position.set(c.x, waterHeight(c.x, c.z) + 4 + Math.sin(time * 2 + c.phase) * 0.6, c.z);
    c.m.rotation.y = time * 1.8 + c.phase;
  }
  for (const t of targets) {
    if (BT.on) { t.grp.visible = false; continue; }
    if (!t.alive) {
      t.sink += dt;
      if (t.sink < 6) {
        t.grp.position.y -= dt * 2.5; t.grp.rotation.z += dt * 0.25;
        if (rng() < 0.3) spawnSmoke(t.x, waterHeight(t.x, t.z) + 2, t.z, rand(-1, 1), rand(2, 4), rand(-1, 1), 4, 6, 4, 0.5, '#2e2e2e');
      } else t.grp.visible = false;
      t.respawn -= dt;
      if (t.respawn <= 0) { const p = freeSpot(40); Object.assign(t, { x: p.x, z: p.z, alive: true }); t.grp.visible = true; t.grp.rotation.z = 0; }
      continue;
    }
    t.x += t.vx * dt; t.z += t.vz * dt;
    if (Math.abs(t.x) > WORLD_X || Math.abs(t.z) > WORLD_Z || islands.some((o) => Math.hypot(o.x - t.x, o.z - t.z) < o.r * 1.3 + 15)) { t.vx *= -1; t.vz *= -1; }
    const h = waterHeight(t.x, t.z);
    t.grp.position.set(t.x, h - 0.3, t.z);
    t.grp.rotation.set(Math.sin(time + t.yaw) * 0.05, t.yaw + time * 0.02, Math.cos(time * 0.8 + t.yaw) * 0.06);
  }
  // arrow to next gate
  const g = gates[R.next];
  const dx = g.x - B.x, dz = g.z - B.z;
  arrow.visible = state.mode === 'play' && state.camMode !== 2 && !BT.on;
  arrow.position.set(B.x, B.y + 32 + Math.sin(time * 3) * 0.5, B.z);
  arrow.rotation.y = Math.atan2(dx, dz);
  arrow.material.color.set(R.next === 0 ? '#ffcf4a' : '#39e1ff');
  $('wrongWay').classList.toggle('hidden', state.mode !== 'play' || BT.on);
  $('nextDist').textContent = Math.round(Math.hypot(dx, dz));

  // dolphins riding the bow wave
  podTimer -= dt;
  if (!pod.active && podTimer <= 0) {
    const sy = Math.sin(B.yaw), cy = Math.cos(B.yaw), side = rng() < 0.5 ? -1 : 1;
    pod.active = true; pod.t = 0; pod.dx = sy; pod.dz = cy;
    pod.x = B.x + sy * 70 - cy * side * 22; pod.z = B.z + cy * 70 + sy * side * 22;
    pod.speed = clamp(B.speed, 8, 25);
    pod.members.forEach((m) => { m.mesh.visible = true; });
  }
  if (pod.active) {
    pod.t += dt;
    const rel = (B.x - pod.x) * pod.dx + (B.z - pod.z) * pod.dz + 40;
    pod.speed = damp(pod.speed, clamp(B.speed + rel * 0.08, 7, 28), 0.5, dt);
    pod.x += pod.dx * pod.speed * dt; pod.z += pod.dz * pod.speed * dt;
    const blocked = islands.some((o) => Math.hypot(o.x - pod.x, o.z - pod.z) < o.r * 1.4 + 10);
    for (const m of pod.members) {
      const px = pod.x - pod.dz * m.lat + pod.dx * m.fwd, pz = pod.z + pod.dx * m.lat + pod.dz * m.fwd;
      const ph = pod.t * 1.7 + m.phase, s = Math.sin(ph);
      const fade = pod.t > 22 || blocked ? -4 : 0;
      m.mesh.position.set(px, waterHeight(px, pz) + s * 2.4 - 0.8 + fade, pz);
      m.mesh.rotation.set(-Math.cos(ph) * 0.75, Math.atan2(pod.dx, pod.dz), 0);
      const up = s > 0.35;
      if (up !== m.prevUp && fade === 0) splashBurst(px, pz, 10, 3, 2);
      m.prevUp = up;
    }
    if (pod.t > 23 || (blocked && pod.t > 1)) { pod.active = false; podTimer = rand(20, 40); pod.members.forEach((m) => (m.mesh.visible = false)); }
  }
  for (const gl of gulls) {
    gl.a += gl.sp * dt;
    gl.g.position.set(gl.cx + Math.cos(gl.a) * gl.rad, gl.h + Math.sin(time * 0.7 + gl.ph) * 2, gl.cz + Math.sin(gl.a) * gl.rad);
    const tx = -Math.sin(gl.a) * Math.sign(gl.sp), tz = Math.cos(gl.a) * Math.sign(gl.sp);
    gl.g.rotation.set(0, Math.atan2(tx, tz), -0.25 * Math.sign(gl.sp));
    const fl = Math.sin(time * 7 + gl.ph) * 0.55;
    gl.l.rotation.z = fl; gl.r.rotation.z = -fl;
  }
}

function updateParticles(dt) {
  for (let i = 0; i < WAKE_N; i++) {
    const w = wake[i];
    if (w.age >= w.life) { if (w.age < 1e9) { wakeMesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); w.age = 1e10; } continue; }
    w.age += dt;
    w.x += w.vx * dt; w.z += w.vz * dt;
    const k = Math.exp(-0.6 * dt); w.vx *= k; w.vz *= k;
    const t = w.age / w.life;
    const s = w.s0 + w.grow * w.age;
    _p.set(w.x, waterHeight(w.x, w.z) + 0.15, w.z);
    _q.setFromAxisAngle(_up, w.rot + w.age * 0.1);
    _s.set(s, 1, s);
    wakeMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    const camD = Math.hypot(w.x - camera.position.x, w.z - camera.position.z);
    const a = w.a * (1 - t) * (1 - t) * Math.min(1, w.age * 5) * 0.75 * (1 - smooth(350, 900, camD));
    wakeMesh.setColorAt(i, _c.setRGB(a, 0.15 + 0.8 * dayF, 0));
  }
  wakeMesh.instanceMatrix.needsUpdate = true;
  wakeMesh.instanceColor.needsUpdate = true;

  for (let i = 0; i < SPRAY_N; i++) {
    const p = sprayP[i];
    if (p.age >= p.life) { if (sprayPos[i * 3 + 1] !== -999) sprayPos[i * 3 + 1] = -999; continue; }
    p.age += dt;
    p.vy -= 9.8 * dt;
    if (p.drag) { const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy *= k; p.vz *= k; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    const f = Math.max(0, 1 - p.age / p.life) * (0.25 + 0.75 * dayF);
    sprayPos[i * 3] = p.x; sprayPos[i * 3 + 1] = p.y; sprayPos[i * 3 + 2] = p.z;
    sprayCol[i * 3] = p.r * f; sprayCol[i * 3 + 1] = p.g * f; sprayCol[i * 3 + 2] = p.b * f;
  }
  sprayGeo.attributes.position.needsUpdate = true;
  sprayGeo.attributes.color.needsUpdate = true;

  const lightK = 0.25 + 0.75 * dayF;
  for (const p of smoke) {
    if (!p.s.visible) continue;
    p.age += dt;
    if (p.age >= p.life) { p.s.visible = false; continue; }
    const t = p.age / p.life;
    p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
    const k = Math.exp(-1.2 * dt); p.vx *= k; p.vz *= k; p.vy = p.vy * k + 0.4 * dt;
    p.s.scale.setScalar(p.s0 + p.grow * Math.sqrt(p.age) * 2);
    const op = p.op * (1 - t) * Math.min(1, p.age * 6);
    p.mat.opacity = op;
    if (p.mat.blending === THREE.NormalBlending) p.mat.color.offsetHSL(0, 0, 0); // keep
  }
  void lightK;
  flashLight.intensity *= Math.exp(-14 * dt);

  if (rainMat.opacity > 0.01) {
    rain.visible = true;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const wx = 6, wz = 3;
    for (let i = 0; i < RAIN_N; i++) {
      const d = rainDrops[i];
      d.y -= d.v * dt; d.x += wx * dt; d.z += wz * dt;
      if (d.y < -20) { d.y = rand(30, 50); d.x = rand(-80, 80); d.z = rand(-80, 80); }
      if (d.x > 80) d.x -= 160; if (d.z > 80) d.z -= 160;
      const o = i * 6;
      rainPos[o] = cx + d.x; rainPos[o + 1] = cy + d.y; rainPos[o + 2] = cz + d.z;
      rainPos[o + 3] = cx + d.x - wx * 0.03; rainPos[o + 4] = cy + d.y + d.v * 0.035; rainPos[o + 5] = cz + d.z - wz * 0.03;
    }
    rainGeo.attributes.position.needsUpdate = true;
  } else rain.visible = false;
}

// ---------- camera ----------
const camTarget = new THREE.Vector3(), camLook = new THREE.Vector3(), _look = new THREE.Vector3();
let orbit = 0.6;
function desiredCam(out, look) {
  const fx = Math.sin(B.yaw), fz = Math.cos(B.yaw);
  const sp = B.speed;
  const mode = state.mode === 'menu' ? 3 : state.camMode;
  if (mode === 0 || mode === 1) {
    const dist = (mode === 0 ? 105 : 62) + sp * 0.8;
    const h = mode === 0 ? 34 : 17;
    // let the mouse swing the camera a bit to look where you aim
    const swing = mouse.has && !isTouch ? -mouse.x * 0.9 : 0;
    const cs = Math.cos(swing), sn = Math.sin(swing);
    const vx = fx * cs - fz * sn, vz = fz * cs + fx * sn;
    out.set(B.x - vx * dist, B.y + h, B.z - vz * dist);
    look.set(B.x + vx * 45, B.y + 6, B.z + vz * 45);
    return 2.2;
  }
  if (mode === 2) {
    _p.set(0, 19.6, 4.9).applyEuler(ship.rotation).add(ship.position); out.copy(_p);
    const swing = mouse.has && !isTouch ? -mouse.x * 1.4 : 0;
    _p.set(Math.sin(-swing) * 100, 15 + (mouse.has ? mouse.y * 30 : 0), Math.cos(swing) * 100).applyEuler(ship.rotation).add(ship.position);
    look.copy(_p);
    return 40;
  }
  out.set(B.x + Math.sin(orbit) * 150, B.y + 34 + Math.sin(orbit * 0.7) * 16, B.z + Math.cos(orbit) * 150);
  look.set(B.x, B.y + 10, B.z);
  return 2;
}
function snapCamera() { desiredCam(camTarget, camLook); camera.position.copy(camTarget); camera.lookAt(camLook); }
function updateCamera(dt) {
  orbit += dt * (state.mode === 'menu' ? 0.06 : 0.1);
  const rate = desiredCam(camTarget, _look);
  camera.position.x = damp(camera.position.x, camTarget.x, rate, dt);
  camera.position.z = damp(camera.position.z, camTarget.z, rate, dt);
  camera.position.y = damp(camera.position.y, camTarget.y, rate * 0.8, dt);
  camLook.x = damp(camLook.x, _look.x, rate * 1.5, dt);
  camLook.y = damp(camLook.y, _look.y, rate * 1.5, dt);
  camLook.z = damp(camLook.z, _look.z, rate * 1.5, dt);
  const minY = waterHeight(camera.position.x, camera.position.z) + 2;
  if (camera.position.y < minY) camera.position.y = minY;
  camera.lookAt(camLook);
  if (state.shake > 0) {
    const s = state.shake * 0.8;
    camera.position.x += rand(-s, s); camera.position.y += rand(-s, s); camera.position.z += rand(-s, s);
    state.shake = Math.max(0, state.shake - dt * 1.5);
  }
  const fov = 55 + clamp(B.speed, 0, 25) * 0.25 + (B.boosting ? 5 : 0);
  camera.fov = damp(camera.fov, fov, 2, dt);
  camera.updateProjectionMatrix();
}

// ---------- HUD ----------
const mm = $('minimap'), mctx = mm.getContext('2d');
let hudT = 0;
function updateHUD(dt) {
  if (state.mode !== 'play') return;
  hudT += dt;
  const R = state.race;
  $('spd').textContent = Math.round(B.speed * 1.944);
  $('thr').style.width = `${Math.abs(B.throttle) * 100}%`;
  $('thr').style.background = B.throttle < -0.02 ? 'linear-gradient(90deg,#ff9b3d,#ff5a3d)' : '';
  $('nit').style.width = `${B.nitro * 100}%`;
  $('nit').parentElement.classList.toggle('full', B.nitro > 0.98);
  $('rel').style.width = `${state.reload * 100}%`;
  $('rel').parentElement.classList.toggle('full', state.reload >= 1);
  $('lapTime').textContent = R.started ? fmt(time - R.startT) : '--:--.--';
  $('gateNum').textContent = R.next === 0 ? (R.started ? '終點 FINISH' : '起點 START') : `${R.next} / ${N_GATES - 1}`;
  $('bestTime').textContent = fmt(R.best);
  $('coins').textContent = state.coins;
  $('kills').textContent = state.kills;
  let hdg = ((Math.PI - B.yaw) * 180) / Math.PI; hdg = ((hdg % 360) + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  $('heading').textContent = `${dirs[Math.round(hdg / 45) % 8]} ${String(Math.round(hdg)).padStart(3, '0')}°`;

  const W = mm.width, cx = W / 2, cy = W / 2, S = (W / 2) / 1300;
  const sy = Math.sin(B.yaw), cyw = Math.cos(B.yaw);
  const proj = (x, z) => {
    const dx = x - B.x, dz = z - B.z;
    const f = dx * sy + dz * cyw, r = -dx * cyw + dz * sy;
    return [cx + r * S, cy - f * S];
  };
  mctx.clearRect(0, 0, W, W);
  mctx.save();
  mctx.beginPath(); mctx.arc(cx, cy, W / 2 - 1, 0, Math.PI * 2); mctx.clip();
  const grd = mctx.createRadialGradient(cx, cy, 10, cx, cy, W / 2);
  grd.addColorStop(0, 'rgba(20,90,130,0.85)'); grd.addColorStop(1, 'rgba(5,30,50,0.9)');
  mctx.fillStyle = grd; mctx.fillRect(0, 0, W, W);
  if (!BT.on) {
    mctx.strokeStyle = 'rgba(57,225,255,0.35)'; mctx.lineWidth = 2; mctx.setLineDash([4, 4]);
    mctx.beginPath();
    gates.forEach((g, i) => { const [x, y] = proj(g.x, g.z); i ? mctx.lineTo(x, y) : mctx.moveTo(x, y); });
    mctx.closePath(); mctx.stroke(); mctx.setLineDash([]);
  }
  mctx.fillStyle = '#d9c78f';
  for (const is of islands) { const [x, y] = proj(is.x, is.z); mctx.beginPath(); mctx.arc(x, y, Math.max(2, is.r * S * 1.05), 0, Math.PI * 2); mctx.fill(); }
  mctx.fillStyle = '#8d8a80';
  for (const r of rocks) { const [x, y] = proj(r.x, r.z); mctx.beginPath(); mctx.arc(x, y, 1.5, 0, Math.PI * 2); mctx.fill(); }
  mctx.fillStyle = '#ffd35a';
  for (const c of coins) { if (!c.alive) continue; const [x, y] = proj(c.x, c.z); mctx.fillRect(x - 1.5, y - 1.5, 3, 3); }
  mctx.fillStyle = '#ff4a3d';
  for (const t of targets) { if (!t.alive) continue; const [x, y] = proj(t.x, t.z); mctx.beginPath(); mctx.moveTo(x, y - 4); mctx.lineTo(x + 3.5, y + 3); mctx.lineTo(x - 3.5, y + 3); mctx.fill(); }
  if (BT.on) drawBattleMinimap(mctx, proj, sy, cyw);
  else gates.forEach((g, i) => {
    const [x, y] = proj(g.x, g.z);
    const next = i === R.next;
    mctx.fillStyle = next ? (i === 0 ? '#ffcf4a' : '#39e1ff') : 'rgba(255,255,255,0.45)';
    mctx.beginPath(); mctx.arc(x, y, next ? 5 + Math.sin(hudT * 8) * 1.2 : 2.5, 0, Math.PI * 2); mctx.fill();
  });
  if (aimValid) { const [x, y] = proj(aim.x, aim.z); mctx.strokeStyle = '#ff5a3d'; mctx.lineWidth = 1.5; mctx.beginPath(); mctx.arc(x, y, 3.5, 0, Math.PI * 2); mctx.stroke(); }
  if (pod.active) { mctx.fillStyle = '#9fd6ff'; const [x, y] = proj(pod.x, pod.z); mctx.beginPath(); mctx.arc(x, y, 2.5, 0, Math.PI * 2); mctx.fill(); }
  mctx.restore();
  const nAng = Math.PI - B.yaw;
  const nxp = cx + Math.sin(-nAng) * (W / 2 - 12), nyp = cy - Math.cos(-nAng) * (W / 2 - 12);
  mctx.fillStyle = '#ff6a3d'; mctx.font = 'bold 13px Rajdhani, sans-serif'; mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
  mctx.fillText('N', nxp, nyp);
  // ship silhouette
  mctx.fillStyle = '#ffffff';
  mctx.beginPath(); mctx.moveTo(cx, cy - 9); mctx.lineTo(cx + 3.5, cy - 2); mctx.lineTo(cx + 3, cy + 8); mctx.lineTo(cx - 3, cy + 8); mctx.lineTo(cx - 3.5, cy - 2); mctx.closePath(); mctx.fill();
  mctx.strokeStyle = 'rgba(160,220,255,0.35)'; mctx.lineWidth = 2;
  mctx.beginPath(); mctx.arc(cx, cy, W / 2 - 1, 0, Math.PI * 2); mctx.stroke();
}

// ---------- main loop ----------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  if (state.mode !== 'pause') {
    time += dt;
    updateEnvironment(dt);
    updateShip(dt);
    updateRace();
    updateWorldObjects(dt);
    updateCamera(dt);
    updateAim(dt);
    updateShells(dt);
    updateBattle(dt);
    updateParticles(dt);
    updateHUD(dt);
  }
  oceanUniforms.uTime.value = time;
  oceanUniforms.uAmp.value = waveAmp;
  oceanUniforms.uCam.value.copy(camera.position);
  ocean.position.set(camera.position.x, 0, camera.position.z);
  sky.position.copy(camera.position);
  const sl = parts.searchlight;
  sl.getWorldPosition(oceanUniforms.uHeadPos.value);
  sl.target.getWorldPosition(tmpV);
  oceanUniforms.uHeadDir.value.copy(tmpV).sub(oceanUniforms.uHeadPos.value).normalize();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state.mode === 'play') togglePause(); });

// debug hook for automated checks
window.__game = {
  state, B, BT, enemies, torps, eshells, keys, mouse, camera, startGame, fireMain, fireSecondary,
  get time() { return time; },
  // advance the simulation without rendering (each(): optional per-step callback)
  sim(sec, each, dt = 1 / 30) {
    for (let t = 0; t < sec; t += dt) {
      if (each) each();
      time += dt;
      updateEnvironment(dt); updateShip(dt); updateRace(); updateWorldObjects(dt); updateCamera(dt);
      updateAim(dt); updateShells(dt); updateBattle(dt); updateParticles(dt); updateHUD(dt);
    }
  },
};

resetShip();
B.y = waterHeight(B.x, B.z) - 0.4;
// URL options, e.g. ?play&cam=3&tod=10&weather=2
{
  const q = new URLSearchParams(location.search);
  if (q.has('tod')) state.tod = clamp(parseFloat(q.get('tod')) || 0, 0, 23.99);
  if (q.has('weather')) { state.weather = clamp(parseInt(q.get('weather'), 10) || 0, 0, 2); const W = WEATHERS[state.weather]; waveAmp = W.amp; state.cloud = W.cloud; state.storm = W.storm; }
  if (q.has('play')) startGame(q.get('play') === 'race' ? 'race' : 'battle');
  if (q.has('cam')) state.camMode = clamp(parseInt(q.get('cam'), 10) || 0, 0, 3);
}
updateEnvironment(0);
snapCamera();
frame();
requestAnimationFrame(() => $('loading').classList.add('done'));
setTimeout(() => $('loading').classList.add('done'), 500);
