/**
 * flyControls.js - Game-style fly camera with inertia ("lazy" smoothing).
 *
 * Mouse look: drag with the left button, or pointer lock when enabled
 * (click the canvas to lock, Esc to release). Keys: W/A/S/D move, Q/E or
 * C/Space down/up, Shift = 3x speed. Movement follows the view direction.
 *
 * `laziness` (0..1) smooths both velocity and look: 0 = instant, 0.9 = very
 * floaty. update(dt) returns true while the camera is still moving so the
 * render loop knows to keep drawing.
 */
import * as THREE from 'three';

export class FlyControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLCanvasElement} canvas
   * @param {{isActive?: () => boolean}} [opts]
   */
  constructor(camera, canvas, opts = {}) {
    this.camera = camera;
    this.canvas = canvas;
    this.isActive = opts.isActive || (() => true);
    this.enabled = false;
    this.pointerLock = false;
    this.speed = 60;          // world units per second
    this.laziness = 0.85;     // 0..1
    this.lookSpeed = 0.0025;  // radians per pixel
    this.yaw = 0; this.pitch = 0;
    this.targetYaw = 0; this.targetPitch = 0;
    this.velocity = new THREE.Vector3();
    this.keys = new Set();
    this._dragging = false;
    this._locked = false;
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    this._onKeyDown = (e) => {
      if (!this.enabled || !this.isActive()) return;
      const t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if ('wasdqec '.includes(k) || k === 'shift') { this.keys.add(k === ' ' ? 'space' : k); if (k === ' ') e.preventDefault(); }
    };
    this._onKeyUp = (e) => { const k = e.key.toLowerCase(); this.keys.delete(k === ' ' ? 'space' : k); };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());

    c.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (this.pointerLock && !this._locked) { c.requestPointerLock && c.requestPointerLock(); return; }
      if (e.button === 0 || e.button === 2) { this._dragging = true; c.setPointerCapture(e.pointerId); }
    });
    c.addEventListener('pointerup', () => { this._dragging = false; });
    c.addEventListener('pointermove', (e) => {
      if (!this.enabled) return;
      if (this._locked || this._dragging) this._look(e.movementX, e.movementY);
    });
    c.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === c;
      c.style.cursor = this._locked ? 'none' : (this.enabled ? 'crosshair' : '');
    });
  }

  _look(dx, dy) {
    this.targetYaw -= dx * this.lookSpeed;
    this.targetPitch -= dy * this.lookSpeed;
    const lim = Math.PI / 2 - 0.01;
    this.targetPitch = Math.max(-lim, Math.min(lim, this.targetPitch));
  }

  /** Enter fly mode from the camera's current orientation. */
  enable() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    this.yaw = this.targetYaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = this.targetPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    this.velocity.set(0, 0, 0);
    this.enabled = true;
    this.canvas.style.cursor = 'crosshair';
    this._applyRotation();
  }

  disable() {
    this.enabled = false;
    this.keys.clear();
    this._dragging = false;
    if (this._locked && document.exitPointerLock) document.exitPointerLock();
    this.canvas.style.cursor = '';
  }

  _applyRotation() {
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  /**
   * @param {number} dt seconds
   * @returns {boolean} true if the camera moved
   */
  update(dt) {
    if (!this.enabled) return false;
    dt = Math.min(dt, 0.1);
    // smoothing factor per frame, normalised to 60 fps so laziness feels the same at any rate
    const k = 1 - Math.pow(Math.max(0, Math.min(0.995, this.laziness)), dt * 60);

    // look
    const dy = this.targetYaw - this.yaw, dp = this.targetPitch - this.pitch;
    this.yaw += dy * k; this.pitch += dp * k;

    // move
    const want = new THREE.Vector3();
    const K = this.keys;
    if (K.has('w')) want.z -= 1;
    if (K.has('s')) want.z += 1;
    if (K.has('a')) want.x -= 1;
    if (K.has('d')) want.x += 1;
    if (K.has('e') || K.has('space')) want.y += 1;
    if (K.has('q') || K.has('c')) want.y -= 1;
    if (want.lengthSq() > 0) {
      want.normalize().multiplyScalar(this.speed * (K.has('shift') ? 3 : 1));
      // camera-relative: z forward along the view, x strafe, y world up
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      const local = new THREE.Vector3(want.x, 0, want.z).applyQuaternion(q);
      local.y += want.y;
      want.copy(local);
    }
    this.velocity.lerp(want, k);

    const moving = this.velocity.lengthSq() > 1e-4 || Math.abs(dy) > 1e-5 || Math.abs(dp) > 1e-5;
    if (moving) {
      this.camera.position.addScaledVector(this.velocity, dt);
      this._applyRotation();
    } else {
      this.velocity.set(0, 0, 0);
    }
    return moving;
  }
}
