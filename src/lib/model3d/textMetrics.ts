/**
 * Deterministic text widths for 3D furniture layout (no DOM, identical in Node, the browser,
 * the poster worker and fluxplot's Python twin `fluxplot.scene3d_viewer`).
 *
 * Advance widths are Arial's (metric-compatible with Helvetica and Liberation Sans, the house
 * furniture fonts) in 1/1000 em. Characters outside the table count as 600. Keep this table and
 * `_ADVANCE` / `_EXTRA` in fluxplot's scene3d_viewer.py byte-identical.
 */
const ASCII='278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'.split(',').map(Number);
const EXTRA:Record<string,number>={'µ':576,'°':400,'±':549,'−':584,'×':584,'÷':549,'²':333,'³':333,'¹':333,'·':278,'–':556,'—':1000,'λ':500,'Å':667,'π':690,'σ':617,'Δ':668,'α':578,'β':575,'γ':500,'θ':556,'…':1000,'’':222};
const FALLBACK=600;

/** Estimated rendered width in px of `text` at `fontPx`. */
export function textWidth(text:string,fontPx:number):number {
 let units=0;
 for(const ch of text){const code=ch.codePointAt(0)!;units+=code>=32&&code<127?ASCII[code-32]:EXTRA[ch]??FALLBACK;}
 return units*fontPx/1000;
}

/** Greedy word wrap to `maxWidth` px; a single word wider than the line keeps its own line. */
export function wrapWords(text:string,fontPx:number,maxWidth:number):string[] {
 const words=text.split(/\s+/).filter(Boolean),lines:string[]=[];
 let line='';
 for(const word of words){const next=line?`${line} ${word}`:word;if(line&&textWidth(next,fontPx)>maxWidth){lines.push(line);line=word;}else line=next;}
 if(line)lines.push(line);
 return lines.length?lines:[''];
}
