import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CONFIG } from '../config';

export type Quality = 'auto' | 'high' | 'medium' | 'low';

export const isTouchDevice = () =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

/**
 * Renderer + scene + camera + optional bloom, with automatic quality
 * downgrade when the frame rate drops.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private bloomEnabled = false;
  private pixelRatio = 1;
  private qualitySetting: Quality = 'auto';
  private autoLevel = 0; // 0 high, 1 medium, 2 low, 3 lowest
  private fpsSmoothed = 60;
  private lowTime = 0;
  private settleTime = 0;
  width = 1;
  height = 1;
  onResize: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.setClearColor(CONFIG.colors.sky, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'stage';
    container.appendChild(this.canvas);
    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.1, 5000);
    this.camera.up.set(0, 1, 0);
    // start one level lower on phones / tablets
    this.autoLevel = isTouchDevice() ? 1 : 0;
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(q: Quality) {
    this.qualitySetting = q;
    this.applyQuality();
  }

  private level(): number {
    switch (this.qualitySetting) {
      case 'high': return 0;
      case 'medium': return 1;
      case 'low': return 2;
      default: return this.autoLevel;
    }
  }

  private applyQuality() {
    const lvl = this.level();
    const dpr = window.devicePixelRatio || 1;
    const ratios = [CONFIG.perf.maxPixelRatio, 1.5, 1, CONFIG.perf.minPixelRatio];
    this.pixelRatio = Math.max(CONFIG.perf.minPixelRatio, Math.min(dpr, ratios[lvl]));
    this.bloomEnabled = lvl === 0;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    if (this.bloomEnabled) this.ensureComposer();
    if (this.composer) {
      this.composer.setPixelRatio(this.pixelRatio);
      this.composer.setSize(this.width, this.height);
    }
    this.settleTime = 0;
    this.lowTime = 0;
  }

  private ensureComposer() {
    if (this.composer) return;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width / 2, this.height / 2), CONFIG.fx.bloomStrength, CONFIG.fx.bloomRadius, CONFIG.fx.bloomThreshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applyQuality();
    this.onResize?.();
  }

  get pxRatio() { return this.pixelRatio; }

  /** Frame-time watchdog: steps quality down while the FPS stays low. */
  trackFrame(realDt: number) {
    if (realDt <= 0 || realDt > 0.5) return;
    this.fpsSmoothed += (1 / realDt - this.fpsSmoothed) * 0.05;
    this.settleTime += realDt;
    if (this.qualitySetting !== 'auto' || this.settleTime < 2) return;
    if (this.fpsSmoothed < CONFIG.perf.lowFps) {
      this.lowTime += realDt;
      if (this.lowTime > CONFIG.perf.downgradeAfter && this.autoLevel < 3) {
        this.autoLevel++;
        this.applyQuality();
      }
    } else this.lowTime = Math.max(0, this.lowTime - realDt);
  }

  render() {
    if (this.bloomEnabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
