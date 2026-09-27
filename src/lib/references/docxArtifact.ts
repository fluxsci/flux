import { unzipSync, strFromU8 } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { addSvgRasterFallbacks, type RasterizeSvg } from "./docxSvgFallback";
import { stripZoteroMarkers } from "./zoteroFields";

/** Validate the bytes that will be published, including every internal OPC target. */
export function validateDocx(bytes: Uint8Array): void {
  const parts = unzipSync(bytes);
  for (const required of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) {
    if (!parts[required]?.length) throw new Error(`Invalid DOCX: missing ${required}`);
  }
  for (const [name, data] of Object.entries(parts)) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const xml = strFromU8(data), errors: string[] = [];
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`Invalid DOCX: declarations in ${name}`);
    const doc = new DOMParser({ errorHandler: { warning: m => errors.push(m), error: m => errors.push(m), fatalError: m => errors.push(m) } }).parseFromString(xml, "application/xml");
    if (errors.length || !doc.documentElement) throw new Error(`Invalid DOCX XML: ${name}: ${errors[0] ?? "missing root"}`);
    if (/⟦Z(?:C|E)/.test(doc.documentElement.textContent ?? "")) throw new Error(`DOCX retains citation markers in ${name}`);
    if (!name.endsWith(".rels")) continue;
    const base = name === "_rels/.rels" ? [] : name.split("/").slice(0, -2);
    const ids = new Set<string>();
    const relationships = doc.getElementsByTagName("Relationship");
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships.item(i)!;
      const id = rel.getAttribute("Id"), target = rel.getAttribute("Target");
      if (!id || !target || ids.has(id)) throw new Error(`Invalid DOCX relationship in ${name}`);
      ids.add(id);
      if (rel.getAttribute("TargetMode") === "External") continue;
      const resolved = target.startsWith("/") ? [] : [...base];
      for (const segment of decodeURIComponent(target.split("#")[0]).split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") { if (!resolved.length) throw new Error("DOCX relationship escapes package"); resolved.pop(); }
        else resolved.push(segment);
      }
      if (!parts[resolved.join("/")]) throw new Error(`DOCX relationship target missing: ${resolved.join("/")}`);
    }
  }
}

/** Shared GUI/headless policy: a safe plain-reference fallback is a degraded success. */
export async function postprocessDocx<T>(bytes: Uint8Array, opts: {
  rasterize: RasterizeSvg;
  inject?: (bytes: Uint8Array) => Promise<{ bytes: Uint8Array; summary: T }>;
}) {
  const raster = await addSvgRasterFallbacks(bytes, opts.rasterize);
  if (raster.report.failed.length) throw new Error(`DOCX figures could not be rasterized: ${raster.report.failed.join(", ")}`);
  let result = raster.bytes, zotero: T | undefined;
  const warnings: string[] = [];
  if (opts.inject) {
    try { const injected = await opts.inject(result); result = injected.bytes; zotero = injected.summary; }
    catch (error) { result = stripZoteroMarkers(result).bytes; warnings.push(`Exported without live Zotero citations: ${error instanceof Error ? error.message : String(error)}`); }
  }
  validateDocx(result);
  return { bytes: result, svgFallbacks: raster.report, zotero, warnings };
}
