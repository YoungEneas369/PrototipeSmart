---
name: smartfurniture-architecture-contracts
description: >-
  Use this skill whenever initializing, implementing, or reviewing any module of
  the SmartFurniture project (Bloques 1-4 + Vision) to enforce the frozen contracts
  in src/types/contracts.ts (v2.1 Rev. 2), right-handed 3D geometry invariants,
  mixed-bay joint deductions, and strict block-by-block validation gates.
---

# SmartFurniture Architecture & Frozen Contracts (v2.1 Rev. 2)

## Core Architectural Rules
1. **Single Source of Truth:** `src/types/contracts.ts` is created in Bloque 1 and frozen thereafter. Never break or rename its exported types in subsequent blocks.
2. **Strict Decoupling:**
   - `src/core/mathEngine/`: Pure TypeScript math only (zero React, zero DOM, zero Three.js).
   - `src/core/cuttingStock/`: Pure 2D optimizer + XML-safe SVG generator (zero React, zero DOM).
   - `src/core/vision/`: Pure offline image rectification, fixed-focal AR, and chroma+parallax band detector (zero React, zero WASM, zero network).
   - `src/components/`: UI modules (`vectorCanvas`, `vectorBlueprint`, `viewer3d`, `mathPanel`) consuming `contracts.ts` exclusively.
   - Additive v4.0 carpentry contract extensions in `src/types/contracts.ts`: `FrontModuleKind`, `FrontZone` (doors, glass doors, 5-piece drawers with 13 mm slide clearance, `leg_void` omitting base + adding rear `faldon`, two-tone `materialOverride`), optional `toeKickHeightMm`, and `CATALOG_14_MUEBLES` in `src/core/vectorBlueprint/catalog14.ts`.
3. **100% Local / Offline Constraint (Etapa 2):** No backend, no external APIs, no CDNs, no Google Fonts, no remote HDRIs.
4. **Preserve Documentation:** Never overwrite or delete project documentation files (`pauta.md`, `Auditoria y Prompts.txt`, `docs/`).

## Frozen Geometric Invariants (Zero Ambiguity)
Read [contracts-spec.md](./references/contracts-spec.md) for full interface definitions.

1. **Right-Handed 3D Coordinate System (mm):**
   - Origin `[0, 0, 0]` at **bottom-left-REAR** corner.
   - `+X`: left -> right (`0` to `x_f`).
   - `+Y`: floor -> top (`0` to `y_f`).
   - `+Z`: rear wall -> visible front (`0` to `z_f`).
   - **Back panel (3 mm Durolac):** nailed on the exterior rear at `z ∈ [-backPanelThickness, 0]` (`cz = -backPanelThickness / 2`, e.g., `-1.5 mm`). Zero Z-fighting; toggling the back panel never alters the 18 mm carcass dimensions.
2. **1:1 Physical Piece Mapping:**
   - Every entry in `DespieceResult.matrizDespiece` represents **one physical board** (`cantidad: 1`) with exact center `posicion3D: [cx, cy, cz]` and axis-aligned `dimensiones3D: [dx, dy, dz]` in mm.
   - Grouped quantities (`cantidad >= 1`) live in `matrixNx5` and `consolidatedRows`.
3. **Normative Coordinate Space & Custom vs. Equidistant Shelves:**
   - `NormalizedSegment` is ALWAYS in **INTERIOR** space `[0, 1]^2`. Photo/homography outputs are in **EXTERIOR** space -> convert with `exteriorToInterior(p, e, dim) = (p - e/dim) / (1 - 2e/dim)` (and inverse `interiorToExterior`). Mandatory test: `exteriorToInterior(0.25, 18, 800) ≈ 0.2382`.
   - In `'equidistant'` mode, `ShelfProgressionData.terms[n-1]` is the shelf **bottom face** `a_n` -> `cy = a_n + e / 2`.
   - In `'custom'` mode, `hShelves[i].position` (`v`) is the shelf **vertical center** in `y_int` (`cy = e + v * y_int`); validate/clamp so shelves do not overlap base/top (`cy ∈ [e + e/2, y_f - e - e/2]`).
4. **Grain Axis & Board Orientation:**
   - Standard sheet: `width = 2440 mm` (horizontal grain axis) × `height = 1220 mm` (cross-grain).
   - On every `BoardPiece`, `ancho` is ALWAYS the grain-parallel dimension (horizontal length for top/base/shelves; vertical height for sides/vertical dividers), and `alto` is the cross-grain dimension (depth `z_f`).
5. **Edge Banding (`edges`):**
   - `top` and `bottom` have length `ancho` (`top` = front visible `+Z` edge); `left` and `right` have length `alto`.
   - Durolac 3 mm back panel has `respectGrain: false` and all `edges` set to `false`.
6. **CRITICAL — Mixed-Bay Joint Deductions (Crossings AND Endpoints):**
   - Interior cavity spans `x ∈ [e, x_f - e]` (`x_int = x_f - 2e`) and `y ∈ [e, y_f - e]` (`y_int = y_f - 2e`).
   - Vertical dividers (`vDividers`) are continuous over `[start, end]`.
   - When computing a horizontal shelf over `[uStart, uEnd]`:
     - Split at every `vDivider` strictly inside `(uStart, uEnd)` whose vertical span overlaps the shelf's `v`, deducting `e / 2` on each side of the divider center.
     - **ALSO check boundary contacts:** if `|uStart - div.position| <= 1e-3` (starts at a divider, not outer wall `u = 0`), shift left face by `+e / 2`; if `|uEnd - div.position| <= 1e-3` (ends at a divider, not outer wall `u = 1`), shift right face by `-e / 2`.
     - Preset 2 (`rack_tv`) MUST use exact `1 / 3` and `2 / 3` (NOT `0.333`/`0.667`) so center shelf = `503.33 mm`.
     - Verify invariant: sum of bay widths + `(numDividers + 2) * e === x_f` with zero 3D overlap.
7. **Back Panel Split Guard:**
   - Split vertically whenever `(x_f > minS && y_f > minS)` **OR** `x_f > maxS` **OR** `y_f > maxS` using `backPanelSheetDimensions ?? sheetDimensions`.

## Verified Toolchain (Pin Exactly)
- `react: "18.3.1"`, `react-dom: "18.3.1"`, `three: "0.162.0"`, `@types/three: "0.162.0"`, `@react-three/fiber: "8.18.0"`, `@react-three/drei: "9.122.0"`, `lucide-react: "^0.454.0"`, `vite: "^6.3.5"`, `vitest: "^3.2.4"`, `@vitejs/plugin-react: "^4.3.4"`, `typescript: "~5.8.3"`. Never `vite@latest` or `three@latest`.
- **Termux only:** `/usr/bin/env` is missing, so run `node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc -b`, `node node_modules/vite/bin/vite.js build`. If `node_modules/.bin` is incomplete, run `npm rebuild`.

## Block Execution Gatekeeper
Never advance until all gates pass:
- **Bloque 1:** `vitest` 100% green (`mathEngine.test.ts`, Etapa 2 check, `exteriorToInterior`, 3 presets zero overlap).
- **Bloque 2:** `vitest` 100% green (Bloque 1 + `cuttingStock.test.ts` incl. `respectGrain` rotation gain).
- **Visión (`src/core/vision/`):** `vitest` 100% green (8 synthetic scenarios incl. parallax/jitter/roble + real-photo regression table).
- **Bloque 3 & 4:** `vitest` + `tsc -b` + `vite build` 100% green, zero external URLs in `src/` & `index.html`, verified offline in desktop browser.
