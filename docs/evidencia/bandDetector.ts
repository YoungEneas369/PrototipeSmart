// Carcass-seeded matched-band detector for shelves/dividers on a RECTIFIED image.
// Pure TypeScript, zero deps, offline. Key idea: the 4 clicked corners already tell us where the
// carcass side boards are (outer 18 mm bands), so we LEARN the melamine front-edge appearance from
// them, and search for bands of the KNOWN thickness (e / x_f, e / y_f) that match it and are flanked
// on both sides by non-board pixels (cavity, books, shadows).
export interface Seg { position: number; start: number; end: number }
export interface Detection { vDividers: Seg[]; hShelves: Seg[]; refLum: number; sigma: number; interiorMatch: number }

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const S = W + 1, I = new Float64Array(S * (H + 1)), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) { let a = 0; for (let x = 0; x < W; x++) { a += src[y * W + x]; I[(y + 1) * S + x + 1] = I[y * S + x + 1] + a; } }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      out[y * W + x] = (I[y1 * S + x1] - I[y0 * S + x1] - I[y1 * S + x0] + I[y0 * S + x0]) / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}
const median = (a: number[]) => { const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

/** 1D matched filter: band of width t "on", with BOTH flanks "off". Returns band centers (px). */
function bandPeaks(cov: Float32Array, t: number, lo: number, hi: number, minCov: number, minContrast: number): number[] {
  const n = cov.length, tt = Math.max(2, Math.round(t)), g = Math.ceil(tt / 2), P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) P[i + 1] = P[i] + cov[i];
  const mean = (a: number, b: number) => { a = Math.max(0, a); b = Math.min(n, b); return b > a ? (P[b] - P[a]) / (b - a) : 0; };
  const c: { c: number; s: number }[] = [];
  for (let i = Math.max(0, lo); i + tt <= Math.min(n, hi); i++) {
    const inside = mean(i, i + tt), flank = Math.max(mean(i - g - 2 * tt, i - g), mean(i + tt + g, i + tt + g + 2 * tt));
    if (inside >= minCov && inside - flank >= minContrast) c.push({ c: i + tt / 2, s: inside - flank });
  }
  c.sort((a, b) => b.s - a.s);
  const out: number[] = [];
  for (const k of c) if (out.every(o => Math.abs(o - k.c) >= 3 * tt)) out.push(k.c);
  return out.sort((a, b) => a - b);
}

/** gray: rectified luminance, row 0 = top. tRatioX = e/x_f, tRatioY = e/y_f.
 *  Output segments are in INTERIOR-normalized space (contracts.ts NormalizedSegment), v = 0 floor. */
export function detectStructure(gray: Float32Array, W: number, H: number, tRatioX: number, tRatioY: number): Detection {
  const tV = tRatioX * W, tH = tRatioY * H, bg = boxBlur(gray, W, H, Math.max(4, Math.round(W / 8)));
  const nrm = new Float32Array(W * H);
  for (let i = 0; i < nrm.length; i++) nrm[i] = gray[i] / (bg[i] + 1e-3); // flat-field: kills vignetting/gradients
  const seed: number[] = [], a = Math.floor(tV * 0.2), b = Math.max(a + 1, Math.ceil(tV * 0.8));
  for (let y = Math.round(H * 0.1); y < H * 0.9; y++) for (let x = a; x < b; x++) seed.push(nrm[y * W + x], nrm[y * W + W - 1 - x]);
  const ref = median(seed), sigma = Math.max(0.06, 3.7 * median(seed.map(v => Math.abs(v - ref)))), on = new Uint8Array(W * H);
  for (let i = 0; i < on.length; i++) on[i] = Math.abs(nrm[i] - ref) < 1.18 * sigma ? 1 : 0;
  const toIntU = (px: number) => (px / W - tRatioX) / (1 - 2 * tRatioX), toIntV = (row: number) => (1 - row / H - tRatioY) / (1 - 2 * tRatioY);
  const yLo = Math.ceil(tH * 1.5), yHi = Math.floor(H - tH * 1.5), colCov = new Float32Array(W);
  for (let x = 0; x < W; x++) { let c = 0; for (let y = yLo; y < yHi; y++) c += on[y * W + x]; colCov[x] = c / (yHi - yLo); }
  const snap = (v: number) => (v < 0.06 ? 0 : v > 0.94 ? 1 : v);
  // Structural prior: an auto-detected divider must be a continuous board touching BOTH the top and
  // the base (books/objects never do). Partial dividers are left to the user (1 tap in the UI).
  const vDividers: Seg[] = bandPeaks(colCov, tV, Math.ceil(tV * 2), Math.floor(W - tV * 2), 0.6, 0.25).map(cx => {
    const x0 = Math.round(cx - tV * 0.3), x1 = Math.round(cx + tV * 0.3);
    let best: [number, number] = [yLo, yLo], s = -1, last = -1;
    for (let y = yLo; y < yHi; y++) {
      let c = 0; for (let x = x0; x <= x1; x++) c += on[y * W + x];
      if (c >= 0.6 * (x1 - x0 + 1)) { if (s < 0) s = y; last = y; }
      else if (s >= 0 && y - last > tH) { if (last - s > best[1] - best[0]) best = [s, last]; s = -1; }
    }
    if (s >= 0 && last - s > best[1] - best[0]) best = [s, last];
    if (best[0] - yLo > 2 * tH || yHi - 1 - best[1] > 2 * tH) return null;
    return { position: toIntU(cx), start: snap(toIntV(best[1])), end: snap(toIntV(best[0])) };
  }).filter((d): d is Seg => d !== null);
  const cuts = [0, ...vDividers.map(d => d.position), 1], pxOf = (u: number) => (tRatioX + u * (1 - 2 * tRatioX)) * W, raw: Seg[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) { // bay-by-bay horizontal search
    const c0 = Math.round(pxOf(cuts[k]) + tV), c1 = Math.round(pxOf(cuts[k + 1]) - tV);
    if (c1 - c0 < 4) continue;
    const rowCov = new Float32Array(H);
    for (let y = 0; y < H; y++) { let c = 0; for (let x = c0; x < c1; x++) c += on[y * W + x]; rowCov[y] = c / (c1 - c0); }
    for (const cy of bandPeaks(rowCov, tH, Math.ceil(tH * 2), Math.floor(H - tH * 2), 0.55, 0.25)) raw.push({ position: toIntV(cy), start: cuts[k], end: cuts[k + 1] });
  }
  raw.sort((p, q) => p.start - q.start);
  const hShelves: Seg[] = [];
  for (const s of raw) { // merge collinear shelves across bays (mathEngine re-splits at dividers)
    const m = hShelves.find(h => Math.abs(h.end - s.start) < 1e-9 && Math.abs(h.position - s.position) < 0.02);
    if (m) { m.end = s.end; m.position = (m.position + s.position) / 2; } else hShelves.push({ ...s });
  }
  // Confidence: if the learned board model also matches most of the interior, it cannot discriminate
  // boards from cavity (white-on-white) -> UI must say "detección no confiable, traza manual".
  let onIn = 0, nIn = 0;
  for (let y = yLo; y < yHi; y++) for (let x = Math.ceil(tV * 1.5); x < W - tV * 1.5; x++) { onIn += on[y * W + x]; nIn++; }
  return { vDividers, hShelves, refLum: ref, sigma, interiorMatch: onIn / nIn };
}
