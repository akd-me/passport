/** Largest `countIds` cap a reader honours; the readers own the quota, so they clamp (R1-19). */
export const MAX_COUNT_CAP = 10_000;

/** `cap` clamped to `[0, MAX_COUNT_CAP]`; `Infinity` means the maximum, NaN means 0. */
export function clampCap(cap: number): number {
  return Number.isNaN(cap) ? 0 : Math.min(MAX_COUNT_CAP, Math.max(0, Math.floor(cap)));
}
