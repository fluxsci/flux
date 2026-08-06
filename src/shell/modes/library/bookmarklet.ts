// The Flux web-capture bookmarklet. Drag the link in the Library window to your bookmarks
// bar; clicking it ON A PAPER PAGE (not in Flux) runs this in the page context.
//
// WHAT IT DOES, AND WHY THIS SHAPE: it downloads a file. That's it — no localhost server, no
// custom protocol, no extension. Every fancier transport is now blocked or fragile:
//   • `flux://add?doi=…` (the previous design) depends on an OS protocol registration, which
//     is unreliable on Linux and invisible when it fails.
//   • A loopback POST to Flux (how Zotero's connector works) is dead for a bookmarklet as of
//     Chrome 142's Local Network Access rules: a public origin reaching 127.0.0.1 now needs a
//     per-site permission prompt. Extensions are exempt; page scripts are not.
// A download is subject to none of that, works in every browser, and needs no setup.
//
// It prefers to ship the ARTICLE ITSELF rather than a URL: `fetch(pdfUrl, credentials:
// 'include')` runs inside your authenticated session, so it walks straight through the
// paywalls and the Cloudflare/PerimeterX walls that defeat Flux's own headless capture. The
// PDF lands as `flux-<slug>.pdf`, and Flux's existing identifier matches it from its content.
// When the page advertises no PDF, or its Content-Security-Policy blocks the fetch, it falls
// back to a `flux-<slug>.fluxcap` JSON sidecar (see src/lib/references/capture.ts).
//
// Authored as a literal string (NOT `fn.toString()`): a function compiled through
// Vite/esbuild picks up `__name()` keep-names wrappers that are undefined in the user's
// browser, which would break the bookmarklet. A string constant is data the bundler won't
// transform. Every backslash is DOUBLED because this is a template literal — `\s` in a
// template literal collapses to a bare `s` and would silently corrupt the regexes.
// Gated headlessly by scripts/verify-bookmarklet.ts, which evals THIS string against a DOM
// stub, so what ships is what's tested.
//
// Readable form of the code below:
//   var D = document, L = location;
//   function m(n){ var e = D.querySelector('meta[name="'+n+'"],meta[property="'+n+'"]'); return e && e.content || ''; }
//   function cd(s){ if(!s) return '';
//     var t = String(s).replace(/^\s*doi:\s*/i,'').replace(/^https?:\/\/(dx\.)?doi\.org\//i,'');
//     var h = t.match(/10\.\d{4,9}\/\S+/i); return h ? h[0].replace(/[)\]>.,;'"]+$/,'') : ''; }
//   var doi = cd(m('citation_doi')) || cd(m('bepress_citation_doi')) || cd(m('dc.identifier'))
//          || cd(m('prism.doi')) || cd(m('DOI')) || cd((D.querySelector('a[href*="doi.org/10."]')||{}).href);
//   var pu  = m('citation_pdf_url') || m('bepress_citation_pdf_url')
//          || ((D.querySelector('link[type="application/pdf"]')||{}).href || '');
//   var ti  = m('citation_title') || m('dc.title') || D.title || '';
//   var slug = (doi || L.hostname).replace(/[^\w.\-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,110) || 'capture';
//   function tst(t,c){ …fixed-position toast so the page tells you it worked… }
//   function dl(bl,nm){ var u = URL.createObjectURL(bl); var a = D.createElement('a');
//     a.href = u; a.download = nm; D.body.appendChild(a); a.click();
//     setTimeout(function(){ URL.revokeObjectURL(u); a.remove(); }, 5000); }
//   function cap(r){ var p = {v:1,url:L.href,doi:doi,title:ti,pdfUrl:pu,reason:r,capturedAt:new Date().toISOString()};
//     dl(new Blob([JSON.stringify(p,null,1)],{type:'application/json'}), 'flux-'+slug+'.fluxcap');
//     tst('Sent details to Flux' + (doi ? ' — '+doi : ''), '#8a6d1f'); }
//   if(!pu) return cap('no-pdf-on-page');
//   fetch(pu,{credentials:'include'})
//     .then(function(r){ if(!r.ok) throw 0; return r.blob(); })
//     .then(function(b){ if(b.size < 1024) throw 0;
//       return b.slice(0,5).text().then(function(h){ if(h.slice(0,4) !== '%PDF') throw 0;
//         dl(b, 'flux-'+slug+'.pdf'); tst('PDF sent to Flux ✓' + (doi ? ' — '+doi : ''), '#1f6d3a'); }); })
//     .catch(function(){ cap('pdf-fetch-blocked'); });
export const BOOKMARKLET_HREF =
  `javascript:(function(){var D=document,L=location;function m(n){var e=D.querySelector('meta[name="'+n+'"],meta[property="'+n+'"]');return e&&e.content||''}function cd(s){if(!s)return'';var t=String(s).replace(/^\\s*doi:\\s*/i,'').replace(/^https?:\\/\\/(dx\\.)?doi\\.org\\//i,'');var h=t.match(/10\\.\\d{4,9}\\/\\S+/i);return h?h[0].replace(/[)\\]>.,;'"]+$/,''):''}var doi=cd(m('citation_doi'))||cd(m('bepress_citation_doi'))||cd(m('dc.identifier'))||cd(m('prism.doi'))||cd(m('DOI'))||cd((D.querySelector('a[href*="doi.org/10."]')||{}).href);var pu=m('citation_pdf_url')||m('bepress_citation_pdf_url')||((D.querySelector('link[type="application/pdf"]')||{}).href||'');var ti=m('citation_title')||m('dc.title')||D.title||'';var slug=(doi||L.hostname).replace(/[^\\w.\\-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,110)||'capture';function tst(t,c){try{var b=D.createElement('div');b.textContent=t;b.style.cssText='position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);padding:10px 16px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.3);background:'+c;D.body.appendChild(b);setTimeout(function(){b.remove()},3600)}catch(e){}}function dl(bl,nm){var u=URL.createObjectURL(bl);var a=D.createElement('a');a.href=u;a.download=nm;D.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(u);a.remove()},5000)}function cap(r){var p={v:1,url:L.href,doi:doi,title:ti,pdfUrl:pu,reason:r,capturedAt:new Date().toISOString()};dl(new Blob([JSON.stringify(p,null,1)],{type:'application/json'}),'flux-'+slug+'.fluxcap');tst('Sent details to Flux'+(doi?' \\u2014 '+doi:''),'#8a6d1f')}if(!pu)return cap('no-pdf-on-page');fetch(pu,{credentials:'include'}).then(function(r){if(!r.ok)throw 0;return r.blob()}).then(function(b){if(b.size<1024)throw 0;return b.slice(0,5).text().then(function(h){if(h.slice(0,4)!=='%PDF')throw 0;dl(b,'flux-'+slug+'.pdf');tst('PDF sent to Flux \\u2713'+(doi?' \\u2014 '+doi:''),'#1f6d3a')})}).catch(function(){cap('pdf-fetch-blocked')})})();`;
