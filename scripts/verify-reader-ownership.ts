import assert from "node:assert/strict";
import { annotationDraft } from "../src/shell/modes/reader/annotationDrafts";
import { flushAll, anyDirty } from "../src/shell/lifecycle";
import { createFindMatchCollector } from "../src/lib/pdf/findMatches";
import { foldForMatch, originalOffset } from "../src/lib/references/textFold";
import { harness } from "./lib/harness.mjs";
const h = harness("verify-reader-ownership");
let reject = true, saved = "", calls = 0;
const draft = annotationDraft("fixture:paper:annotation","pane-test","old", async text => { calls++; if(reject) throw new Error("EACCES"); saved=text; });
draft.text="scientific note";
let result=await flushAll();
h.ok(!result.ok && draft.text === "scientific note" && draft.saved === "old", "failed note save retains draft and blocks app-wide flush");
draft.dispose(); h.ok(anyDirty(),"view teardown cannot remove an unsaved note owner");
reject=false; result=await flushAll();
h.ok(result.ok && saved === "scientific note" && calls === 2,"retry commits the original draft exactly once");
draft.dispose(); h.ok(!anyDirty(),"committed disposed draft releases its save owner");
for (const text of ["각 target", "A\u0301-\f\u00a0 target", "\u0130\u0130 target", "Cafe\u0301 target", "Café target", "İ target", "😀 target", "alpha - \n target"]) {
 const f=foldForMatch(text); h.eq(originalOffset(f,f.text.indexOf("target")),text.indexOf("target"),`Unicode/separator map recovers exact original offset: ${JSON.stringify(text)}`);
}
const mapped = foldForMatch("각A\u0301 -\f  😀 target");
h.eq(mapped.text,"각a\f😀 target","Unicode decomposition expansion and form-feed separation retain exact matching semantics");
h.eq([0,1,2,3,4,5,6].map(i=>originalOffset(mapped,i)),[0,0,0,1,3,8,9],"expanded Hangul, removed mark and non-BMP mapping address exact UTF-16 source offsets");
const collect=createFindMatchCollector(); const snapshot={pageMatches:[] as number[][],pageMatchesLength:[] as number[][],_pageContents:[] as string[]};
let first: any;
const start=performance.now();
for(let p=0;p<300;p++) {
 snapshot.pageMatches[p]=Array.from({length:305},(_,i)=>i*2);
 snapshot.pageMatchesLength[p]=Array(305).fill(1);
 snapshot._pageContents[p]="a ".repeat(305);
 const rows=collect(snapshot,"a");
 if(p===0) first=rows[0]; else assert.equal(rows[0],first);
}
const rows=collect(snapshot,"a");
h.eq(rows.length,91500,"incremental 300-page search retains every result and exact total");
h.ok(rows[91499].index===91499 && rows[91499].page===300 && rows[91499].hit==="a","last result retains correct navigation and snippet");
const rebuildMs=performance.now()-start;
h.ok(rebuildMs<2000,`300-page progress rebuilds stay below2s component budget (${rebuildMs.toFixed(0)}ms; baseline15.7s)`);
h.eq(collect(snapshot,"a"),rows,"unchanged match notifications return the existing result list");
h.done();
