// WS-6.3 (fortify plan) — the flux-core error taxonomy. Verbs throw TYPED
// errors; the registry's render adapters map them per surface (CLI exit codes,
// MCP isError results) instead of every wrapper re-inventing string checks.
// The live bridge keeps its own mapping (bridgeServer maps thrown → 400).

export class FluxError extends Error {
  constructor(
    message: string,
    public readonly code: string = "flux-error",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A named thing (figure, canvas, document, reference…) doesn't exist. */
export class NotFoundError extends FluxError {
  constructor(message: string) {
    super(message, "not-found");
  }
}

/** The advisory lock is held (the "deferred: … is locked" contract from
 *  locks.ts). CLI maps this to exit 75 (EX_TEMPFAIL — script-retryable). */
export class LockedError extends FluxError {
  constructor(message: string) {
    super(message, "locked");
  }
}

/** Bad input/arguments/model state the caller can fix. */
export class ValidationError extends FluxError {
  constructor(message: string) {
    super(message, "invalid");
  }
}

/** An external tool (quarto, a recipe interpreter) ran and failed — carries
 *  its exit code and log tail so surfaces can show WHY. */
export class ExternalToolError extends FluxError {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly log = "",
  ) {
    super(message, "external-tool");
  }
}

/** Classify an arbitrary thrown value onto the taxonomy without changing the
 *  message (migration seam: core still throws plain Errors in most places —
 *  the well-known strings map to codes here until each site is converted). */
export function classifyError(e: unknown): FluxError {
  if (e instanceof FluxError) return e;
  const msg = String((e as Error)?.message ?? e);
  if (/deferred: .* is locked|is being written by/i.test(msg)) return new LockedError(msg);
  if (/not found|no such|no figure|no canvas|unknown (figure|canvas|document)/i.test(msg)) return new NotFoundError(msg);
  if (/unsafe .* id|escapes project root|invalid|must be/i.test(msg)) return new ValidationError(msg);
  return new FluxError(msg);
}
