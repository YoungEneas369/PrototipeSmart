---
name: cutting-stock-2d-optimizer
description: >-
  Use this skill when implementing, debugging, or optimizing src/core/cuttingStock/
  (Bloque 2). Enforces strict thickness separation (18mm vs 3mm), exact virtual-pad
  kerf handling, grain-direction locking along 2440mm with real 90-degree rotation
  gains when unlocked, 2-stage guillotine + optional MaxRects, and offline SVG.
---

# 2D Cutting Stock Optimizer & Offline SVG Generator (v2.1 Rev. 2)

## 1. Non-Negotiable Packing Invariants
1. **Strict Material/Thickness Separation:**
   - Group pieces by `espesor` (`18 mm` Melamina vs. `3 mm` Fondo Durolac/MDF) BEFORE packing. Never mix thicknesses on the same sheet.
   - Use `params.sheetDimensions` for 18 mm and `params.backPanelSheetDimensions ?? params.sheetDimensions` for 3 mm.
   - Populate `sheet.espesorMm`, `sheet.materialLabel`, `melamineSheetsCount`, and `backPanelSheetsCount`.
2. **Squaring Trim (`trimMm`) + Exact Kerf Handling:**
   - `trim = params.trimMm ?? 0`; usable dimensions `usableW = W - 2 * trim`, `usableH = H - 2 * trim`.
   - Let `s = params.kerf` (e.g., `4.0 mm`).
   - Virtual-pad capacity `(usableW + s) × (usableH + s)`; placing `(pw, ph)` reserves `(pw + s) × (ph + s)`, while recording exact coordinates `{ x: trim + ..., y: trim + ..., ancho: pw, alto: ph }`.
   - Guarantees:
     - `trim <= x` and `x + ancho <= sheetWidth - trim`
     - `trim <= y` and `y + alto <= sheetHeight - trim`
     - Pairwise separation `>= s` on X or Y
     - Exact edge cases (`trim = 0, s = 4`): `2440 × 1220` fits on 1 sheet; two `1218 × 600` fit side-by-side; two `1220 × 600` require 2 strips.
3. **Grain Direction Lock + Real Rotation Benefit When Unlocked (v2.1 Rev. 2):**
   - Sheet `width` (`2440 mm` default) is the grain axis; `height` (`1220 mm`) is cross-grain.
   - A piece may rotate 90° **only** when `!(params.respectGrain && piece.respectGrain)`.
   - When `respectGrain = true` and `piece.respectGrain = true`, rotation is strictly forbidden (`rotado: false`).
   - **CRITICAL FIX (Rev. 2):** In standard cabinets, most pieces have `ancho > alto` (`alto = z_f`). When rotation IS allowed (`respectGrain = false`), the guillotine packer MUST evaluate multi-orientation policies (`default`, `preferRotated`, `mixed` — see [guillotine_sim.ts](../../../docs/evidencia/guillotine_sim.ts)) and pick the layout with fewest unplaced pieces, fewest sheets, and fewest strips. This guarantees that toggling `respectGrain` OFF visibly rotates pieces and saves sheets (e.g., `900×1150×410` module drops from **2 sheets / 33.7%** to **1 sheet / 67.4%** with 5 rotated pieces).
4. **Algorithm Choice:**
   - Default `packingStrategy = 'guillotine'` (2-stage strip packing: rip strips along grain, fill by FFD with `<= 25%` height tolerance, stack strips into sheets). Fully cuttable on real panel saws (Sodimac/Imperial) and explainable with sumatorias.
   - Optional `packingStrategy = 'maxrects'`: MaxRects BSSF with free-rectangle pruning (CNC-style), obeying identical thickness, grain, kerf, and trim invariants.
   - Reference prototype + verified outputs: [guillotine_sim.ts](../../../docs/evidencia/guillotine_sim.ts).
5. **Oversized Pieces Guard:**
   - If a piece cannot fit an empty usable sheet (under its rotation rules), push immediately to `unplacedPieces` — never infinite-loop.
6. **Exact Metrics:**
   - Sheet: `usoPorcentaje = (sumPieceAreas / (anchoSheet * altoSheet)) * 100`, `desperdicioPorcentaje = 100 - usoPorcentaje`.
   - Global: `usagePercentage`, `wastePercentage = 100 - usagePercentage` (`usage + waste === 100` within `1e-6`).
   - Chilean market formats supported via selector (`2500 × 1830 mm` Melamina, `2440 × 1520 mm` Durolac), while keeping `2440 × 1220 mm` as default for pauta compliance.

## 2. Offline Vector SVG (`src/core/cuttingStock/svgGenerator.ts`)
- Export `renderCuttingPlanSvg(sheets: SheetLayout[], kerf: number, trimMm?: number): string`.
- **100% Offline:** `font-family="system-ui, -apple-system, sans-serif"`, zero external URLs or stylesheets.
- **XML Escaping:** Escape `&`, `<`, `>`, `"`, `'` in all labels and piece names.
- **Visual Clarity:** Explicit `viewBox`, stacked sheets with headers (`Plancha #N · Material · Uso XX.X% / Desperdicio YY.Y%`), grain arrow (`→ Veta`), optional trim border when `trimMm > 0`, subtle waste grid, color-coded piece types, `ancho × alto mm`, and `(R)` badge when `rotado === true`.

## Verification Checklist
Run Vitest and confirm:
- [ ] Pairwise overlap & minimum `>= kerf` gap + `trimMm` bounds check passes on all sheets for both `'guillotine'` and `'maxrects'`.
- [ ] `2440 × 1220`, `2 × (1218 × 600)`, and `2 × (1220 × 600)` kerf edge tests pass.
- [ ] `respectGrain = true` yields zero `rotado: true` melamine pieces, and `respectGrain = false` reduces sheets from 2 -> 1 on `900×1150×410`.
- [ ] Preset 3 (`closet`) separates 18 mm and 3 mm sheets, works on both `2440×1220` and Chile (`2500×1830` / `2440×1520`), `unplacedPieces.length === 0`, `usage + waste === 100`.
- [ ] `2600 × 1500 mm` piece lands cleanly in `unplacedPieces`.
- [ ] `svgMarkup` is valid XML containing `<svg`, `</svg>`, sheet labels, and dimensions.
