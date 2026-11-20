---
name: r3f-offline-parametric-viewer
description: >-
  Use this skill when installing Three.js / React Three Fiber dependencies or
  building src/components/viewer3d/Viewer3D.tsx and MathPanel.tsx (Bloque 3).
  Prevents Three.js r170+ version conflicts with R3F v8/Drei v9, blocks hidden
  CDN network calls, and guides procedural textures, exploded view, and CSV export.
---

# Offline React Three Fiber Parametric 3D Viewer

## 1. Safe Pinned Dependency Matrix (Critical Anti-Breakage Rule)
Running unpinned `npm install three` installs `three@0.17x–0.18x+`, which **breaks `@react-three/fiber@^8` and `@react-three/drei@^9`** (JSX `ThreeElements` type mismatches and removed legacy Three.js APIs).

Always pin compatible versions together:
```json
{
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "three": "0.162.0",
  "@react-three/fiber": "8.18.0",
  "@react-three/drei": "9.122.0",
  "lucide-react": "^0.454.0"
}
```
VERIFIED on 2026-11-20 (vitest ✅, `tsc -b` strict ✅, `vite build` ✅, bundle free of network requests) with
vite `^6.3.5`, vitest `^3.2.4`, @vitejs/plugin-react `^4.3.4`, typescript `~5.8.3`.
Reference config: [toolchain-spike](../../../docs/evidencia/toolchain-spike/). Note: `dist/` always contains
XML namespace URLs (`w3.org`) and React/three error-doc strings — these are NOT network calls; run the offline
grep on `src/` and `index.html`.
And devDependencies:
```json
{
  "@types/react": "^18.3.12",
  "@types/react-dom": "^18.3.1",
  "@types/three": "0.162.0"
}
```

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
1. **Units & Centering:**
   - Convert mm to meters (`* 0.001`).
   - Wrap all boards in a `<group position={[-x_f / 2000, 0, -z_f / 2000]}>` so the furniture sits centered on the floor `y = 0`.
2. **Board Rendering:**
   - Render each `piece` in `despiece.matrizDespiece` as `<mesh position={...}>` with `<boxGeometry args={[dx / 1000, dy / 1000, dz / 1000]} />`.
   - Attach `<Edges color={isAlerted ? '#ef4444' : '#334155'} />` to every board for crisp architectural readability.
3. **Procedural CanvasTextures (Memory-Safe):**
   - Generate textures inside `useMemo` and dispose them in `useEffect(() => () => tex.dispose(), [tex])`:
     - `blanco`: warm satin matte white (`#f5f5f4`) with subtle micro-grain.
     - `roble`: warm oak base (`#d4a973`) with layered procedural wood fibers/veins oriented along the panel's `ancho` axis.
     - `grafito`: matte dark slate (`#374151`) with fine satin texture.
     - `durolac_3mm`: smooth rear kraft/off-white backing (`#d6c7b2`).
4. **Pandeo Alert Highlighting:**
   - Check `alertedIds = new Set(despiece.alerts.map(a => a.piezaId))`.
   - Highlight alerted shelves with an amber/red emissive tint (`#f59e0b` / `#ef4444`) and bold edge color so changes appear immediately when toggling a center divider.
5. **Exploded View (`explodeFactor` in `0..1`):**
   - Compute furniture center `C = [x_f / 2, y_f / 2, z_f / 2]`.
   - For each piece at `P = piece.posicion3D`, offset along normalized `(P - C)` scaled by `explodeFactor * maxOffsetMm` (e.g., `180 mm`); for `tipo === 'fondo'`, force strong `-Z` displacement (`-explodeFactor * 220 mm`).
6. **3D Dimension Annotations:**
   - Draw X (`x_f mm`), Y (`y_f mm`), and Z (`z_f mm`) dimension lines slightly outside the bounding box using `<Line />` + `<Html center>` pills.

## 4. MathPanel & Export Rules (`src/components/mathPanel/MathPanel.tsx`)
- Display live `V_f`, `V_0` (with **"Fijar V₀ actual"** button), `kx/ky/kz`, `e = 18 mm` invariance note, arithmetic progression (`H_int, s_libre, a1, d, terms`), `n × 3` vs `n × 5` matrix transition, mechanical alerts, and interactive SVG cutting plan preview.
- **CSV Export:** Prefix content with UTF-8 BOM `\uFEFF` (`new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })`) so Spanish accents open cleanly in Excel.
- **SVG Export:** Export `cuttingPlan.svgMarkup` as `image/svg+xml;charset=utf-8`.

## Verification Checklist
- [ ] `npm run build` succeeds with zero TypeScript errors (especially JSX ThreeElements).
- [ ] No `http://` or `https://` URLs inside `src/` or `index.html`.
- [ ] Moving sliders updates 3D meshes, exploded view, math formulas, alerts, and SVG synchronously.
