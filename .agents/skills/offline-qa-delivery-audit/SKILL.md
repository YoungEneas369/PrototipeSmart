---
name: offline-qa-delivery-audit
description: >-
  Use this skill at the end of any development block or before recording the
  final INACAP Etapa 3 video to run automated test/build gates, audit strict
  100% offline compliance, verify all 3 official presets, and check mathematical
  defense readiness.
---

# SmartFurniture Offline QA & INACAP Delivery Audit (v2.1 Rev. 2)

## 1. Automated Verification Command
Run this single verification chain at every block gate:
```bash
npx vitest run && npm run build && ! grep -rnE "https?://|fetch\(|@import\s+url|<Environment|fonts\.googleapis" src/ index.html
```
*(Ignore XML namespace declarations like `xmlns="http://www.w3.org/2000/svg"` when reviewing `grep` output—verify zero external runtime URLs or font/HDRI loads.)*

On Termux (Android), replace `npx vitest run && npm run build` with:
`node node_modules/vitest/vitest.mjs run && node node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build`.

## 1b. Real-Photo Regression Table (Mandatory Before Bloque 4 / Video)
Track the team's 8–12 annotated real photos (protocol in `docs/RESUMEN_PARA_EL_EQUIPO.md`):
`photo id | true dividers/shelves | detected | max error (mm) | interiorMatch | confidence | pass/fail`.
Re-run after any detector threshold tweak. Pick the video demo photos exclusively from passing rows.

## 2. Functional Smoke Test Matrix (Desktop Browser + DevTools -> Network -> Offline)
Always run final UI/WebGL verification on a **desktop browser** (not Termux-only) with Network Offline enabled:
1. **Preset 1 — Estantería (`800 × 1800 × 320`, 4 repisas):**
   - Fix `V_0`, slide `x_f` to `960 mm` (`k_x = 1.20`): confirm pandeo alert triggers (`luz libre = 924 mm > 850 mm`) and shelves turn amber/red in 3D.
   - Click *"Agregar divisor vertical central"*: confirm shelves auto-subdivide (`luz libre = 453 mm`) and alert disappears in real time.
   - Vary `N` from `3` to `5`: confirm `H_int`, `s_libre`, `a1`, `d`, and `a_n` update synchronously.
2. **Preset 2 — Rack de TV (`1600 × 550 × 400`, `topBetweenSides`):**
   - Confirm center shelf fits cleanly between vertical dividers (`503.33 mm`, exact `1/3` and `2/3`, zero 3D intersection).
   - Toggle `topOverSides` vs `topBetweenSides` and `fullPerimeter` vs `visibleEdgesOnly` and observe matrix & edge-banding updates.
3. **Preset 3 — Clóset (`1500 × 2100 × 550`, `hasBackPanel: true`):**
   - Toggle back panel OFF -> ON: confirm transition `n × 3` -> `n × 5`, back panel positioned at `z ∈ [-3, 0]` without shifting 18 mm carcass, and separate 18 mm vs 3 mm sheets in Cutting Stock SVG with `unplacedPieces === 0`.
   - Switch sheet format `2440×1220` -> Chile (`2500×1830` + Durolac `2440×1520`) and confirm sheet count drops cleanly.
   - Verify `respectGrain` toggle visibly rotates pieces and saves sheets on a rotation-sensitive cabinet (e.g., `900×1150×410`, 1 shelf: 2 sheets -> 1 sheet) and `usage% + waste% === 100%`.
4. **VectorCanvas (Bloque 4 — Photo -> Vision -> 3D):**
   - Load procedural local sample sketch AND real team photos.
   - Drag 4 corners (`TL, TR, BR, BL`) with **4× loupe**: confirm live rectified preview and projective grid update cleanly; degenerate quad shows warning without crashing.
   - Click *"Detectar estructura automáticamente"*: confirm dividers/shelves appear in perspective, confidence badge reflects `detectionConfidence`, 1-click color eyedropper works, and 3D viewer updates synchronously.
   - Test perspective-invariant A4 calibration (`297 mm`), optional Vista Lateral ZY tab, CSV export (UTF-8 BOM `\uFEFF`), and SVG export.

## 3. INACAP Unidad 3 Video Defense Talking Points
Ensure the team can clearly explain:
- **Vectors in $\mathbb{R}^3$:** $V_f = (x_f, y_f, z_f)$ and normalized interior topology $(u_i, v_i) \in [0, 1]^2$ obtained via `exteriorToInterior()`.
- **Scaling & Invariance:** $k_x, k_y, k_z$ with invariant $e = 18\text{ mm}$; distinction between pure linear scaling `M = M0 · diag(k1, k2, 1)` (Etapa 2) and affine carpentry deductions (`-2e`) in 3D.
- **Arithmetic Progression:** $s_{\text{libre}} = \frac{H_{\text{int}} - N e}{N + 1}$, $a_1 = e + s_{\text{libre}}$, $d = s_{\text{libre}} + e$, $a_n = a_1 + (n-1)d$.
- **Matrices:** $n \times 3 \to n \times 5$ extension and $3 \times 3$ projective homography $H$ (8×8 Gaussian elimination) + $H^{-1}$.
- **Summations & Optimization:** Net area ($\text{m}^2$), edge banding ($\text{m}$), vision coverage projection profiles, 2D guillotine Cutting Stock with kerf $s$, grain lock, and Euler-Bernoulli sag justification ($\delta = \frac{5 W L^3}{384 E I}$).
