/**
 * viewer.js - Three.js scene for the 3D tab: orbit camera, HDR/EXR or
 * built-in studio environment, PBR material controls, bloom, supersampling,
 * baked mesh display, the raymarch preview and PNG capture.
 *
 * Rendering is on demand: call viewer.invalidate() after any change.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RaymarchPreview } from './raymarch.js';
import { FlyControls } from './flyControls.js';

export const MATERIAL_PRESETS = {
  gold:   { color: '#ffc14d', metalness: 1.0, roughness: 0.28 },
  chrome: { color: '#f0f0f4', metalness: 1.0, roughness: 0.12 },
  copper: { color: '#d88a5a', metalness: 1.0, roughness: 0.32 },
  clay:   { color: '#c9c2b8', metalness: 0.0, roughness: 0.85 },
  plastic:{ color: '#ff5f8a', metalness: 0.0, roughness: 0.35 },
  black:  { color: '#1c1c20', metalness: 0.2, roughness: 0.45 }
};

/** Final pass used for transparent captures: lifts alpha where bloom painted over empty pixels. */
const AlphaFromGlowShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c.rgb, max(c.a, clamp(l, 0.0, 1.0))); }`
};

export class Viewer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.baseRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderScale = 1.5;
    this.renderer.setPixelRatio(this.baseRatio * this.renderScale);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.bgColor = new THREE.Color(0x0f1012);
    this.scene.background = this.bgColor;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    // artwork lies in the XY plane facing +Z (thickness along Z), like a sign facing the camera
    this.camera.position.set(0, 30, 180);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.addEventListener('change', () => this.invalidate());
    this.fly = new FlyControls(this.camera, canvas, { isActive: () => canvas.getClientRects().length > 0 });
    this.navMode = 'orbit';
    this.hidePointer = false;
    this._lastT = performance.now();
    canvas.addEventListener('pointerdown', () => { if (this.navMode === 'orbit' && this.hidePointer) canvas.style.cursor = 'none'; });
    window.addEventListener('pointerup', () => { if (this.navMode === 'orbit') canvas.style.cursor = ''; });

    // environments
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.studioEnv = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.hdrTexture = null;    // equirect texture (for raymarch + background)
    this.hdrEnv = null;        // PMREM of the HDR
    this.hdrName = '';
    this.showHdrBackground = false;
    this.scene.environment = this.studioEnv;

    const key = new THREE.DirectionalLight(0xfff2e0, 0.8);
    key.position.set(60, 80, 120);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.25);
    fill.position.set(-80, 20, 60);
    this.lights = new THREE.Group();
    this.lights.add(key, fill, new THREE.AmbientLight(0xffffff, 0.1));
    this.scene.add(this.lights);

    this.grid = new THREE.GridHelper(240, 24, 0x2c3036, 0x22252a);
    this.grid.position.y = -58; // floor under a 100-unit sign
    this.scene.add(this.grid);

    this.material = new THREE.MeshStandardMaterial({ color: MATERIAL_PRESETS.gold.color, metalness: 1, roughness: 0.28, envMapIntensity: 1.0, side: THREE.DoubleSide });
    this.wireMaterial = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, wireframe: true, transparent: true, opacity: 0.35 });
    this.mesh = null;
    this.wireMesh = null;

    this.raymarch = new RaymarchPreview();
    this.scene.add(this.raymarch.mesh);

    // post-processing: render -> bloom (optional) -> output (tone map + sRGB)
    this.composerTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, this.composerTarget);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.0, 0.3, 1.5);
    this.bloomPass.enabled = false;
    this.alphaPass = new ShaderPass(AlphaFromGlowShader);
    this.alphaPass.enabled = false;
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
    this.composer.addPass(this.alphaPass);

    this.setPreset('gold');

    this._needs = true;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
    this.resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  resize() {
    const p = this.canvas.parentElement;
    const w = p.clientWidth, h = p.clientHeight;
    if (!w || !h) return;
    this._w = w; this._h = h;
    const ratio = this.baseRatio * this.renderScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Supersampling factor (1 = native, 2 = 4x samples). */
  setRenderScale(s) {
    this.renderScale = s;
    this.resize();
  }

  invalidate() { this._needs = true; }

  _render() {
    if (this.raymarch.mesh.visible) {
      this.raymarch.material.uniforms.uProj.value.copy(this.camera.projectionMatrix);
    }
    this.composer.render();
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const now = performance.now();
    const dt = (now - this._lastT) / 1000;
    this._lastT = now;
    const moved = this.navMode === 'fly' ? this.fly.update(dt) : this.controls.update();
    if (!this._needs && !moved) return;
    this._needs = false;
    this._render();
  }

  // ------------------------------------------------------------------ navigation
  /** 'orbit' or 'fly'. */
  setNavMode(mode) {
    if (mode === this.navMode) return;
    if (mode === 'fly') {
      this._orbitDistance = this.camera.position.distanceTo(this.controls.target);
      this.controls.enabled = false;
      this.fly.enable();
    } else {
      this.fly.disable();
      // keep orbiting around the point in front of the camera so there is no jump
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const d = this._orbitDistance || 150;
      this.controls.target.copy(this.camera.position).addScaledVector(dir, d);
      this.controls.enabled = true;
      this.controls.update();
    }
    this.navMode = mode;
    this.invalidate();
  }

  /** 0 = snappy, 1 = very floaty. Applies to orbit damping and fly inertia. */
  setLaziness(l) {
    l = Math.max(0, Math.min(1, l));
    this.controls.dampingFactor = 0.35 - 0.33 * l;   // 0.35 .. 0.02
    this.fly.laziness = 0.5 + 0.49 * l;              // 0.5 .. 0.99
    this.invalidate();
  }

  setFlySpeed(v) { this.fly.speed = v; }

  setHidePointer(on) {
    this.hidePointer = on;
    this.fly.pointerLock = on;
    if (!on && document.pointerLockElement === this.canvas && document.exitPointerLock) document.exitPointerLock();
  }

  // ------------------------------------------------------------------ material
  setPreset(name) {
    const p = MATERIAL_PRESETS[name] || MATERIAL_PRESETS.gold;
    this.setMaterial(p);
  }

  /**
   * @param {{color?: string, metalness?: number, roughness?: number, envIntensity?: number}} m
   */
  setMaterial(m) {
    if (m.color != null) this.material.color.set(m.color);
    if (m.metalness != null) this.material.metalness = m.metalness;
    if (m.roughness != null) this.material.roughness = m.roughness;
    if (m.envIntensity != null) this.material.envMapIntensity = m.envIntensity;
    this.material.needsUpdate = true;
    this.raymarch.setMaterial(this.material.color, this.material.metalness, this.material.roughness, this.material.envMapIntensity);
    this.invalidate();
  }

  setFlatShading(flat) {
    this.material.flatShading = flat;
    this.material.needsUpdate = true;
    this.invalidate();
  }

  setWireframe(on) {
    this._wire = on;
    if (this.wireMesh) this.wireMesh.visible = on && !!this.mesh && this.mesh.visible;
    this.invalidate();
  }

  setGrid(on) { this.grid.visible = on; this.invalidate(); }

  /** Bloom strength; 0 disables the pass. */
  setGlow(strength, radius = 0.3, threshold = 1.5) {
    this.bloomPass.strength = strength;
    this.bloomPass.radius = radius;
    this.bloomPass.threshold = threshold;
    this.bloomPass.enabled = strength > 0;
    this.invalidate();
  }

  setExposure(v) {
    this.renderer.toneMappingExposure = v;
    this.invalidate();
  }

  // ------------------------------------------------------------------ environment
  /**
   * Load an .hdr or .exr from a URL or File. Resolves with the texture.
   * @param {string|File} src
   * @param {string} [name]
   */
  async loadHDR(src, name) {
    const isFile = typeof src !== 'string';
    const label = name || (isFile ? src.name : src.split('/').pop());
    const ext = label.toLowerCase().split('.').pop();
    const loader = ext === 'exr' ? new EXRLoader() : new RGBELoader();
    loader.setDataType(THREE.HalfFloatType);
    let url = src, revoke = null;
    if (isFile) { url = URL.createObjectURL(src); revoke = url; }
    try {
      const tex = await loader.loadAsync(url);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.clearHDR();
      this.hdrTexture = tex;
      this.hdrEnv = this.pmrem.fromEquirectangular(tex).texture;
      this.hdrName = label;
      this.scene.environment = this.hdrEnv;
      this.raymarch.setEnvironment(tex);
      this._applyBackground();
      this.invalidate();
      return tex;
    } finally {
      if (revoke) URL.revokeObjectURL(revoke);
    }
  }

  /** Back to the built-in studio environment. */
  clearHDR() {
    if (this.hdrEnv) this.hdrEnv.dispose();
    if (this.hdrTexture) this.hdrTexture.dispose();
    this.hdrEnv = null; this.hdrTexture = null; this.hdrName = '';
    this.scene.environment = this.studioEnv;
    this.raymarch.setEnvironment(null);
    this._applyBackground();
    this.invalidate();
  }

  setHdrBackground(on) {
    this.showHdrBackground = on;
    this._applyBackground();
    this.invalidate();
  }

  _applyBackground() {
    this.scene.background = (this.showHdrBackground && this.hdrTexture) ? this.hdrTexture : this.bgColor;
  }

  /** Rotate the environment (and background) around the vertical axis, radians. */
  setEnvRotation(rad) {
    this.scene.environmentRotation.set(0, rad, 0);
    this.scene.backgroundRotation.set(0, rad, 0);
    this.raymarch.setEnvRotation(rad);
    this.invalidate();
  }

  setBackgroundBlur(v) {
    this.scene.backgroundBlurriness = v;
    this.invalidate();
  }

  // ------------------------------------------------------------------ meshes
  clearMesh() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    if (this.wireMesh) {
      this.scene.remove(this.wireMesh);
      this.wireMesh = null;
    }
    this.invalidate();
  }

  setGeometry(geo) {
    this.clearMesh();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.wireMesh = new THREE.Mesh(geo, this.wireMaterial);
    this.wireMesh.visible = !!this._wire;
    this.scene.add(this.mesh, this.wireMesh);
    this.invalidate();
  }

  setMeshArrays(positions, indices, normals) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (normals) geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    else geo.computeVertexNormals();
    if (indices) geo.setIndex(new THREE.BufferAttribute(indices, 1));
    this.setGeometry(geo);
  }

  setMeshVisible(v) {
    if (this.mesh) this.mesh.visible = v;
    if (this.wireMesh) this.wireMesh.visible = v && !!this._wire;
    this.invalidate();
  }

  setRaymarchVisible(v) {
    this.raymarch.mesh.visible = v && !!this.raymarch.meta;
    this.invalidate();
  }

  frame(size = 100) {
    const d = size * 1.7;
    this.camera.position.set(0, size * 0.25, d);
    this.grid.position.y = -size * 0.58;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.invalidate();
  }

  exportArrays() {
    if (!this.mesh) return null;
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute('position').array;
    const idx = geo.getIndex() ? geo.getIndex().array : null;
    const nrm = geo.getAttribute('normal') ? geo.getAttribute('normal').array : null;
    return { positions: pos, indices: idx ? (idx instanceof Uint32Array ? idx : new Uint32Array(idx)) : null, normals: nrm };
  }

  // ------------------------------------------------------------------ capture
  /**
   * Render a PNG of the current view.
   * @param {{scale?: number, transparent?: boolean, hideGrid?: boolean}} o
   *   scale multiplies the on-screen resolution (2 = twice the pixels per side)
   * @returns {Promise<Blob>}
   */
  capturePNG(o = {}) {
    const scale = o.scale ?? 2;
    const transparent = o.transparent ?? true;
    const prevBg = this.scene.background;
    const prevGrid = this.grid.visible;
    const prevRatio = this.baseRatio * this.renderScale;
    const ratio = this.baseRatio * scale;
    if (transparent) this.scene.background = null;
    if (o.hideGrid ?? transparent) this.grid.visible = false;
    this.alphaPass.enabled = transparent && this.bloomPass.enabled;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this._w, this._h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(this._w, this._h);
    this.renderer.setClearColor(0x000000, transparent ? 0 : 1);
    this._render();
    return new Promise((resolve) => {
      this.canvas.toBlob((blob) => {
        // restore
        this.scene.background = prevBg;
        this.grid.visible = prevGrid;
        this.alphaPass.enabled = false;
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.setPixelRatio(prevRatio);
        this.renderer.setSize(this._w, this._h, false);
        this.composer.setPixelRatio(prevRatio);
        this.composer.setSize(this._w, this._h);
        this.invalidate();
        resolve(blob);
      }, 'image/png');
    });
  }
}
