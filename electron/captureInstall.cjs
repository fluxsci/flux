// The web-capture install page: a real page in the user's DEFAULT browser holding the
// draggable "Add to FluxLib" link.
//
// It has to be a page, not a copied string, for two reasons. A bookmarklet is installed by
// DRAGGING a link — typing a 2 KB `javascript:` URL into a bookmark dialog is miserable. And
// the dragged bookmark inherits the SOURCE PAGE's favicon, which is the only way to get the
// Flux mark onto the bookmark instead of the browser's blank-page icon.
//
// The icon is inlined as a data URI (from build/icons/32x32.png, baked in below) because
// build/ is buildResources and never ships inside the packaged app.
const FLUX_ICON_DATA_URI = "data:image/png;base64,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";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Full HTML for the install page, given the bookmarklet href (the renderer owns that string). */
function captureInstallHtml(href) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Add to FluxLib — install</title>
<link rel="icon" href="${FLUX_ICON_DATA_URI}">
<meta name="color-scheme" content="light dark">
<style>
 :root{--bg:#fffcf0;--tx:#100f0f;--tx2:#6f6e69;--line:#e6e4d9;--accent:#1f6d3a;--card:#f2f0e5}
 @media (prefers-color-scheme:dark){:root{--bg:#100f0f;--tx:#cecdc3;--tx2:#878580;--line:#282726;--card:#1c1b1a}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 main{max-width:46rem;margin:0 auto;padding:3rem 1.5rem 5rem}
 h1{font-size:1.6rem;margin:0 0 .3rem;letter-spacing:-.01em}
 .sub{color:var(--tx2);margin:0 0 2rem}
 .drop{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;padding:1.4rem;border:2px dashed var(--line);border-radius:12px;background:var(--card);margin:0 0 .75rem}
 a.bm{display:inline-flex;align-items:center;gap:.5rem;padding:.7rem 1.2rem;background:var(--accent);color:#fff;border-radius:9px;text-decoration:none;font-weight:600;cursor:grab}
 a.bm img{width:18px;height:18px;border-radius:3px}
 .drop span{color:var(--tx2);font-size:.95rem}
 h2{font-size:1.05rem;margin:2.2rem 0 .5rem}
 ol,ul{padding-left:1.3rem;margin:.4rem 0}
 li{margin:.35rem 0}
 code{background:var(--card);border:1px solid var(--line);padding:.08rem .35rem;border-radius:4px;font-size:.9em}
 table{border-collapse:collapse;width:100%;margin:.6rem 0;font-size:.95rem}
 th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
 th{color:var(--tx2);font-weight:600;white-space:nowrap}
 .note{border-left:3px solid var(--line);padding:.1rem 0 .1rem 1rem;color:var(--tx2);margin:1rem 0}
 a{color:var(--accent)}
</style></head><body><main>
<h1>Add to FluxLib</h1>
<p class="sub">One click on any paper page saves it into your library — from inside your own
logged-in browser, so it reaches what Flux can't fetch on its own.</p>

<div class="drop">
  <a class="bm" href="${esc(href)}"><img src="${FLUX_ICON_DATA_URI}" alt="">Add to FluxLib</a>
  <span>&larr; drag this onto your bookmarks bar</span>
</div>
<p class="sub" style="margin:0 0 2rem;font-size:.9rem">Bookmarks bar hidden? <code>Ctrl+Shift+B</code>
(<code>⌘⇧B</code> on macOS).</p>

<h2>Using it</h2>
<p>Open a paper — the article page or the PDF itself — and click the bookmark. A message
appears at the top of the page telling you what happened:</p>
<table>
 <tr><th>Green</th><td>The PDF was captured. Flux files it and matches it to a reference automatically.</td></tr>
 <tr><th>Amber</th><td>No PDF was reachable, so the paper's details were captured instead. Flux still adds the reference — it just won't have the PDF.</td></tr>
 <tr><th>Nothing</th><td>The click didn't run. See below.</td></tr>
</table>
<p>Files land in your downloads folder named <code>flux-…</code>, and Flux picks them up
within a second or two if it's open. If it isn't, they wait — nothing is lost.</p>

<h2>Browser support</h2>
<table>
 <tr><th>Chrome, Edge, Brave</th><td>Fully supported. Bookmarklets run everywhere.</td></tr>
 <tr><th>Safari</th><td>Works. Show the Favourites bar with <code>⌘⇧B</code>.</td></tr>
 <tr><th>Firefox</th><td>Works on many sites, but <strong>silently does nothing on publishers with a
   strict Content-Security-Policy</strong> — Firefox applies the page's CSP to bookmarklets, which
   Chrome doesn't (<a href="https://bugzilla.mozilla.org/show_bug.cgi?id=866522">Mozilla bug 866522</a>,
   open since 2013). If a click does nothing on a publisher site, that's why. Use Chrome for capture,
   or save the PDF yourself and drop it into Flux's <code>pdfs_to_assign</code> folder.</td></tr>
</table>
<div class="note">Don't disable <code>security.csp.enable</code> to work around this — it turns
off CSP for every site you visit.</div>

<h2>If nothing happens</h2>
<ul>
 <li>Check the address bar for a blocked-download icon, and allow it.</li>
 <li>On a page with a strict CSP the click may be blocked outright (see Firefox, above).</li>
 <li>Some publishers block the PDF fetch but not the script — you get the amber message and the
     reference still arrives, just without its PDF.</li>
</ul>
</main></body></html>`;
}

module.exports = { captureInstallHtml, FLUX_ICON_DATA_URI };
