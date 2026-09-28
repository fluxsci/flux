/** One numeric stepping law for labels, Inspector fields and the F-menu. */
export function numericStep(value: number, steps: number, step = 1, factor?: number): number {
  return +(factor && factor > 1 ? value * factor ** steps : value + step * steps).toFixed(6);
}
export function numericFraction(value: number, min: number, max: number, factor?: number): number {
  const fraction = factor && min > 0 && max > min
    ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
  return Math.max(0, Math.min(1, fraction));
}
