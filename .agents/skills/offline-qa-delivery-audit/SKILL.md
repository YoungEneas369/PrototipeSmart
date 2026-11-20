---
name: offline-qa-delivery-audit
description: >-
  Use this skill at the end of any development block or before recording the
  final INACAP Etapa 3 video to run automated test/build gates, audit strict
  100% offline compliance, verify all 3 official presets, and check mathematical
  defense readiness.
---

# SmartFurniture Offline QA & INACAP Delivery Audit

## 1. Automated Verification Command
Run this single verification chain at every block gate:
```bash
npx vitest run && npm run build && ! grep -rnE "https?://|fetch\(|@import\s+url|<Environment|fonts\.googleapis" src/ index.html
```
*(Ignore XML namespace declarations like `xmlns="http://www.w3.org/2000/svg"` when reviewing `grep` output—verify zero external runtime URLs or font/HDRI loads.)*

On Termux, replace `npx vitest run && npm run build` with
`node node_modules/vitest/vitest.mjs run && node node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build`.

## 1b. Real-Photo Regression Table (v2.1, mandatory before the video)
Keep a table of the 10–15 annotated real photos (protocol in `docs/RESUMEN_PARA_EL_EQUIPO.md`):
photo id · true dividers/shelves · detected · max error (mm) · `interiorMatch` · pass/fail. Re-run after
every detector change. Pick the video photos only from rows that pass.

## 2. Functional Smoke Test Matrix (All 4 Steps + 3 Presets)
Verify in browser with **DevTools -> Network -> Offline** enabled:
1. **Preset 1 — Estantería (`800 × 1800 × 320`, 4 repisas):**
   - Fix `V_0`, slide `x_f` to `960 mm` (`k_x = 1.20`): confirm pandeo alert triggers (`luz libre = 924 mm > 850 mm`) and shelves turn amber/red in 3D.
   - Click *"Agregar divisor vertical central"*: confirm shelves auto-subdivide (`luz libre = 453 mm`) and alert disappears in real time.
   - Vary `N` from `3` to `5`: confirm `H_int`, `s_libre`, `a1`, `d`, and `a_n` update synchronously.
2. **Preset 2 — Rack de TV (`1600 × 550 × 400`, `topBetweenSides`):**
   - Confirm center shelf fits cleanly between vertical dividers (`~503.3 mm`, zero 3D intersection).
   - Toggle `topOverSides` vs `topBetweenSides` and `fullPerimeter` vs `visibleEdgesOnly` and observe matrix & edge-banding updates.
3. **Preset 3 — Clóset (`1500 × 2100 × 550`, `hasBackPanel: true`):**
   - Toggle back panel OFF -> ON: confirm transition `n × 3` -> `n × 5`, back panel positioned at `z ∈ [-3, 0]` without shifting 18 mm carcass, and separate 18 mm vs 3 mm sheets in Cutting Stock SVG with `unplacedPieces === 0`.
   - Toggle `respectGrain`: confirm SVG layout updates and `usage% + waste% === 100%`.
4. **VectorCanvas (Bloque 4):**
   - Load procedural local sample sketch (no external file needed).
   - Drag 4 corners (`TL, TR, BR, BL`): confirm projective grid follows quad and degenerate quad shows warning without crashing.
   - Test A4 calibration (`297 mm`) and 2-view lateral `aspectRatioZY` sync.
   - Export CSV (verify UTF-8 BOM `\uFEFF`) and SVG (verify clean local render).

## 3. INACAP Unidad 3 Video Defense Talking Points
Ensure the team can clearly explain:
- **Vectors in $\mathbb{R}^3$:** $V_f = (x_f, y_f, z_f)$ and normalized 2D topology $(u_i, v_i) \in [0, 1]^2$.
- **Scaling & Invariance:** $k_x, k_y, k_z$ with invariant $e = 18\text{ mm}$; distinction between pure linear scaling `M = M0 · diag(k1, k2, 1)` (Etapa 2) and affine carpentry deductions (`-2e`) in 3D.
- **Arithmetic Progression:** $s_{\text{libre}} = \frac{H_{\text{int}} - N e}{N + 1}$, $a_1 = e + s_{\text{libre}}$, $d = s_{\text{libre}} + e$, $a_n = a_1 + (n-1)d$.
- **Matrices:** $n \times 3 \to n \times 5$ extension and $3 \times 3$ projective homography $H$ (8×8 Gaussian elimination) + $H^{-1}$.
- **Summations & Optimization:** Net area ($\text{m}^2$), edge banding ($\text{m}$), 2D Cutting Stock with kerf $s$, grain lock, and Euler-Bernoulli sag justification ($\delta = \frac{5 W L^3}{384 E I}$).
