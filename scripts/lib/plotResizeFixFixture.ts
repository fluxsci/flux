import fs from 'node:fs';
import type { FluxPlotManifest } from '../../src/lib/plot/types';

/** Small deterministic reproduction of matplotlib's defs-backed fill_between,
 * fixed-size markers and a two-column above-axes legend. No private plot data. */
export function plotResizeFixFixture(options:{frame?:boolean;title?:boolean;row?:boolean}={}){
  const manifest=JSON.parse(fs.readFileSync('scripts/fixtures/relayout/line/base.fluxplot.json','utf8')) as FluxPlotManifest;
  let svg=fs.readFileSync('scripts/fixtures/relayout/line/base.svg','utf8');
  const layout=manifest.layout!,font=Object.keys(layout.fonts)[0];
  layout.frames['confidence.band']={f:'data',axes:'plot-area'};
  layout.frames['confidence.mean']={f:'data',axes:'plot-area'};
  const band=`<g id="confidence.band" data-role="area"><defs><path id="confidence-path" d="M 70 -120 L 100 -100 L 140 -125 L 130 -140 Z"/></defs><use href="#confidence-path" x="0" y="230.4" style="fill:#777;fill-opacity:0.2"/></g>`;
  const marker=`<g id="confidence.mean" data-role="mean"><defs><path id="confidence-marker" d="M -3 0 L 3 0"/></defs><use href="#confidence-marker" x="100" y="120" style="stroke:#111;stroke-width:1"/></g>`;
  // A single-row (ncol = entries) legend, or the default two columns of two.
  const names=options.row?['QW','AW','SWS','Sigma','REM']:['Condition A','Condition B','Condition C','Condition D'];
  const entries=names.map((text,i)=>{
    const x=options.row?50+i*36:i<2?50:145,y=options.row?8:(i%2?18:8)+(options.title?11:0),w=options.row?6*text.length:i<2?60:70;
    layout.texts[`legend.entry.${i}.label`]={text,font,anchor:[x,y],bbox:[x,y-6,x+w,y],ha:'left',va:'baseline',rotation:0};
    return `<g id="legend.entry.${i}.swatch" data-role="legend-swatch"><path d="M ${x-13} ${y-2} L ${x-5} ${y-2}" style="stroke:#333;stroke-width:1"/></g><g id="legend.entry.${i}.label" data-role="legend-label"><text x="${x}" y="${y}" style="font-size:6px">${text}</text></g>`;
  }).join('');
  const height=options.row?13:options.title?34:23;
  const legendRight=options.row?50+4*36+6*3+5:220;
  layout.legends=[{id:'legend',owner:'plot-area',bbox:[35,0,legendRight,height],sizePt:[legendRight-35,height],bboxToAnchor:{frame:'axes',bbox:[0,1.02,0,0]},borderAxesPadPt:0,inLayout:false,locRequested:'lower left',locResolved:'lower left',collision:null}];
  layout.frames.legend={f:'legend'};
  const background=options.frame?`<g id="legend.background" data-role="background"><path d="M 37 ${height} L 218 ${height} Q 220 ${height} 220 ${height-2} L 220 2 Q 220 0 218 0 L 37 0 Q 35 0 35 2 L 35 ${height-2} Q 35 ${height} 37 ${height} Z" style="fill:white;stroke:#ccc;stroke-width:1"/></g>`:'';
  let title='';
  if(options.title){layout.texts['legend.title']={text:'Conditions',font,anchor:[90,7],bbox:[90,1,145,7],ha:'left',va:'baseline',rotation:0};title='<g id="legend.title" data-role="legend-title"><text x="90" y="7" style="font-size:6px">Conditions</text></g>';}
  svg=svg.replace('</svg>',`${band}${marker}<g id="legend" data-role="legend">${background}${title}${entries}</g></svg>`);
  return {svg,manifest};
}

export const hiddenPanelSvg=`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><g id="figure" data-role="figure"><g id="figure.background" data-role="background"><rect width="400" height="200" fill="white"/></g><g id="panel.left" data-role="plot-area"><rect x="10" y="20" width="100" height="100" fill="#5678aa"/><text x="20" y="140" font-size="12">Left panel</text></g><g id="panel.right" data-role="plot-area"><rect x="250" y="20" width="100" height="100" fill="#aa7856"/><text x="260" y="140" font-size="12">Right panel</text></g></g></svg>`;
