// Diagnostics for sampled screencast frames, not a proof about every presented
// frame. Keep dropouts in the input: zero-width frames are precisely the failure
// this oracle must detect. Geometry checks need three intact marker bounds.
'use strict';
function analyze(frames) {
  const blanks = [], glitches = [];
  const maxW = Math.max(0, ...frames.map((f) => f.bw));
  const intact = (f) => f.bw > maxW * 0.55 && f.bh > 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], p = frames[i - 1], n = frames[i + 1];
    // A complete loss is observable even at the capture boundary or for several
    // consecutive samples. This lab keeps at least one black marker onscreen.
    if (f.bw === 0 && f.dark === 0) {
      blanks.push({ i, t: f.t - frames[0].t, dark: [p?.dark, f.dark, n?.dark] });
      continue;
    }
    if (!p || !n) continue;
    if (f.dark < Math.min(p.dark, n.dark) * 0.5)
      blanks.push({ i, t: f.t - frames[0].t, dark: [p.dark, f.dark, n.dark] });
    if (![p, f, n].every(intact)) continue;
    const fraction = n.t > p.t ? (f.t - p.t) / (n.t - p.t) : 0.5;
    const ew = p.bw + (n.bw - p.bw) * fraction, eh = p.bh + (n.bh - p.bh) * fraction;
    if (Math.abs(f.bw - ew) > ew * 0.06 || Math.abs(f.bh - eh) > eh * 0.06)
      glitches.push({ i, t: f.t - frames[0].t, bw: [p.bw, f.bw, n.bw], bh: [p.bh, f.bh, n.bh] });
    if (f.x != null && p.x != null && n.x != null) {
      const ex = (p.x + n.x) / 2;
      if (Math.abs(f.x - ex) > 12 && Math.sign(f.x - p.x) !== Math.sign(n.x - f.x) && Math.abs(p.x - n.x) < 40)
        glitches.push({ i, t: f.t - frames[0].t, x: [p.x, f.x, n.x] });
    }
  }
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t).sort((a, b) => a - b);
  return { frames: frames.length, gapP50: gaps[Math.floor(gaps.length / 2)] ?? null,
    gapP95: gaps[Math.floor(gaps.length * 0.95)] ?? null,
    blanks, glitches };
}
module.exports = { analyze };
