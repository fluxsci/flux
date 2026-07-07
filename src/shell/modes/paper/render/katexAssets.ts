// Self-contained KaTeX CSS for the Preview iframe + printToPDF export (2.1): the
// stock stylesheet references url(fonts/*.woff2) that a srcdoc / printed document
// can't fetch — every font is inlined as a data: URI at BUILD time via Vite's
// ?inline imports (the renderer-side twin of the slide export's computeKatexCss
// prebake: same substitutions, but no Node fs / no fsGuard coupling, so it works
// in dev, packaged, and the browser demo alike). Dynamically imported by
// renderManuscript ONLY when the document contains math, so math-free previews
// never pull the ~0.5MB fonts chunk.

import katexCssRaw from "katex/dist/katex.min.css?raw";
import AMS_Regular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline";
import Caligraphic_Bold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline";
import Caligraphic_Regular from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline";
import Fraktur_Bold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline";
import Fraktur_Regular from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline";
import Main_Bold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?inline";
import Main_BoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline";
import Main_Italic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?inline";
import Main_Regular from "katex/dist/fonts/KaTeX_Main-Regular.woff2?inline";
import Math_BoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline";
import Math_Italic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?inline";
import SansSerif_Bold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline";
import SansSerif_Italic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline";
import SansSerif_Regular from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline";
import Script_Regular from "katex/dist/fonts/KaTeX_Script-Regular.woff2?inline";
import Size1_Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline";
import Size2_Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline";
import Size3_Regular from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline";
import Size4_Regular from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline";
import Typewriter_Regular from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline";

const FONTS: Record<string, string> = {
  "KaTeX_AMS-Regular.woff2": AMS_Regular,
  "KaTeX_Caligraphic-Bold.woff2": Caligraphic_Bold,
  "KaTeX_Caligraphic-Regular.woff2": Caligraphic_Regular,
  "KaTeX_Fraktur-Bold.woff2": Fraktur_Bold,
  "KaTeX_Fraktur-Regular.woff2": Fraktur_Regular,
  "KaTeX_Main-Bold.woff2": Main_Bold,
  "KaTeX_Main-BoldItalic.woff2": Main_BoldItalic,
  "KaTeX_Main-Italic.woff2": Main_Italic,
  "KaTeX_Main-Regular.woff2": Main_Regular,
  "KaTeX_Math-BoldItalic.woff2": Math_BoldItalic,
  "KaTeX_Math-Italic.woff2": Math_Italic,
  "KaTeX_SansSerif-Bold.woff2": SansSerif_Bold,
  "KaTeX_SansSerif-Italic.woff2": SansSerif_Italic,
  "KaTeX_SansSerif-Regular.woff2": SansSerif_Regular,
  "KaTeX_Script-Regular.woff2": Script_Regular,
  "KaTeX_Size1-Regular.woff2": Size1_Regular,
  "KaTeX_Size2-Regular.woff2": Size2_Regular,
  "KaTeX_Size3-Regular.woff2": Size3_Regular,
  "KaTeX_Size4-Regular.woff2": Size4_Regular,
  "KaTeX_Typewriter-Regular.woff2": Typewriter_Regular,
};

function inlineFonts(css: string): string {
  for (const [name, dataUri] of Object.entries(FONTS)) {
    css = css.replaceAll(`url(fonts/${name})`, `url(${dataUri})`);
  }
  // Strip the now-broken woff/ttf alternates (in a srcdoc/print doc they'd 404) —
  // the same substitution the slide export's computeKatexCss applies.
  return css.replace(/,url\(fonts\/[\w-]+\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, "");
}

/** The full KaTeX stylesheet with every font inlined — drop into a <style> tag. */
export const katexCssInlined: string = inlineFonts(katexCssRaw);
