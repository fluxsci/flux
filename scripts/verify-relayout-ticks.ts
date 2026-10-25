import fs from "node:fs";
import { ticksAt } from "../src/lib/plot/relayout/ticking";
import { harness } from "./lib/harness.mjs";
const h=harness("verify-relayout-ticks"),table=JSON.parse(fs.readFileSync("scripts/fixtures/relayout/ticks.json","utf8"));
const failures:unknown[]=[],categories=new Map<string,{total:number;values:number;labels:number;offset:number;minor:number}>();
for(const [index,row]of table.rows.entries()){
 const actual=ticksAt(row.axis,row.length,row.fontPt,row.vertical),kind=`${row.axis.major.kind}/${row.axis.formatter.kind}`;
 let c=categories.get(kind);if(!c)categories.set(kind,c={total:0,values:0,labels:0,offset:0,minor:0});c.total++;
 const values=actual.values.length===row.values.length&&actual.values.every((v,i)=>Math.abs(v-row.values[i])<=1e-10*Math.max(1e-300,Math.abs(v),Math.abs(row.values[i])));
 const labels=JSON.stringify(actual.labels)===JSON.stringify(row.labels),offset=actual.offset===row.offset;
 const minor=!row.minor||actual.minor.length===row.minor.length&&actual.minor.every((v,i)=>Math.abs(v-row.minor[i])<=1e-9*Math.max(1e-300,Math.abs(v),Math.abs(row.minor[i])));if(!minor)c.minor++;
 if(!values)c.values++;if(!labels)c.labels++;if(!offset)c.offset++;
 if(!values||!labels||!offset||!minor)failures.push({index,row,actual,values,labels,offset,minor});
}
for(const [kind,c]of categories)h.ok(!c.values&&!c.labels&&!c.offset&&!c.minor,`${kind}: ${c.total} rows; value failures ${c.values}, labels ${c.labels}, offsets ${c.offset}, minor ${c.minor}`);
fs.mkdirSync("test-results/relayout",{recursive:true});fs.writeFileSync("test-results/relayout/ticks-failures.json",JSON.stringify(failures,null,2)+"\n");
await h.done();
