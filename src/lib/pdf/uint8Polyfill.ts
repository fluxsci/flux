// Compatibility shim for the bleeding-edge JS methods pdf.js 6.x assumes but Electron
// 33's bundled Chromium 130 lacks (system Chrome 150 has them → headless tests render,
// but the real app throws "… is not a function"). pdf.js targets ~Chrome 140+. Covers:
//   • Uint8Array.prototype.toHex / toBase64  +  static Uint8Array.fromBase64 / fromHex
//     (TC39 "Uint8Array to/from base64 & hex", Chrome 140)
//   • Map/WeakMap.prototype.getOrInsert / getOrInsertComputed  ("upsert" proposal) —
//     pdf.js uses these ~27× on CORE paths, so WITHOUT this every PDF fails on 130.
// Loaded in BOTH the main thread (PdfView.svelte) and the pdf.js worker (pdfjsWorker.ts).
// Every patch is guarded → a no-op where the natives exist. btoa/atob exist in Window +
// WorkerGlobalScope.
/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Map/WeakMap upsert proposal (getOrInsert / getOrInsertComputed) ---------
for (const Ctor of [Map, WeakMap] as const) {
  const mp = Ctor.prototype as any;
  if (typeof mp.getOrInsert !== "function") {
    mp.getOrInsert = function (this: any, key: any, value: any) {
      if (this.has(key)) return this.get(key);
      this.set(key, value);
      return value;
    };
  }
  if (typeof mp.getOrInsertComputed !== "function") {
    mp.getOrInsertComputed = function (this: any, key: any, callbackFn: (k: any) => any) {
      if (this.has(key)) return this.get(key);
      const v = callbackFn(key);
      this.set(key, v);
      return v;
    };
  }
}

// --- Uint8Array to/from base64 & hex -----------------------------------------
const U8 = Uint8Array as any;
const proto = Uint8Array.prototype as any;

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, "0");

if (typeof proto.toHex !== "function") {
  proto.toHex = function toHex(this: Uint8Array): string {
    let s = "";
    for (let i = 0; i < this.length; i++) s += HEX[this[i]];
    return s;
  };
}

if (typeof U8.fromHex !== "function") {
  U8.fromHex = function fromHex(str: string): Uint8Array {
    const s = String(str).replace(/\s+/g, "");
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  };
}

if (typeof proto.toBase64 !== "function") {
  proto.toBase64 = function toBase64(this: Uint8Array, opts?: { alphabet?: string; omitPadding?: boolean }): string {
    let bin = "";
    const CH = 0x8000; // chunk so String.fromCharCode.apply doesn't overflow the arg limit
    for (let i = 0; i < this.length; i += CH) {
      bin += String.fromCharCode.apply(null, this.subarray(i, i + CH) as unknown as number[]);
    }
    let b64 = btoa(bin);
    if (opts?.alphabet === "base64url") b64 = b64.replace(/\+/g, "-").replace(/\//g, "_");
    if (opts?.omitPadding) b64 = b64.replace(/=+$/, "");
    return b64;
  };
}

if (typeof U8.fromBase64 !== "function") {
  U8.fromBase64 = function fromBase64(str: string, opts?: { alphabet?: string }): Uint8Array {
    let s = String(str);
    if (opts?.alphabet === "base64url") s = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
}

// --- Response/Blob.prototype.bytes (Chrome 133) -------------------------------
// pdf.js 6 loads its WASM (quickjs-eval font compiler, jbig2, openjpeg) via
// `(await fetch(url)).bytes()`. Without it, `t.bytes is not a function` → WASM fails →
// embedded CFF fonts can't compile → they get SUBSTITUTED, and a font whose name matches
// /Symbol/ (e.g. ITCSymbolStd) becomes the Adobe Symbol font → Latin text renders Greek.
if (typeof Response !== "undefined" && typeof (Response.prototype as any).bytes !== "function") {
  (Response.prototype as any).bytes = function (this: Response): Promise<Uint8Array> {
    return this.arrayBuffer().then((b) => new Uint8Array(b));
  };
}
if (typeof Blob !== "undefined" && typeof (Blob.prototype as any).bytes !== "function") {
  (Blob.prototype as any).bytes = function (this: Blob): Promise<Uint8Array> {
    return this.arrayBuffer().then((b) => new Uint8Array(b));
  };
}

// --- Math.sumPrecise (Chrome 137) --------------------------------------------
if (typeof (Math as any).sumPrecise !== "function") {
  (Math as any).sumPrecise = function (iterable: Iterable<number>): number {
    let sum = 0;
    for (const x of iterable) sum += x;
    return sum;
  };
}

export {}; // module marker (side-effect import)
