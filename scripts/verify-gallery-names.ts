import assert from "node:assert/strict";
import { galleryNameSimilarity as similar } from "../src/lib/plot/galleryNames";

assert.equal(similar("rate_NREM_subject01.svg", "rate_NREM_subject03.svg"), 1);
assert(similar("rate_NREM_subject01.svg", "rate_REM_subject02.svg") > 0);
assert.equal(similar("rate_NREM_subject01.svg", "unrelated/control.svg"), 0);
assert.equal(similar("result-00.svg", "result-11.png"), 1);
assert.equal(similar("same-folder/rate.svg", "same-folder/control.svg"), 0);
assert.equal(similar("CalciumTrace01.svg", "calcium_trace02.svg"), 1);
assert.equal(similar("动物_结果_01.svg", "动物_结果_02.svg"), 1);
assert.equal(similar("123.svg", "456.svg"), 0);
assert.equal(similar("123.svg", "123.svg"), 1);
assert.equal(similar("result.svg", "resulting.svg"), 0);
assert.equal(similar("rate_subject_01.svg", "rate_control_02.svg"), 0);
console.log("GALLERY NAMES VERIFY: PASS (11 checks)");
