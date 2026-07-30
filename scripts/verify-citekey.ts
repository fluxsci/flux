// Pure gate: the deterministic citekey scheme (Better BibTeX default emulation,
// 2026-07-29). Pins the format contract — `auth.lower + shorttitle(3,3) + year` —
// plus the safety properties the scheme must keep regardless of style: diacritic
// folding, case-insensitive collision suffixing (items/<key>/ dirs on case-folding
// filesystems), length cap that never drops the year, and dupeSignature stability.
//   Run: npx tsx scripts/verify-citekey.ts
import { makeCitekey, dupeSignature } from "../src/lib/references/citekey";

let fails = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
  if (!cond) fails++;
};

// --- the BBT default format -------------------------------------------------------------
{
  const k = makeCitekey({ authors: ["Müller"], year: "2024", title: "The neural basis of decision making" });
  ok(k === "mullerNeuralBasisDecision2024", `BBT shape: author folded+lower, 3 Capitalized title words, year last (${k})`);
}
{
  const k = makeCitekey({ authors: ["Watson"], year: "1953", title: "Molecular structure of nucleic acids" });
  ok(k === "watsonMolecularStructureNucleic1953", `skip-words excluded from the 3-word window (${k})`);
}
{
  const k = makeCitekey({ authors: ["Smith"], year: "2020", title: "fMRI evidence for DNA repair" });
  ok(k === "smithFMRIEvidenceDNA2020", `inner word case preserved — acronyms survive capitalization (${k})`);
}
{
  const k = makeCitekey({ authors: ["Ng"], year: "2019", title: "Sleep" });
  ok(k === "ngSleep2019", `short titles use what exists (${k})`);
}
{
  const k = makeCitekey({ authors: ["van der Berg"], year: "2021", title: "Cortical maps" });
  ok(k === "vanderbergCorticalMaps2021", `multi-word family names collapse (${k})`);
}
{
  ok(makeCitekey({ authors: [], year: "2020", title: "Untitled manuscript draft" }) === "anonUntitledManuscriptDraft2020", "no author -> anon");
  ok(makeCitekey({ authors: ["Lee"], year: "", title: "Notes on things" }) === "leeNotesThings", "no year -> omitted");
  ok(makeCitekey({ authors: [], year: "", title: "" }) === "anon", "nothing at all -> anon (never empty)");
}

// --- collision suffixing: case-INSENSITIVE (dir safety on macOS/Windows) -----------------
{
  const taken = new Set(["smithNeural2020"]);
  const k = makeCitekey({ authors: ["Smith"], year: "2020", title: "Neural" }, taken);
  ok(k === "smithNeural2020a", `exact collision suffixes (${k})`);
  // A key differing ONLY in case must also suffix — it would share items/<key>/ on APFS/NTFS.
  const taken2 = new Set(["smithneural2020"]);
  const k2 = makeCitekey({ authors: ["Smith"], year: "2020", title: "Neural" }, taken2);
  ok(k2 === "smithNeural2020a", `case-insensitive collision suffixes (${k2})`);
  // Suffix chain: a, b, …
  const taken3 = new Set(["smithNeural2020", "smithNeural2020a"]);
  const k3 = makeCitekey({ authors: ["Smith"], year: "2020", title: "Neural" }, taken3);
  ok(k3 === "smithNeural2020b", `suffix chain advances (${k3})`);
}

// --- length cap keeps the year ------------------------------------------------------------
{
  const long = "Supercalifragilisticexpialidocious hippopotomonstrosesquippedaliophobia electroencephalographically";
  const k = makeCitekey({ authors: ["Bannisterworthingtonshire"], year: "2024", title: long });
  ok(k.length <= 60 + 2, `capped length (${k.length})`); // +2 headroom for a collision suffix
  ok(/2024$/.test(k), `year survives the cap (${k})`);
}

// --- determinism -------------------------------------------------------------------------
{
  const e = { authors: ["Kandel"], year: "2000", title: "Principles of neural science" };
  ok(makeCitekey(e) === makeCitekey(e), "same entry -> same key, always");
}

// --- dupeSignature unchanged by the key-format change ------------------------------------
{
  const sig1 = dupeSignature({ authors: ["Ng, A"], year: "2019", title: "Hippocampal replay during sleep" });
  const sig2 = dupeSignature({ authors: ["Ng, A"], year: "2019", title: "Hippocampal Replay During SLEEP!" });
  ok(!!sig1 && sig1 === sig2, "signature is case/punct-invariant");
  ok(dupeSignature({ authors: [], year: "", title: "Short" }) === null, "too little to match -> null");
}

console.log(`\n##VERIFY## ${JSON.stringify({ name: "citekey", pass: fails === 0, fails })}`);
if (fails) process.exit(1);
