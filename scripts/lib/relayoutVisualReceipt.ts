/** Regenerate the review strip from pristine matplotlib truth and production apply. */
import fs from 'node:fs';import {DOMParser} from 'linkedom';import {Resvg} from '@resvg/resvg-js';
import {buildRelayoutModel,solveRelayout,applyRelayout} from '../../src/lib/plot/relayout';
const names=['line','scatter-sizes','colorbar','image-equal','nested','secondary','figure-text','annotation','fluxbox','log-wide','log-subs','both-sides','manual-colorbar','annotation-symlog'];
const index=JSON.parse(fs.readFileSync('scripts/fixtures/relayout/cases.json','utf8')),rows=[];let y=30;
for(const name of names){const c=index.cases.find(c=>c.name===name),size=c.sizes[22],dir='scripts/fixtures/relayout/'+name+'/',m=JSON.parse(fs.readFileSync(dir+'base.fluxplot.json','utf8')),root=new DOMParser().parseFromString(fs.readFileSync(dir+'base.svg','utf8'),'image/svg+xml').documentElement as unknown as Element,model=buildRelayoutModel(m,root);if(!model.supported)throw Error(name);applyRelayout(root,model,solveRelayout(model,size));const truth=new DOMParser().parseFromString(fs.readFileSync(dir+size.stem+'.svg','utf8'),'image/svg+xml').documentElement;
 rows.push(`<text x="5" y="${y+12}" font-size="13">${name}</text>`);y+=20;
 for(const [i,svg]of [root,truth].entries()){svg.setAttribute('x',String(i*440));svg.setAttribute('y',String(y));svg.setAttribute('width','430');svg.setAttribute('height','180');rows.push(String(svg));}y+=190;
}
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="880" height="${y}" viewBox="0 0 880 ${y}"><rect width="880" height="${y}" fill="white"/><text x="5" y="18" font-size="14">Flux reflow</text><text x="445" y="18" font-size="14">Matplotlib truth</text>${rows.join('')}</svg>`;
fs.mkdirSync('notes/elastic_relayout_2026-10-23',{recursive:true});fs.writeFileSync('notes/elastic_relayout_2026-10-23/oracle-strip.png',new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng());
