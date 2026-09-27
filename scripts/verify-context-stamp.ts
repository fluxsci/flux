// Headless renderer stores: the stamp and live bridge must agree on every surface.
import { get } from 'svelte/store';
import { buildContextStamp, readerContext, libraryContext, slideContext, presentContext, paperHeading } from '../src/lib/bridge/contextStamp';
import { registerTargetResolver, prepareTargetResolvers, currentTargets, resolveAt, targetViewIdentity } from '../src/lib/bridge/targetResolvers';
import { getAppContext } from '../src/lib/bridge/appContext';
import * as fig from '../src/lib/store';
import { currentProject, view, type ModeId } from '../src/shell/shellStore';
import { panes, focusedPaneId } from '../src/shell/paneStore';
import { setStoreTenant } from '../src/lib/tenancy';
import { registerFlushable } from '../src/shell/lifecycle';
import { paperSelection } from '../src/lib/project/paperSelectionStore';
import { createMemBridge } from '../src/lib/project/memBridge';
import { makeClaim, makeResolve, makeReply, parseLedger, serializeEvent } from '../src/lib/project/annotations';
import { addAnnotation, initAnnotationStore, annotationInbox, refreshAnnotations, withdrawAnnotation, rememberRoute, annotationRoute } from '../src/shell/agent/annotationStore';
import { toasts } from '../src/lib/toast';
import { annotationOpen, installAnnotateChord, bufferAnnotationInput, focusAnnotationInput, closeAnnotation } from '../src/shell/agent/annotateChord';

let checks = 0;
function assert(value: unknown, message: string) { checks++; if (!value) throw Error(message); console.log('ok:', message); }
const mode = (mode: ModeId) => { panes.set([{ id: 'stamp-pane', mode }]); focusedPaneId.set('stamp-pane'); };
const root = '/annotation-test';
const fb = createMemBridge();
Object.assign(globalThis, { window: { fig: fb }, localStorage: (() => { const m = new Map<string,string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string,v: string) => m.set(k,v) }; })() });
view.set('home');
assert(buildContextStamp().surface === 'home' && !buildContextStamp().reader, 'Home has no stale mode context');
currentProject.set({ path: root, name: 'Stamp test' }); view.set('workspace');
fig.loadProject({ version: 2, name: 'stamp', canvases: [{ id: 'c', name: 'Canvas' }], figures: [{ id: 'f', name: 'Figure', nickname: 'Density', canvasId: 'c', x: 0, y: 0, width: 600, height: 400, background: '#fff', elements: Array.from({length: 25}, (_, i) => ({ id: `e${i}`, type: 'rect' as const, name: `Box ${i}`, x: 0, y: 0, width: 30, height: 20, rotation: 0, fill: '#aaa', stroke: '#222', strokeWidth: 1, cornerRadius: 0 })) }], assets: [], palette: [] }, null);
fig.embeddedProjectRoot.set(root); fig.activeCanvasId.set('c'); fig.activeFigureId.set('f'); fig.selectedFrameId.set('f'); fig.selection.set(new Set(Array.from({length:25},(_,i)=>`e${i}`)));
fig.viewport.set({panX: 12, panY: 13, zoom: 2});
const releaseFigure = registerFlushable({ id: 'figure', isDirty: () => false, flush: async () => {} });
mode('figure'); setStoreTenant('figure');
let s = buildContextStamp({ targets: [{ kind: 'element', figureId: 'f', elementId: 'e0', type: 'rect' }] });
assert(s.activeFigureName === 'Density' && s.activeCanvasId === 'c' && s.selectedFrameId === 'f' && s.selection?.length === 25 && s.selectionSummary?.length === 20 && s.viewport?.zoom === 2, 'Figure stamp names canvas/frame/figure and caps its selection digest at 20');
assert(s.targets?.[0].kind === 'element' && getAppContext().activeFigure?.elements.length === 25, 'Target refs survive alongside the unabridged bridge figure digest');
fig.partSelection.set({elementId: 'e0', partId: 'control'});
assert(buildContextStamp().partSelection?.partId === 'control', 'Semantic selection is included');
releaseFigure();
assert(!buildContextStamp().activeFigureId && getAppContext().figures.length === 0, 'Unmounted Figure never leaks its cached model into the live stamp');
const releaseSlide = registerFlushable({id: 'slide', isDirty: () => false, flush: async () => {}});
setStoreTenant('slide'); mode('slide'); slideContext.set({deckId:'d', slideIndex:2, beat:1, slideId:'f'});
assert(buildContextStamp().slide?.slideIndex === 2 && getAppContext().slide?.deckId === 'd', 'Slide carries deck/index/beat in both callers');
mode('paper'); paperSelection.set({doc:'manuscript/main.qmd',from:100,to:115,quote:'selected words'}); paperHeading.set('Results');
s = buildContextStamp();
assert(s.doc?.heading === 'Results' && s.targets?.[0].kind === 'doc' && getAppContext().doc?.quote === 'selected words' && !getAppContext().activeFigure, 'Paper includes heading and exact range without another mode’s figure digest');
mode('reader'); readerContext.set({citekey:'smith2020', title:'Paper title', page:4, selection:'A passage', highlightId:'h1', source:{supplement:'methods.pdf'}});
s = buildContextStamp();
assert(s.reader?.page === 4 && s.reader.highlightId === 'h1' && s.targets?.[0].kind === 'passage' && getAppContext().reader?.selection === 'A passage', 'Reader includes title/page/passage/highlight/source and target');
mode('library'); libraryContext.set({query:'tag:sleep',selectedKeys:['smith2020','lee2021'],collection:'Sleep'});
s = buildContextStamp();
assert(s.library?.collection === 'Sleep' && s.targets?.length === 2 && getAppContext().library?.query === 'tag:sleep', 'Library includes query/collection/all selected items');
presentContext.set({deckId:'d',slideIndex:2,beat:3,slideId:'s3'});
s = buildContextStamp();
assert(s.surface === 'present' && s.present?.beat === 3 && s.targets?.[0].kind === 'beat', 'Present carries deck/slide/beat and a target');
presentContext.set(null); mode('figure');
s = buildContextStamp({window:{kind:'utility',name:'gallery'},targets:[{kind:'region',surface:'figure',rect:{x:0,y:0,w:10,h:10}}]});
assert(s.window?.kind === 'utility' && s.window.name === 'gallery' && s.targets?.length === 1, 'Utility capture is identified explicitly');
releaseSlide();

// Registry precedence and cleanup with headless DOM-shaped roots. No renderer
// component imports: current selection and point lookup use the same registry.
{
  const doc: any = { activeElement: null, elementsFromPoint: () => [overlay, inner] };
  function node(parent: any = null): any { return { parentElement: parent, ownerDocument: doc, isConnected: true, closest: () => null,
    getClientRects: () => [{}], getBoundingClientRect: () => ({x:0,y:0,width:100,height:100,left:0,top:0,right:100,bottom:100}),
    contains(other: any) { for (let n=other;n;n=n.parentElement) if(n===this)return true; return false; } }; }
  const outer=node(), inner=node(outer), overlay=node(); doc.activeElement=inner;
  const slide = {kind:'slide' as const,deckId:'d',slideId:'s'}, track={kind:'track' as const,deckId:'d',slideId:'s',trackId:'t',beat:1};
  let prepared=0, model={};
  const offOuter=registerTargetResolver({surface:'slide',root:()=>outer,current:()=>[slide],prepare:()=>prepared++,at:()=>[{ref:slide,bounds:{x:0,y:0,w:100,h:100},label:'slide'}]});
  const offInner=registerTargetResolver({surface:'slide',root:()=>inner,current:()=>[track],prepare:()=>prepared++,revision:()=>[model],at:()=>[{ref:track,bounds:{x:10,y:10,w:10,h:10},label:'track'}]});
  prepareTargetResolvers();
  assert(prepared===2&&resolveAt(12,12,{document:doc,ignore:overlay})[0]?.ref.kind==='track','Innermost timeline wins the hit test while the overlay is ignored');
  assert(currentTargets('slide',doc)[0]?.kind==='track','Focused nested surface owns the selected target');
  const identity=targetViewIdentity(doc);model={};inner.scrollTop=10;
  assert(targetViewIdentity(doc).some((v,i)=>v!==identity[i]),'Retained view identity detects model and scroll changes without a hover scan');
  offInner();assert(resolveAt(12,12,{document:doc,ignore:overlay})[0]?.ref.kind==='slide','Unmount unregisters its resolver');offOuter();
}

// Bootstrap typing, including cold initialization during a pending capture.
const inputDoc: any = {activeElement: null};
const input: any = {ownerDocument:inputDoc,isConnected:true,focus(){inputDoc.activeElement=this;}};
const keyWindow=Object.assign(new EventTarget(),{fig:fb,document:inputDoc,innerWidth:1200,innerHeight:800,devicePixelRatio:1,focus(){}});
Object.assign(globalThis,{window:keyWindow,document:inputDoc});
fb.captureWindow=async()=>({png:new Uint8Array([1]),width:1200,height:800});
const removeKeys=installAnnotateChord();
const key=(key: string,code: string,extra={})=>keyWindow.dispatchEvent(Object.assign(new Event('keydown',{cancelable:true}),{key,code,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,...extra}));
key('M','KeyM',{ctrlKey:true,shiftKey:true});key('a','KeyA');key('b','KeyB');key('c','KeyC');
initAnnotationStore();
assert(get(annotationOpen)&&focusAnnotationInput(input).text==='abc','Cold store initialization preserves the active capture and its buffered abc');
bufferAnnotationInput();key('r','KeyR');key('Enter','Enter');
const refreshed=focusAnnotationInput(input);
assert(refreshed.text==='r'&&refreshed.submit,'Refreshing a retained picture buffers typing and Enter until focus returns');
closeAnnotation();key('M','KeyM',{ctrlKey:true,shiftKey:true});key('x','KeyX');key('y','KeyY');key('Backspace','Backspace');key('Escape','Escape');
assert(!get(annotationOpen),'Escape cancels even before lazy textarea focus');
key('M','KeyM',{metaKey:true,shiftKey:true});
assert(focusAnnotationInput(input).text==='x','Early Escape retains buffered typing, including Backspace, on Cmd-chord reopen');closeAnnotation();
const retired=key('S','KeyS',{ctrlKey:true,shiftKey:true});
assert(!retired&&!get(annotationOpen),'Retired shifted save chord is absorbed, never opens Annotate');
removeKeys();

// Real renderer IO + shared fold: publication order, one append, named routing,
// concurrent status writers, edit/withdraw, and failed image writes.
initAnnotationStore(); await refreshAnnotations();
const order: string[] = [];
const writeFile = fb.writeFile.bind(fb), append = fb.feedbackAppend!.bind(fb);
fb.writeFile = async (p,b) => { order.push('png'); await writeFile(p,b); };
fb.feedbackAppend = async (p,t) => { order.push('append'); return append(p,t); };
const ctx = {surface:'reader', targets:s.targets, snapshot:{image:null,rect:{x:0,y:0,w:10,h:10},window:{w:10,h:10,dpr:1},marks:[]}};
await addAnnotation('Point here #review',ctx,'none',{png:new Uint8Array([137,80,78,71])});
const ledgerPath = root+'/.meta/feedback.ndjson';
let events = parseLedger(await fb.readText(ledgerPath));
assert(order.join() === 'png,append' && events.length === 1 && events[0].kind === 'note' && !!events[0].context?.snapshot?.image, 'PNG is durable before exactly one note append');
assert(ctx.snapshot.image === null, 'Saving does not mutate the draft context');
const first = get(annotationInbox)[0];
const session = {id:'agent-1',name:'heron',client:'codex'};
order.length = 0;
await addAnnotation('Please adjust', {surface:'figure'}, {session});
events = parseLedger(await fb.readText(ledgerPath));
const named = get(annotationInbox).find(i=>i.text === 'Please adjust')!;
assert(order.join() === 'append' && events.at(-2)?.kind === 'note' && events.at(-1)?.kind === 'assign' && named.chip.includes('heron'), 'Named route and assign share ONE append and the queue names its recipient');
await append(ledgerPath,serializeEvent(makeClaim(named.id,session,'codex'))); await refreshAnnotations(true);
assert(get(annotationInbox).find(i=>i.id === named.id)?.chip === 'Claimed by heron' && get(toasts).some(t=>t.msg.includes('heron claimed')), 'Second writer claim updates the shared status and names the agent in a toast');
await append(ledgerPath,serializeEvent(makeReply(named.id,{kind:'agent',name:'heron'},'Which axis?','codex',{session,state:'needs-input'}))); await refreshAnnotations(true);
assert(get(annotationInbox).find(i=>i.id === named.id)?.status === 'needs-input' && get(toasts).some(t=>t.msg.includes('heron has a question') && !!t.action), 'Needs-input has a named toast with a working open action');
await append(ledgerPath,serializeEvent(makeResolve(named.id,'codex',{session,author:{kind:'agent',name:'heron'}}))); await refreshAnnotations(true);
assert(get(annotationInbox).find(i=>i.id === named.id)?.chip === 'Resolved by heron' && get(toasts).some(t=>t.msg.includes('heron resolved')), 'Resolution names the agent in chip and toast');
order.length = 0; await addAnnotation('Edited note',first.context!,'none',{replaces:first.id});
events = parseLedger(await fb.readText(ledgerPath));
assert(order.join() === 'append' && events.at(-2)?.kind === 'withdraw' && events.at(-1)?.kind === 'note', 'Edit withdraws and replaces in one append');
const edited = get(annotationInbox).find(i=>i.text === 'Edited note')!; await withdrawAnnotation(edited.id);
assert(get(annotationInbox).find(i=>i.id === edited.id)?.status === 'withdrawn', 'Withdraw retains ledger history');
const before = await fb.readText(ledgerPath); let refused = false;
fb.writeFile = async () => { throw Error('disk full'); };
try { await addAnnotation('unsaved',ctx,'none',{png:new Uint8Array([1])}); } catch { refused = true; }
assert(refused && await fb.readText(ledgerPath) === before, 'Image failure never publishes a dangling note');
rememberRoute({session}); currentProject.set({path:root+'-other',name:'Other'}); currentProject.set({path:root,name:'Stamp test'});
assert(typeof get(annotationRoute) === 'object' && JSON.stringify(get(annotationRoute)).includes('heron'), 'Recipient preference is remembered per project');
closeAnnotation();
console.log(`##VERIFY## ${JSON.stringify({script:'verify-context-stamp',ok:true,checks,failed:0})}`);
