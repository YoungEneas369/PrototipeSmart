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
1. **1-Step Auto-Reconstruction on Upload (v3.3):** Uploading a frontal photo immediately executes Edge-Barrier Flood-Fill background segmentation (`autoDetectFurnitureQuad`: Sobel 3×3 gradient barriers + iterative BFS border flood-fill + largest connected foreground component + trapezoid corner refinement), estimates proportional `W/H` (`û_XY`) and camera distance `Z`, rectifies RGBA, runs **Recursive XY-Cut + Cavity Detection**, and updates 3D live (`Foto ↔ 3D`). Dragging any `[TL, TR, BR, BL]` corner auto-reanalyzes on pointer up.
2. **Aspect ratio & Camera Pose (`Z` meters + dynamic `horizonV`):** Zhang vector formula with a **fixed focal prior** (`f_px = f35 / 43.27 * hypot(imgW, imgH)`, default `f35 = 26` or UI selector `1× = 26 mm` / `2× = 52 mm`). `estimateCameraPoseMeters(quad, imgW, imgH, knownAxis, knownSizeMm, focal35mm)` decomposes `toCanvas` to estimate camera distance in meters (`Z`), pitch angle, and exact zero-parallax horizon `estimatedHorizonV = 0.5 - (centerRaw · h2) / ||h2||²`, fed directly into `analyzeRectifiedFurniture(..., { horizonV })`. Never estimate `f` and do NOT build an offline EXIF parser. Evidence: [zhang_sim.ts](../../../docs/evidencia/zhang_sim.ts).
3. **Rectify RGBA:** Bilinear sampling via `toCanvas` into `Uint8ClampedArray`. Adaptive width so an 18 mm board spans `>= 6 px`: `W = max(360, ceil(6 * x_f / e))`, `H = round(W * y_f / x_f)`. Row `0` = top (`v = 1`).
4. **Detect (`analyzeRectifiedFurniture` — Recursive XY-Cut + Dual Mode):**
   - **Channels:** Flat-field luminance `L / boxBlur(L, W/8)` + illumination-invariant chromaticity + carcass-border seeding (or 1-click eyedropper) + parallax-aware unilateral anchoring.
   - **Recursive XY-Cut (`v3.3`):** Hierarchically partitions open/asymmetric furniture (desks with knee-space + pedestals + upper cubbies, staggered multi-cubby shelves) into columns/tiers up to depth 3, emitting both full-height and partial `vDividers` (`start`/`end ∈ [0,1]`) plus leaf `cavities: DetectedCavity[]` (`open_bay` / `knee_space`). Partial vertical dividers pass a T-junction endpoint-support guard to reject floating objects/books.
   - **Closed-Front Mode & Confidence (`0..1`):** `interiorMatch > 0.5` checks full-span dark seams (`closed_front` + handle BFS) or returns `uncertain` (`confidence < 0.5`).
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
