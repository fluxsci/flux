export interface RelayoutWarning { code: string; ids?: string[] }
export interface RelayoutReport {
  status: "exact" | "reflowed" | "approximate" | "stretch";
  warnings: RelayoutWarning[];
  retickedAxes?:string[];
}
export function stretchReport(...reasons: string[]): RelayoutReport {
  return {status:"stretch",warnings:reasons.map(code=>({code}))};
}
export function reportText(report:RelayoutReport):string {
  const labels:Record<string,string>={"layout:missing":"regenerate with fluxplot ≥ 0.4 to reflow", "layout:stretch":"chosen in Layout",
    "projection:polar":"polar axes not supported", "3d":"3D axes not supported", "subfigures":"subfigures not supported",
    "layout:compressed":"compressed layout not supported", "font:unmeasured":"unmeasured glyph", "ticks:feedback":"tick feedback", "ticks:crowded":"ticks crowded", "ticks:fixed":"labels fixed in source"};
  return [report.status[0].toUpperCase()+report.status.slice(1),...(report.retickedAxes?.length?[report.retickedAxes.join(", ")+" ticks recomputed"]:[]),...report.warnings.map(w=>labels[w.code]??w.code.replaceAll(":"," "))].join(" · ");
}
