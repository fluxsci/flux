/** Deterministic WebGL2 rendering, shared by worker, player, export and notebook. */
import {
  BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Group,
  HemisphereLight, Matrix3, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  NoToneMapping, OrthographicCamera, PerspectiveCamera, Scene, SRGBColorSpace,
  Vector3, WebGLRenderer, type Material, type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { prepareGlb } from './glbCore.mjs';
import { orbitPose, boundsSphere, type OrbitPose } from './orbit';
import { mapValues } from './colormap';
import { buildScene3dPartIndex, scene3dPartLineage, type Scene3dPartIndex, resolveScene3dPartStyle } from './scene3d';
import { RENDERER_VERSION } from './poster';
export { RENDERER_VERSION } from './poster';
import { lerpColor } from '../color/interp';
import type { Model3dInfo, Model3dElement, ModelBounds, Model3dRenderSpec, Scene3dManifest, Scene3dPart } from './types';

export type RenderSpec = Model3dRenderSpec & { morph?: NonNullable<Model3dRenderSpec['morph']> & { toManifest?: Scene3dManifest } };
export interface LoadedModelStats extends Model3dInfo { bytes: number; parseMs: number }
export interface RenderCoreStats { contexts: number; residentBytes: number; loads: number; renders: number; lost: boolean; assets: number; morphPairs: number }
type Canvas = OffscreenCanvas | HTMLCanvasElement;
type FluxMaterial = MeshBasicMaterial | MeshStandardMaterial;
type Attribute = BufferAttribute | import('three').InterleavedBufferAttribute;
interface Part {
  node: string; mesh: Mesh<BufferGeometry, FluxMaterial>; sourceColor: Color; sourceOpacity: number;
  sourceColors?: Attribute; materials: Map<string, FluxMaterial>; colorKey?: string; vertexAlpha: boolean;
}
interface Loaded { bytes: ArrayBuffer; group: Group; parts: Part[]; stats: LoadedModelStats; storedBounds?: ModelBounds }
interface MorphPart { mesh: Mesh<BufferGeometry, FluxMaterial>; a: Part; b: Part; colorA: string; colorB: string; opacityA: number; opacityB: number; hiddenA: boolean; hiddenB: boolean; vertexColors: boolean }
interface Morph { group: Group; parts: MorphPart[]; ids: [string, string] }
const liveCanvases = new WeakSet<object>();
const rgb = (color: string) => /^#[0-9a-f]{8}$/i.test(color) ? color.slice(0, 7) : color;
const alpha = (color?: string) => color && /^#[0-9a-f]{8}$/i.test(color) ? parseInt(color.slice(7), 16) / 255 : undefined;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const modelStates = (el: Model3dElement, override?: Record<string, number>) => override ?? el.modelStates ?? {};
function materialsOf(material: Material | Material[]) { return Array.isArray(material) ? material : [material]; }
function disposeGroup(group: Object3D) {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
  group.traverse((object) => { if (object instanceof Mesh) { geometries.add(object.geometry); materialsOf(object.material).forEach((m) => materials.add(m)); } });
  geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); group.clear();
}
function makeMaterial(lighting: string): FluxMaterial {
  return lighting === 'unlit' ? new MeshBasicMaterial({ side: DoubleSide }) : new MeshStandardMaterial({ roughness: 0.55, metalness: 0, side: DoubleSide });
}
function setStates(part: Part, states: Record<string, number>) {
  const mesh = part.mesh;
  if (!mesh.morphTargetInfluences) return;
  mesh.morphTargetInfluences.fill(0);
  for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) mesh.morphTargetInfluences[index] = Number.isFinite(states[name]) ? states[name] : 0;
}
interface SemanticIndex { parts: Scene3dPartIndex; nodes: Map<string, Scene3dPart>; order: Map<string, number> }
function semanticIndex(manifest?: Scene3dManifest): SemanticIndex {
  const parts = manifest ? buildScene3dPartIndex(manifest) : Object.create(null), nodes = new Map<string, Scene3dPart>();
  for (const part of manifest?.parts ?? []) { if (part.node && !nodes.has(part.node)) nodes.set(part.node, part); if (!nodes.has(part.id)) nodes.set(part.id, part); }
  return { parts, nodes, order: new Map((manifest?.order ?? []).map((id, i) => [id, i])) };
}
/** The pure field mapper owns LUT/range/missing semantics; renderer owns GPU attributes. */
function stylePart(part: Part, element: Model3dElement, manifest: Scene3dManifest | undefined, index: SemanticIndex) {
  const entry = index.nodes.get(part.node), id = entry?.id ?? part.node, override = resolveScene3dPartStyle(manifest, element.overrides ?? {}, id, { sourceColors: false, index: index.parts });
  const lighting = element.modelLighting ?? 'studio';
  let material = part.materials.get(lighting);
  if (!material) { material = makeMaterial(lighting); part.materials.set(lighting, material); }
  part.mesh.material = material;
  const source = element.modelColors === 'source';
  const fieldOwner = typeof entry?.field === 'string' ? index.parts[entry.field] : entry;
  const field = fieldOwner?.field && typeof fieldOwner.field === 'object' ? fieldOwner.field : undefined;
  const value = part.mesh.geometry.getAttribute('_value') ?? part.mesh.geometry.getAttribute('_VALUE');
  const valid = part.mesh.geometry.getAttribute('_valid') ?? part.mesh.geometry.getAttribute('_VALID');
  const remap = source && !override?.fill && field && value;
  const colorKey = JSON.stringify([source, override?.fill, field, element.fields?.[fieldOwner?.id ?? id]]);
  if (part.colorKey !== colorKey) {
    if (remap) {
      const values = Float32Array.from({ length: value.count }, (_, i) => value.getX(i));
      const mask = valid ? Uint8Array.from({ length: valid.count }, (_, i) => valid.getX(i)) : undefined;
      part.mesh.geometry.setAttribute('color', new BufferAttribute(mapValues(values, field, element.fields?.[fieldOwner?.id ?? id], mask), 3));
    } else if (part.sourceColors) part.mesh.geometry.setAttribute('color', part.sourceColors);
    else part.mesh.geometry.deleteAttribute('color');
    part.colorKey = colorKey;
  }
  const vertexColors = source && !override?.fill && !!part.mesh.geometry.getAttribute('color');
  if (material.vertexColors !== vertexColors) { material.vertexColors = vertexColors; material.needsUpdate = true; }
  if (!source) material.color.set(rgb(element.fill));
  else if (override?.fill) material.color.set(rgb(override.fill));
  else if (remap) material.color.setRGB(1, 1, 1);
  else if (entry?.color) material.color.set(rgb(entry.color));
  else material.color.copy(part.sourceColor);
  const semanticOpacity = element.overrides?.[id]?.opacity !== undefined || scene3dPartLineage(index.parts, id).some(p => p.opacity !== undefined || element.overrides?.[p.id]?.opacity !== undefined);
  material.opacity = clamp01(Number(semanticOpacity ? override.opacity : alpha(entry?.color) ?? part.sourceOpacity) * (alpha(!source ? element.fill : override.fill) ?? 1));
  const transparent = material.opacity < 1 || (vertexColors && part.vertexAlpha);
  if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
  material.depthWrite = !transparent;
  part.mesh.visible = !(override?.hidden ?? entry?.hidden ?? false);
  const order = index.order.get(id) ?? -1;
  part.mesh.renderOrder = (transparent ? 1_000_000 : 0) + Math.max(0, order);
}
function effectiveAttribute(part: Part, name: 'position' | 'normal') {
  const geometry = part.mesh.geometry, source = geometry.getAttribute(name);
  const result = new Float32Array(source.count * 3), v = new Vector3();
  const targets = geometry.morphAttributes[name] ?? [], weights = part.mesh.morphTargetInfluences ?? [];
  const normalMatrix = new Matrix3().getNormalMatrix(part.mesh.matrixWorld);
  for (let i = 0; i < source.count; i++) {
    v.fromBufferAttribute(source, i);
    for (let j = 0; j < targets.length; j++) {
      const weight = weights[j] ?? 0; if (!weight) continue;
      const target = targets[j];
      v.x += weight * (target.getX(i) - (geometry.morphTargetsRelative ? 0 : source.getX(i)));
      v.y += weight * (target.getY(i) - (geometry.morphTargetsRelative ? 0 : source.getY(i)));
      v.z += weight * (target.getZ(i) - (geometry.morphTargetsRelative ? 0 : source.getZ(i)));
    }
    if (name === 'position') { v.applyMatrix4(part.mesh.matrixWorld); } else v.applyNormalMatrix(normalMatrix);
    v.toArray(result, i * 3);
  }
  return new BufferAttribute(result, 3);
}
function effectiveColors(part: Part) {
  const count = part.mesh.geometry.getAttribute('position').count, source = part.mesh.geometry.getAttribute('color');
  const out = new Float32Array(count * 4), color = part.mesh.material.color;
  for (let i = 0; i < count; i++) {
    out[i * 4] = (source?.getX(i) ?? 1) * color.r;
    out[i * 4 + 1] = (source?.getY(i) ?? 1) * color.g;
    out[i * 4 + 2] = (source?.getZ(i) ?? 1) * color.b;
    out[i * 4 + 3] = source?.itemSize === 4 ? source.getW(i) : 1;
  }
  return new BufferAttribute(out, 4);
}
function compatible(a: Part, b: Part) {
  const ga = a.mesh.geometry, gb = b.mesh.geometry, count = ga.getAttribute('position').count;
  if (count !== gb.getAttribute('position').count) return false;
  const na = ga.index?.count ?? count, nb = gb.index?.count ?? count;
  if (na !== nb) return false;
  for (let i = 0; i < na; i++) if ((ga.index?.getX(i) ?? i) !== (gb.index?.getX(i) ?? i)) return false;
  return true;
}
function sphereLerpBounds(a: ModelBounds, b: ModelBounds, t: number): ModelBounds {
  const sa = boundsSphere(a), sb = boundsSphere(b), r = sa.radius * (1 - t) + sb.radius * t;
  const center = sa.center.map((v, i) => v * (1 - t) + sb.center[i] * t);
  // A diagonal of this box has length 2r and `radius` is r: orbitPose recovers exactly the lerped sphere.
  return { min: center.map((v) => v - r / Math.sqrt(3)) as [number, number, number], max: center.map((v) => v + r / Math.sqrt(3)) as [number, number, number], radius: r };
}
export function createRenderCore(canvas: Canvas, options: { onContextState?: (lost: boolean) => void } = {}) {
  if (liveCanvases.has(canvas)) throw new Error('A 3D canvas cannot own a second renderer');
  const context = canvas.getContext('webgl2', { antialias: true, alpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
  if (!context) throw new Error('WebGL2 is unavailable');
  liveCanvases.add(canvas);
  const renderer = new WebGLRenderer({ canvas: canvas as HTMLCanvasElement, context, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setClearColor(0, 0); renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = NoToneMapping;
  const scene = new Scene(), loader = new GLTFLoader();
  // Prepared GLBs are self-contained. Refuse accidental resource fetches defensively.
  loader.manager.setURLModifier((url) => { if (url) throw new Error('External GLB resources are not permitted'); return url; });
  const key = new DirectionalLight(0xffffff, 2), fill = new DirectionalLight(0xffffff, 0.6);
  const ambient = new HemisphereLight(new Color().setRGB(0.9, 0.9, 0.9), new Color().setRGB(0.35, 0.35, 0.35), 1);
  scene.add(key, key.target, fill, fill.target, ambient);
  const ortho = new OrthographicCamera(), perspective = new PerspectiveCamera(), matrix = new Matrix4();
  const tickets = new Map<string, number>();
  const assets = new Map<string, Loaded>(), inflight = new Map<string, Promise<LoadedModelStats>>(), morphs = new Map<string, Morph>();
  let disposed = false, lost = false, generation = 0, restores: Promise<void> = Promise.resolve();
  let loads = 0, renders = 0, lastWidth = 0, lastHeight = 0;
  function stats(): RenderCoreStats { return { contexts: disposed ? 0 : 1, residentBytes: [...assets.values()].reduce((sum, a) => sum + a.bytes.byteLength, 0), loads, renders, lost, assets: assets.size, morphPairs: morphs.size }; }
  function guard() { if (disposed) throw new Error('3D renderer disposed'); if (lost) throw new Error('3D WebGL context unavailable'); }
  /** Stored asset bounds, when the caller has them, govern framing: they are what
   * the furniture/overlay projection uses, including old metadata without a
   * tight radius (half-diagonal). Without them the inspected bounds are used. */
  async function parse(id: string, bytes: ArrayBuffer, storedBounds?: ModelBounds): Promise<Loaded> {
    const started = performance.now(), prepared = prepareGlb(bytes), data = prepared.bytes.slice().buffer as ArrayBuffer;
    const gltf = await loader.parseAsync(data, '');
    const group = gltf.scene, parts: Part[] = [];
    group.updateMatrixWorld(true);
    group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const sourceMesh = object as Mesh<BufferGeometry, Material>;
      // Instances may share source geometry; part-specific field colors must not alias.
      sourceMesh.geometry = sourceMesh.geometry.clone();
      const original = materialsOf(sourceMesh.material)[0] as MeshStandardMaterial;
      if (!sourceMesh.geometry.getAttribute('normal')) sourceMesh.geometry.computeVertexNormals();
      let node: Object3D | null = object, index: number | undefined;
      while (node && index === undefined) { index = gltf.parser.associations.get(node)?.nodes; node = node.parent; }
      // Same part id as glbCore (`name || node-<glTF node index>`). three renames
      // unnamed objects (mesh_<n>), which made styling unnamed parts a no-op.
      const nodeDef = index !== undefined ? gltf.parser.json.nodes?.[index] : undefined;
      const nodeName = index === undefined ? undefined : typeof nodeDef?.name === 'string' && nodeDef.name ? nodeDef.name : `node-${index}`;
      const name = nodeName ?? object.name ?? `${id}:${parts.length}`;
      const colors = sourceMesh.geometry.getAttribute('color');
      let vertexAlpha = false;
      if (colors?.itemSize === 4) for (let i = 0; i < colors.count; i++) if (colors.getW(i) < 1) { vertexAlpha = true; break; }
      const material = makeMaterial('studio');
      const part: Part = { node: name, mesh: sourceMesh as Mesh<BufferGeometry, FluxMaterial>, sourceColor: original.color?.clone() ?? new Color(1, 1, 1), sourceOpacity: original.opacity ?? 1, sourceColors: colors, materials: new Map([['studio', material]]), vertexAlpha };
      materialsOf(sourceMesh.material).forEach((m) => m.dispose()); sourceMesh.material = material;
      // State defaults are explicit in the authored element, never hidden GLB state.
      sourceMesh.morphTargetInfluences?.fill(0); parts.push(part);
    });
    const bounds = storedBounds ? structuredClone(storedBounds) : prepared.info.bounds;
    return { bytes: data, group, parts, storedBounds, stats: { ...prepared.info, bounds, bytes: data.byteLength, parseMs: performance.now() - started } };
  }
  function dropMorphs(id?: string) {
    for (const [key, pair] of morphs) if (!id || pair.ids.includes(id)) { disposeGroup(pair.group); morphs.delete(key); }
  }
  function releaseLoaded(asset: Loaded) { for (const part of asset.parts) for (const material of part.materials.values()) material.dispose(); disposeGroup(asset.group); }
  function load(assetId: string, bytes: ArrayBuffer, storedBounds?: ModelBounds): Promise<LoadedModelStats> {
    if (disposed) return Promise.reject(new Error('3D renderer disposed'));
    const existing = assets.get(assetId); if (existing) return Promise.resolve(existing.stats);
    if (inflight.has(assetId)) return inflight.get(assetId)!;
    const version = generation, ticket = (tickets.get(assetId) ?? 0) + 1; tickets.set(assetId, ticket);
    const promise = parse(assetId, bytes, storedBounds).then((loaded) => {
      if (disposed || version !== generation || tickets.get(assetId) !== ticket) { releaseLoaded(loaded); throw new Error('3D load was invalidated'); }
      assets.set(assetId, loaded); loads++; return loaded.stats;
    }).finally(() => { if (inflight.get(assetId) === promise) inflight.delete(assetId); });
    inflight.set(assetId, promise); return promise;
  }
  function unload(assetId: string) { tickets.set(assetId, (tickets.get(assetId) ?? 0) + 1); inflight.delete(assetId); const asset = assets.get(assetId); if (!asset) return; dropMorphs(assetId); assets.delete(assetId); releaseLoaded(asset); }
  function style(asset: Loaded, element: Model3dElement, manifest?: Scene3dManifest, states?: Record<string, number>) {
    const index = semanticIndex(manifest);
    for (const part of asset.parts) { stylePart(part, element, manifest, index); setStates(part, modelStates(element, states)); }
  }
  function getMorph(spec: RenderSpec, a: Loaded, b: Loaded): Morph {
    const destination = spec.morph!.toElement ?? spec.element;
    const appearance = (el: Model3dElement) => [el.fill, el.modelColors, el.modelLighting, el.overrides, el.fields, el.modelStates];
    const cacheKey = JSON.stringify([spec.assetId, spec.morph!.to, spec.morph!.pairs, appearance(spec.element), appearance(destination), spec.states, spec.manifest, spec.morph!.toManifest]);
    const old = morphs.get(cacheKey); if (old) return old;
    const indices = new Map<Scene3dManifest | undefined, SemanticIndex>();
    const endpoint = (part: Part, el: Model3dElement, manifest?: Scene3dManifest, states?: Record<string, number>) => {
      if (!indices.has(manifest)) indices.set(manifest, semanticIndex(manifest));
      stylePart(part, el, manifest, indices.get(manifest)!); setStates(part, modelStates(el, states));
      return { position: effectiveAttribute(part, 'position'), normal: effectiveAttribute(part, 'normal'), colors: effectiveColors(part), vertexColors: part.mesh.material.vertexColors, color: `#${part.mesh.material.color.getHexString()}`, opacity: part.mesh.material.opacity, hidden: !part.mesh.visible };
    };
    const pair: Morph = { group: new Group(), parts: [], ids: [spec.assetId, spec.morph!.to] };
    const pairedA = new Set<Part>(), pairedB = new Set<Part>();
    try {
    for (const names of spec.morph!.pairs) {
      const from = names.primitiveA !== undefined ? [a.parts[names.primitiveA]].filter(Boolean) : a.parts.filter((p) => p.node === names.nodeA);
      const to = names.primitiveB !== undefined ? [b.parts[names.primitiveB]].filter(Boolean) : b.parts.filter((p) => p.node === names.nodeB);
      if (!from.length || from.length !== to.length) throw new Error(`Missing or ambiguous morph part ${names.nodeA}`);
      for (let i = 0; i < from.length; i++) {
        const pa = from[i], pb = to[i];
        if (pairedA.has(pa) || pairedB.has(pb)) throw new Error('Morph primitive is paired more than once');
        pairedA.add(pa); pairedB.add(pb); if (!compatible(pa, pb)) throw new Error(`Incompatible morph topology ${names.nodeA}`);
        const ea = endpoint(pa, spec.element, spec.manifest, spec.states), eb = endpoint(pb, destination, spec.morph!.toManifest ?? spec.manifest);
        const geometry = new BufferGeometry(); geometry.setIndex(pa.mesh.geometry.index?.clone() ?? null);
        geometry.setAttribute('position', ea.position); geometry.setAttribute('normal', ea.normal);
        geometry.morphAttributes.position = [eb.position]; geometry.morphAttributes.normal = [eb.normal];
        geometry.morphTargetsRelative = false;
        const vertexColors = ea.vertexColors && eb.vertexColors;
        if (vertexColors) { geometry.setAttribute('color', ea.colors); geometry.morphAttributes.color = [eb.colors]; }
        const material = makeMaterial(spec.element.modelLighting ?? 'studio'); material.vertexColors = vertexColors;
        const mesh = new Mesh(geometry, material); mesh.frustumCulled = false; pair.group.add(mesh);
        pair.parts.push({ mesh, a: pa, b: pb, colorA: ea.color, colorB: eb.color, opacityA: ea.opacity, opacityB: eb.opacity, hiddenA: ea.hidden, hiddenB: eb.hidden, vertexColors });
      }
    }
    if (pair.parts.length !== a.parts.length || pair.parts.length !== b.parts.length) throw new Error('Morph must pair every mesh primitive exactly once');
    } catch (error) { disposeGroup(pair.group); throw error; }
    // Bound transient flight caches; the active pair is inserted most recently.
    if (morphs.size >= 8) { const [key, oldPair] = morphs.entries().next().value!; disposeGroup(oldPair.group); morphs.delete(key); }
    morphs.set(cacheKey, pair); return pair;
  }
  function cameraFor(pose: OrbitPose, w: number, h: number) {
    const camera = pose.projection === 'perspective' ? perspective : ortho;
    if (camera instanceof OrthographicCamera) { camera.left = -pose.halfWidth; camera.right = pose.halfWidth; camera.top = pose.halfHeight; camera.bottom = -pose.halfHeight; }
    else { camera.fov = pose.fovY; camera.aspect = w / h; }
    camera.near = pose.near; camera.far = pose.far; camera.position.fromArray(pose.position);
    matrix.makeBasis(new Vector3(...pose.right), new Vector3(...pose.up), new Vector3(...pose.direction)); camera.quaternion.setFromRotationMatrix(matrix);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true); return camera;
  }
  function render(spec: RenderSpec) {
    guard();
    const w = Math.round(spec.w), h = Math.round(spec.h);
    if (!Number.isFinite(w + h) || w < 1 || h < 1 || w > 16384 || h > 16384) throw new Error('Invalid 3D render dimensions');
    const source = assets.get(spec.assetId); if (!source) throw new Error(`3D asset not loaded: ${spec.assetId}`);
    let group: Group, bounds = source.stats.bounds, element = spec.element;
    const t = clamp01(spec.morph?.t ?? 0);
    if (spec.morph && t > 0) {
      const target = assets.get(spec.morph.to); if (!target) throw new Error(`3D morph destination not loaded: ${spec.morph.to}`);
      if (t === 1) { element = spec.morph.toElement ?? element; style(target, element, spec.morph.toManifest ?? spec.manifest); group = target.group; bounds = target.stats.bounds; }
      else {
        const pair = getMorph(spec, source, target); group = pair.group; bounds = sphereLerpBounds(bounds, target.stats.bounds, t);
        for (const part of pair.parts) {
          part.mesh.morphTargetInfluences![0] = t;
          const material = part.mesh.material;
          material.color.set(part.vertexColors ? '#ffffff' : lerpColor(part.colorA, part.colorB, t));
          material.opacity = part.opacityA * (1 - t) + part.opacityB * t;
          material.transparent = material.opacity < 1 || part.a.vertexAlpha || part.b.vertexAlpha; material.depthWrite = !material.transparent;
          part.mesh.visible = !(t < 0.5 ? part.hiddenA : part.hiddenB);
          part.mesh.renderOrder = material.transparent ? 1_000_000 : 0;
        }
      }
    } else { style(source, element, spec.manifest, spec.states); group = source.group; }
    const pose = orbitPose(element, bounds, { width: w, height: h }), camera = cameraFor(pose, w, h);
    key.position.copy(camera.position).addScaledVector(new Vector3(...pose.right), -2 * pose.radius).addScaledVector(new Vector3(...pose.up), 2 * pose.radius);
    fill.position.copy(camera.position).addScaledVector(new Vector3(...pose.right), 2 * pose.radius).addScaledVector(new Vector3(...pose.up), -pose.radius);
    key.target.position.fromArray(pose.target); fill.target.position.fromArray(pose.target); ambient.position.fromArray(pose.up);
    if (lastWidth !== w || lastHeight !== h) { renderer.setSize(w, h, false); lastWidth = w; lastHeight = h; }
    scene.add(group); try { renderer.render(scene, camera); renders++; } finally { scene.remove(group); }
    return { pose, renderer: context!.getParameter(context!.RENDERER) as string };
  }
  const onLost = (event: Event) => { event.preventDefault(); lost = true; options.onContextState?.(true); };
  const onRestored = () => {
    if (disposed) return;
    const retained = [...assets].map(([id, a]) => [id, a.bytes, tickets.get(id), a.storedBounds] as const); const restoredGeneration = ++generation; inflight.clear(); dropMorphs();
    for (const asset of assets.values()) releaseLoaded(asset); assets.clear(); lastWidth = 0; lastHeight = 0;
    restores = Promise.all(retained.map(async ([id, bytes, ticket, storedBounds]) => { const loaded = await parse(id, bytes, storedBounds); if (disposed || restoredGeneration !== generation || tickets.get(id) !== ticket) releaseLoaded(loaded); else assets.set(id, loaded); })).then(() => { if (!disposed && restoredGeneration === generation) { lost = false; options.onContextState?.(false); } });
    restores.catch(() => { lost = true; });
  };
  canvas.addEventListener('webglcontextlost', onLost); canvas.addEventListener('webglcontextrestored', onRestored);
  function dispose() {
    if (disposed) return; disposed = true; generation++; dropMorphs();
    for (const asset of assets.values()) releaseLoaded(asset); assets.clear();
    canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
    renderer.dispose(); renderer.forceContextLoss(); canvas.width = 1; canvas.height = 1;
  }
  return { load, unload, render, snapshot: async (spec: RenderSpec) => { render(spec); return createImageBitmap(canvas); }, ready: () => restores, stats, dispose, canvas };
}
export type RenderCore = ReturnType<typeof createRenderCore>;
