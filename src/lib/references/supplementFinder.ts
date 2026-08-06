// Acquiring a paper's SUPPLEMENTARY files from the open-access route.
//
// The proxy capture engine picks supplements up off the publisher's article page while it's
// already there (electron/proxyFetch.cjs). That leaves the papers whose main text arrived via
// OA, where Flux never visits a publisher page at all. Europe PMC covers those: one request
// returns a ZIP of every supplementary file it holds.
//
// Scope, honestly stated: this works for the Europe PMC OPEN-ACCESS subset only. A paper that
// is merely `inEPMC` (indexed, but subscription — e.g. most of Science) returns 404, and that
// is a normal "nothing here", not a failure.
import { europePmcSupplementsUrl, pmcNumber, type FetchDeps, type PdfInputs } from "./pdfFinder";
import { isSupplementUrl } from "./supplement";
import { unzip } from "./unzip";

export interface FoundSupplement {
  name: string;
  bytes: Uint8Array;
  label?: string;
  url?: string;
  source: string;
}

// Europe PMC's archive bundles the ARTICLE'S OWN FIGURES in with the supplementary files —
// every figure as both .jpg and .gif, plus the occasional CC licence badge. Those are not
// supplements; storing them would bury the real ones under a pile of duplicated artwork.
//
// The filter is deliberately inverted: rather than enumerating what a figure looks like
// (`_f001.jpg`, `-g5.gif`, `_Fig11_ESM.jpg`, `_Tab1_ESM.gif` — naming that varies per
// publisher and defeated a first attempt), it asks what a figure CAN be. Article artwork is
// always an image, and supplementary images are rare and named as supplements. So: keep
// every non-image; keep an image only when its name says supplement.
const IMAGE_EXT = /\.(jpe?g|gif|png|tiff?|bmp|webp|svg)$/i;

/** True if this archive member is the article's own artwork rather than a supplementary file. */
export function isArticleAsset(name: string): boolean {
  return IMAGE_EXT.test(name) && !isSupplementUrl(name);
}

/**
 * Fetch and unpack a paper's supplementary files from Europe PMC.
 * Returns [] for anything not in the OA subset — including on 404, which is the normal
 * answer for a subscription article. Never throws.
 */
export async function fetchEuropePmcSupplements(pmcid: string, deps: FetchDeps): Promise<FoundSupplement[]> {
  if (!pmcNumber(pmcid)) return [];
  const url = europePmcSupplementsUrl(pmcid);
  const got = await deps.getBytes(url).catch(() => null);
  if (!got || got.bytes.length < 64) return [];
  // A ZIP starts "PK\x03\x04"; anything else is an error page served with a 200.
  const b = got.bytes;
  if (!(b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)) return [];
  let entries: { name: string; bytes: Uint8Array }[] = [];
  try {
    entries = await unzip(b);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.bytes.length > 0 && !isArticleAsset(e.name))
    .map((e) => ({ name: e.name.split("/").pop() || e.name, bytes: e.bytes, url, source: "europepmc-suppl" }));
}

/** True if this entry is worth asking Europe PMC about (it needs a PMCID). */
export const canFetchOaSupplements = (x: PdfInputs): boolean => !!pmcNumber(x.pmcid);
