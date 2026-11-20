---
name: furniture-math-homography
description: >-
  Use this skill when implementing or testing src/core/mathEngine/ (Bloque 1)
  or perspective rectification and A4 calibration in VectorCanvas (Bloque 4).
  Covers pure 3x3 homography, perspective-invariant metric calibration, Unidad 3
  matrix scaling, arithmetic shelf progressions, and structural sag alerts.
---

# Furniture Math Engine & 3x3 Projective Homography

## 1. Pure 3x3 Homography (`src/core/mathEngine/homography.ts`)
Zero external linear algebra libraries.
- **Vertex Order (Frozen):** `quadCorners = [TL, TR, BR, BL]` maps strictly to `[(0, 1), (1, 1), (1, 0), (0, 0)]` so perspective rectification and canvas-Y-to-furniture-Y inversion (`0 = floor, 1 = top`) happen in a single matrix `H`.
- **8x8 Linear System:** Fix `h33 = 1` and solve `A · h = b` using Gaussian elimination with **partial pivoting**. Return `null` if any pivot `< 1e-10` (collinear/degenerate quad).
- **Exact Inverse (`invertMatrix3x3`):** Compute adjugate/cofactor inverse; return `null` if `|det(H)| < 1e-10`.
- **Projection (`applyHomography`):** Compute `[x', y', w'] = H · [x, y, 1]^T`. Guard against `|w'| < 1e-10` before dividing by `w'`.

## 1b. v2.1 Additions
- `exteriorToInterior(p, e, dim)` / `interiorToExterior` helpers live in `mathEngine/index.ts` (pure, tested).
  The homography output (unit square of the OUTER quad) is exterior space; contracts use interior space.
- `aspectRatioXY` from a photo uses Zhang's vector formula with a **fixed focal prior**
  (`f_px = f35 / 43.27 * diag_px`, f35 from EXIF or 26) — never the estimated f (degenerate for typical
  tilted closet photos). Evidence: [zhang_sim.ts](../../../docs/evidencia/zhang_sim.ts).
- Aspect ratio and A4 scale only PREFILL `V_0`; the user types `V_f`. Keep them simple.

## 2. Perspective-Invariant A4 Metric Calibration (Bloque 4)
**Avoid the raw-pixel perspective error trap:** Never compute `mmPerPixel` solely in distorted raw image pixels when the photo has perspective tilt.
- When `toUnit` is valid and the A4 reference segment `[p1, p2]` lies coplanar with the furniture front face:
  1. Project `u1 = applyHomography(toUnit, p1)` and `u2 = applyHomography(toUnit, p2)`.
  2. Compute normalized deltas `du = u2.x - u1.x`, `dv = u2.y - u1.y`.
  3. Using `aspectRatioXY` (`W / H`), compute rectified dimensionless length `dRect = Math.hypot(du * aspectRatioXY, dv)`.
  4. Estimate real dimensions directly in rectified space:
     - `yCal = medidaRealMm / dRect`
     - `xCal = yCal * aspectRatioXY`
  5. Fallback to raw-pixel `mmPerPixel` only if `toUnit` is `null` or `dRect < 1e-4`.

## 3. Unidad 3 Mathematical Formulations (`src/core/mathEngine/index.ts`)
1. **Base Matrix Scaling (`scaleBaseMatrix`):**
   - `M = M0 · diag(kx, ky, 1)` keeps `e` invariant.
   - Mandatory Etapa 2 regression test: `M0 = [[800, 400, 18], [800, 400, 18], [600, 400, 18]]`, `kx = ky = 1.2` -> original area `0.8800 m²`, scaled `1.2672 m²`, original edge banding `6.80 m`, scaled `8.16 m`, `e === 18`.
2. **Arithmetic Shelf Progression (`calculateShelfProgression`):**
   - `hInteriorMm = y_f - 2 * e`.
   - If `shelfCount <= 0` or `hInteriorMm - shelfCount * e <= 0`, return `terms: []` and `clearSpanMm <= 0` (and emit `'dimension_invalida'` critical alert in `calculateDespiece`).
   - Otherwise:
     - `clearSpanMm = (hInteriorMm - N * e) / (N + 1)`
     - `a1 = e + clearSpanMm` (bottom face of 1st shelf from floor)
     - `d = clearSpanMm + e`
     - `terms[n-1] = a1 + (n - 1) * d` for `n = 1..N`
   - **3D Center Placement Rule:** The 3D center `cy` of shelf `n` is **`terms[n-1] + e / 2`**, NOT `terms[n-1]`!
3. **Corner Joint Deductions:**
   - `topOverSides`: top/base = `x_f × z_f`; sides = `(y_f - 2e) × z_f`.
   - `topBetweenSides`: sides = `y_f × z_f`; top/base = `(x_f - 2e) × z_f`.
4. **Back Panel Split Guard:**
   - If `hasBackPanel === true`: split vertically along interior `vDividers` (or equal vertical strips) whenever `(x_f > minSheet && y_f > minSheet)` **OR** `x_f > maxSheet` **OR** `y_f > maxSheet`, so oversized back panels fit standard sheets cleanly.
5. **Structural Sag / Pandeo Rule:**
   - Emit `'pandeo'` (`severidad: 'warning'`) for every horizontal 18 mm shelf with net span (`ancho`) `> 850 mm`.
   - Engineering context (for tooltips/defense): Based on Euler-Bernoulli deflection `δ = 5 W L³ / (384 E I)` for MDP particleboard (`E ≈ 2.0 GPa`), spans `> 700 mm` risk creep under heavy books and `> 850 mm` is the critical structural limit.

## Verification Checklist
Run `npx vitest run` and confirm:
- [ ] Etapa 2 exact numbers (`0.8800 -> 1.2672 m²`, `6.80 -> 8.16 m`, `e = 18 mm`).
- [ ] Zero 3D AABB overlap across all 3 presets (`estanteria`, `rack_tv`, `closet`).
- [ ] Symmetric shelf clearances (`N = 3, 4, 5`) including top clearance `=== s_libre`.
- [ ] Pandeo alert triggers at `x_f = 1000 mm` and disappears when adding a `vDivider` at `u = 0.5`.
- [ ] Homography round-trip error `< 1e-6` and degenerate quad returns `null`.
