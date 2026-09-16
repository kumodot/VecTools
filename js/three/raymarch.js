/**
 * raymarch.js - Realtime SDF preview of the blob/inflate modes.
 *
 * The 2D signed distance (R) and local thickness (G) fields are uploaded as an
 * RG float texture. A fragment shader raymarches the SAME 3D field that
 * sdfField.js bakes (rounded-box in the (d, z) plane, with the dome profiles
 * feeding the slab half-height), so what you see while dragging sliders is
 * what marching cubes will produce on Bake.
 *
 * The march happens in image PIXEL space so all parameters keep pixel units.
 * The world <-> pixel mapping mirrors sdfField.js#gridToWorld:
 *   world = ((px - cx) * s, -(py - cy) * s, -pz * s)
 */
import * as THREE from 'three';

export const PROFILE_INDEX = { roundedExtrude: 0, pillow: 1, localWidth: 2 };

const VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;

varying vec3 vWorld;

uniform sampler2D uField;      // R = signed 2D distance (px), G = local half-width (px)
uniform vec2  uTexSize;
uniform int   uProfile;        // 0 rounded extrude, 1 pillow, 2 local width
uniform float uHalfT;          // slab half thickness (px)
uniform float uRound;          // fillet radius (px)
uniform float uBulge;
uniform float uBulgePow;
uniform float uMaxBulge;
uniform float uThinProtect;
uniform vec3  uBoundsMin;      // pixel-space box (z centred on 0)
uniform vec3  uBoundsMax;
uniform vec2  uCenter;         // pixel-space centre used by the world mapping
uniform float uScale;          // world units per pixel
uniform int   uSteps;
uniform vec3  uColor;
uniform float uMetal;
uniform float uRough;
uniform float uSectionZ;       // >= 0: clip everything above this world z (cutaway), < 0 disabled
uniform mat4  uProj;           // camera projection matrix (not provided to fragment shaders by three.js)
uniform sampler2D uEnv;        // equirect HDR (mipmapped), used when uHasEnv == 1
uniform int   uHasEnv;
uniform float uEnvMaxLod;
uniform float uEnvRot;         // rotation around world Y, radians
uniform float uEnvIntensity;
#define PI 3.14159265359

// ---- world <-> pixel ------------------------------------------------------
vec3 worldToPixel(vec3 w) {
  return vec3(w.x / uScale + uCenter.x, -w.y / uScale + uCenter.y, -w.z / uScale);
}
vec3 pixelToWorld(vec3 p) {
  return vec3((p.x - uCenter.x) * uScale, -(p.y - uCenter.y) * uScale, -p.z * uScale);
}
vec3 dirWorldToPixel(vec3 d) { return vec3(d.x, -d.y, -d.z); }
vec3 dirPixelToWorld(vec3 d) { return vec3(d.x, -d.y, -d.z); }

// ---- field sampling (manual bilinear on a NEAREST float texture) ----------
vec2 sampleField(vec2 p) {
  vec2 maxI = uTexSize - 1.0;
  vec2 q = clamp(p, vec2(0.0), maxI);
  vec2 f = fract(q);
  ivec2 i0 = ivec2(floor(q));
  ivec2 i1 = min(i0 + 1, ivec2(maxI));
  vec2 a = texelFetch(uField, i0, 0).rg;
  vec2 b = texelFetch(uField, ivec2(i1.x, i0.y), 0).rg;
  vec2 c = texelFetch(uField, ivec2(i0.x, i1.y), 0).rg;
  vec2 d = texelFetch(uField, i1, 0).rg;
  vec2 v = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  // grow the distance for samples outside the image rectangle
  vec2 dd = max(max(-p, p - maxI), 0.0);
  v.r += length(dd);
  return v;
}

// ---- the same profiles as sdfField.js ------------------------------------
float roundedBox(float d, float z, float H, float r) {
  float qx = d + r;
  float qy = abs(z) - H + r;
  vec2 q = vec2(qx, qy);
  return min(max(qx, qy), 0.0) + length(max(q, 0.0)) - r;
}

float domeHalfHeight(float d, float lw) {
  float din = max(-d, 0.0);
  bool useLocal = uProfile == 2;
  float R = useLocal ? min(max(lw, 1e-6), uMaxBulge) : max(uMaxBulge, 1e-6);
  float t = clamp(din / R, 0.0, 1.0);
  float scaleH = useLocal ? R : uMaxBulge;
  float hgt = scaleH * uBulge * pow(t, uBulgePow);
  float floorH = uThinProtect * min(din, R);
  hgt = max(hgt, floorH);
  return uHalfT + hgt;
}

float map(vec3 p) {
  vec2 f = sampleField(p.xy);
  float Hs = uProfile == 0 ? uHalfT : domeHalfHeight(f.r, f.g);
  float r = min(uRound, Hs);
  float v = roundedBox(f.r, p.z, Hs, r);
  if (uSectionZ >= 0.0) {
    // cutaway: intersect with the half-space world z <= uSectionZ  (pixel z >= -uSectionZ/uScale)
    float cut = (-uSectionZ / uScale) - p.z;
    v = max(v, cut);
  }
  return v;
}

vec3 calcNormal(vec3 p, float e) {
  vec2 h = vec2(e, 0.0);
  return normalize(vec3(
    map(p + h.xyy) - map(p - h.xyy),
    map(p + h.yxy) - map(p - h.yxy),
    map(p + h.yyx) - map(p - h.yyx)));
}

// ---- shading -------------------------------------------------------------
vec3 envColor(vec3 r) {
  // procedural studio: warm top, cool horizon, dark floor, two softboxes
  float up = r.y * 0.5 + 0.5;
  vec3 sky = mix(vec3(0.08, 0.08, 0.10), vec3(0.55, 0.58, 0.65), smoothstep(0.35, 0.75, up));
  sky = mix(sky, vec3(0.95, 0.92, 0.85), smoothstep(0.8, 1.0, up));
  float box1 = smoothstep(0.80, 0.99, dot(r, normalize(vec3(0.5, 0.8, 0.6))));
  float box2 = smoothstep(0.85, 0.99, dot(r, normalize(vec3(-0.7, 0.3, 0.4))));
  float strip = smoothstep(0.90, 0.995, dot(r, normalize(vec3(0.0, -0.2, 1.0)))) * 0.35;
  return sky + vec3(1.0, 0.97, 0.9) * (box1 * 1.2 + box2 * 0.7 + strip);
}

vec3 shade(vec3 n, vec3 v) {
  vec3 base = uColor;
  float rough = clamp(uRough, 0.04, 1.0);
  float NdotV = clamp(dot(n, v), 0.0, 1.0);
  vec3 F0 = mix(vec3(0.04), base, uMetal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
  vec3 diffuse = base * (1.0 - uMetal);
  vec3 col = diffuse * mix(vec3(0.12, 0.11, 0.11), vec3(0.45, 0.47, 0.52), n.y * 0.5 + 0.5);

  vec3 L[3];
  vec3 C[3];
  L[0] = normalize(vec3(0.5, 0.8, 0.6));  C[0] = vec3(1.0, 0.96, 0.9) * 1.4;
  L[1] = normalize(vec3(-0.7, 0.3, 0.4)); C[1] = vec3(0.7, 0.8, 1.0) * 0.6;
  L[2] = normalize(vec3(0.2, -0.4, -0.9)); C[2] = vec3(1.0, 0.9, 0.8) * 0.5;
  float shin = 2.0 / (rough * rough * rough * rough) - 2.0;
  for (int i = 0; i < 3; i++) {
    float NdotL = max(dot(n, L[i]), 0.0);
    vec3 H = normalize(L[i] + v);
    float NdotH = max(dot(n, H), 0.0);
    vec3 spec = F * pow(NdotH, shin) * (shin + 8.0) / 25.0;
    col += (diffuse * NdotL + spec * NdotL) * C[i];
  }
  vec3 R = reflect(-v, n);
  if (uHasEnv == 1) {
    // equirect lookup, same convention as three.js equirectUv(), rotated around Y
    float c = cos(uEnvRot), s = sin(uEnvRot);
    vec3 d = vec3(c * R.x + s * R.z, R.y, -s * R.x + c * R.z);
    vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
    float lod = pow(rough, 0.6) * uEnvMaxLod;
    vec3 spec = textureLod(uEnv, uv, lod).rgb * uEnvIntensity;
    // rough diffuse-ish ambient from a very blurred lookup along the normal
    vec3 dn = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
    vec2 uvn = vec2(atan(dn.z, dn.x) / (2.0 * PI) + 0.5, asin(clamp(dn.y, -1.0, 1.0)) / PI + 0.5);
    vec3 amb = textureLod(uEnv, uvn, uEnvMaxLod).rgb * uEnvIntensity;
    col = diffuse * amb + spec * F;
    // keep a touch of the key lights so the form reads even with a flat HDR
    col += diffuse * max(dot(n, L[0]), 0.0) * C[0] * 0.25;
  } else {
    col += envColor(R) * F * (1.0 - rough * 0.75) * uEnvIntensity;
  }
  return col;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 roW = cameraPosition;
  vec3 rdW = normalize(vWorld - cameraPosition);
  vec3 ro = worldToPixel(roW);
  vec3 rd = normalize(dirWorldToPixel(rdW));

  // slab test against the pixel-space box
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoundsMin - ro) * inv;
  vec3 t1 = (uBoundsMax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tNear = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tFar = min(min(tmax.x, tmax.y), tmax.z);
  if (tFar <= tNear) discard;

  float extent = max(uBoundsMax.x - uBoundsMin.x, uBoundsMax.y - uBoundsMin.y);
  float eps = max(extent * 0.0006, 0.05);
  float t = tNear;
  bool hit = false;
  for (int i = 0; i < 512; i++) {
    if (i >= uSteps) break;
    vec3 p = ro + rd * t;
    float d = map(p);
    if (d < eps) { hit = true; break; }
    t += max(d * 0.9, eps * 0.5);
    if (t > tFar) break;
  }
  if (!hit) discard;

  vec3 p = ro + rd * t;
  // Normals use a wider baseline than the hit test: a binary-raster EDT has
  // gradient jumps along the Voronoi seams of staircase edge pixels, and a
  // ~1.5 px central difference averages those out without moving the surface.
  vec3 nP = calcNormal(p, max(extent * 0.0015, 1.0));
  vec3 n = normalize(dirPixelToWorld(nP));
  vec3 v = -rdW;
  vec3 col = shade(n, v);

  // cheap AO from a few samples along the normal
  float ao = 0.0;
  for (int i = 1; i <= 4; i++) {
    float hh = float(i) * extent * 0.004;
    ao += (hh - map(p + nP * hh)) / hh;
  }
  ao = clamp(1.0 - ao * 0.22, 0.0, 1.0);
  col *= mix(0.55, 1.0, ao);

  col = aces(col);
  col = pow(col, vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);

  // write real depth so meshes/grid can coexist
  vec4 clip = uProj * viewMatrix * vec4(pixelToWorld(p), 1.0);
  float ndc = clip.z / clip.w;
  gl_FragDepthEXT = ndc * 0.5 + 0.5;
}`;

/**
 * Wraps a box mesh that raymarches the SDF field.
 */
export class RaymarchPreview {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      uniforms: {
        uField: { value: null },
        uTexSize: { value: new THREE.Vector2(1, 1) },
        uProfile: { value: 0 },
        uHalfT: { value: 8 },
        uRound: { value: 8 },
        uBulge: { value: 1 },
        uBulgePow: { value: 1 },
        uMaxBulge: { value: 8 },
        uThinProtect: { value: 0 },
        uBoundsMin: { value: new THREE.Vector3() },
        uBoundsMax: { value: new THREE.Vector3() },
        uCenter: { value: new THREE.Vector2() },
        uScale: { value: 1 },
        uSteps: { value: 160 },
        uColor: { value: new THREE.Color(0xffc14d) },
        uMetal: { value: 1 },
        uRough: { value: 0.3 },
        uSectionZ: { value: -1 },
        uProj: { value: new THREE.Matrix4() },
        uEnv: { value: null },
        uHasEnv: { value: 0 },
        uEnvMaxLod: { value: 0 },
        uEnvRot: { value: 0 },
        uEnvIntensity: { value: 1 }
      }
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.texture = null;
    this.meta = null; // { w, h, bbox:{minX,minY,maxX,maxY}, center, scale }
  }

  /**
   * Upload new 2D fields.
   * @param {Float32Array} sdf2d
   * @param {Float32Array} thickness
   * @param {number} w
   * @param {number} h
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} bbox  ink bbox in px
   * @param {number} targetSize  world size of the longest xy extent
   */
  setField(sdf2d, thickness, w, h, bbox, targetSize) {
    const data = new Float32Array(w * h * 2);
    for (let i = 0, n = w * h; i < n; i++) {
      data[i * 2] = sdf2d[i];
      data[i * 2 + 1] = thickness ? thickness[i] : 0;
    }
    if (this.texture) this.texture.dispose();
    const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    this.material.uniforms.uField.value = tex;
    this.material.uniforms.uTexSize.value.set(w, h);
    this.meta = { w, h, bbox, targetSize };
    this.updateBounds();
    this.mesh.visible = true;
  }

  /** Recompute the pixel box and the world box from the current params. */
  updateBounds() {
    if (!this.meta) return;
    const u = this.material.uniforms;
    const { bbox, targetSize } = this.meta;
    const margin = u.uRound.value + 3;
    const minX = bbox.minX - margin, maxX = bbox.maxX + margin;
    const minY = bbox.minY - margin, maxY = bbox.maxY + margin;
    // max half height across profiles (conservative)
    let Hmax = u.uHalfT.value;
    if (u.uProfile.value !== 0) Hmax += u.uMaxBulge.value * Math.max(u.uBulge.value, u.uThinProtect.value, 1);
    const halfZ = Hmax + 2;
    const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
    const longest = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 1e-6);
    const s = targetSize / longest;
    u.uBoundsMin.value.set(minX, minY, -halfZ);
    u.uBoundsMax.value.set(maxX, maxY, halfZ);
    u.uCenter.value.set(cx, cy);
    u.uScale.value = s;
    // world box: x = (px-cx)*s, y = -(py-cy)*s, z = -pz*s
    const wx = (maxX - minX) * s, wy = (maxY - minY) * s, wz = 2 * halfZ * s;
    this.mesh.scale.set(wx, wy, wz);
    this.mesh.position.set(((minX + maxX) / 2 - cx) * s, -((minY + maxY) / 2 - cy) * s, 0);
    this.pixelScale = s;
  }

  /**
   * @param {{profile:string, halfThickness:number, roundRadius:number, bulge:number, bulgePower:number, maxBulge:number, thinProtect:number, steps:number, sectionZ:number}} p  pixel units
   */
  setParams(p) {
    const u = this.material.uniforms;
    u.uProfile.value = PROFILE_INDEX[p.profile] ?? 0;
    u.uHalfT.value = p.halfThickness;
    u.uRound.value = p.roundRadius;
    u.uBulge.value = p.bulge;
    u.uBulgePow.value = p.bulgePower;
    u.uMaxBulge.value = p.maxBulge;
    u.uThinProtect.value = p.thinProtect;
    u.uSteps.value = p.steps;
    u.uSectionZ.value = p.sectionZ ?? -1;
    this.updateBounds();
  }

  setMaterial(color, metal, rough, intensity = 1) {
    const u = this.material.uniforms;
    u.uColor.value.set(color);
    u.uMetal.value = metal;
    u.uRough.value = rough;
    u.uEnvIntensity.value = intensity;
  }

  /** Equirect HDR texture (mipmapped) or null for the procedural studio. */
  setEnvironment(tex) {
    const u = this.material.uniforms;
    u.uEnv.value = tex;
    u.uHasEnv.value = tex ? 1 : 0;
    if (tex && tex.image) {
      const w = tex.image.width || 1, h = tex.image.height || 1;
      u.uEnvMaxLod.value = Math.max(0, Math.log2(Math.max(w, h)) - 1);
    }
  }

  setEnvRotation(rad) { this.material.uniforms.uEnvRot.value = rad; }

  dispose() {
    if (this.texture) this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
