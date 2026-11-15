/**
 * The Brain globe's 3D scene (Phase 4 A2, Memory 01-D13 phase 2). Library: Three.js (`three` core plus its
 * OrbitControls add-on). Records are one InstancedMesh (one draw call for up to 5,000), links are great-circle
 * arcs in one LineSegments, the selected record gets a ring and its links in honey. It renders only when
 * something changed, measures frame time, and frees every GPU object on dispose.
 *
 * The scene owns its canvas (appended to `host`) and the `data-*` test hooks on `host`: `data-nodes` and
 * `data-edges` (what is actually drawn), `data-ready` (a frame with the current data was drawn),
 * `data-selected` and `data-frame-ms` (average time spent drawing one frame, over the last 60 drawn frames: what the
 * globe costs, whether or not the window is in front and getting animation frames).
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  SphereGeometry,
  Spherical,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FrameMeter, arcSegmentPositions, arcSegmentsFor, edgePairs, fibonacciSphere, globeSummary, nodeRadius } from './globe-layout';

export interface GlobeNode {
  id: string;
  kind: string;
  importance: number;
  archived: boolean;
}

/** Colours read from the theme's CSS tokens. */
export interface GlobePalette {
  kinds: Record<string, string>;
  /** Links. */
  edge: string;
  /** Selection ring and the selected record's links. */
  highlight: string;
  /** The globe's body. */
  sphere: string;
  /** Latitude and longitude lines. */
  grid: string;
  /** Archived records are mixed toward this. */
  fade: string;
}

export interface GlobeCallbacks {
  /** Pointer over a record (index into the nodes given to setData), or null. x/y are relative to the canvas. */
  onHover: (index: number | null, x: number, y: number) => void;
  /** A click (not a drag) on a record. */
  onPick: (index: number) => void;
}

const FOV = 40;
const START_DISTANCE = 3.6;
const MIN_DISTANCE = 1.5;
const MAX_DISTANCE = 8;
const SPIN_SPEED = 0.6;
const FACE_MS = 650;
const CLICK_SLOP_PX = 5;

/** True when this machine can make a WebGL context at all. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export class GlobeScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 50);
  private readonly controls: OrbitControls;
  private readonly meter = new FrameMeter(60);
  private readonly resize: ResizeObserver;

  private readonly body: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly grid: LineSegments<BufferGeometry, LineBasicMaterial>;
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly edgeMaterial = new LineBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false });
  private readonly litMaterial = new LineBasicMaterial({ transparent: true, opacity: 1, depthWrite: false });
  private nodeGeometry: IcosahedronGeometry | null = null;
  private readonly nodeMaterial = new MeshBasicMaterial();
  private points: InstancedMesh | null = null;
  private edges: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  private lit: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;

  private nodes: GlobeNode[] = [];
  private positions: Float32Array = new Float32Array(0);
  private radii: Float32Array = new Float32Array(0);
  private pairs: Array<[number, number]> = [];
  private palette: GlobePalette | null = null;
  private selected = -1;

  private raf = 0;
  private frames = 0;
  private dirty = true;
  /** Set when data changes; cleared (and data-ready set) once a frame with it is drawn. */
  private pendingReady = false;
  private pointer: { x: number; y: number } | null = null;
  private pointerMoved = false;
  private hovered = -1;
  private down: { x: number; y: number } | null = null;
  private face: { from: Vector3; to: Vector3; distance: number; start: number } | null = null;
  private reducedMotion: boolean;
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: GlobeCallbacks,
    options: { reducedMotion: boolean; describedBy?: string; className?: string },
  ) {
    this.reducedMotion = options.reducedMotion;
    // Throws when WebGL can't start; the caller shows the list instead.
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('tabindex', '0');
    this.canvas.setAttribute('aria-label', globeSummary(0, 0));
    if (options.describedBy) this.canvas.setAttribute('aria-describedby', options.describedBy);
    if (options.className) this.canvas.className = options.className;
    this.canvas.dataset['testid'] = 'brain-globe-canvas';
    host.appendChild(this.canvas);

    this.camera.position.set(0, 0.35, START_DISTANCE);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.maxDistance = MAX_DISTANCE;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.8;
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = SPIN_SPEED;
    // Any drag, wheel or pinch stops the idle spin for good (until the view is opened again).
    this.controls.addEventListener('start', this.stopSpin);
    this.controls.addEventListener('change', this.markDirty);

    // The globe's body hides the far side, so the near side reads clearly.
    this.body = new Mesh(new SphereGeometry(0.985, 48, 32), new MeshBasicMaterial({ transparent: true, opacity: 0.92 }));
    this.body.renderOrder = 0;
    this.scene.add(this.body);
    this.grid = new LineSegments(graticule(0.988), new LineBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false }));
    this.grid.renderOrder = 1;
    this.scene.add(this.grid);
    this.ring = new Mesh(new RingGeometry(1.45, 1.95, 40), new MeshBasicMaterial({ side: DoubleSide, depthTest: false, transparent: true }));
    this.ring.renderOrder = 10;
    this.ring.visible = false;
    this.scene.add(this.ring);

    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('keydown', this.onKeyDown);
    this.resize = new ResizeObserver(() => this.fitSize());
    this.resize.observe(host);
    this.fitSize();
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Nodes must already be in globe order (orderForGlobe). */
  setData(nodes: GlobeNode[], edges: ReadonlyArray<{ from: string; to: string }>, palette: GlobePalette): void {
    this.nodes = nodes;
    this.palette = palette;
    const n = nodes.length;
    this.positions = fibonacciSphere(n, 1);
    this.radii = new Float32Array(n);
    for (let i = 0; i < n; i++) this.radii[i] = nodeRadius(nodes[i]!.importance, n);
    this.pairs = edgePairs(
      nodes.map((x) => x.id),
      edges,
    );

    // Records: one instanced draw. A coarser mesh when there are thousands.
    this.disposeNodes();
    this.nodeGeometry = new IcosahedronGeometry(1, n > 1200 ? 1 : 3);
    const mesh = new InstancedMesh(this.nodeGeometry, this.nodeMaterial, Math.max(1, n));
    mesh.count = n;
    const m = new Matrix4();
    for (let i = 0; i < n; i++) {
      const r = this.radii[i]!;
      m.makeScale(r, r, r);
      m.setPosition(this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 2;
    // Picking is done in screen space (see pick), so three's per-instance raycast isn't needed.
    mesh.raycast = () => {};
    this.points = mesh;
    this.scene.add(mesh);

    // Links: every arc in one LineSegments.
    this.disposeEdges();
    const segs = arcSegmentsFor(this.pairs.length);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(arcSegmentPositions(this.positions, this.pairs, segs, 1), 3));
    this.edges = new LineSegments(geo, this.edgeMaterial);
    this.edges.renderOrder = 1;
    this.scene.add(this.edges);

    this.applyPalette(palette);
    this.canvas.setAttribute('aria-label', globeSummary(n, this.pairs.length));
    this.host.dataset['nodes'] = String(n);
    this.host.dataset['edges'] = String(this.pairs.length);
    this.host.dataset['ready'] = 'false';
    this.pendingReady = true;
    // The selection is re-applied by the owner (ids may have moved).
    this.selected = -1;
    this.updateSelection();
    this.hovered = -1;
    this.pointerMoved = this.pointer !== null;
    this.dirty = true;
  }

  setPalette(palette: GlobePalette): void {
    this.palette = palette;
    this.applyPalette(palette);
    this.dirty = true;
  }

  /** Highlight a record (or none). `face` turns the globe so it is in front. */
  setSelected(id: string | null, face: boolean): void {
    const i = id === null ? -1 : this.nodes.findIndex((x) => x.id === id);
    if (i !== this.selected) {
      this.selected = i;
      this.updateSelection();
    }
    if (face && i >= 0) this.faceNode(i);
    this.dirty = true;
  }

  setReducedMotion(reduce: boolean): void {
    this.reducedMotion = reduce;
    if (reduce) this.controls.autoRotate = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    this.controls.removeEventListener('start', this.stopSpin);
    this.controls.removeEventListener('change', this.markDirty);
    this.controls.dispose();
    this.disposeNodes();
    this.disposeEdges();
    this.nodeMaterial.dispose();
    this.edgeMaterial.dispose();
    this.litMaterial.dispose();
    this.body.geometry.dispose();
    this.body.material.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    // Give the context back now: switching views repeatedly must not pile up WebGL contexts.
    this.renderer.forceContextLoss();
    this.canvas.remove();
    for (const k of ['nodes', 'edges', 'ready', 'selected', 'frameMs']) delete this.host.dataset[k];
  }

  // ---- internals ----

  private readonly stopSpin = (): void => {
    this.controls.autoRotate = false;
    this.face = null;
  };

  private readonly markDirty = (): void => {
    this.dirty = true;
    if (this.pointer) this.pointerMoved = true;
  };

  private fitSize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private applyPalette(p: GlobePalette): void {
    const fade = new Color(p.fade);
    const c = new Color();
    const mesh = this.points;
    if (mesh) {
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i]!;
        c.set(p.kinds[node.kind] ?? p.edge);
        // Archived: mixed most of the way into the background, so it reads as faded.
        if (node.archived) c.lerp(fade, 0.62);
        mesh.setColorAt(i, c);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.edgeMaterial.color.set(p.edge);
    this.litMaterial.color.set(p.highlight);
    this.ring.material.color.set(p.highlight);
    this.body.material.color.set(p.sphere);
    this.grid.material.color.set(p.grid);
  }

  private updateSelection(): void {
    if (this.lit) {
      this.scene.remove(this.lit);
      this.lit.geometry.dispose();
      this.lit = null;
    }
    const i = this.selected;
    this.ring.visible = false;
    this.edgeMaterial.opacity = i >= 0 ? 0.1 : 0.2;
    this.host.dataset['selected'] = i >= 0 ? this.nodes[i]!.id : '';
    if (i < 0) return;
    const r = this.radii[i]!;
    this.ring.scale.set(r, r, r);
    this.ring.position.set(this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!);
    const mine = this.pairs.filter(([a, b]) => a === i || b === i);
    if (mine.length) {
      const segs = arcSegmentsFor(0);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(arcSegmentPositions(this.positions, mine, segs, 1.002), 3));
      this.lit = new LineSegments(geo, this.litMaterial);
      this.lit.renderOrder = 3;
      this.scene.add(this.lit);
    }
  }

  /** Turn the camera (same distance) so record i is in front, smoothly unless motion is reduced. */
  private faceNode(i: number): void {
    this.controls.autoRotate = false;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const distance = offset.length();
    const to = new Vector3(this.positions[i * 3]!, this.positions[i * 3 + 1]!, this.positions[i * 3 + 2]!).normalize();
    const from = offset.normalize();
    if (this.reducedMotion || from.angleTo(to) < 1e-3) {
      this.camera.position.copy(to.multiplyScalar(distance)).add(target);
      this.controls.update();
      this.face = null;
    } else {
      this.face = { from, to, distance, start: performance.now() };
    }
    this.dirty = true;
  }

  private stepFace(now: number): void {
    const f = this.face;
    if (!f) return;
    const t = Math.min(1, (now - f.start) / FACE_MS);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    // Slerp the direction.
    const angle = f.from.angleTo(f.to);
    let dir: Vector3;
    if (angle > Math.PI - 1e-3) dir = f.from.clone().lerp(f.to, e).normalize();
    else {
      const s = Math.sin(angle);
      dir = f.from
        .clone()
        .multiplyScalar(Math.sin((1 - e) * angle) / s)
        .add(f.to.clone().multiplyScalar(Math.sin(e * angle) / s));
    }
    if (dir.lengthSq() < 1e-6) dir = f.to.clone();
    this.camera.position.copy(dir.normalize().multiplyScalar(f.distance)).add(this.controls.target);
    this.dirty = true;
    if (t >= 1) this.face = null;
  }

  /** The record under canvas point (x, y): nearest on screen, on the near side, within its size plus a margin. */
  private pick(x: number, y: number): number {
    const n = this.nodes.length;
    if (!n) return -1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cam = this.camera.position;
    const pxPerUnit = h / (2 * Math.tan((FOV * Math.PI) / 360));
    const v = new Vector3();
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const px = this.positions[i * 3]!;
      const py = this.positions[i * 3 + 1]!;
      const pz = this.positions[i * 3 + 2]!;
      // On the unit sphere, p faces the camera when p · cam > 1.
      if (px * cam.x + py * cam.y + pz * cam.z <= 1) continue;
      v.set(px, py, pz);
      const dist = v.distanceTo(cam);
      v.project(this.camera);
      const sx = ((v.x + 1) / 2) * w;
      const sy = ((1 - v.y) / 2) * h;
      const rad = (this.radii[i]! * pxPerUnit) / dist;
      const tol = Math.max(rad + 4, 9);
      const d2 = (sx - x) ** 2 + (sy - y) ** 2;
      if (d2 > tol * tol) continue;
      const score = d2 / (tol * tol);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const box = this.canvas.getBoundingClientRect();
    this.pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
    this.pointerMoved = true;
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    this.pointerMoved = false;
    if (this.hovered !== -1) {
      this.hovered = -1;
      this.canvas.style.cursor = '';
      this.callbacks.onHover(null, 0, 0);
    }
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
    const box = this.canvas.getBoundingClientRect();
    const i = this.pick(e.clientX - box.left, e.clientY - box.top);
    if (i >= 0) this.callbacks.onPick(i);
  };

  /** Arrow keys turn the globe; + and - zoom. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const STEP = Math.PI / 24;
    let dTheta = 0;
    let dPhi = 0;
    let zoom = 1;
    if (e.key === 'ArrowLeft') dTheta = -STEP;
    else if (e.key === 'ArrowRight') dTheta = STEP;
    else if (e.key === 'ArrowUp') dPhi = -STEP;
    else if (e.key === 'ArrowDown') dPhi = STEP;
    else if (e.key === '+' || e.key === '=') zoom = 0.85;
    else if (e.key === '-' || e.key === '_') zoom = 1 / 0.85;
    else return;
    e.preventDefault();
    this.stopSpin();
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const s = new Spherical().setFromVector3(offset);
    s.theta += dTheta;
    s.phi = Math.min(Math.PI - 0.05, Math.max(0.05, s.phi + dPhi));
    s.radius = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, s.radius * zoom));
    offset.setFromSpherical(s);
    this.camera.position.copy(target).add(offset);
    this.controls.update();
    this.dirty = true;
  };

  private readonly tick = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const started = performance.now();

    this.stepFace(now);
    if (this.controls.update()) this.dirty = true;

    if (this.pointerMoved && this.pointer && !this.down) {
      this.pointerMoved = false;
      const i = this.pick(this.pointer.x, this.pointer.y);
      if (i !== this.hovered) {
        this.hovered = i;
        this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
      }
      this.callbacks.onHover(i >= 0 ? i : null, this.pointer.x, this.pointer.y);
    }

    if (!this.dirty) return;
    this.dirty = false;
    if (this.selected >= 0) {
      const i = this.selected;
      this.ring.quaternion.copy(this.camera.quaternion);
      const cam = this.camera.position;
      this.ring.visible = this.positions[i * 3]! * cam.x + this.positions[i * 3 + 1]! * cam.y + this.positions[i * 3 + 2]! * cam.z > 1;
    }
    this.renderer.render(this.scene, this.camera);
    this.meter.push(performance.now() - started);
    if (++this.frames % 10 === 1) this.host.dataset['frameMs'] = this.meter.average().toFixed(1);
    if (this.pendingReady) {
      this.pendingReady = false;
      this.host.dataset['ready'] = 'true';
    }
  };

  private disposeNodes(): void {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.dispose();
      this.points = null;
    }
    this.nodeGeometry?.dispose();
    this.nodeGeometry = null;
  }

  private disposeEdges(): void {
    if (this.edges) {
      this.scene.remove(this.edges);
      this.edges.geometry.dispose();
      this.edges = null;
    }
    if (this.lit) {
      this.scene.remove(this.lit);
      this.lit.geometry.dispose();
      this.lit = null;
    }
  }
}

/** Latitude and longitude lines every 30°, as line segments. */
function graticule(r: number): BufferGeometry {
  const pts: number[] = [];
  const STEPS = 72;
  for (let lat = -60; lat <= 60; lat += 30) {
    const phi = (lat * Math.PI) / 180;
    const y = Math.sin(phi) * r;
    const rr = Math.cos(phi) * r;
    for (let s = 0; s < STEPS; s++) {
      const a0 = (s / STEPS) * Math.PI * 2;
      const a1 = ((s + 1) / STEPS) * Math.PI * 2;
      pts.push(Math.cos(a0) * rr, y, Math.sin(a0) * rr, Math.cos(a1) * rr, y, Math.sin(a1) * rr);
    }
  }
  for (let lon = 0; lon < 180; lon += 30) {
    const th = (lon * Math.PI) / 180;
    for (let s = 0; s < STEPS; s++) {
      const a0 = (s / STEPS) * Math.PI * 2;
      const a1 = ((s + 1) / STEPS) * Math.PI * 2;
      pts.push(
        Math.cos(a0) * Math.cos(th) * r,
        Math.sin(a0) * r,
        Math.cos(a0) * Math.sin(th) * r,
        Math.cos(a1) * Math.cos(th) * r,
        Math.sin(a1) * r,
        Math.cos(a1) * Math.sin(th) * r,
      );
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  return geo;
}
