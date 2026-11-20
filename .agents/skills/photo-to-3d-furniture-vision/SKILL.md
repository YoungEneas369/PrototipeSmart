---
name: photo-to-3d-furniture-vision
description: >-
  Use this skill when designing, implementing, or improving the photo-to-3D
  furniture recognition pipeline (src/core/vision/ and VectorCanvas in Bloque 4).
  Covers homography rectification, fixed-focal aspect ratio, the chroma+luminance
  parallax-aware carcass-seeded detector with 1-click eyedropper and confidence,
  exterior->interior conversion, real-photo failure modes, and the photo protocol.
---

# Offline Photo-to-3D Furniture Vision (v2.1 Rev. 2)

## Ground truth about the problem
- The user sets or refines `V_f` in mm. From the photo we primarily need **accurate topology** (`u, v` of dividers/shelves) so the 3D model updates immediately.
- A 4-corner homography to the unit square gives exact normalized `u, v` **regardless of aspect ratio**. Fixed-focal aspect ratio and perspective-invariant A4 calibration prefill `V_0` / `V_f`.
- Auto-detection is a **high-accuracy assistant**, while fast manual editing (4× loupe, live rectified preview, 1-click color eyedropper, add/drag/delete with snap) is the **100% guaranteed path**.

## Pipeline (`src/core/vision/` + `VectorCanvas.tsx`)
1. **Corners `[TL, TR, BR, BL]`:** Place with **4× loupe** + live **rectified preview thumbnail** so users confirm straight framing before running detection.
2. **Aspect ratio:** Zhang vector formula with a **fixed focal prior** (`f_px = f35 / 43.27 * hypot(imgW, imgH)`, default `f35 = 26` or UI selector `1× = 26 mm` / `2× = 52 mm`). Never estimate `f` (fails on 43% of tilted closet photos) and do NOT build an offline EXIF parser. Evidence: [zhang_sim.ts](../../../docs/evidencia/zhang_sim.ts).
3. **Rectify RGBA:** Bilinear sampling via `toCanvas` into `Uint8ClampedArray`. Adaptive width so an 18 mm board spans `>= 6 px`: `W = max(360, ceil(6 * x_f / e))`, `H = round(W * y_f / x_f)`. Row `0` = top (`v = 1`).
4. **Detect (`detectStructureRGBA`):** Reference verified implementation in [bandDetector.ts](../../../docs/evidencia/bandDetector.ts) (`8/8` passing in [band_test.ts](../../../docs/evidencia/band_test.ts)):
   - **Channels:** Flat-field luminance `L / boxBlur(L, W/8)` (integral image, kills window gradients/vignetting) + illumination-invariant chromaticity `(R-G)/(R+G+B+15)` and `(B-0.5*(R+G))/(R+G+B+15)` (separates wood/roble from equal-luminance gray shadows).
   - **Robust Seeding:** Sample all **4 outer carcass borders** (left, right, top, bottom) with median + MAD (50% breakdown point -> tolerates single-edge corner click jitter), plus optional `seedPoint?: { u; v }` for a **1-click eyedropper** in the UI.
   - **Parallax-Aware Front-Edge Anchoring:** Below horizon (`v < horizonV`), shelves expose their top surface above the front edge -> anchor on zero-gap bottom drop (`mean(i, i+t) - mean(i+t, i+t+fw)`). Above horizon (`v > horizonV`), anchor on zero-gap top rise. Same geometry horizontally for left/right dividers. Rejects giant solid regions (`> 0.24 * dim`) and suppresses underside double-triggers via NMS `max(4*t, 0.055*n)`.
   - **Structural Priors:** Dividers must be continuous top-to-base (rejects books); shelves are searched bay-by-bay and collinear segments are merged across bays (`mathEngine` re-splits at dividers).
   - **Confidence (`0..1`):** `interiorMatch > 0.5` => `confidence < 0.5` (white-on-white) => UI explicitly alerts and switches focus to manual tracing.
5. **Convert exterior -> interior:** Emit `NormalizedSegment` via `exteriorToInterior(p, e, dim)` from `mathEngine` (prevents ~9 mm shift error).
6. **Depth Z:** Fast typology presets (`320 / 400 / 500 / 550 mm`), manual input, AND optional **Vista Lateral (ZY)** tab in Paso 1 for full `pauta.md` compliance.

## Known failure modes & real-photo status
- 🟡 **Parallax:** Solved in synthetic stress tests (`Clóset 550 mm @ 3 m`, `~100 mm` visible faces -> `0.0–0.5 mm` error), **must be calibrated on 8–12 real phone photos** (23–24 nov).
- 🔴 **White carcass + white back panel:** Undetectable by appearance alone -> cleanly flagged via `confidence < 0.5` -> quick manual tracing.
- 🟠 **Ultrawide `0.5×` barrel distortion / closed doors / cropped photos:** Explicitly guarded by the in-app **Photo Protocol** card.

## Photo protocol (display in Paso 1 UI)
Mueble abierto, sin puertas · cámara centrada a media altura · alejarse `≥ 3 m` y usar zoom `1×–2×` (nunca `0.5×`) · sin recortar · enviar por WhatsApp como **Documento** o por USB/Drive.

## Verification Checklist
- [ ] Vitest port of all **8 scenarios** from [band_test.ts](../../../docs/evidencia/band_test.ts) passes (`<= 8 mm` error; white-on-white returns `confidence < 0.5`).
- [ ] Real-photo regression table (8–12 annotated team photos) tracked before Bloque 4 / video.
- [ ] Zero network requests, zero WASM, `< 120 ms` per detection on phone hardware.
