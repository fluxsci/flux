/** Self-contained notebook shell around the same render core used by Flux/export. */
import { createInlineHost, defaultRenderElement } from './inlineHost';
import { axisView, homeView, statesAtFrame, clamp, type AxisView } from './orbit';
import { furnitureLayout } from './furnitureLayout';
import { furnitureSvg } from './furniture';
import { WheelStepper } from '../interact/wheelLaw';
import { RENDERER_VERSION } from './renderCore';
import type { Model3dElement, Scene3dManifest } from './types';
export { RENDERER_VERSION };
export interface NotebookPayload { glb: string | ArrayBuffer; manifest?: Scene3dManifest; width?: number; height?: number; element?: Partial<Model3dElement>; fallback?: string }

export async function mount(host: HTMLElement, payload: NotebookPayload) {
  const doc = host.ownerDocument, id = `flux-model3d-viewer-${crypto.randomUUID()}`, assetId = `${id}.glb`;
  const authoredWidth = Math.max(160, Math.round(payload.width ?? (payload.manifest?.size?.width ?? 5) * 96));
  const authoredHeight = Math.max(120, Math.round(payload.height ?? (payload.manifest?.size?.height ?? 4) * 96));
  let width = authoredWidth, height = authoredHeight;
  const previous = [...host.childNodes];
  let available = false;
  let element = { ...defaultRenderElement(assetId, payload.manifest), ...payload.element, id, assetId, width, height } as Model3dElement;
  const container = doc.createElement('section'); container.className = 'flux-model3d-viewer'; container.setAttribute('aria-label', 'Interactive 3D model');
  container.style.cssText = `width:${width}px;max-width:100%;font:12px/1.5 system-ui,sans-serif;color:var(--vscode-editor-foreground,#29313a);background:var(--vscode-editor-background,#fff);box-sizing:border-box;border:1px solid var(--vscode-panel-border,#dce0e5);border-radius:8px;overflow:hidden;visibility:hidden`;
  const stage = doc.createElement('div'); stage.tabIndex = 0; stage.setAttribute('aria-label', '3D view. Drag to orbit; Shift drag to pan; Alt drag to roll.');
  stage.style.cssText = `position:relative;background:#fff;width:100%;height:${height}px;outline-offset:-2px;touch-action:none;overflow:hidden;`;
  const svg = () => { const node = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); node.setAttribute('viewBox', `0 0 ${width} ${height}`); node.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible'; return node; };
  const under = svg(), over = svg(), canvas = doc.createElement('canvas'); canvas.style.position = 'absolute';
  stage.append(under, canvas, over);
  const controls = doc.createElement('div'); controls.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--vscode-panel-border,#e5e7eb)';
  const controlStyle = 'font:inherit;color:inherit;background:var(--vscode-button-secondaryBackground,#f2f4f7);border:1px solid var(--vscode-button-border,#cbd2dc);border-radius:5px;padding:5px 9px';
  const button = (label: string, action: () => void) => { const node = doc.createElement('button'); node.type = 'button'; node.style.cssText = controlStyle; node.textContent = label; node.addEventListener('click', action); controls.append(node); return node; };
  const viewSelect = doc.createElement('select'); viewSelect.setAttribute('aria-label', 'Axis view'); viewSelect.style.cssText = controlStyle;
  for (const view of ['View', 'Front', 'Back', 'Right', 'Left', 'Top', 'Bottom']) { const option = doc.createElement('option'); option.value = view.toLowerCase(); option.textContent = view; viewSelect.append(option); }
  controls.append(viewSelect);
  const readout = doc.createElement('textarea'); readout.rows = 2; readout.readOnly = true; readout.setAttribute('aria-label', 'Copy view Python code'); readout.style.cssText = 'box-sizing:border-box;width:100%;resize:vertical;min-height:48px;font:11px/1.5 ui-monospace,monospace;color:inherit;background:transparent;border:1px solid var(--vscode-panel-border,#dce0e5);border-radius:5px;padding:6px 8px';
  const status = doc.createElement('div'); status.style.cssText = 'padding:8px 12px 10px;font-size:11px;opacity:.75'; status.setAttribute('role', 'status'); status.textContent = 'Preparing 3D view…';
  container.append(stage, controls, status); host.append(container);
  let disposed = false;
  const cleanup = new AbortController(), wheel = new WheelStepper();
  let inline: ReturnType<typeof createInlineHost> | undefined, view: ReturnType<ReturnType<typeof createInlineHost>['view']> | undefined;
  const getView = () => ({ azimuth: element.orbitAzimuth, elevation: element.orbitElevation, roll: element.orbitRoll ?? 0, zoom: element.orbitZoom, panX: element.orbitPanX ?? 0, panY: element.orbitPanY ?? 0, projection: element.orbitProjection, fov: element.orbitFov, ...(element.modelStates ? { states: { ...element.modelStates } } : {}) });
  const number = (n: number) => Number(n.toFixed(3));
  /** A complete call that pastes straight back into Python: `sc.view(...)`
   *  (fluxplot's Scene3D.view accepts these keywords; sequences use frame=N). */
  const frameOf = () => {
    if (!payload.manifest?.sequence || !names.length) return null;
    const states = element.modelStates ?? {}, frame = names.reduce((sum, name, i) => sum + (states[name] ?? 0) * (i + 1), 0), expected = statesAtFrame(names, frame);
    return names.every(name => Math.abs((states[name] ?? 0) - (expected[name] ?? 0)) < 1e-6) ? number(frame) : null;
  };
  const code = () => {
    const args = [`azimuth=${number(element.orbitAzimuth)}`, `elevation=${number(element.orbitElevation)}`, `zoom=${number(element.orbitZoom)}`];
    if (element.orbitRoll) args.push(`roll=${number(element.orbitRoll)}`);
    if (element.orbitPanX) args.push(`panX=${number(element.orbitPanX)}`);
    if (element.orbitPanY) args.push(`panY=${number(element.orbitPanY)}`);
    if (element.orbitProjection === 'perspective') args.push(`projection="perspective"`, `fov=${number(element.orbitFov)}`);
    const frame = frameOf(), weights = Object.entries(element.modelStates ?? {}).filter(([, v]) => v !== 0);
    if (frame !== null && frame > 0) args.push(`frame=${frame}`);
    else if (frame === null && weights.length) args.push(`states={${weights.map(([k, v]) => `${JSON.stringify(k)}: ${number(v)}`).join(', ')}}`);
    return `sc.view(${args.join(', ')})`;
  };
  function paint() {
    if (disposed || !view) return;
    width = Math.max(1, Math.round(stage.clientWidth || authoredWidth)); height = Math.max(1, Math.round(width * authoredHeight / authoredWidth));
    stage.style.height = `${height}px`; under.setAttribute('viewBox', `0 0 ${width} ${height}`); over.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const layout = furnitureLayout(payload.manifest, { width, height }, element.overrides), rect = layout.viewport;
    const dpr = Math.min(2, doc.defaultView?.devicePixelRatio ?? 1);
    const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.left = `${rect.x}px`; canvas.style.top = `${rect.y}px`; canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
    const { pose } = view.render(element, w, h);
    const furniture = furnitureSvg(payload.manifest, element, pose, layout); under.innerHTML = furniture.under; over.innerHTML = furniture.over;
    readout.value = code();
  }
  const stateInputs = new Map<string, { input: HTMLInputElement; value: HTMLOutputElement }>();
  let sequenceControl: { input: HTMLInputElement; value: HTMLOutputElement } | undefined;
  function syncSequenceControl() {
    if (!sequenceControl) return;
    const states = element.modelStates ?? {}, frame = names.reduce((sum, name, i) => sum + (states[name] ?? 0) * (i + 1), 0);
    const expected = statesAtFrame(names, frame);
    const exact = frame >= 0 && frame <= names.length && names.every((name) => Math.abs((states[name] ?? 0) - (expected[name] ?? 0)) < 1e-6);
    sequenceControl.input.value = String(exact ? frame : 0);
    sequenceControl.value.textContent = exact ? String(number(frame)) : 'Custom';
    sequenceControl.input.setAttribute('aria-valuetext', exact ? String(number(frame)) : 'Custom state weights');
    sequenceControl.input.title = exact ? '' : 'Current weights do not describe one frame. Move the slider to choose a frame.';
  }
  function setView(patch: Partial<ReturnType<typeof getView>>) {
    const fields = { azimuth: 'orbitAzimuth', elevation: 'orbitElevation', roll: 'orbitRoll', zoom: 'orbitZoom', panX: 'orbitPanX', panY: 'orbitPanY', projection: 'orbitProjection', fov: 'orbitFov', states: 'modelStates' } as const;
    for (const [key, value] of Object.entries(patch)) if (key in fields) (element as unknown as Record<string, unknown>)[fields[key as keyof typeof fields]] = value;
    element.orbitElevation = clamp(element.orbitElevation, -90, 90); element.orbitZoom = clamp(element.orbitZoom, 0.02, 50);
    for (const [name, control] of stateInputs) { control.input.value = String(element.modelStates?.[name] ?? 0); control.value.textContent = String(number(element.modelStates?.[name] ?? 0)); }
    syncSequenceControl(); paint();
  }
  button('Home', () => { element = { ...element, ...homeView(undefined, payload.manifest), modelStates: payload.manifest?.view?.states ?? {} }; setView({}); });
  button('Copy view', () => { readout.value = code(); readout.focus(); readout.select(); void doc.defaultView?.navigator.clipboard?.writeText(readout.value).then(() => { status.textContent = 'Copied. Paste into your notebook (rename sc to your scene variable).'; }, () => { status.textContent = 'Select and copy the view code.'; }); });
  controls.append(readout);
  viewSelect.addEventListener('change', () => { if (viewSelect.value === 'view') return; element = { ...element, ...axisView(viewSelect.value as AxisView, element.orbitAzimuth) }; paint(); viewSelect.value = 'view'; });
  const names = payload.manifest?.states?.map((s) => s.name) ?? [];
  function slider(label: string, max: number, initial: number, change: (value: number) => void) {
    const row = doc.createElement('label'); row.style.cssText = 'display:grid;grid-template-columns:minmax(75px,1fr) minmax(100px,3fr) 32px;align-items:center;gap:10px;padding:3px 12px';
    const name = doc.createElement('span'); name.textContent = label; const input = doc.createElement('input'); input.type = 'range'; input.min = '0'; input.max = String(max); input.step = '0.01'; input.value = String(initial); input.setAttribute('aria-label', label);
    input.style.cssText = 'width:100%;accent-color:var(--vscode-focusBorder,#4385be)'; const value = doc.createElement('output'); value.style.cssText = 'font-variant-numeric:tabular-nums;text-align:right'; value.textContent = String(number(initial));
    input.addEventListener('input', () => { value.textContent = String(number(input.valueAsNumber)); change(input.valueAsNumber); }); row.append(name, input, value); container.insertBefore(row, status); return { input, value };
  }
  if (payload.manifest?.sequence && names.length) sequenceControl = slider('Frame', names.length, 0, (frame) => setView({ states: statesAtFrame(names, frame) }));
  else for (const state of payload.manifest?.states ?? []) stateInputs.set(state.name, slider(state.label ?? state.name, 1, element.modelStates?.[state.name] ?? 0, (weight) => setView({ states: { ...element.modelStates, [state.name]: weight } })));
  syncSequenceControl();
  let drag: { x: number; y: number; mode: 'orbit' | 'pan' | 'roll'; pointer: number } | undefined;
  stage.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; stage.focus(); stage.setPointerCapture(event.pointerId); drag = { x: event.clientX, y: event.clientY, mode: event.shiftKey ? 'pan' : event.altKey ? 'roll' : 'orbit', pointer: event.pointerId }; event.preventDefault(); }, { signal: cleanup.signal });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y; drag.x = event.clientX; drag.y = event.clientY;
    if (drag.mode === 'orbit') setView({ azimuth: element.orbitAzimuth - dx * 0.4, elevation: element.orbitElevation + dy * 0.4 });
    else if (drag.mode === 'roll') setView({ roll: (element.orbitRoll ?? 0) + dx * 0.4 });
    else { const rect = furnitureLayout(payload.manifest, { width, height }, element.overrides).viewport, scale = 2 / (element.orbitZoom * Math.min(rect.width, rect.height)); setView({ panX: (element.orbitPanX ?? 0) - dx * scale, panY: (element.orbitPanY ?? 0) + dy * scale }); }
  }, { signal: cleanup.signal });
  const stop = () => { drag = undefined; };
  stage.addEventListener('pointerup', stop, { signal: cleanup.signal }); stage.addEventListener('pointercancel', stop, { signal: cleanup.signal });
  // Scrolling a notebook past a model must scroll the page. The wheel zooms
  // only once the view is active (clicked/focused) or with Ctrl/⌘ held.
  stage.addEventListener('wheel', (event) => {
    if (!(event.ctrlKey || event.metaKey || doc.activeElement === stage)) return;
    event.preventDefault(); const steps = wheel.steps({ deltaY: event.deltaY, deltaMode: event.deltaMode, time: performance.now() }); if (steps) setView({ zoom: element.orbitZoom * 1.1 ** steps });
  }, { passive: false, signal: cleanup.signal });
  stage.addEventListener('keydown', (event) => {
    const views: Record<string, AxisView> = { '1': 'front', '2': 'back', '3': 'right', '4': 'left', '5': 'top', '6': 'bottom' };
    if (views[event.key]) { event.preventDefault(); element = { ...element, ...axisView(views[event.key], element.orbitAzimuth) }; paint(); }
    else if (event.key === 'Home') { event.preventDefault(); element = { ...element, ...homeView(undefined, payload.manifest), modelStates: payload.manifest?.view?.states ?? {} }; setView({}); }
  }, { signal: cleanup.signal });
  const resize = new ResizeObserver(() => paint()); resize.observe(stage);
  const observer = new MutationObserver(() => { if (!host.isConnected) dispose(); });
  function dispose() { if (disposed) return; disposed = true; cleanup.abort(); observer.disconnect(); resize.disconnect(); view?.dispose(); inline?.dispose(); container.remove(); }
  doc.defaultView?.addEventListener('pagehide', dispose, { once: true, signal: cleanup.signal });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  const outputRoot = host.getRootNode(); if (outputRoot !== doc) observer.observe(outputRoot, { childList: true, subtree: true });
  try {
    const bytes = typeof payload.glb === 'string' ? Uint8Array.from(atob(payload.glb.replace(/^data:.*?;base64,/, '')), (c) => c.charCodeAt(0)).buffer : payload.glb;
    inline = createInlineHost({ document: doc, sourceKey: id, modelBytes: () => bytes, manifest: () => payload.manifest });
    await inline.ready([assetId], [{ assetId, w: width, h: height, element, manifest: payload.manifest }]);
    if (!disposed) { view = inline.view(canvas); paint(); available = true; previous.forEach((node) => node.parentNode === host && node.remove()); container.style.visibility = 'visible'; status.textContent = 'Drag to orbit · Shift drag to pan · Alt drag to roll · click then scroll (or Ctrl/⌘+scroll) to zoom · 1–6: axis views · Home: reset'; }
  } catch (error) {
    inline?.dispose(); inline = undefined; cleanup.abort(); observer.disconnect(); resize.disconnect();
    if (!disposed) { container.style.visibility = 'visible'; if (previous.length) { container.remove(); host.title = `Interactive 3D unavailable: ${error instanceof Error ? error.message : String(error)}`; } stage.replaceChildren(); if (payload.fallback) { const image = doc.createElement('img'); image.src = payload.fallback; image.alt = 'Static 3D preview'; image.style.maxWidth = '100%'; stage.append(image); } status.textContent = `Interactive 3D unavailable: ${error instanceof Error ? error.message : String(error)}. Use show(static=True) for a still image.`; }
  }
  return { available, dispose, getView, setView, stats: () => inline?.stats() };
}
