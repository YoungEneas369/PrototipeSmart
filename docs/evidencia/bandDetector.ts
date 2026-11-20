// Carcass-seeded, chroma+luminance, parallax-aware matched-band detector on a RECTIFIED image.
// Pure TypeScript, zero deps, 100% offline.
// Key ideas (v2.1 Rev. 2):
//  1. Flat-field normalized luminance + illumination-invariant chromaticity (separates wood/melamine from gray shadows).
//  2. 4-border carcass seeding (median + MAD) for tolerance to corner-click jitter, plus optional 1-click eyedropper.
//  3. Parallax-aware one-sided zero-gap edge anchoring: below camera horizon, shelves expose their top surface
//     above the front edge (anchor on bottom drop); above horizon, underside extends below (anchor on top drop).
//     Same geometry horizontally for left/right vertical dividers.
export interface Seg { position: number; start: number; end: number }

export interface DetectOptions {
  /** Normalized optical horizon height in [0, 1] (0 = floor, 1 = top). Default 0.5 (mid-height protocol). */
  horizonV?: number;
  /** Optional 1-click eyedropper point in exterior normalized [0, 1]^2 (u: 0 left -> 1 right, v: 0 floor -> 1 top). */
  seedPoint?: { u: number; v: number };
  /** Enable parallax-aware one-sided edge anchoring (default true). */
  parallaxAware?: boolean;
}

export interface Detection {
  vDividers: Seg[];
  hShelves: Seg[];
  refLum: number;
  sigma: number;
  interiorMatch: number;
  /** Overall confidence in [0, 1]. If < 0.5, UI should warn and guide quick manual tracing. */
  confidence: number;
}

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const S = W + 1, I = new Float64Array(S * (H + 1)), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let a = 0;
    for (let x = 0; x < W; x++) {
      a += src[y * W + x];
      I[(y + 1) * S + x + 1] = I[y * S + x + 1] + a;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      out[y * W + x] = (I[y1 * S + x1] - I[y0 * S + x1] - I[y1 * S + x0] + I[y0 * S + x0]) / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = Float64Array.from(a).sort();
  return s[s.length >> 1];
}

function mad(a: number[], med: number): number {
  return median(a.map(v => Math.abs(v - med)));
}

/**
 * 1D parallax-aware front-edge detector on a coverage profile cov[0..n-1].
 * Uses zero-gap adjacent flanks so the unique peak aligns strictly with the 18 mm front face
 * even when perspective parallax exposes 2-8x wider top/under/side board surfaces.
 */
function bandPeaks(
  cov: Float32Array,
  t: number,
  lo: number,
  hi: number,
  centerIdx: number,
  minCov: number,
  minContrast: number,
  parallaxAware: boolean,
): number[] {
  const n = cov.length;
  const tt = Math.max(2, Math.round(t));
  const fw = Math.max(6, Math.round(2.5 * tt));
  const deadZone = 0.04 * n;
  const nmsRadius = Math.max(4 * tt, Math.round(0.055 * n));
  const maxParallaxRun = Math.max(5 * tt, Math.round(0.24 * n));
  const P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) P[i + 1] = P[i] + cov[i];
  const mean = (a: number, b: number) => {
    const aa = Math.max(0, a), bb = Math.min(n, b);
    return bb > aa ? (P[bb] - P[aa]) / (bb - aa) : 0;
  };

  const candidates: { c: number; s: number }[] = [];
  const start = Math.max(0, lo), end = Math.min(n, hi);
  for (let i = start; i + tt <= end; i++) {
    const inside = mean(i, i + tt);
    if (inside < minCov) continue;
    const center = i + tt / 2;
    const flankBefore = mean(i - fw, i);
    const flankAfter = mean(i + tt, i + tt + fw);
    let contrast = 0;

    if (!parallaxAware || Math.abs(center - centerIdx) <= deadZone) {
      contrast = inside - Math.max(flankBefore, flankAfter);
    } else if (center > centerIdx) {
      // Below horizon (or right of center): depth surface extends toward smaller indices (before i).
      // Front face is anchored at the sharp drop immediately AFTER i + tt.
      contrast = inside - flankAfter;
      // Reject giant solid background regions extending further than physically plausible parallax.
      if (i - maxParallaxRun >= start && mean(i - maxParallaxRun, i) >= minCov * 0.85) continue;
    } else {
      // Above horizon (or left of center): depth surface extends toward larger indices (after i + tt).
      // Front face is anchored at the sharp rise immediately BEFORE i.
      contrast = inside - flankBefore;
      if (i + tt + maxParallaxRun <= end && mean(i + tt, i + tt + maxParallaxRun) >= minCov * 0.85) continue;
    }

    if (contrast >= minContrast) candidates.push({ c: center, s: contrast });
  }

  candidates.sort((a, b) => b.s - a.s);
  const out: number[] = [];
  for (const k of candidates) {
    if (out.every(o => Math.abs(o - k.c) >= nmsRadius)) out.push(k.c);
  }
  return out.sort((a, b) => a - b);
}

function detectFromChannels(
  gray: Float32Array,
  c1: Float32Array | null,
  c2: Float32Array | null,
  W: number,
  H: number,
  tRatioX: number,
  tRatioY: number,
  opts: DetectOptions = {},
): Detection {
  const horizonV = opts.horizonV ?? 0.5;
  const parallaxAware = opts.parallaxAware ?? true;
  const tV = tRatioX * W, tH = tRatioY * H;

  const bg = boxBlur(gray, W, H, Math.max(4, Math.round(W / 8)));
  const nrm = new Float32Array(W * H);
  for (let i = 0; i < nrm.length; i++) nrm[i] = gray[i] / (bg[i] + 1e-3);

  const seedL: number[] = [], seedC1: number[] = [], seedC2: number[] = [];
  const pushPx = (idx: number) => {
    seedL.push(nrm[idx]);
    if (c1 && c2) { seedC1.push(c1[idx]); seedC2.push(c2[idx]); }
  };

  if (opts.seedPoint) {
    // Optional 1-click eyedropper override: sample small patch on user-clicked melamine front edge.
    const cx = Math.round(opts.seedPoint.u * W);
    const cy = Math.round((1 - opts.seedPoint.v) * H);
    const rx = Math.max(1, Math.round(tV * 0.4)), ry = Math.max(1, Math.round(tH * 0.4));
    for (let y = Math.max(0, cy - ry); y <= Math.min(H - 1, cy + ry); y++) {
      for (let x = Math.max(0, cx - rx); x <= Math.min(W - 1, cx + rx); x++) pushPx(y * W + x);
    }
  } else {
    // 4-border carcass seeding (left, right, top, bottom) -> median tolerates single-edge click jitter.
    const ax = Math.floor(tV * 0.25), bx = Math.max(ax + 1, Math.ceil(tV * 0.85));
    for (let y = Math.round(H * 0.12); y < H * 0.88; y++) {
      for (let x = ax; x < bx; x++) {
        pushPx(y * W + x);
        pushPx(y * W + (W - 1 - x));
      }
    }
    const ay = Math.floor(tH * 0.25), by = Math.max(ay + 1, Math.ceil(tH * 0.85));
    for (let x = Math.round(W * 0.12); x < W * 0.88; x++) {
      for (let y = ay; y < by; y++) {
        pushPx(y * W + x);
        pushPx((H - 1 - y) * W + x);
      }
    }
  }

  const refL = median(seedL);
  const sigL = Math.max(0.065, 3.6 * mad(seedL, refL));
  const useChroma = c1 !== null && c2 !== null && seedC1.length > 0;
  const refC1 = useChroma ? median(seedC1) : 0;
  const refC2 = useChroma ? median(seedC2) : 0;
  const sigC1 = useChroma ? Math.max(0.03, 3.6 * mad(seedC1, refC1)) : 1;
  const sigC2 = useChroma ? Math.max(0.03, 3.6 * mad(seedC2, refC2)) : 1;

  const on = new Uint8Array(W * H);
  const thresh2 = 1.25 * 1.25;
  for (let i = 0; i < on.length; i++) {
    const dl = (nrm[i] - refL) / sigL;
    if (!useChroma) {
      on[i] = dl * dl < thresh2 ? 1 : 0;
    } else {
      const dc1 = (c1![i] - refC1) / sigC1;
      const dc2 = (c2![i] - refC2) / sigC2;
      // Weighted Mahalanobis distance: luminance + chroma jointly separate wood & colored boards from shadows.
      on[i] = dl * dl + 1.2 * (dc1 * dc1 + dc2 * dc2) < thresh2 * 1.35 ? 1 : 0;
    }
  }

  const toIntU = (px: number) => (px / W - tRatioX) / (1 - 2 * tRatioX);
  const toIntV = (row: number) => (1 - row / H - tRatioY) / (1 - 2 * tRatioY);
  const yLo = Math.ceil(tH * 1.5), yHi = Math.floor(H - tH * 1.5);
  const colCov = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = yLo; y < yHi; y++) c += on[y * W + x];
    colCov[x] = c / Math.max(1, yHi - yLo);
  }

  const snap = (v: number) => (v < 0.06 ? 0 : v > 0.94 ? 1 : v);
  const vDividers: Seg[] = bandPeaks(
    colCov, tV, Math.ceil(tV * 2), Math.floor(W - tV * 2), W * 0.5, 0.58, 0.25, parallaxAware,
  ).map(cx => {
    const x0 = Math.max(0, Math.round(cx - tV * 0.3)), x1 = Math.min(W - 1, Math.round(cx + tV * 0.3));
    let best: [number, number] = [yLo, yLo], s = -1, last = -1;
    for (let y = yLo; y < yHi; y++) {
      let c = 0;
      for (let x = x0; x <= x1; x++) c += on[y * W + x];
      if (c >= 0.6 * (x1 - x0 + 1)) {
        if (s < 0) s = y;
        last = y;
      } else if (s >= 0 && y - last > tH) {
        if (last - s > best[1] - best[0]) best = [s, last];
        s = -1;
      }
    }
    if (s >= 0 && last - s > best[1] - best[0]) best = [s, last];
    // Structural prior: auto-detected dividers must be continuous from top to base (rejects books).
    if (best[0] - yLo > 2 * tH || yHi - 1 - best[1] > 2 * tH) return null;
    return { position: toIntU(cx), start: snap(toIntV(best[1])), end: snap(toIntV(best[0])) };
  }).filter((d): d is Seg => d !== null);

  const cuts = [0, ...vDividers.map(d => d.position), 1];
  const pxOf = (u: number) => (tRatioX + u * (1 - 2 * tRatioX)) * W;
  const horizonRow = (1 - horizonV) * H;
  const raw: Seg[] = [];

  for (let k = 0; k + 1 < cuts.length; k++) {
    const c0 = Math.round(pxOf(cuts[k]) + tV), c1 = Math.round(pxOf(cuts[k + 1]) - tV);
    if (c1 - c0 < 4) continue;
    const rowCov = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let c = 0;
      for (let x = c0; x < c1; x++) c += on[y * W + x];
      rowCov[y] = c / (c1 - c0);
    }
    for (const cy of bandPeaks(
      rowCov, tH, Math.ceil(tH * 2), Math.floor(H - tH * 2), horizonRow, 0.55, 0.25, parallaxAware,
    )) {
      raw.push({ position: toIntV(cy), start: cuts[k], end: cuts[k + 1] });
    }
  }

  raw.sort((p, q) => p.start - q.start);
  const hShelves: Seg[] = [];
  for (const s of raw) {
    const m = hShelves.find(h => Math.abs(h.end - s.start) < 1e-9 && Math.abs(h.position - s.position) < 0.02);
    if (m) {
      m.end = s.end;
      m.position = (m.position + s.position) / 2;
    } else {
      hShelves.push({ ...s });
    }
  }

  let onIn = 0, nIn = 0;
  for (let y = yLo; y < yHi; y++) {
    for (let x = Math.ceil(tV * 1.5); x < W - tV * 1.5; x++) {
      onIn += on[y * W + x];
      nIn++;
    }
  }
  const interiorMatch = nIn > 0 ? onIn / nIn : 1;
  // Confidence drops sharply once >50% of the interior matches the carcass appearance (white-on-white).
  const confidence = interiorMatch >= 0.5
    ? Math.max(0, Math.min(0.45, (1 - interiorMatch) * 0.8))
    : Math.max(0.5, Math.min(1, 1 - interiorMatch * 0.9));

  return { vDividers, hShelves, refLum: refL, sigma: sigL, interiorMatch, confidence };
}

/** Grayscale entry point (backward compatible with v2.1 tests). */
export function detectStructure(
  gray: Float32Array,
  W: number,
  H: number,
  tRatioX: number,
  tRatioY: number,
  opts?: DetectOptions,
): Detection {
  return detectFromChannels(gray, null, null, W, H, tRatioX, tRatioY, opts);
}

/** RGBA entry point (direct from HTML5 Canvas ImageData.data, enables chroma+luminance discrimination). */
export function detectStructureRGBA(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  tRatioX: number,
  tRatioY: number,
  opts?: DetectOptions,
): Detection {
  const N = W * H;
  const gray = new Float32Array(N);
  const c1 = new Float32Array(N);
  const c2 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const s = r + g + b + 15;
    c1[i] = (r - g) / s;
    c2[i] = (b - 0.5 * (r + g)) / s;
  }
  return detectFromChannels(gray, c1, c2, W, H, tRatioX, tRatioY, opts);
}
