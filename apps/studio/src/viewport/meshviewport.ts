/**
 * The inspection viewport (P4-T2), built to `.agents/skills/threejs-editor-viewport`.
 *
 * The invariant that shapes it: viewports are INSTRUMENTS, never pixel truth.
 * Core renders the sprites; this shows a mesh so you can judge shape and
 * joints. It therefore stays visually plain — standard materials, neutral
 * lighting, helpers — and nothing here may ever be presented as output.
 *
 * A plain class with init/attach/dispose and an emitter, per the skill's
 * architecture stance: three.js never leaks into a framework component, so
 * three's monthly churn and React stay strangers.
 */
import * as THREE from 'three/webgpu';
import CameraControls from 'camera-controls';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { pickJoint, type ScreenJoint } from './picking';
import { disposeTree, type MaterialLike, type TreeNode } from './dispose';

export type ViewMode = 'textured' | 'clay' | 'wire';

export interface NudgeEvent {
  joint: string;
  /** model-space delta, which is what `rig --edits` expects */
  delta: [number, number, number];
}

type Events = {
  ready: () => void;
  error: (message: string) => void;
  jointSelected: (joint: string | null) => void;
  jointNudged: (e: NudgeEvent) => void;
};

/** camera-controls needs a THREE subset installed once, before any instance. */
let installed = false;
function installOnce(): void {
  if (installed) return;
  CameraControls.install({
    THREE: THREE as unknown as Parameters<typeof CameraControls.install>[0]['THREE'],
  });
  installed = true;
}

const CLAY = new THREE.MeshStandardMaterial({ color: 0x9a96a4, roughness: 0.85, metalness: 0 });
const WIRE = new THREE.MeshBasicMaterial({ color: 0x55d0d6, wireframe: true });
/** Module-level and therefore shared by every viewport — never disposed. */
const SHARED: ReadonlySet<MaterialLike> = new Set([CLAY, WIRE] as unknown as MaterialLike[]);

export class MeshViewport {
  #container: HTMLElement;
  #renderer: THREE.WebGPURenderer;
  #scene = new THREE.Scene();
  #camera: THREE.PerspectiveCamera;
  #controls: CameraControls | null = null;
  #timer = new THREE.Timer();
  #resize: ResizeObserver | null = null;
  #raf = 0;
  #frames = 0;
  #lastError: string | null = null;
  #disposed = false;

  /** the loaded glTF root, replaced wholesale on each load */
  #model: THREE.Object3D | null = null;
  #originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  #mode: ViewMode = 'textured';

  // --- bone overlay ---
  #skeletonHelper: THREE.SkeletonHelper | null = null;
  #bones: THREE.Bone[] = [];
  #selected: string | null = null;
  #mixer: THREE.AnimationMixer | null = null;
  #animPlaying = false;
  #animDuration = 0;
  #gizmo: TransformControls | null = null;
  #gizmoHelper: THREE.Object3D | null = null;
  #proxy = new THREE.Object3D();
  #dragStart = new THREE.Vector3();
  #listeners: { [K in keyof Events]: Events[K][] } = {
    ready: [],
    error: [],
    jointSelected: [],
    jointNudged: [],
  };
  #onPointerDown: (e: PointerEvent) => void;
  #onKeyDown: (e: KeyboardEvent) => void;

  private constructor(container: HTMLElement, renderer: THREE.WebGPURenderer) {
    this.#container = container;
    this.#renderer = renderer;
    this.#camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.#camera.position.set(0, 1.2, 3);

    this.#scene.background = null;
    // neutral, plain, deliberately unflattering — this is an instrument
    this.#scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 4, 3);
    this.#scene.add(key);
    this.#scene.add(new THREE.GridHelper(4, 8, 0x32323a, 0x24242a));
    this.#scene.add(this.#proxy);

    this.#onPointerDown = (e) => this.#handlePick(e);
    this.#onKeyDown = (e) => this.#handleKey(e);
  }

  /** Async because WebGPURenderer.init() is (skill: defer the first frame). */
  static async create(container: HTMLElement): Promise<MeshViewport> {
    installOnce();
    const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    await renderer.init();
    const v = new MeshViewport(container, renderer);
    v.#attach();
    return v;
  }

  #attach(): void {
    const canvas = this.#renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.tabIndex = 0; // keyboard reachable: the gizmo has W/E/R/Q
    this.#container.appendChild(canvas);

    this.#controls = new CameraControls(this.#camera, canvas);
    this.#controls.smoothTime = 0.08;
    this.#controls.dollyToCursor = true;

    this.#gizmo = new TransformControls(this.#camera, canvas);
    this.#gizmo.setSpace('world');
    // the classic bug the skill names: the camera orbiting mid-drag
    this.#gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = Boolean((e as unknown as { value: boolean }).value);
      if (this.#controls) this.#controls.enabled = !dragging;
      if (dragging) this.#dragStart.copy(this.#proxy.position);
      else this.#commitNudge();
    });
    // recent three splits the controls from their visual
    this.#gizmoHelper = this.#gizmo.getHelper();
    this.#gizmoHelper.visible = false;
    this.#scene.add(this.#gizmoHelper);

    canvas.addEventListener('pointerdown', this.#onPointerDown);
    canvas.addEventListener('keydown', this.#onKeyDown);

    this.#resize = new ResizeObserver(() => this.#applySize());
    this.#resize.observe(this.#container);
    this.#applySize();

    const loop = () => {
      if (this.#disposed) return;
      this.#raf = requestAnimationFrame(loop);
      this.#frames++;
      this.#timer.update();
      const dt = this.#timer.getDelta();
      this.#controls?.update(dt);
      // playback rides the SAME loop the camera does - no second clock, and
      // the hidden-window pause applies to motion exactly as it does to draws
      if (this.#mixer && this.#animPlaying) this.#mixer.update(dt);
      try {
        this.#renderer.render(this.#scene, this.#camera);
      } catch (err) {
        // a throw inside rAF kills the loop silently; surface it instead
        this.#lastError = err instanceof Error ? err.message : String(err);
        this.#emit('error', this.#lastError);
      }
    };
    this.#raf = requestAnimationFrame(loop);
    this.#emit('ready');
  }

  #applySize(): void {
    const w = this.#container.clientWidth || 1;
    const h = this.#container.clientHeight || 1;
    this.#renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.#renderer.setSize(w, h, false); // CSS-sized canvas
    this.#camera.aspect = w / h;
    this.#camera.updateProjectionMatrix();
  }

  /** Load canonical glTF bytes (asset-store only, per the skill). */
  async load(bytes: ArrayBuffer): Promise<void> {
    this.#clearModel();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(bytes, '');
    this.#model = gltf.scene;
    this.#scene.add(this.#model);

    this.#originalMaterials.clear();
    this.#bones = [];
    let skinnedRoot: THREE.Object3D | null = null;
    this.#model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        this.#originalMaterials.set(mesh, mesh.material);
      }
      if ((o as THREE.Bone).isBone) this.#bones.push(o as THREE.Bone);
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && skinnedRoot === null) skinnedRoot = o;
    });
    if (this.#bones.length > 0) {
      this.#skeletonHelper = new THREE.SkeletonHelper(skinnedRoot ?? this.#model);
      this.#skeletonHelper.visible = false;
      this.#scene.add(this.#skeletonHelper);
    }
    this.setMode(this.#mode);
    if (gltf.animations.length > 0) {
      this.#mixer = new THREE.AnimationMixer(this.#model);
      const clip = gltf.animations[0]!;
      this.#animDuration = clip.duration;
      this.#mixer.clipAction(clip).play();
      this.#animPlaying = true; // the preview exists to SHOW motion
    }
    this.frame();
  }

  /* ---- animation transport (D-038: playback, never synthesis) ---- */

  get animationDuration(): number {
    return this.#mixer ? this.#animDuration : 0;
  }

  get animationTime(): number {
    return this.#mixer ? this.#mixer.time % Math.max(this.#animDuration, 1e-6) : 0;
  }

  get animationPlaying(): boolean {
    return this.#animPlaying;
  }

  setAnimationPlaying(playing: boolean): void {
    if (!this.#mixer) return;
    this.#animPlaying = playing;
    this.renderOnce();
  }

  /** Jump to `t` seconds - works paused, so the scrub IS the frame picker. */
  seekAnimation(t: number): void {
    if (!this.#mixer) return;
    this.#mixer.setTime(Math.max(0, Math.min(t, this.#animDuration)));
    this.renderOnce();
  }

  /**
   * Draw exactly one frame, now.
   *
   * The loop is requestAnimationFrame, which by design does NOT run while the
   * window is hidden — right for a desktop app (no GPU burn in the
   * background) and the reason a hidden webview shows zero frames. This is
   * the deterministic escape hatch: it repaints after a state change that a
   * paused loop would otherwise sit on, and it is how the in-pane checks
   * prove the renderer draws at all.
   */
  renderOnce(): void {
    if (this.#disposed) return;
    this.#frames++;
    try {
      this.#renderer.render(this.#scene, this.#camera);
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#emit('error', this.#lastError);
    }
  }

  /** fitToBox — the frame-selected an editor must have. */
  frame(): void {
    if (!this.#model || !this.#controls) return;
    const box = new THREE.Box3().setFromObject(this.#model);
    if (box.isEmpty()) return;
    this.#controls.fitToBox(box, true, { paddingTop: 0.1, paddingBottom: 0.1 });
  }

  setMode(mode: ViewMode): void {
    this.#mode = mode;
    for (const [mesh, original] of this.#originalMaterials) {
      mesh.material = mode === 'textured' ? original : mode === 'clay' ? CLAY : WIRE;
    }
  }

  get mode(): ViewMode {
    return this.#mode;
  }

  setSkeletonVisible(visible: boolean): void {
    if (this.#skeletonHelper) this.#skeletonHelper.visible = visible;
    if (!visible) this.selectJoint(null);
  }

  get jointNames(): string[] {
    return this.#bones.map((b) => b.name);
  }

  selectJoint(name: string | null): void {
    this.#selected = name;
    const bone = name === null ? null : this.#bones.find((b) => b.name === name) ?? null;
    if (bone === null) {
      this.#gizmo?.detach();
      if (this.#gizmoHelper) this.#gizmoHelper.visible = false;
    } else {
      bone.getWorldPosition(this.#proxy.position);
      this.#gizmo?.attach(this.#proxy);
      if (this.#gizmoHelper) this.#gizmoHelper.visible = true;
    }
    this.#emit('jointSelected', name);
  }

  get selectedJoint(): string | null {
    return this.#selected;
  }

  /**
   * Select a joint BY NAME and bring the camera's orbit target to it — the
   * deform report's rows call this, so a flagged joint is one activation away
   * from being looked at instead of a name the user must hunt for by eye.
   * No transition: the render loop is on-demand, and a smoothed move would
   * need frames nothing schedules.
   */
  focusJoint(name: string): void {
    this.selectJoint(name);
    const bone = this.#bones.find((b) => b.name === name);
    if (!bone || !this.#controls) return;
    const p = new THREE.Vector3();
    bone.getWorldPosition(p);
    this.#controls.moveTo(p.x, p.y, p.z, false);
    // F14: centering alone left a x10-stretch clavicle inspected from across
    // the room. Dolly to a close-up - near enough to judge one joint, far
    // enough to keep its neighborhood - but never dolly OUT past where the
    // user already is (their zoom is their choice).
    this.#controls.dollyTo(Math.min(this.#controls.distance, 0.65), false);
    this.#controls.update(0);
    this.renderOnce();
  }

  /** Joint positions in canvas pixels — the pick space, and testable input. */
  screenJoints(): ScreenJoint[] {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    return this.#bones.map((b) => {
      b.getWorldPosition(v);
      const depth = v.clone().applyMatrix4(this.#camera.matrixWorldInverse).z;
      v.project(this.#camera);
      return {
        name: b.name,
        x: ((v.x + 1) / 2) * rect.width,
        y: ((1 - v.y) / 2) * rect.height,
        depth: -depth,
      };
    });
  }

  #handlePick(e: PointerEvent): void {
    if (this.#skeletonHelper?.visible !== true) return;
    if (this.#gizmo?.dragging) return;
    const rect = this.#renderer.domElement.getBoundingClientRect();
    const hit = pickJoint(this.screenJoints(), e.clientX - rect.left, e.clientY - rect.top, 14);
    // a miss deselects: grabbing "whatever was nearby" is worse than nothing
    if (hit !== this.#selected) this.selectJoint(hit);
  }

  #handleKey(e: KeyboardEvent): void {
    if (!this.#gizmo) return;
    const k = e.key.toLowerCase();
    // the editor keys users arrive with (Blender/Unity/three's own editor)
    if (k === 'w') this.#gizmo.setMode('translate');
    else if (k === 'e') this.#gizmo.setMode('rotate');
    else if (k === 'r') this.#gizmo.setMode('scale');
    else if (k === 'q') {
      this.#gizmo.setSpace(this.#gizmo.space === 'local' ? 'world' : 'local');
    } else if (k === 'f') this.frame();
    else if (k === 'escape') this.selectJoint(null);
    else return;
    e.preventDefault();
  }

  #commitNudge(): void {
    if (this.#selected === null || this.#model === null) return;
    const worldDelta = this.#proxy.position.clone().sub(this.#dragStart);
    if (worldDelta.lengthSq() < 1e-12) return;
    // core's joint heads/tails live in MODEL space; a world delta must come
    // back through the model's transform or a rotated import edits sideways
    const inv = new THREE.Matrix4().copy(this.#model.matrixWorld).invert();
    const local = worldDelta.clone().transformDirection(inv).multiplyScalar(worldDelta.length());
    this.#emit('jointNudged', {
      joint: this.#selected,
      delta: [
        Number(local.x.toFixed(6)),
        Number(local.y.toFixed(6)),
        Number(local.z.toFixed(6)),
      ],
    });
  }

  /**
   * The renderer's own accounting — the leak assertion the skill requires
   * ("assert renderer.info.memory returns to baseline"), and the only honest
   * way to verify a GPU canvas is drawing: reading its pixels back gives an
   * empty buffer, because the drawing buffer is cleared after present.
   */
  stats(): {
    geometries: number;
    textures: number;
    calls: number;
    triangles: number;
    frames: number;
    sceneChildren: number;
    lastError: string | null;
  } {
    return {
      geometries: this.#renderer.info.memory.geometries,
      textures: this.#renderer.info.memory.textures,
      calls: this.#renderer.info.render.calls,
      triangles: this.#renderer.info.render.triangles,
      frames: this.#frames,
      sceneChildren: this.#scene.children.length,
      lastError: this.#lastError,
    };
  }

  #clearModel(): void {
    if (this.#skeletonHelper) {
      this.#scene.remove(this.#skeletonHelper);
      this.#skeletonHelper.dispose();
      this.#skeletonHelper = null;
    }
    if (this.#mixer) {
      this.#mixer.stopAllAction();
      if (this.#model) this.#mixer.uncacheRoot(this.#model);
      this.#mixer = null;
      this.#animPlaying = false;
      this.#animDuration = 0;
    }
    if (!this.#model) return;
    this.#scene.remove(this.#model);
    // the walk lives in dispose.ts so it can be tested without a GPU; SHARED
    // is what stops a mesh missing from the map taking the app-wide clay or
    // wireframe material down with it
    disposeTree(
      this.#model as unknown as TreeNode,
      this.#originalMaterials as unknown as Map<TreeNode, MaterialLike | MaterialLike[]>,
      SHARED,
    );
    this.#originalMaterials.clear();
    this.#model = null;
    this.#bones = [];
    this.#selected = null;
  }

  on<K extends keyof Events>(event: K, cb: Events[K]): () => void {
    this.#listeners[event].push(cb as never);
    return () => {
      this.#listeners[event] = this.#listeners[event].filter((f) => f !== cb) as never;
    };
  }

  #emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const cb of [...this.#listeners[event]]) (cb as (...a: unknown[]) => void)(...args);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    this.#resize?.disconnect();
    const canvas = this.#renderer.domElement;
    canvas.removeEventListener('pointerdown', this.#onPointerDown);
    canvas.removeEventListener('keydown', this.#onKeyDown);
    this.#gizmo?.detach();
    this.#gizmo?.dispose();
    if (this.#gizmoHelper) this.#scene.remove(this.#gizmoHelper);
    this.#controls?.dispose();
    this.#clearModel();
    this.#renderer.dispose();
    canvas.remove();
    for (const k of Object.keys(this.#listeners) as (keyof Events)[]) this.#listeners[k] = [];
  }
}
