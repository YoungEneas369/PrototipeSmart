---
name: photo-to-3d-furniture-vision
description: >-
  Use this skill when designing, implementing, or improving the photo-to-3D
  furniture recognition pipeline (src/core/vision/ and VectorCanvas in Bloque 4).
  Covers homography rectification, focal-prior aspect ratio, the carcass-seeded
  matched-band shelf/divider detector with confidence, exterior->interior
  coordinate conversion, known real-photo failure modes, and the photo protocol.
---

# Offline Photo-to-3D Furniture Vision (evidence-based, red-team audited)

## Ground truth about the problem
- The user TYPES `V_f` in mm. From the photo we need **topology** (u, v of dividers/shelves).
- A 4-corner homography to the unit square gives exact normalized u, v **regardless of aspect ratio**.
  Aspect ratio / A4 scale only prefill `V_0` -> low stakes. Spend effort on detection + correction UX.
- Auto-detection is an **assistant**. The manual path (4× loupe, snap, add/drag/delete lines) is the
  guaranteed path and must always work.

## Pipeline
1. **Corners** `[TL, TR, BR, BL]` with 4× loupe (edge snap optional; fails on white-on-white walls).
2. **Aspect ratio:** Zhang vector formula with a **FIXED focal prior**, NOT estimated f.
   `f_px = f35 / 43.27 * hypot(imgW, imgH)`, f35 from EXIF `FocalLengthIn35mmFilm` else **26**.
   Monte Carlo evidence (σ=2.5 px clicks): typical tilted closet photo -> estimated-f Zhang invalid 43 %,
   p95 error 21 %; focal-prior p95 2.0 % (2.9 % even with a 15 % wrong prior). Never crop (principal point).
3. **Rectify** with bilinear sampling through `toCanvas`. Width adaptive so the 18 mm board is ≥ 6 px:
   `W = max(360, ceil(6 * x_f / e))`, `H = round(W * y_f / x_f)`. Row 0 = top (v = 1).
4. **Detect** with the carcass-seeded matched-band detector — reference implementation (86 lines, tested):
   [bandDetector.ts](../../../docs/evidencia/bandDetector.ts) (stress test: [band_test.ts](../../../docs/evidencia/band_test.ts)).
   Requires approximate `V_0` for `tRatio = e / dim`. Full rationale: [ANALISIS_TECNICO_v2.1.md](../../../docs/ANALISIS_TECNICO_v2.1.md).
   - Flat-field normalize `L / boxBlur(L, W/8)` (integral image).
   - Learn board appearance from the carcass side bands (median + MAD).
   - Per-pixel binary "board-like"; projection profiles = **coverage fractions** (not gradient sums).
   - 1D matched filter of known thickness, both flanks must be off; NMS at 3·t.
   - Dividers first, kept only if continuous and touching BOTH top and base (rejects books).
   - Shelves bay-by-bay; collinear shelves across bays merged (mathEngine re-splits at dividers).
   - `interiorMatch > 0.5` => model cannot discriminate (white-on-white) => tell user to trace manually.
5. **Convert exterior -> interior** before emitting `NormalizedSegment` (contracts use INTERIOR space):
   `p_int = (p_ext - e/dim) / (1 - 2e/dim)`. Skipping this = ~9 mm error at u = 0.25 on 800 mm.
6. **Depth Z:** typology preset (320 / 400 / 500 / 550 mm) or manual input. 2-view ZY is optional scope.

## Known failure modes (handle or communicate)
- 🔴 **Parallax (untested):** shelves below eye level show their top face (band 2–8× thicker than 18 mm);
  above eye level the underside. Fix direction: one-sided flank test, pick the lower edge below the
  horizon and the upper edge above it. Must be tuned on REAL photos.
- 🔴 White carcass + white back panel: undetectable by pixels -> rely on confidence + manual.
- 🟠 Ultrawide 0.5× barrel distortion; doors/drawers out of scope; WhatsApp strips EXIF (send as Document).

## Photo protocol (show in UI)
Mueble abierto, sin puertas · cámara centrada a media altura · alejarse ≥ 3 m y usar zoom 1×–2× (nunca 0.5×) ·
sin recortar · enviar por WhatsApp como **Documento** o por USB/Drive.

## Verification
- [ ] Vitest port of the synthetic stress test (books, shadows, 2× light gradient, noise): Estantería,
      Rack TV, Clóset, Grafito pass with ≤ 8 mm error; white-on-white returns `interiorMatch > 0.5`.
- [ ] Real-photo eval set (10–15 annotated photos) tracked as a regression table before the video.
- [ ] Zero network requests, zero WASM, < 100 ms per detection on phone hardware.
