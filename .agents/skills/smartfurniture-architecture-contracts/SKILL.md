---
name: smartfurniture-architecture-contracts
description: >-
  Use this skill whenever initializing, implementing, or reviewing any module of
  the SmartFurniture project (Bloques 1-4) to enforce the frozen contracts in
  src/types/contracts.ts, right-handed 3D geometry invariants, mixed-bay joint
  deductions, and strict block-by-block validation gates.
---

# SmartFurniture Architecture & Frozen Contracts

## Core Architectural Rules
1. **Single Source of Truth:** `src/types/contracts.ts` is created in Bloque 1 and frozen thereafter. Never break or rename its exported types in Bloques 2, 3, or 4.
2. **Strict Decoupling:**
   - `src/core/mathEngine/`: Pure TypeScript math only (zero React, zero DOM, zero Three.js).
   - `src/core/cuttingStock/`: Pure 2D optimizer + XML-safe SVG generator (zero React, zero DOM).
   - `src/components/`: UI modules (`vectorCanvas`, `viewer3d`, `mathPanel`) consuming `contracts.ts` exclusively.
3. **100% Local / Offline Constraint (Etapa 2):** No backend, no external APIs, no CDNs, no Google Fonts, no remote HDRIs.
4. **Preserve Documentation:** Never overwrite or delete project documentation files (`pauta.md`, `Auditoria y Prompts.txt`, `Especificación Técnica.pdf`).

## Frozen Geometric Invariants (Zero Ambiguity)
Read [contracts-spec.md](./references/contracts-spec.md) for full interface definitions.

1. **Right-Handed 3D Coordinate System (mm):**
   - Origin `[0, 0, 0]` at **bottom-left-REAR** corner.
   - `+X`: left -> right (`0` to `x_f`).
   - `+Y`: floor -> top (`0` to `y_f`).
   - `+Z`: rear wall -> visible front (`0` to `z_f`).
   - **Back panel (3 mm Durolac):** nailed on the exterior rear at `z ∈ [-backPanelThickness, 0]` (`cz = -backPanelThickness / 2`, e.g., `-1.5 mm`). Zero Z-fighting; activating/deactivating the back panel never alters the 18 mm carcass dimensions.
2. **1:1 Physical Piece Mapping:**
   - Every entry in `DespieceResult.matrizDespiece` represents **one physical board** (`cantidad: 1`) with exact center `posicion3D: [cx, cy, cz]` and axis-aligned `dimensiones3D: [dx, dy, dz]` in mm.
   - Grouped quantities (`cantidad >= 1`) live in `matrixNx5` and `consolidatedRows`.
3. **Grain Axis & Board Orientation:**
   - Standard sheet: `width = 2440 mm` (horizontal grain axis) × `height = 1220 mm` (cross-grain).
   - On every `BoardPiece`, `ancho` is ALWAYS the grain-parallel dimension (horizontal length for top/base/shelves; vertical height for sides/vertical dividers), and `alto` is the cross-grain dimension (depth `z_f`).
4. **Edge Banding (`edges`):**
   - `top` and `bottom` have length `ancho` (`top` = front visible `+Z` edge); `left` and `right` have length `alto`.
   - Durolac 3 mm back panel has `respectGrain: false` and all `edges` set to `false`.
5. **CRITICAL — Mixed-Bay Joint Deductions (Both Crossings AND Endpoints):**
   - Interior cavity spans `x ∈ [e, x_f - e]` (`x_int = x_f - 2e`) and `y ∈ [e, y_f - e]` (`y_int = y_f - 2e`).
   - Vertical dividers (`vDividers`) are continuous over `[start, end]`.
   - When computing a horizontal shelf over `[uStart, uEnd]`:
     - Split it at every `vDivider` strictly inside `(uStart, uEnd)` whose vertical span overlaps the shelf's `v`, deducting `e / 2` on each side of the divider center.
     - **ALSO check boundary contacts:** if `|uStart - div.position| <= 1e-3` (shelf starts at a vertical divider, NOT at outer wall `u = 0`), shift its left face right by `+e / 2`; if `|uEnd - div.position| <= 1e-3` (shelf ends at a vertical divider, NOT at outer wall `u = 1`), shift its right face left by `-e / 2`.
     - Verify invariant: sum of bay widths + `(numDividers + 2) * e === x_f` with zero 3D overlap.

## v2.1 Amendments (apply in Bloque 1 BEFORE freezing — see docs/ANALISIS_TECNICO_v2.1.md §5)
- **Coordinate space is normative:** `NormalizedSegment` is ALWAYS INTERIOR space. Photo/homography output is
  EXTERIOR space -> convert with `exteriorToInterior(p, e, dim) = (p - e/dim) / (1 - 2e/dim)` (+ inverse).
  Mandatory test: `exteriorToInterior(0.25, 18, 800) ≈ 0.2382`.
- **New OPTIONAL fields (defaults keep v2.0 tests valid):**
  - `FurnitureTopology.detectionSource?: 'manual' | 'auto' | 'preset'`, `detectionConfidence?: number` (0..1).
  - `ScaleAndBoardParams.trimMm?: number` (default 0), `packingStrategy?: 'guillotine' | 'maxrects'`
    (default `'guillotine'`), `backPanelSheetDimensions?: { width; height }` (default = `sheetDimensions`).
- Back panel split also when ONE side exceeds the sheet's LONG side.
- **Verified toolchain (pin exactly):** react/react-dom `18.3.1`, three + @types/three `0.162.0`,
  @react-three/fiber `8.18.0`, @react-three/drei `9.122.0`, vite `^6.3.5`, vitest `^3.2.4`,
  @vitejs/plugin-react `^4.3.4`, typescript `~5.8.3`. Never `vite@latest` (8.x unverified).
- **Termux only:** `/usr/bin/env` is missing so `npm run`/`npx` print `sh: <bin>: not found`. Run
  `node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc -b`,
  `node node_modules/vite/bin/vite.js build`. If `node_modules/.bin` is incomplete, run `npm rebuild`.

## Block Execution Gatekeeper
Never advance to the next block until all gates pass:
- **Pre-Bloque 1 (Termux/Linux):** Verify `node -v` and `npm -v` are installed (on Termux: `pkg install nodejs-lts`).
- **Bloque 1:** `npx vitest run` 100% green (`mathEngine.test.ts` including Etapa 2 exact check).
- **Bloque 2:** `npx vitest run` 100% green (Bloque 1 + `cuttingStock.test.ts`).
- **Bloque 3 & 4:** `npx vitest run && npm run build` 100% green with zero TypeScript errors and zero external URLs in `src/`.
