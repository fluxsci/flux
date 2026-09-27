const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { slideAudioGraph } = require('../electron/slideAudioGraph.cjs');
(async () => {
  const { harness } = await import('./lib/harness.mjs');
  const h = harness('verify-v020-audio-graph');
  const encoder = path.resolve('build/video-encoder', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-audio-graph-'));
  const run = args => { const r = spawnSync(encoder, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }); assert.equal(r.status, 0, r.stderr?.toString() || String(r.error)); return r.stdout; };
  try {
    const video = path.join(scratch, 'video.mp4'), tone = path.join(scratch, 'tone.wav');
    run(['-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=30:d=2.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.2', tone]);
    const segments = [{ assetId:'tone', startMs:500,endMs:800,offsetMs:0 },{ assetId:'tone',startMs:1000,endMs:2200,offsetMs:0 }];
    const graph = slideAudioGraph(segments, { tone }, 2400);
    for (let i=0; i<20; i++) {
      const output = path.join(scratch, `mux-${i}.mp4`);
      run(['-i', video, ...graph.inputs, '-filter_complex', graph.filter, '-map','0:v:0','-map','[audio]','-c:v','copy','-c:a','aac','-b:a','192k','-t','2.4',output]);
      const pcm=run(['-i', output, '-vn', '-ac','1','-ar','48000','-f','f32le','pipe:1']);
      assert.ok(pcm.length / 4 >= 115200 && pcm.length / 4 < 116224, `run ${i} has full 2.4s clock plus less than one 1024-sample AAC padding packet, actual ${pcm.length / 4}`);
      for(let sample=0; sample<pcm.length/4; sample++) assert.ok(Number.isFinite(pcm.readFloatLE(sample*4)), `run ${i} finite sample ${sample}`);
      function rms(from,to) { let energy=0, n=0; for(let j=from*48000; j<to*48000; j++) { const v=pcm.readFloatLE(Math.floor(j)*4); energy+=v*v; n++; } assert.ok(n>0); const value=Math.sqrt(energy/n); assert.ok(Number.isFinite(value)); return value; }
      assert.ok(rms(2.25,2.35)<.001, `run ${i} final hold is decoded silence`);
      assert.ok(rms(.55,.65)>.04, `run ${i} source tone remains audible`);
    }
    h.ok(true, '20 real AAC mux jobs retain full decoded audio coverage, audible windows and trailing silence');
    const highTone = path.join(scratch, 'high.wav');
    run(['-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1.2',highTone]);
    const mix=slideAudioGraph([{assetId:'tone',startMs:100,endMs:1300,offsetMs:0,loop:false},{assetId:'high',startMs:100,endMs:2200,offsetMs:0,loop:true}],{tone,high:highTone},2400);
    const mixed=path.join(scratch,'concurrent-loop.mp4');
    run(['-i',video,...mix.inputs,'-filter_complex',mix.filter,'-map','0:v:0','-map','[audio]','-c:v','copy','-c:a','aac','-b:a','192k','-t','2.4',mixed]);
    const signal=run(['-i',mixed,'-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']);
    assert.ok(signal.length/4>=115200 && signal.length/4<116224);
    for(let i=0;i<signal.length/4;i++) assert.ok(Number.isFinite(signal.readFloatLE(i*4)));
    const amplitude=(frequency,from,to)=>{let re=0,im=0;const first=Math.round(from*48000),last=Math.round(to*48000);for(let sample=first;sample<last;sample++){const v=signal.readFloatLE(sample*4),phase=2*Math.PI*frequency*sample/48000;re+=v*Math.cos(phase);im+=v*Math.sin(phase);}return 2*Math.hypot(re,im)/(last-first);};
    assert.ok(amplitude(440,.4,.5)>.04 && amplitude(880,.4,.5)>.04,'two independent tones survive concurrent mixing');
    assert.ok(amplitude(440,1.6,1.7)<.002 && amplitude(880,1.6,1.7)>.04,'nonloop signal ends and loop signal remains after wrap');
    for(const [from,to] of [[.02,.08],[2.25,2.35]]){let power=0,n=0;for(let i=Math.round(from*48000);i<Math.round(to*48000);i++){power+=signal.readFloatLE(i*4)**2;n++;}assert.ok(n>0 && Number.isFinite(power) && Math.sqrt(power/n)<.001,'bounded start/end hold contains decoded silence');}
    console.log(`concurrent loop AAC samples=${signal.length/4}, intended=115200, padding=${signal.length/4-115200}`);
    h.ok(true,'actual concurrent two-tone AAC mix preserves both signals, natural end, loop wrap, finite clock and silent holds');
    assert.throws(() => slideAudioGraph([{...segments[0], offsetMs:NaN}],{tone},2400), /Invalid/);
    assert.throws(() => slideAudioGraph([{...segments[0], endMs:2500}],{tone},2400), /Invalid/);
    h.ok(true, 'nonfinite offset and out-of-timeline segments refuse before encoder launch');
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
  await h.done();
})().catch(e => { console.error(e);process.exitCode=1; });
