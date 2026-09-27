/** Only a definitive client response may become a durable no-copy result. */
export function definitiveHttpAbsence(status: number): boolean { return status === 404 || status === 410; }
/** All other failures (including authentication and malformed requests) are
 * non-definitive for a scientific paper: never enter durable absence ledgers. */
export function transientHttpStatus(status: number): boolean { return !definitiveHttpAbsence(status); }
export function isTransientNetworkError(error?: string): boolean {
  if (!error) return false;
  const match = /^HTTP\s+(\d{3})\b/i.exec(error);
  return !match || transientHttpStatus(Number(match[1]));
}
