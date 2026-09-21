import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { harness } from "./lib/harness.mjs";
const { runProcess } = createRequire(import.meta.url)("../electron/processRunner.cjs");
const h = harness("verify-process-runner");
const run = (script: string, options = {}) => runProcess({ executable: process.execPath, argv: ["-e", script], cwd: tmpdir() }, options);
let result = await run("process.stdin.on('end',()=>{console.log('EOF')});process.stdin.resume()");
h.ok(result.code === 0 && result.stdout.trim() === "EOF", "noninteractive children receive EOF on stdin");
result = await run("process.stdout.write('a'.repeat(100000));process.stderr.write('b'.repeat(100000))", { maxOutputBytes: 1024 });
h.eq([result.stdout.length, result.stderr.length, result.truncated.stdout, result.truncated.stderr], [1024,1024,98976,98976], "output flood retains bounded tails with exact truncation counters");
result = await run("process.kill(process.pid,'SIGTERM')");
h.ok(result.code !== 0 && result.status === "signal", "signal termination cannot become exit zero");
result = await run("setInterval(()=>{},1000)", { timeoutMs: 20, killGraceMs: 20 });
h.ok(result.code !== 0 && result.status === "timeout", "deadline terminates the job with truthful status");
const controller = new AbortController(); const promise = run("setInterval(()=>{},1000)", { signal: controller.signal }); controller.abort();
result = await promise; h.eq(result.status, "cancelled", "already-aborted request is cancelled");
result = await runProcess({ executable: "/missing/flux-process", cwd: tmpdir() });
h.ok(result.status === "spawn-error" && result.code !== 0, "spawn error is handled and cannot succeed");
await assert.rejects(() => runProcess({ executable: process.execPath, argv: [1], cwd: tmpdir() }), /Invalid/);
h.ok(true, "invalid argv is rejected before spawn");
result = await run("console.log('output');setInterval(()=>{},1000)",{onOutput(){throw new Error("injected log failure");},killGraceMs:20});
h.ok(result.code !== 0 && result.status === "output-error" && result.stderr.includes("injected log failure"),"output sink failure cancels owned process without an uncaught exception or false success");
if(process.platform !== "win32"){
  result = await run(`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});console.log(child.pid);setInterval(()=>{},1000);`,{timeoutMs:250,killGraceMs:30});
  const pid=Number(result.stdout.trim());assert(pid>0);
  let running=false;try{process.kill(pid,0);const stat=await import('node:fs/promises').then(fs=>fs.readFile('/proc/'+pid+'/stat','utf8')).catch(()=> '');running=!stat.includes(') Z ');}catch{}
  h.ok(!running && result.status === "timeout","timeout kills a SIGTERM-resistant descendant in the owned POSIX process group");
}
h.done();
