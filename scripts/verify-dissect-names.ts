// How the Dissect viewer shortens names (src/lib/dissect/names.ts): a label is a name without what
// it shares with its parent, and never empty by accident. Run via run-verifies.
import { harness } from "./lib/harness.mjs";
import { keyStem, withoutStem, groupLabel, fileLabel, monoWidth } from "../src/lib/dissect/names";

const h = harness("verify-dissect-names");
const stem = "sd-early-rem-state-barcodes-alnair-e1-d";

h.section("the plot's own name");
h.eq(keyStem(`synaptic_signature_of_sleep/sd_early_predict/${stem}`), stem, "a key's last segment is the plot's name");
h.eq(keyStem("growth"), "growth", "a key with no folder is its own name");
h.eq(keyStem("a/b/"), "b", "a trailing slash is ignored");

h.section("dropping a shared front");
h.eq(withoutStem(`${stem}-rem-sorted`, stem), "rem-sorted", "what follows the stem and a separator is the label");
h.eq(withoutStem(`${stem}--source_data`, stem), "source_data", "several separators go together");
h.eq(withoutStem(`${stem}_v2`, stem), "v2", "underscore separates too");
h.eq(withoutStem(`${stem}.raw`, stem), "raw", "and a dot");
h.eq(withoutStem(stem, stem), "", "the stem alone leaves nothing");
h.eq(withoutStem("plotter", "plot"), "plotter", "a word that merely starts with the stem is left whole");
h.eq(withoutStem("Growth-Curves-by-site", "growth-curves"), "by-site", "case does not matter for the comparison");
h.eq(withoutStem("by_subject", stem), "by_subject", "a name that does not share the front is left whole");
h.eq(withoutStem("anything", ""), "anything", "no stem, no change");

h.section("groups and files");
h.eq(groupLabel(`${stem}-five-states`, stem), "five-states", "a group is labelled by what tells it apart");
h.eq(groupLabel(stem, stem), stem, "a group named exactly after the plot keeps its name");
h.eq(groupLabel("_stats", stem), "_stats", "an ordinary group keeps its name");
const group = `${stem}-rem-sorted`;
h.eq(fileLabel(`${group}--source_data.csv`, group, stem), { label: "source_data", ext: "csv" }, "a file drops its group's name first");
h.eq(fileLabel(`${group}.png`, group, stem), { label: "", ext: "png" }, "a file named after its group is that group's own picture");
h.eq(fileLabel(`${stem}.svg`, "", stem), { label: "", ext: "svg" }, "…and the plot's own picture at the root");
h.eq(fileLabel(`${stem}-notes.txt`, "", stem), { label: "notes", ext: "txt" }, "a loose file drops the plot's name");
h.eq(fileLabel("summary.csv", "_stats", stem), { label: "summary", ext: "csv" }, "an ordinary file is its name without the extension");
h.eq(fileLabel(`${stem}-extra.csv`, "by_subject", stem), { label: "extra", ext: "csv" }, "a file in an ordinary group still drops the plot's name");
h.eq(fileLabel("README", "", stem), { label: "README", ext: "" }, "no extension, no trouble");
h.eq(fileLabel("archive.tar.gz", "", stem), { label: "archive.tar", ext: "gz" }, "only the last extension is the extension");
h.eq(fileLabel(".hidden", "", stem).label.length > 0 || fileLabel(".hidden", "", stem).ext === "hidden", true, "a dotfile is not lost");

h.section("laying out without measuring");
h.ok(monoWidth("rem-sorted") < monoWidth("anatomy-sorted") && monoWidth("") === 0, "a longer label is wider; nothing is nothing");
h.ok(monoWidth("abc", 9.5, 0.08) > monoWidth("abc", 9.5), "letter-spacing adds width");

await h.done();
