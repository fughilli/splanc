/**
 * Allocation-free order statistics over a Float64Array prefix (the capture
 * loop's per-frame medians: tracker motion and neighbourhood residuals, the
 * blob-population monitor). Same values as sorting, in O(n).
 */

/** The median of s[0..n) (reorders it). */
export function medianInPlace(s: Float64Array, n: number): number | null {
  if (n === 0) return null;
  const m = n >> 1;
  const hi = select(s, n, m);
  if (n % 2) return hi;
  // The lower middle: the largest of s[0..m) (select partitioned it below m).
  let lo = -Infinity;
  for (let i = 0; i < m; i++) if (s[i]! > lo) lo = s[i]!;
  return (lo + hi) / 2;
}

/** Hoare quickselect: the k-th smallest of s[0..n), leaving s[0..k) ≤ it ≤ s(k..n). */
export function select(s: Float64Array, n: number, k: number): number {
  let l = 0;
  let r = n - 1;
  while (r > l) {
    const pivot = s[(l + r) >> 1]!;
    let i = l;
    let j = r;
    while (i <= j) {
      while (s[i]! < pivot) i++;
      while (s[j]! > pivot) j--;
      if (i <= j) {
        const t = s[i]!;
        s[i] = s[j]!;
        s[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) r = j;
    else if (k >= i) l = i;
    else break;
  }
  return s[k]!;
}
