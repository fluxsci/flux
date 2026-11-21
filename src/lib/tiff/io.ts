/**
 * The only way bytes come into the TIFF reader. Pure: no DOM, no Node.
 *
 * Engines inject a `RangedSource`: Node positional reads (flux-core, the conversion child), `File.slice` in a
 * renderer, memory in the gates. The reader never asks for the whole file, so a 6 GB movie costs what its
 * planes cost.
 */

export interface RangedSource {
  /** File size in bytes. */
  size: number;
  /** Exactly `length` bytes from `offset` (the reader never asks past `size`). */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** A source over bytes already in memory (gates, small drops). Reads are copies: a reader owns what it gets and may
 *  transform it in place, as it may with a fresh read from disk. */
export function memorySource(bytes: Uint8Array): RangedSource {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength) throw new TiffError("truncated", `read of ${length} bytes at ${offset} is past the end of the file (${bytes.byteLength} bytes)`);
      return bytes.slice(offset, offset + length);
    },
  };
}

/**
 * Why a file cannot be read: `code` is stable (gates and the asking surface switch on it), `message` names the
 * cause in words and `hint` the way out.
 */
export class TiffError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(code: string, message: string, hint?: string) {
    super(hint ? `${message}. ${hint}` : message);
    this.name = "TiffError";
    this.code = code;
    this.hint = hint;
  }
}

/** Thrown when a signal aborts work; `name` is "AbortError" like the platform's own. */
export class TiffAbortError extends Error {
  constructor() { super("The TIFF conversion was cancelled"); this.name = "AbortError"; }
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new TiffAbortError();
}

/** Typed arrays are read in the platform's byte order; every engine Flux runs on is little-endian. */
export const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
