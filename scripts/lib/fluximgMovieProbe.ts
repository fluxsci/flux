// A child process for verify-fluximg-movie.ts: writes one image movie and reports its own peak RSS (the parent's heap
// holds the fixture's arrays; a movie's memory is measured where nothing else lives). Synthetic data only.
// Args: <root> <elementId> <slide|-> <out> <pieceBudgetBytes|-> [scale]
import "./cssStub.mjs";
const [root, elementId, slide, out, budget, scale] = process.argv.slice(2);
const { exportImageMovie } = await import("../../flux-core/fluximgMovie");
const rssStart = process.memoryUsage().rss;
let peak = rssStart;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
const t0 = performance.now();
const r = await exportImageMovie(root, elementId, { out, ...(slide !== "-" ? { slide } : {}), ...(budget !== "-" ? { pieceBudget: Number(budget) } : {}), ...(scale ? { scale: Number(scale) } : {}) });
const ms = performance.now() - t0;
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().rss);
console.log(JSON.stringify({ rssStart, peak, maxRSS: process.resourceUsage().maxRSS * 1024, ms, frames: r.frames, width: r.width, height: r.height, bytes: r.bytes, stats: r.stats }));
