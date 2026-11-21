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

## Pipeline (`src/core/vision/` + `VectorCanvas.tsx` — v4.0)
1. **1-Drag Front Framing Box + Optional 4-Corner Homography (v4.0):** Uploading a photo runs pre-smoothed Sobel 3×3 + top/upper-side Flood-Fill (never bottom-center so desk leg voids stay intact) + grounded lower-center bias (`autoDetectFurnitureQuad`) returning both a clean front rectangle and `exteriorBgRgb`. Default UX uses a **1-drag rectangular front frame** (`frameMode: 'box'`) instead of forcing 4 independent corners; full 4-corner `H 3×3` perspective mode (`frameMode: 'quad'`) is 1 click away for tilted photos.
2. **Aspect ratio & Camera Pose (`Z` meters + dynamic `horizonV`):** Zhang vector formula with a **fixed focal prior** (`f_px = f35 / 43.27 * hypot(imgW, imgH)`, default `f35 = 26` or UI selector `1× = 26 mm` / `2× = 52 mm`). `estimateCameraPoseMeters` decomposes `toCanvas` to estimate camera distance `Z`, pitch, and dynamic `estimatedHorizonV`, fed into `analyzeRectifiedFurniture`.
3. **Rectify RGBA:** Bilinear sampling via `toCanvas` into `Uint8ClampedArray`. Adaptive width so an 18 mm board spans `>= 6 px`: `W = max(360, ceil(6 * x_f / e))`, `H = round(W * y_f / x_f)`. Row `0` = top (`v = 1`).
4. **Unified Hybrid Vision + Per-Cell `FrontZone` Classifier (`analyzeRectifiedFurniture` v4.0):**
   - **3-Edge Desk-Safe Carcass Seeding + Material Inference:** Excludes bottom center from carcass median so open-bottom desks aren't poisoned by floor color; estimates `detectedMaterial` (`blanco` / `roble` / `grafito`).
   - **Recursive XY-Cut + Partial Edge Transitions:** Handles open bookcases, corner-suspended desk drawers (`leg_void` via `exteriorBgRgb`), hybrid open+closed racks (`furnitureMode: 'hybrid'`), and two-tone wood-door cabinets (`materialOverride: 'roble'`), emitting `inferredZones: FrontZone[]` directly.
   - **1-Click Interactive Zone Cycling:** Clicking any colored zone on `VectorCanvas` cycles `open → door_left → door_double → drawers → door_glass → leg_void` in real time.
5. **Convert exterior -> interior:** Emit `NormalizedSegment` via `exteriorToInterior(p, e, dim)` from `mathEngine`.
6. **Depth Z:** Fast typology presets (`320 / 400 / 500 / 550 mm`), manual input, AND optional **Vista Lateral (ZY)** tab in Ajuste preciso.

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
