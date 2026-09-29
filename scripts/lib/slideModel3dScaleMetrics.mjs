/** Qualification uses raw publication-frame stamps, never rounded summaries. */
export const SLIDE_MODEL_FRAME_BUDGET_MS = 17;
export function positiveSlideModelHardware(renderer, features) {
  // Electron 43 reports WebGL (1 and 2) under one `webgl` feature; older builds split out `webgl2`.
  return (features?.webgl2 ?? features?.webgl) === 'enabled' && typeof renderer === 'string'
    && !/swiftshader|software|llvmpipe|softpipe|unknown|generic/i.test(renderer)
    && /\b(?:NVIDIA|AMD|ATI|Intel|Apple|Qualcomm|Adreno|Mali|PowerVR|Radeon|GeForce|RTX)\b/i.test(renderer);
}
export function slideModelCohortTiming(frames, inputs, visibility, durationMs) {
  if (inputs.length !== 1 || inputs[0].key !== 'ArrowRight' || !Number.isFinite(inputs[0].stamp) || !Number.isFinite(durationMs) || durationMs <= 0) throw Error('One finite trusted cue and authored duration required');
  if (!frames.length || frames.some(f => ![f.stamp, f.started, f.finished].every(Number.isFinite) || f.started < f.stamp || f.finished < f.started)) throw Error('Finite ordered publication timestamps required');
  const firstPublicationMs = frames[0].finished - inputs[0].stamp;
  const coveredMs = frames.at(-1).stamp - inputs[0].stamp;
  const uninterrupted = !visibility.some(e => e.event === 'blur' || e.visible !== 'visible' || e.focused !== true);
  return { firstPublicationMs, coveredMs, durationMs, responsive: firstPublicationMs >= 0 && firstPublicationMs <= 100, complete: coveredMs >= durationMs, uninterrupted };
}
export function slideModelFrameMetrics(frames, expectedIds, { hardware = false, minimumFrames = 80 } = {}) {
  if (!Number.isInteger(minimumFrames) || minimumFrames < 2 || hardware && minimumFrames < 80) throw Error('Invalid publication sample requirement');
  if (!Array.isArray(frames) || frames.length < minimumFrames) throw Error(`Fewer than ${minimumFrames} actual published animation frames`);
  const expected = new Set(expectedIds);
  if (!expected.size) throw Error('Expected visible model identities are required');
  let previous = -Infinity;
  for (const frame of frames) {
    if (!Number.isFinite(frame.stamp) || frame.stamp <= previous) throw Error('Publication frame stamps must be finite and strictly increasing');
    previous = frame.stamp;
    if (!Array.isArray(frame.ids) || [...expected].some(id => !frame.ids.includes(id))) throw Error('A published frame omitted a visible model');
    if (hardware && (frame.visible !== 'visible' || frame.focused !== true)) throw Error('Native publication lost visibility or focus');
  }
  const gaps = frames.slice(1).map((f, i) => f.stamp - frames[i].stamp), sorted = [...gaps].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * .95) - 1];
  return { frameCount: frames.length, gaps, p95, max: sorted.at(-1), budgetMs: SLIDE_MODEL_FRAME_BUDGET_MS, withinBudget: p95 <= SLIDE_MODEL_FRAME_BUDGET_MS };
}
