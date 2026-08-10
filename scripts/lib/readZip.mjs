// Minimal ZIP entry reader — enough to look inside a signed .xpi, and no more.
//
// Exists so verify-extension can check the ARTIFACT THAT SHIPS rather than something standing
// in for it. The committed .xpi is the only way a Firefox user on a checkout gets web capture,
// so "is it actually built from this source?" has to be answered from its own bytes; a sidecar
// of hashes written at signing time would be one more thing that can quietly drift, which is
// the exact failure mode this whole area has already had once.
//
// Dependency-free (Windows port: no shelling out to `unzip`), no ZIP64 — an .xpi is ~40KB.
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

/**
 * Read every file entry: Map<name, Buffer>. Throws on anything it doesn't understand rather
 * than returning a partial archive — a gate must not silently check fewer files than it says.
 */
export function readZip(buf) {
  // The end-of-central-directory record sits last, after an optional trailing comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
    }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error(`corrupt central directory at entry ${n}`);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory entry

    // The local header repeats the name/extra with its OWN lengths — the data starts after
    // those, not after the central-directory copy.
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressed);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`${name}: unsupported compression method ${method}`);
  }
  return out;
}
