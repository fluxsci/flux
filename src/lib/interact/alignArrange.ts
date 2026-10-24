/** Transient layout owner. The model contains only settled positions; canvas
 * scrubs share Canvas's transform drive and never publish pointermove edits. */
import { derived, get, writable } from 'svelte/store';
import { project, selection, editorSelectionExclusions, partSelection, partSelections, activeFigureId, enteredGroupId, activeTool, projectDir, embeddedProjectRoot, arrange, lastArrangeRows, commit, mutateFigure, undo, redo, isEditorTargetExcluded } from '../store';
import {pushToast} from '../toast';
import { storeTenantState } from '../tenancy';
import { editSession } from './editSession';
import { unitOf } from '../groups';
import { balancedRows, validRowCounts, type AlignKind, type Rect } from '../geometry';
import { createArrangementSnapshot, planArrangement, snapshotAfterArrangement, resolveLayoutUnits, type LayoutSnapshot, type ArrangementPlan } from '../layout/arrangement';
import { applyArrangementPlan, applyLayoutTranslations, alignPanels, distributePanels } from '../ops';
import { plotDom, plotManifests, plotGen, requestPlotDom } from '../plot/store';
import { resolveUnitSpine, planPlotSpineAlignment, type SpineChoice } from '../plot/landmarks';
import type { Element, Figure } from '../types';
import type { FluxPlotManifest } from '../plot/types';

type Axis = 'x' | 'y';
export type ArrangementAnchor = { x: 0 | .5 | 1; y: 0 | .5 | 1 };
type Anchor = ArrangementAnchor;
type Mode = 'align' | 'arrange';
export interface AlignArrangeState {
  id: number; mode: Mode; figureId: string; count: number; excludedCount: number; blockedReason?: string;
  alignTarget: 'selection' | 'reference' | 'figure'; referenceId: string;
  units: { id: string; label: string }[];
  topology: 'row' | 'column' | 'grid'; rows: number; cols: number; status: string;
  gapX: number; gapY: number; anchor: Anchor; linkedGaps: boolean; dragging: boolean;
  bounds: Rect | null; hover: AlignKind | 'plot-x' | 'plot-y' | 'gap-x' | 'gap-y' | null;
  referenceBounds?: Rect;
  panelVisible?: boolean;
  plot?: { loading: boolean; reasonX?: string; reasonY?: string; referenceId: string;
    units: { id: string; label: string; choiceX: string; choiceY: string; explicitChoice: boolean; optionsX: {value:string;label:string}[]; optionsY: {value:string;label:string}[] }[] };
}
// Session preference, independent of document/history and tool ownership.
// All writes go through setArrangementAnchor so an active preview is rebased.
const savedArrangementAnchor = writable<Anchor>({x:.5,y:.5});
export const arrangementAnchor = {subscribe:savedArrangementAnchor.subscribe};
export const alignArrange = writable<AlignArrangeState | null>(null);
export const arrangementPreview = writable<{figureId:string; plan:ArrangementPlan; transforms:Map<string,string>} | null>(null);
export const arrangementLayout = writable<ArrangementPlan | null>(null);
export const alignmentGuides = writable<{x1:number;y1:number;x2:number;y2:number}[]>([]);
/** Recognition is read-only and independent of the panel. Never tidy an
 * irregular selection merely because it was selected. */
export const passiveArrangement = derived(
  [project, selection, activeFigureId, enteredGroupId, editorSelectionExclusions, partSelection, partSelections, activeTool, alignArrange],
  ([$project,$selection,$figureId,$scope,$excluded,$part,$parts,$tool,$owner]): ArrangementPlan|null => {
    if($owner || $selection.size<2 || $part || $parts.length || ($tool!=='select'&&$tool!=='scale'))return null;
    const figures=$project.figures.filter(f=>f.elements.some(e=>$selection.has(e.id)));
    if(figures.length!==1 || figures[0].id!==$figureId)return null;
    try {
      const base=createArrangementSnapshot(figures[0],[...$selection],{scope:$scope,excluded:$excluded});
      if(base.units.length<2 || base.suggested || !base.regularX || !base.regularY)return null;
      const plan=planArrangement(base,{mode:'tidy'});
      return plan.identity?plan:null;
    } catch {return null;}
  });
let serial = 0;
let captured: {figureId:string; ids:string[]; scope:string|null; excluded:ReadonlySet<string>} | null = null;
let snapshot: LayoutSnapshot | null = null;
let pin = {x:0,y:0};
let ownWrite = false;
let disposing = false;
let changed = false;
let fieldValid = true;
type FieldInteraction = 'typing'|'wheel'|'scrub';
let inner: {snapshot:LayoutSnapshot; state:AlignArrangeState; axis:Axis; plan:ArrangementPlan|null; kind:'field'|'drag'; interaction:FieldInteraction|null; rebased:boolean} | null = null;
let choices: Record<Axis, Record<string, SpineChoice>> = {x:{},y:{}};
let unsubscribers: (() => void)[] = [];
const acceptedPlotSources = new Map<string,{root:SVGSVGElement|undefined;manifest:FluxPlotManifest|undefined}>();
const visit = editSession({handoff:'finish', terminalOnConflict:true, onSettle:() => { if (!disposing) clearOwner(); }});

function figure(): Figure | undefined { return captured ? get(project).figures.find(f=>f.id===captured!.figureId) : undefined; }
function write(fn:()=>void) { ownWrite=true; try { fn(); } finally { ownWrite=false; } }
function publish(state: AlignArrangeState) {
  const scientific=state.hover==='plot-x'||state.hover==='plot-y';
  const referenceId=scientific?state.plot?.referenceId:state.alignTarget==='reference'?state.referenceId:undefined;
  state={...state,referenceBounds:state.mode==='align'&&referenceId?snapshot?.units.find(u=>u.key===referenceId)?.bounds:undefined};
  alignArrange.set(state);
  arrange.set(state.mode==='arrange' && !state.blockedReason && state.count>=2 ? {active:true,n:state.count,rows:state.rows,cols:state.cols}:null);
}
function clearOwner() {
  arrangementPreview.set(null); arrangementLayout.set(null); alignmentGuides.set([]); inner=null; snapshot=null; captured=null; changed=false;
  for (const unsub of unsubscribers.splice(0)) unsub();
  alignArrange.set(null); arrange.set(null); acceptedPlotSources.clear();
}
/** A foreign publication must never accept an uncommitted numeric draft over
 * the new model. Drop only transient UI, then settle the already-owned edit. */
function closeForOwnerChange() {
  if(inner)cancelArrangementField();
  closeAlignArrange();
}
function selectedPlotAssets() {
  return new Set(spineUnits().flatMap(u=>u.members.filter(e=>e.type==='plot').map(e=>(e as Extract<Element,{type:'plot'}>).assetId)));
}
function capturePlotSources() {
  const manifests=get(plotManifests);
  for(const id of selectedPlotAssets())acceptedPlotSources.set(id,{root:plotDom.get(id),manifest:manifests[id]});
}
function plotSourcesChanged():boolean {
  const manifests=get(plotManifests);
  for(const [id,previous] of acceptedPlotSources) {
    const root=plotDom.get(id),manifest=manifests[id];
    // The initial lazy parse may normalize a primed manifest together with
    // installing its first root. This is hydration, not a changed source.
    if(!previous.root&&root){acceptedPlotSources.set(id,{root,manifest});continue;}
    if((previous.root&&previous.root!==root)||(previous.manifest&&previous.manifest!==manifest))return true;
    if(previous.manifest!==manifest)acceptedPlotSources.set(id,{root,manifest});
  }
  return false;
}
function watchOwner() {
  let starting=true;
  capturePlotSources();
  const close=()=>{if(!starting&&!ownWrite&&!disposing) closeForOwnerChange();};
  for(const source of [selection,activeFigureId,enteredGroupId,storeTenantState,projectDir,embeddedProjectRoot,editorSelectionExclusions,partSelection,partSelections]) unsubscribers.push(source.subscribe(close));
  unsubscribers.push(project.subscribe(close));
  const sourceChange=()=>{
    if(starting||ownWrite||disposing)return;
    if(plotSourcesChanged()){closeForOwnerChange();return;}
    refreshPlotChoices();
  };
  unsubscribers.push(plotManifests.subscribe(sourceChange),plotGen.subscribe(sourceChange));
  starting=false;
}
function makeSnapshot() {
  const f=figure();
  return f && captured ? createArrangementSnapshot(f,captured.ids,{scope:captured.scope,excluded:captured.excluded}):null;
}
function label(f:Figure, ids:string[], key:string, elements?:Map<string,Element>) {
  const first=elements ? elements.get(ids[0]) : f.elements.find(e=>ids.includes(e.id));
  const group=first && unitOf(f,first,captured?.scope).groupId;
  return (group ? f.groups?.[group]?.name : undefined) || (first && ('name' in first ? String(first.name || '') : '')) || `${first?.type ?? 'Object'} ${key.replace(/^[eg]:/,'').slice(0,8)}`;
}
export function openAlignArrange(mode:Mode='align', panelVisible=true) {
  closeAlignArrange();
  const p=get(project), sel=get(selection), f=p.figures.find(f=>f.id===get(activeFigureId));
  const across=p.figures.filter(f=>f.elements.some(e=>sel.has(e.id))).length>1;
  const drilled=!!get(partSelection)||get(partSelections).length>0;
  captured={figureId:f?.id ?? '',ids:[...sel],scope:get(enteredGroupId),excluded:new Set(get(editorSelectionExclusions))};
  snapshot=makeSnapshot();
  const units=snapshot?.units ?? [];
  const ordered=snapshot?.orderedKeys ?? units.map(u=>u.key);
  const count=units.length;
  const unitMap=new Map(units.map(u=>[u.key,u]));
  const elements=new Map(f?.elements.map(e=>[e.id,e])??[]);
  const editable=new Set(units.flatMap(u=>u.memberIds));
  const blockedReason=across?'Select objects within one figure':drilled?'Select whole objects to align':!count?'Select objects to align':undefined;
  const state:AlignArrangeState={id:++serial,panelVisible,mode:'align',figureId:f?.id ?? '',count,excludedCount:[...sel].filter(id=>!editable.has(id)).length,blockedReason,
    alignTarget:count===1?'figure':'selection',referenceId:ordered[0]??'',units:ordered.map(key=>{const u=unitMap.get(key)!;return {id:key,label:label(f!,u.memberIds,key,elements)};}),
    topology:snapshot?.topology??'row',rows:snapshot?.rowCount??0,cols:snapshot?.cols??0,status:'',gapX:snapshot?.gapX??0,gapY:snapshot?.gapY??0,anchor:{...get(arrangementAnchor)},linkedGaps:false,dragging:false,bounds:snapshot?.bounds??null,hover:null};
  choices={x:{},y:{}}; changed=false; activeTool.set('select'); publish(state); watchOwner(); refreshPlotChoices();
  if(mode==='arrange') switchAlignArrange('arrange');
}
export function closeAlignArrange(cancel=false) {
  if(!get(alignArrange))return;
  disposing=true;
  try {
    if(inner) { if(cancel||!fieldValid||inner.kind==='drag') cancelArrangementField(); else acceptArrangementField(); }
    write(()=>cancel?visit.cancel():visit.finish());
    clearOwner();
  } finally {disposing=false;}
}
export function switchAlignArrange(mode:Mode) {
  let s=get(alignArrange); if(!s||s.mode===mode)return;
  if(inner) {if(fieldValid)acceptArrangementField();else cancelArrangementField();}
  s=get(alignArrange);if(!s)return;
  if(mode==='align') {
    disposing=true; try{write(()=>visit.finish());}finally{disposing=false;}
    changed=false; arrangementLayout.set(null); snapshot=makeSnapshot(); publish({...s,mode,dragging:false,bounds:snapshot?.bounds??s.bounds}); refreshPlotChoices(); return;
  }
  if(s.blockedReason||s.count<2)return;
  // Open, settled Align actions and mode exit already refresh this baseline;
  // foreign model changes close the owner. Re-capturing it here duplicates the
  // entire selection walk on the direct Alt+T path.
  if(!snapshot)return;
  s={...s,mode,anchor:{...get(arrangementAnchor)},linkedGaps:false};
  pin={x:snapshot.bounds.x+s.anchor.x*snapshot.bounds.w,y:snapshot.bounds.y+s.anchor.y*snapshot.bounds.h};
  publish(s); const plan=planArrangement(snapshot,{mode:'tidy',anchor:s.anchor,pin}); applyPlan(plan); showPlan(plan);
}
function showPlan(plan:ArrangementPlan) {
  arrangementLayout.set(plan);
  const s=get(alignArrange);if(!s)return;
  publish({...s,bounds:plan.bounds,topology:plan.topology,rows:plan.rowCount,cols:plan.cols,gapX:plan.gapX,gapY:plan.gapY,
    status:plan.suggested?'Suggested grid':plan.mode==='reflow'?`Reflowed ${plan.topology}`:`Existing ${plan.topology}${changed?' · spacing tidied':''}`});
  lastArrangeRows.set(plan.rowCount);
}
function applyPlan(plan:ArrangementPlan) {
  const f=figure();if(!f||!snapshot||!captured)return;
  // The planner's shared identity result is this exact owned baseline. There
  // is nothing to commit or clone; preserve alternate-axis defaults/mode by
  // using the ordinary path whenever those metadata values actually change.
  if(plan.identity&&plan.units===snapshot.units&&plan.positions===snapshot.memberPositions&&
    plan.gapX===snapshot.gapX&&plan.gapY===snapshot.gapY&&plan.mode===snapshot.mode)return;
  const byId=new Map(f.elements.map(e=>[e.id,e]));
  const differs=plan.positions.some(pos=>{const e=byId.get(pos.id);return !e||e.x!==pos.x||e.y!==pos.y;});
  if(differs) {write(()=>visit.run(()=>mutateFigure(f.id,p=>applyArrangementPlan(p,f.id,plan))));changed=true;}
  if(!get(alignArrange))return;
  snapshot=snapshotAfterArrangement(snapshot,plan);
}
export function reflowArrangement(mode:'row'|'column'|'grid') {
  const s=get(alignArrange); if(!s||!snapshot||s.mode!=='arrange'||s.blockedReason)return;
  if(inner)acceptArrangementField();
  const rows=mode==='row'?1:mode==='column'?s.count:balancedRows(s.count);
  reflowRows(rows);
}
function reflowRows(rows:number) {
  if(inner)acceptArrangementField();
  const s=get(alignArrange);if(!s||!snapshot)return;
  const plan=planArrangement(snapshot,{mode:'reflow',rows,gapX:s.gapX,gapY:s.gapY,anchor:s.anchor,pin});applyPlan(plan);showPlan(plan);
}
export function stepArrangementRows(dir:1|-1) {
  const s=get(alignArrange);if(!s)return;
  const rows=validRowCounts(s.count), i=Math.max(0,rows.indexOf(s.rows));reflowRows(rows[Math.max(0,Math.min(rows.length-1,i+dir))]);
}
/** Changing the session pin is UI state only. During an inner edit, pin the
 * current preview bounds so the next gap sample starts without a jump. */
export function setArrangementAnchor(x:Anchor['x'],y:Anchor['y']) {
  if(![0,.5,1].includes(x)||![0,.5,1].includes(y))return;
  const anchor={x,y},saved=get(arrangementAnchor);
  if(saved.x!==x||saved.y!==y)savedArrangementAnchor.set(anchor);
  const s=get(alignArrange);if(!s || (s.anchor.x===x&&s.anchor.y===y))return;
  if(s.bounds)pin={x:s.bounds.x+x*s.bounds.w,y:s.bounds.y+y*s.bounds.h};
  if(inner)inner.rebased=true;
  publish({...s,anchor});
}
export function setArrangementLinked(linkedGaps:boolean) {if(inner)acceptArrangementField();const s=get(alignArrange);if(s)publish({...s,linkedGaps});}
export function beginArrangementField(axis:Axis, interaction:FieldInteraction='typing') {
  if(inner)acceptArrangementField();
  const s=get(alignArrange);if(!s||!snapshot||s.mode!=='arrange')return;
  fieldValid=true;inner={snapshot,state:s,axis,plan:null,kind:'field',interaction,rebased:false};
}
export function setArrangementFieldInteraction(axis:Axis, interaction:FieldInteraction|null) {
  if(inner?.kind!=='field'||inner.axis!==axis)return;
  inner.interaction=interaction;
}
export function ownsArrangementField(axis:Axis):boolean {return inner?.kind==='field' && inner.axis===axis;}
export function setArrangementFieldValidity(valid:boolean){fieldValid=valid;}
export function setArrangementGap(axis:Axis,value:number|undefined) {
  const s=get(alignArrange);if(!s||!snapshot||s.mode!=='arrange')return;
  if(value===undefined||!Number.isFinite(value)){fieldValid=false;return;}
  fieldValid=true;
  // A focused, unchanged field preserves exact regular-within-epsilon
  // coordinates. Once an anchor change rebases the pin, that same numeric gap
  // can legitimately describe a translated arrangement and must be planned.
  if(inner && !inner.rebased && value===(axis==='x'?inner.state.gapX:inner.state.gapY) && !s.linkedGaps) {
    inner.plan=null;arrangementPreview.set(null);publish({...inner.state,dragging:s.dragging});
    arrangementLayout.set(planArrangement(inner.snapshot,{mode:'tidy',anchor:s.anchor,pin}));return;
  }
  const base=inner?.snapshot??snapshot;
  const plan=planArrangement(base,{mode:'tidy',...(axis==='x'||s.linkedGaps?{gapX:value}:{}),...(axis==='y'||s.linkedGaps?{gapY:value}:{}),anchor:s.anchor,pin});
  if(inner) {
    inner.plan=plan;
    const transforms=new Map(plan.translations.filter(t=>t.dx||t.dy).map(t=>[t.id,`translate3d(${t.dx}px, ${t.dy}px, 0)`]));
    arrangementPreview.set({figureId:s.figureId,plan,transforms}); showPlan(plan);
  } else {applyPlan(plan);showPlan(plan);}
}
export function acceptArrangementField() {
  if(!inner)return;
  if(!fieldValid){cancelArrangementField();return;}
  const plan=inner.plan;inner=null;arrangementPreview.set(null);
  if(plan){applyPlan(plan);showPlan(plan);}
  const s=get(alignArrange);if(s?.dragging)publish({...s,dragging:false});
}
export function cancelArrangementField() {
  if(!inner)return;
  const old=inner,anchor={...get(arrangementAnchor)};inner=null;fieldValid=true;
  pin={x:old.snapshot.bounds.x+anchor.x*old.snapshot.bounds.w,y:old.snapshot.bounds.y+anchor.y*old.snapshot.bounds.h};
  arrangementPreview.set(null);snapshot=old.snapshot;publish({...old.state,anchor,dragging:false});
  arrangementLayout.set(planArrangement(snapshot,{mode:'tidy',anchor,pin}));
}
export function beginArrangementDrag(axis:Axis) {
  if(!get(alignArrange)) {if(!get(passiveArrangement))return;openAlignArrange('arrange',false);}
  beginArrangementField(axis);if(inner)inner.kind='drag';const s=get(alignArrange);if(s)publish({...s,dragging:true});}
/** Optional axis shortcut while editing a gap or hovering its passive guide.
 * Native text entry always wins; the choice survives release and tool close. */
export function handleArrangementAnchorKey(e:KeyboardEvent,axis?:Axis):boolean {
  if(e.type!=='keydown'||!['1','2','3'].includes(e.key)||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return false;
  const target=e.target instanceof HTMLElement?e.target:null;
  if(target?.matches('input,textarea,select')||target?.isContentEditable)return false;
  const editedAxis=inner?.axis??axis;
  if(!editedAxis || (!inner&&!get(passiveArrangement)&&get(alignArrange)?.mode!=='arrange'))return false;
  e.preventDefault();e.stopPropagation();
  const anchor=get(arrangementAnchor),value=([0,.5,1] as const)[Number(e.key)-1];
  setArrangementAnchor(editedAxis==='x'?value:anchor.x,editedAxis==='y'?value:anchor.y);
  return true;
}
export function endArrangementDrag(accept:boolean) {
  const hidden=get(alignArrange)?.panelVisible===false;
  if(accept)acceptArrangementField();else cancelArrangementField();
  if(hidden)closeAlignArrange(!accept);
}
export function setAlignTarget(alignTarget:AlignArrangeState['alignTarget']){const s=get(alignArrange);if(s)publish({...s,alignTarget});}
export function setAlignReference(referenceId:string){const s=get(alignArrange);if(s?.units.some(u=>u.id===referenceId))publish({...s,referenceId});}
export function setAlignArrangeHover(hover:AlignArrangeState['hover']) {
  const s=get(alignArrange), f=figure();if(!s)return;publish({...s,hover});alignmentGuides.set([]);
  if(!hover||!f||!snapshot)return;
  if(hover==='plot-x'||hover==='plot-y') {
    if(!s.plot)return;
    const axis=hover==='plot-x'?'x':'y';
    const context=plotContext();
    alignmentGuides.set(spineUnits().filter(u=>u.members.some(e=>e.type==='plot')).flatMap(u=>{const l=resolveUnitSpine(u,axis,context,choices[axis][u.key]).landmark;return l?[{x1:l.start.x,y1:l.start.y,x2:l.end.x,y2:l.end.y}]:[]}));return;
  }
  const b=s.alignTarget==='figure'?{x:0,y:0,w:f.width,h:f.height}:s.alignTarget==='reference'?snapshot.units.find(u=>u.key===s.referenceId)?.bounds:s.bounds;
  if(!b)return;
  if(hover==='left'||hover==='right'||hover==='centerH') {const x=b.x+(hover==='left'?0:hover==='right'?b.w:b.w/2);alignmentGuides.set([{x1:x,y1:b.y-12,x2:x,y2:b.y+b.h+12}]);}
  if(hover==='top'||hover==='bottom'||hover==='centerV') {const y=b.y+(hover==='top'?0:hover==='bottom'?b.h:b.h/2);alignmentGuides.set([{x1:b.x-12,y1:y,x2:b.x+b.w+12,y2:y}]);}
}
function afterAlign(){snapshot=makeSnapshot();const s=get(alignArrange);if(s&&snapshot)publish({...s,bounds:snapshot.bounds,topology:snapshot.topology,rows:snapshot.rowCount,cols:snapshot.cols,gapX:snapshot.gapX,gapY:snapshot.gapY,status:snapshot.suggested?'Suggested grid':`Existing ${snapshot.topology}`});refreshPlotChoices();}
export function alignSelection(kind:AlignKind) {
  const s=get(alignArrange), c=captured; if(!s||!c||s.blockedReason)return;
  write(()=>commit(p=>alignPanels(p,c.figureId,kind,c.ids,{scope:c.scope,excluded:c.excluded,target:s.alignTarget==='reference'?{unitKey:s.referenceId}:s.alignTarget})));afterAlign();
}
export function distributeSelection(axis:'h'|'v') {
  const s=get(alignArrange),f=figure();if(!s||!f||!captured||s.blockedReason||s.count<3)return;
  const c=captured;
  write(()=>commit(p=>distributePanels(p,c.figureId,axis,c.ids,undefined,{scope:c.scope,excluded:c.excluded})));afterAlign();
}
const plotContext=()=>({manifest:(id:string)=>get(plotManifests)[id],plotRoot:(id:string)=>plotDom.get(id)??null,figure:figure(),scope:captured?.scope,excluded:captured?.excluded,partExcluded:isEditorTargetExcluded});
function spineUnits() {
  const f=figure();if(!f||!captured||!f.elements.some(e=>e.type==='plot'))return [];
  // Include hidden/locked/excluded descendants (including dangling groups): the
  // scientific resolver refuses an incomplete rigid move rather than tearing
  // annotations off their plot. Ordinary layout still uses editable units.
  return resolveLayoutUnits(f,captured.ids,{scope:captured.scope,editable:false});
}
function refreshPlotChoices() {
  const s=get(alignArrange);if(!s)return;
  const allUnits=spineUnits();
  const units=allUnits.filter(u=>u.members.some(e=>e.type==='plot'));
  // A 5k-shape selection must not run per-plot membership checks 10k times or
  // build 5k scientific dropdown rows. Nonplot units still block a mixed set.
  if(!units.length){publish({...s,plot:undefined});return;}
  const nonplots=allUnits.length-units.length;
  const reason=nonplots?`${nonplots} selected ${nonplots===1?'unit contains':'units contain'} no semantic plot`:undefined;
  let loading=false;
  for(const u of units)for(const e of u.members)if(e.type==='plot'&&!plotDom.has(e.assetId)){requestPlotDom(e.assetId);loading=true;}
  const referenceId=s.plot?.referenceId&&units.some(u=>u.key===s.plot!.referenceId)?s.plot.referenceId:units.some(u=>u.key===s.referenceId)?s.referenceId:units[0].key;
  const reasons:{x?:string;y?:string}={x:reason,y:reason};
  const names=new Map(s.units.map(u=>[u.id,u.label]));
  const ctx=plotContext();
  const items=units.map(u=>{
    const resolutions={x:resolveUnitSpine(u,'x',ctx,choices.x[u.key]),y:resolveUnitSpine(u,'y',ctx,choices.y[u.key])};
    for(const axis of ['x','y'] as const)if(resolutions[axis].reason)reasons[axis]??=`${names.get(u.key)??u.key}: ${resolutions[axis].reason}`;
    const plots=u.members.filter(e=>e.type==='plot'), assets=get(project).assets;
    const plotNames=new Map(plots.map((e,i)=>{
      const name=('name' in e&&e.name?String(e.name):assets.find(a=>a.id===e.assetId)?.name)||'Plot';
      return [e.id,plots.length>1?`Plot ${i+1} · ${name}`:name];
    }));
    const options=(axis:Axis)=>resolutions[axis].candidates.filter(c=>c.eligible).map(c=>({value:JSON.stringify({plotId:c.plotId,panelId:c.panelId,spineId:c.spineId}),label:`${plotNames.get(c.plotId)??'Plot'} · ${c.label}`}));
    const choice=(axis:Axis)=>{const l=resolutions[axis].landmark;return choices[axis][u.key]?JSON.stringify(choices[axis][u.key]):l?JSON.stringify({plotId:l.plotId,panelId:l.panelId,spineId:l.spineId}):'';};
    return {id:u.key,label:names.get(u.key)??u.key,choiceX:choice('x'),choiceY:choice('y'),explicitChoice:!!choices.x[u.key]||!!choices.y[u.key],optionsX:options('x'),optionsY:options('y')};
  });
  publish({...s,plot:{loading,referenceId,reasonX:s.blockedReason??reasons.x??(units.length<2?'Select two or more plot units':undefined),reasonY:s.blockedReason??reasons.y??(units.length<2?'Select two or more plot units':undefined),units:items}});
}
export function setPlotAlignReference(referenceId:string){const s=get(alignArrange);if(s?.plot&&s.units.some(u=>u.id===referenceId))publish({...s,plot:{...s.plot,referenceId}});}
export function setPlotAlignChoice(unitId:string,axis:Axis,value:string){
  if(!value){delete choices[axis][unitId];refreshPlotChoices();return;}
  try{choices[axis][unitId]=JSON.parse(value);refreshPlotChoices();}catch{/* invalid selection is never applied */}
}
export function alignPlotSpines(axis:Axis) {
  refreshPlotChoices();const s=get(alignArrange),f=figure();if(!s?.plot||!f||s.blockedReason||(axis==='x'?s.plot.reasonX:s.plot.reasonY))return;
  const plan=planPlotSpineAlignment(spineUnits(),axis,s.plot.referenceId,plotContext(),choices[axis]);
  if(plan.issues.length||!plan.translations.some(t=>t.dx||t.dy))return;
  write(()=>commit(p=>applyLayoutTranslations(p,f.id,plan.translations)));afterAlign();
}
export function canMatchPlotAreas():boolean {
  const s=get(alignArrange),units=spineUnits();
  if(!s||s.blockedReason||units.length<2)return false;
  const manifests=get(plotManifests);
  return units.every(u=>u.members.length===1&&u.members[0].type==='plot'&&u.members[0].layoutMode!=='stretch'&&manifests[u.members[0].assetId]?.layout?.supported);
}
export async function matchSelectedPlotAreas(dimension:'height'|'width'|'both') {
  if(!canMatchPlotAreas())return;
  const s=get(alignArrange)!,f=figure()!,units=spineUnits(),ids=units.map(u=>u.members[0].id);
  const reference=units.find(u=>u.key===(s.plot?.referenceId??s.referenceId))?.members[0].id??ids[0];
  const owner=s.id;const {matchPlotAreas}=await import('../plot/relayout/ops');
  if(get(alignArrange)?.id!==owner||get(activeFigureId)!==f.id)return;
  let result:ReturnType<typeof matchPlotAreas>=[];write(()=>commit(p=>{result=matchPlotAreas(p,ids,{dimension,reference},get(plotManifests));}));afterAlign();
  const reasons=result.flatMap(r=>r.report.warnings.filter(w=>w.code.startsWith('match:')||w.code.startsWith('aspect-locked:')).map(w=>w.code.replaceAll(':',' ')));if(reasons.length)pushToast('info',[...new Set(reasons)].join('; '));
}
/** Called after shell, typing, node-edit, rail and modal ownership checks. */
export function handleAlignArrangeKey(e:KeyboardEvent):boolean {
  const s=get(alignArrange);if(!s)return false;
  if(handleArrangementAnchorKey(e))return true;
  const target=e.target instanceof HTMLElement?e.target:null;
  if(e.isComposing||target?.matches('input,textarea,select')||target?.isContentEditable)return false;
  // These keys belong to the focused native control. Claim editor routing
  // without preventing its default activation/scroll behavior.
  if(target?.closest('button,[role="radio"]')&&(e.key===' '||e.key==='Enter'||e.key.startsWith('Arrow')))return true;
  const mod=e.metaKey||e.ctrlKey;
  if(mod&&(e.code==='KeyZ'||e.code==='KeyY')) {
    e.preventDefault();const pending=changed||!!inner?.plan;const redoKey=e.code==='KeyY'||e.shiftKey;
    closeAlignArrange(true);if(redoKey)redo();else if(!pending)undo();return true;
  }
  if(e.key==='Escape') {e.preventDefault();if(inner)cancelArrangementField();else closeAlignArrange(true);return true;}
  if(s.dragging){e.preventDefault();return true;}
  if(e.code==='Space'&&!mod&&!e.altKey){e.preventDefault();if(!e.repeat)switchAlignArrange(s.mode==='align'?'arrange':'align');return true;}
  if(e.key==='Enter'){e.preventDefault();closeAlignArrange();return true;}
  if(!mod&&!e.altKey&&!e.shiftKey&&!e.repeat){
    if(s.mode==='align'){
      const kinds:Record<string,AlignKind>={KeyW:'top',KeyA:'left',KeyS:'bottom',KeyD:'right',KeyH:'centerH',KeyV:'centerV'};
      if(kinds[e.code])alignSelection(kinds[e.code]);else if(e.code==='KeyX'||e.code==='KeyY')alignPlotSpines(e.code==='KeyX'?'x':'y');
    }else if(e.code==='KeyA')reflowArrangement(s.rows===1?'column':'row');else if(e.code==='KeyG')reflowArrangement('grid');else if(e.code==='KeyD'||e.code==='KeyF')stepArrangementRows(e.code==='KeyD'?1:-1);
  }
  // Native focus navigation remains available; canvas tool commands do not.
  if(e.key!=='Tab')e.preventDefault();return true;
}
