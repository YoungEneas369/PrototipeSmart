---
name: r3f-offline-parametric-viewer
description: >-
  Use this skill when installing Three.js / React Three Fiber dependencies or
  building src/components/viewer3d/Viewer3D.tsx and MathPanel.tsx (Bloque 3).
  Prevents Three.js r170+ version conflicts with R3F v8/Drei v9, blocks hidden
  CDN network calls, and guides procedural textures, exploded view, and CSV export.
---

# Offline React Three Fiber Parametric 3D Viewer (v2.1 Rev. 2)

## 1. Safe Pinned Dependency Matrix (Critical Anti-Breakage Rule)
Running unpinned `npm install three` installs `three@0.17x–0.18x+`, which **breaks `@react-three/fiber@^8` and `@react-three/drei@^9`** (JSX `ThreeElements` type mismatches and removed legacy Three.js APIs).

Always pin compatible versions together:
```json
{
  "react": "18.3.1",
  "react-dom": "18.3.1",
  "three": "0.162.0",
  "@react-three/fiber": "8.18.0",
  "@react-three/drei": "9.122.0",
  "lucide-react": "^0.454.0"
}
```
And devDependencies:
```json
{
  "@types/react": "^18.3.12",
  "@types/react-dom": "^18.3.1",
  "@types/three": "0.162.0",
  "@vitejs/plugin-react": "^4.3.4",
  "typescript": "~5.8.3",
  "vite": "^6.3.5",
  "vitest": "^3.2.4"
}
```
VERIFIED on 2026-11-20 (`vitest` ✅, `tsc -b` strict ✅, `vite build` ✅, bundle free of network requests) in [toolchain-spike](../../../docs/evidencia/toolchain-spike/). Run the offline URL grep on `src/` and `index.html` (never on `dist/`, which always contains XML namespace strings like `w3.org` and React/Three error doc URLs).

## 2. Strict Offline Guardrails (Zero Hidden CDN Requests)
- **FORBIDDEN:**
  - `<Environment preset="..." />` (fetches HDRI from remote CDN).
  - `<Text />` / `<Text3D />` without a bundled local font file (fetches Troika default font from CDN).
  - External Google Fonts `<link>`, `@import url("https://...")`, or remote image URLs.
- **APPROVED (100% Offline):**
  - Native Three.js lights: `<ambientLight />`, `<hemisphereLight />`, `<directionalLight />`.
  - Procedural `THREE.CanvasTexture` generated in-memory via `<canvas>`.
  - `@react-three/drei`: `<OrbitControls />`, `<Edges />`, `<Line />`, `<Html />` (styled with `font-family: system-ui, -apple-system, sans-serif`).
  - Native `<gridHelper />`.

## 3. Viewer3D Implementation Pattern (`src/components/viewer3d/Viewer3D.tsx`)
1. **Units & Centering:** Convert mm to meters (`* 0.001`) and wrap boards in `<group position={[-x_f / 2000, 0, -z_f / 2000]}>` so the furniture sits centered on `y = 0`.
2. **Board Rendering:** Render each `piece` in `despiece.matrizDespiece` as `<mesh position={...}>` with `<boxGeometry args={[dx / 1000, dy / 1000, dz / 1000]} />` + `<Edges color={isAlerted ? '#ef4444' : '#334155'} />`.
3. **Procedural CanvasTextures (Memory-Safe):** Generate inside `useMemo` and dispose in `useEffect(() => () => tex.dispose(), [tex])`:
   - `blanco`: warm satin matte white (`#f5f5f4`) with subtle micro-grain.
   - `roble`: warm oak base (`#d4a973`) with procedural wood fibers aligned along the panel's `ancho` axis.
   - `grafito`: matte dark slate (`#374151`) with fine satin texture.
   - `durolac_3mm`: smooth rear kraft/off-white backing (`#d6c7b2`).
4. **Pandeo Alert Highlighting:** Check `alertedIds = new Set(despiece.alerts.map(a => a.piezaId))` and tint alerted shelves amber/red (`#f59e0b` / `#ef4444`).
5. **Exploded View (`explodeFactor` in `0..1`):** Offset each piece from furniture center `C = [x_f/2, y_f/2, z_f/2]` along normalized `(P - C)` scaled by `explodeFactor * 180 mm`; for `tipo === 'fondo'`, push `-Z` (`-explodeFactor * 220 mm`).
6. **3D Dimension Annotations:** Draw X (`x_f mm`), Y (`y_f mm`), and Z (`z_f mm`) lines outside the bounding box with `<Line />` + `<Html center>`.

## 4. MathPanel & Export Rules (`src/components/mathPanel/MathPanel.tsx`)
- Display live `V_f`, `V_0` (with **"Fijar V₀ actual"** button), `kx/ky/kz`, `e = 18 mm` invariance note, arithmetic progression (`H_int, s_libre, a1, d, terms`), homography matrix `H (3×3)` when available, `n × 3` vs `n × 5` matrix transition, mechanical alerts, sheet format selector (`2440×1220` default vs Chile `2500×1830` + `2440×1520`), strategy (`guillotine` / `maxrects`), and interactive SVG preview.
- **CSV Export:** Prefix with UTF-8 BOM `\uFEFF` (`new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })`).
- **SVG Export:** Export `cuttingPlan.svgMarkup` as `image/svg+xml;charset=utf-8`.

## Verification Checklist
- [ ] `tsc -b && vite build` succeeds with zero TypeScript errors (especially JSX `ThreeElements`).
- [ ] Zero `http://` or `https://` URLs inside `src/` or `index.html`.
- [ ] Moving sliders updates 3D meshes, exploded view, math formulas, alerts, and SVG synchronously in desktop browser offline mode.
