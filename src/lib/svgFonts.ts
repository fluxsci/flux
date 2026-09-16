// Bundled webfonts for standalone SVG images: the live document loads Gelasio through
// fonts.css; an SVG image has no access to document fonts, so a snapshot that
// mentions it carries the faces inline. Loaded once, only when needed.
let gelasioCss: Promise<string> | null = null;
export function svgFontCss(svgText: string): Promise<string> {
  if (!/Gelasio|Georgia/.test(svgText)) return Promise.resolve("");
  if (!gelasioCss) {
    gelasioCss = (async () => {
      const faces: string[] = [];
      for (const f of [
        { file: new URL("../styles/fonts/Gelasio.woff2", import.meta.url).href, style: "normal" },
        { file: new URL("../styles/fonts/Gelasio-italic.woff2", import.meta.url).href, style: "italic" },
      ]) {
        try {
          const buf = new Uint8Array(await (await fetch(f.file)).arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          faces.push(`@font-face{font-family:"Gelasio";font-style:${f.style};font-weight:400 700;src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2")}`);
        } catch {
          /* font missing — the platform fallback renders */
        }
      }
      return faces.join("");
    })();
  }
  return gelasioCss;
}
