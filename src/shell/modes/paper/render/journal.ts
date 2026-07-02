// Journal stylesheet, shared by the in-app Preview (iframe srcdoc) and the
// self-contained HTML/PDF exports — so preview == export (Flux_Paper_Plan.md D1).
// Light cream "paper" sheets, serif print scale, numbered captions, a real
// references list. Self-contained: no external fonts/urls, @page drives the PDF.

export const journalCss = `
:root {
  --paper: #fdfcf9;
  --ink: #1a1916;
  --muted: #565049;
  --faint: #8a8279;
  --rule: #e4ded3;
  --accent: #205ea6;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #1a1a1a; }
body {
  font-family: Georgia, "Times New Roman", serif;
  color: var(--ink);
  line-height: 1.62;
  font-size: 11.5pt;
}
.sheet {
  background: var(--paper);
  color: var(--ink);
  width: 8.5in;
  min-height: 11in;
  margin: 24px auto;
  padding: 1in 1in 1.1in;
  box-shadow: 0 6px 30px rgba(0,0,0,0.4);
}
.continuous .sheet { min-height: 0; box-shadow: 0 6px 30px rgba(0,0,0,0.4); }
h1, h2, h3, h4 { font-weight: 700; line-height: 1.25; color: #100f0f; margin: 1.4em 0 0.5em; }
h1 { font-size: 1.9em; margin-top: 0; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.16em; }
h4 { font-size: 1em; }
p { margin: 0 0 0.85em; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.title-block { margin-bottom: 2em; border-bottom: 1px solid var(--rule); padding-bottom: 1.2em; }
.title-block .title { font-size: 2.1em; font-weight: 700; line-height: 1.2; margin: 0 0 0.3em; }
.title-block .authors { color: var(--muted); font-size: 1.05em; }
.title-block .affil { color: var(--faint); font-size: 0.9em; font-style: italic; margin-top: 0.3em; }
.abstract { background: #f4f0e8; border-radius: 6px; padding: 0.9em 1.2em; margin: 1.4em 0; font-size: 0.96em; }
.abstract .lbl { font-weight: 700; font-variant: small-caps; letter-spacing: 0.04em; color: var(--muted); }
figure.fig { margin: 1.6em 0; text-align: center; page-break-inside: avoid; break-inside: avoid; }
figure.fig .art { display: inline-block; max-width: 100%; }
figure.fig .art svg { max-width: 100%; height: auto; }
figure.fig .art.sized svg { width: 100%; height: auto; }
figcaption, .cap { font-size: 0.86em; color: var(--muted); line-height: 1.5; margin-top: 0.6em; text-align: center; max-width: 90%; margin-left: auto; margin-right: auto; }
figcaption b, .cap b { color: #100f0f; }
table { border-collapse: collapse; width: 100%; margin: 0.6em auto; font-size: 0.93em; page-break-inside: avoid; }
th, td { border: 1px solid var(--rule); padding: 5px 11px; text-align: left; }
th { background: #f4f0e8; font-weight: 700; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid var(--rule); color: var(--muted); font-style: italic; }
.callout { margin: 1.2em 0; border: 1px solid var(--rule); border-left: 4px solid var(--accent); border-radius: 6px; padding: 0.7em 1em; background: #f7f4ee; page-break-inside: avoid; }
.callout-label { font-weight: 700; font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); margin-bottom: 0.3em; }
.callout-body > :last-child { margin-bottom: 0; }
.callout-note { border-left-color: #205ea6; } .callout-note .callout-label { color: #205ea6; }
.callout-tip { border-left-color: #66800b; } .callout-tip .callout-label { color: #66800b; }
.callout-warning { border-left-color: #ad8301; } .callout-warning .callout-label { color: #ad8301; }
.callout-important { border-left-color: #af3029; } .callout-important .callout-label { color: #af3029; }
.callout-caution { border-left-color: #bc5215; } .callout-caution .callout-label { color: #bc5215; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.88em; background: #f0ece3; padding: 1px 4px; border-radius: 3px; }
pre { background: #f0ece3; padding: 0.8em 1em; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; }
hr { border: none; border-top: 1px solid var(--rule); margin: 1.6em 0; }
sup { font-size: 0.75em; }
.references { margin-top: 2em; border-top: 1px solid var(--rule); padding-top: 1em; }
.references h2 { font-size: 1.2em; }
.ref { font-size: 0.9em; line-height: 1.5; margin: 0 0 0.7em; padding-left: 1.6em; text-indent: -1.6em; color: var(--ink); }
.ref .ref-authors { }
.ref .ref-title { }
.ref .ref-venue { font-style: italic; color: var(--muted); }
.ref a { color: var(--accent); }
.detached-note { color: var(--faint); font-style: italic; }
/* paginated preview: real letter sheets with page numbers */
.page {
  position: relative;
  background: var(--paper);
  color: var(--ink);
  width: 8.5in;
  height: 11in;
  margin: 24px auto;
  padding: 1in 1in 0.7in;
  box-shadow: 0 6px 30px rgba(0,0,0,0.4);
  overflow: hidden;
}
.page-body { overflow: hidden; }
.page-num { position: absolute; left: 0; right: 0; bottom: 0.42in; text-align: center; font-size: 0.8em; color: var(--faint); }
@page { size: letter; margin: 1in; }
@media print {
  html, body { background: #fff; }
  .sheet { box-shadow: none; margin: 0; width: auto; min-height: 0; padding: 0; }
}
`;
