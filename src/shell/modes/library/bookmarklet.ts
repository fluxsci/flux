// The Flux web-capture bookmarklet. The user drags the link in the Library window
// to their bookmarks bar; clicking it ON A PAPER PAGE (not in Flux) runs this in the
// page context, extracts a DOI from the page's citation meta tags, and opens
// flux://add?doi=… — falling back to flux://add?url=… so Flux can scrape it
// server-side.
//
// Authored as a literal string (not a stringified function): a function compiled
// through Vite/esbuild can pick up `__name()` keep-names wrappers that are undefined
// in the user's browser, which would break the bookmarklet. A string constant is
// data the bundler won't transform. Unit-tested in scripts (eval + a DOM stub).
//
// Readable form of the code below:
//   function p(n){ var m = document.querySelector('meta[name="'+n+'"],meta[property="'+n+'"]'); return m && m.content; }
//   function c(s){ if(!s) return "";
//     var t = String(s).replace(/^\s*doi:\s*/i,"").replace(/^https?:\/\/(dx\.)?doi\.org\//i,"");
//     var h = t.match(/10\.\d{4,9}\/\S+/i); return h ? h[0].replace(/[)\]>.,;'"]+$/,"") : ""; }
//   var d = c(p("citation_doi")) || c(p("bepress_citation_doi")) || c(p("dc.identifier"))
//        || c(p("prism.doi")) || c(p("DOI"));
//   location.href = d ? "flux://add?doi="+encodeURIComponent(d)
//                     : "flux://add?url="+encodeURIComponent(location.href);
export const BOOKMARKLET_HREF =
  `javascript:(function(){function p(n){var m=document.querySelector('meta[name="'+n+'"],meta[property="'+n+'"]');return m&&m.content}function c(s){if(!s)return'';var t=String(s).replace(/^\\s*doi:\\s*/i,'').replace(/^https?:\\/\\/(dx\\.)?doi\\.org\\//i,'');var h=t.match(/10\\.\\d{4,9}\\/\\S+/i);return h?h[0].replace(/[)\\]>.,;'"]+$/,''):''}var d=c(p('citation_doi'))||c(p('bepress_citation_doi'))||c(p('dc.identifier'))||c(p('prism.doi'))||c(p('DOI'));location.href=d?'flux://add?doi='+encodeURIComponent(d):'flux://add?url='+encodeURIComponent(location.href)})();`;
