// Same unchanged Nielsen/frame budgets, with 1,200 semantic scatter points,
// a data morph, 120 effects and 12 plot-bearing slides, plus a
// 1,200-marker hand-off on the real preview flight layer.
process.env.FLUX_SLIDE_DENSE = "1";
await import("./verify-scale-slide.mjs");
