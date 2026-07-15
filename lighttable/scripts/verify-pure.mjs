// Unit tests for electron/lib/pure.cjs — no disk, no Electron, no build step.
import { createRequire } from "node:module";
import { check, section, finish } from "./lib/harness.mjs";

const require = createRequire(import.meta.url);
const pure = require("../electron/lib/pure.cjs");
const { isImage, keyOf, naturalCompare, alignByKeys, bucketFor, thumbKey, wantsThumb, mimeFor, BUCKETS } = pure;

section("naturalCompare");
check("img2 < img10", naturalCompare("img2", "img10") < 0);
check("img10 < img100", naturalCompare("img10", "img100") < 0);
check("img2 < img10 < img100 sort", ["img100", "img2", "img10"].sort(naturalCompare).join(",") === "img2,img10,img100");
check("plain lexicographic for non-digits", naturalCompare("alpha", "beta") < 0);
check("equal strings compare 0", naturalCompare("a1b", "a1b") === 0);
check("huge digit runs don't overflow", naturalCompare("f99999999999999999998", "f99999999999999999999") < 0);
check("zero-padding: numerically equal falls through deterministically", naturalCompare("img007", "img7") !== 0 && Math.sign(naturalCompare("img007", "img7")) === -Math.sign(naturalCompare("img7", "img007")));
check("zero-padded ordering: img007a2 vs img7a10 uses later chunks", naturalCompare("img007a2", "img7a10") < 0);
check("mixed digit/alpha chunks", naturalCompare("a1", "a") > 0);
check("total order is deterministic (sort stable target)", ["b2", "a10", "a2", "a1"].sort(naturalCompare).join(",") === "a1,a2,a10,b2");

section("keyOf / isImage");
check("keyOf strips extension", keyOf("item_007.png") === "item_007");
check("keyOf keeps dotted stems", keyOf("fig.v2.final.png") === "fig.v2.final");
check("keyOf without extension is identity", keyOf("README") === "README");
check("isImage accepts png/jpg/jpeg/webp/gif/avif/bmp/svg case-insensitively", ["a.png", "b.JPG", "c.jpeg", "d.WebP", "e.gif", "f.avif", "g.bmp", "h.SVG"].every(isImage));
check("isImage rejects others", ["a.txt", "b.pdf", "noext", "d.png.md"].every((n) => !isImage(n)));

section("alignByKeys");
{
  const { keys, bySet } = alignByKeys({
    A: ["img_10.png", "img_2.png", "zeta.svg"],
    B: ["img_2.jpg", "img_10.png"],
  });
  check("keys are the natural-sorted union", keys.join(",") === "img_2,img_10,zeta");
  check("arrays aligned: equal lengths across sets", bySet.A.length === 3 && bySet.B.length === 3);
  check("cross-extension alignment (B's img_2.jpg joins A's img_2.png)", bySet.B[0].present && bySet.B[0].file === "img_2.jpg");
  check("missing item marked present:false with null file", bySet.B[2].present === false && bySet.B[2].file === null);
  check("present items carry their basename", bySet.A[2].file === "zeta.svg");
}
{
  const { bySet } = alignByKeys({ A: ["a.png", "a.jpg"] });
  check("duplicate key in one set: first by natural sort wins", bySet.A.length === 1 && bySet.A[0].file === "a.jpg");
}
{
  const { keys, bySet } = alignByKeys({});
  check("empty input -> empty alignment", keys.length === 0 && Object.keys(bySet).length === 0);
}

section("bucketFor / thumbKey");
check("exact bucket", bucketFor(128) === 128);
check("rounds UP between buckets", bucketFor(129) === 192 && bucketFor(200) === 256);
check("above max clamps to largest", bucketFor(4000) === BUCKETS[BUCKETS.length - 1]);
check("thumbKey stable", thumbKey("/a/b.png", 1, 2, 256) === thumbKey("/a/b.png", 1, 2, 256));
check(
  "thumbKey distinct on path/mtime/size/px",
  new Set([
    thumbKey("/a/b.png", 1, 2, 256),
    thumbKey("/a/c.png", 1, 2, 256),
    thumbKey("/a/b.png", 9, 2, 256),
    thumbKey("/a/b.png", 1, 9, 256),
    thumbKey("/a/b.png", 1, 2, 512),
  ]).size === 5
);

section("wantsThumb / mimeFor");
check("raster formats get thumbnails", ["x.png", "x.jpg", "x.webp", "x.bmp"].every(wantsThumb));
check("svg/gif served as originals", !wantsThumb("x.svg") && !wantsThumb("x.gif"));
check("mimeFor svg is image/svg+xml", mimeFor("/p/x.svg") === "image/svg+xml");
check("mimeFor jpg/jpeg is image/jpeg", mimeFor("x.jpg") === "image/jpeg" && mimeFor("x.jpeg") === "image/jpeg");
check("mimeFor unknown falls back to octet-stream", mimeFor("x.weird") === "application/octet-stream");

finish("verify-pure");
