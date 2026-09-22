import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  // The group SIGKILL is issued as runProcess resolves, but the descendant's
  // teardown is the kernel's to schedule — sampling one instant made this read
  // "alive" on a loaded runner, and a /proc read losing the race to a complete
  // reap returned "" and also read as alive. Poll instead: still a real kill
  // assertion, just not a stopwatch on the scheduler. A zombie counts as dead
  // (its parent is gone, so init reaps it); without /proc only a full reap does.
  const fsp = await import('node:fs/promises');
  const hasProc = existsSync('/proc/self/stat');
  let running = true;
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    try { process.kill(pid, 0); } catch { running = false; break; }
    if (hasProc) {
      const stat = await fsp.readFile('/proc/' + pid + '/stat', 'utf8').catch(() => '');
      if (!stat || stat.includes(') Z ')) { running = false; break; }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  h.ok(!running && result.status === "timeout","timeout kills a SIGTERM-resistant descendant in the owned POSIX process group");
}
h.done();
