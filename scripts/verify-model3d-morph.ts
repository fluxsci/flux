import {readFile} from 'node:fs/promises';
import {harness} from './lib/harness.mjs';
import {inspectGlb,prepareGlb,writeGlb} from '../src/lib/model3d/glbCore.mjs';
import {morphCompatible,morphFixHint} from '../src/lib/model3d/morphPair';
const h=harness('verify-model3d-morph'),dir=new URL('./fixtures/model3d/fluxplot/',import.meta.url);
const A=inspectGlb(await readFile(new URL('morph-a.glb',dir))),B=inspectGlb(await readFile(new URL('morph-b.glb',dir))),C=inspectGlb(await readFile(new URL('morph-incompatible.glb',dir)));
h.ok(morphCompatible(A,B).ok,'shared two-part Python morph pair compatible');h.ok(!morphCompatible(A,C).ok,'incompatible Python partner refused');h.ok(!!morphCompatible(A,C).reason,'fallback gives first mismatch reason');
const swapped=structuredClone(B);swapped.topology.parts.reverse();h.ok(morphCompatible(A,swapped).ok,'named pairing independent of primitive order');
const plain={positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,2]},u16=inspectGlb(writeGlb({parts:[plain]})),u32=inspectGlb(writeGlb({parts:[{...plain,indexType:5125}]}));h.ok(morphCompatible(u16,u32).ok,'unnamed pairing by order and index width independent');
const mismatch=structuredClone(u16);mismatch.topology.parts[0].vertices++;h.ok(morphCompatible(u16,mismatch).reason?.includes('vertices (3 vs 4)'),'vertex mismatch names counts');
for(const name of ['morph-a.glb','morph-b.glb']){const bytes=await readFile(new URL(name,dir));h.eq(inspectGlb(prepareGlb(bytes).bytes).topology,inspectGlb(bytes).topology,`${name} fingerprint preserved by preparation`);}
h.ok(morphFixHint.includes('share_topology_with'),'fallback supplies actionable Python hint');const repeated=structuredClone(A);repeated.topology.parts[1].node=repeated.topology.parts[0].node;h.eq(morphCompatible(repeated,repeated).pairs.length,1,'multi-primitive node emits one renderer node pair');h.eq(morphCompatible(u16,u32).pairs[0].primitiveA,0,'unnamed node pair includes primitive-order index');await h.done();
