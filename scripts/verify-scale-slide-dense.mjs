// Same unchanged Nielsen/frame budgets, with 1,200 semantic scatter points,
// a data morph, 120 effects and 12 plot-bearing slides.
process.env.FLUX_SLIDE_DENSE = "1";
await import("./verify-scale-slide.mjs");
