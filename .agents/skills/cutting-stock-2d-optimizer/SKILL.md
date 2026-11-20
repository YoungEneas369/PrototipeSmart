---
name: cutting-stock-2d-optimizer
description: >-
  Use this skill when implementing, debugging, or optimizing src/core/cuttingStock/
  (Bloque 2). Enforces strict thickness separation (18mm vs 3mm), exact virtual-pad
  kerf handling, grain-direction locking along 2440mm, guillotine vs MaxRects
  woodworking considerations, and 100% offline XML-safe SVG generation.
---

# 2D Cutting Stock Optimizer & Offline SVG Generator

## 1. Non-Negotiable Packing Invariants
1. **Strict Material/Thickness Separation:**
   - Group pieces by `espesor` (e.g., `18 mm` Melamina vs. `3 mm` Fondo Durolac/MDF) BEFORE packing. Never mix 18 mm and 3 mm pieces on the same sheet.
   - Populate `sheet.espesorMm`, `sheet.materialLabel`, `melamineSheetsCount`, and `backPanelSheetsCount`.
2. **Grain Direction Lock:**
   - Sheet `width` (`2440 mm` default) is the grain axis; `height` (`1220 mm` default) is cross-grain.
   - A piece may rotate 90° **only** when `!(params.respectGrain && piece.respectGrain)`.
   - When both are `true`, rotation is strictly forbidden (`rotado: false`).
3. **Exact Kerf Handling (Zero False Edge Rejections):**
   - Let `s = params.kerf` (e.g., `4.0 mm`).
   - Initialize each fresh sheet's free rectangle to virtual dimensions **`(sheetWidth + s) × (sheetHeight + s)`**.
   - When placing a piece of real size `(pw, ph)`, reserve **`(pw + s) × (ph + s)`** in the free-rect space, but record exact real coordinates `{ x, y, ancho: pw, alto: ph }` in `PlacedRectangle`.
   - Check guarantees:
     - `0 <= x` and `x + ancho <= sheetWidth`
     - `0 <= y` and `y + alto <= sheetHeight`
     - Every pair of pieces on the same sheet has horizontal or vertical separation `>= s`
     - Exact edge cases pass: `2440 × 1220` fits on 1 sheet with `s = 4`; two `1218 × 600` pieces fit side-by-side (`1218 + 4 + 1218 = 2440`), while two `1220 × 600` pieces do NOT.
4. **Algorithm Choice (v2.1: GUILLOTINE STRIPS by default):**
   - Default `packingStrategy = 'guillotine'` (2-stage): rip strips along the grain (strip height = piece `alto`,
     usually `z_f`), then fill each strip by length with First-Fit Decreasing (accept a piece in a strip only if
     `strip.h >= piece.alto` and `strip.h - piece.alto <= 0.25 * strip.h`). Stack strips into sheets the same way.
     Same virtual-pad kerf trick on both axes. Rationale: carcass pieces share `alto = z_f` so 2D collapses to ~1D;
     the result is cuttable on a real panel saw (Sodimac/Imperial) and explainable with sumatorias.
   - Reference prototype + expected numbers: [guillotine_sim.ts](../../../docs/evidencia/guillotine_sim.ts)
     (Estantería 2 sheets on 2440×1220 = optimal under grain lock, 1 sheet on Chile 2500×1830; Clóset 18 mm = area
     lower bound; back panel 2×750×2100 needs 2 sheets on 2440×1220 but 1 on Durolac 2440×1520).
   - Optional `'maxrects'`: MaxRects BSSF with free-rectangle pruning (CNC-style, may be non-guillotine). Only if time allows.
   - Honour `params.trimMm` (shrink usable sheet by `2 * trimMm` per axis) and `params.backPanelSheetDimensions` for 3 mm.
5. **Oversized Pieces Guard:**
   - Before opening a new sheet, test whether the piece fits an empty `(sheetWidth + s) × (sheetHeight + s)` bin (respecting rotation rules). If not, push to `unplacedPieces` immediately — never enter an infinite sheet-creation loop.
6. **Exact Metrics:**
   - Sheet: `usoPorcentaje = (sumPieceAreas / (anchoSheet * altoSheet)) * 100`; `desperdicioPorcentaje = 100 - usoPorcentaje`.
   - Global: `usagePercentage` across all used sheets; `wastePercentage = 100 - usagePercentage` (`usagePercentage + wastePercentage === 100` within `1e-6`). Note: sawdust kerf counts as waste.
   - Note on Chilean market formats: Default to `2440 × 1220 mm` for Etapa 2/test compliance, while allowing `params.sheetDimensions` to accept Chilean commercial boards (`2500 × 1830 mm` Arauco Vesto / Masisa) seamlessly.

## 2. Offline Vector SVG (`src/core/cuttingStock/svgGenerator.ts`)
- Export `renderCuttingPlanSvg(sheets: SheetLayout[], kerf: number): string`.
- **100% Offline:** Use `font-family="system-ui, -apple-system, sans-serif"`. Zero external links, stylesheets, or images.
- **XML Escaping:** Always escape `&`, `<`, `>`, `"`, `'` in piece names and material labels.
- **Visual Clarity (Video-Ready):**
  - Explicit `viewBox` and vertical stack of sheets with clear headers (`Plancha #N · Melamina 18 mm · Uso XX.X% / Desperdicio YY.Y%`).
  - Grain direction arrow (`→ Veta 2440 mm`) on 18 mm sheets.
  - Subtle waste grid background, color-coded piece types, piece name, `ancho × alto mm`, and `(R)` badge when `rotado === true`.

## Verification Checklist
Run `npx vitest run` and confirm:
- [ ] Pairwise overlap & minimum `>= kerf` gap check passes on all sheets.
- [ ] `2440 × 1220`, `2 × (1218 × 600)`, and `2 × (1220 × 600)` kerf edge tests pass.
- [ ] `respectGrain = true` yields zero `rotado: true` melamine pieces.
- [ ] Preset 3 (`closet`) produces separate 18 mm and 3 mm sheets, `unplacedPieces.length === 0`, and `usage + waste === 100`.
- [ ] `2600 × 1500 mm` piece lands cleanly in `unplacedPieces`.
- [ ] `svgMarkup` is valid XML containing `<svg`, `</svg>`, sheet labels, and dimensions.
