# SmartFurniture Frozen Contracts Reference (`src/types/contracts.ts` — v2.1 Rev. 2)

## Exact Required Types
- `MelamineMaterial = 'blanco' | 'roble' | 'grafito'`
- `PieceMaterial = MelamineMaterial | 'durolac_3mm'`
- `PieceType = 'cubierta' | 'base' | 'lateral' | 'division_vertical' | 'repisa' | 'fondo'`
- `Point2D = { x: number; y: number }`
- `NormalizedSegment = { id: string; position: number; start: number; end: number }`
  - Space: **INTERIOR** `[0, 1]^2` (normative); `u = 0` left inner face (`x = e`) -> `1` right inner face (`x = x_f - e`); `v = 0` base top face (`y = e`) -> `1` top underside (`y = y_f - e`).
  - For `'custom'` horizontal shelves, `position` (`v`) is the shelf **vertical center** (`cy = e + v * y_int`).
  - Photo/homography coordinates are EXTERIOR -> convert via `exteriorToInterior(p, e, dim)`.
- `FurnitureTopology`:
  - `viewsMode: 1 | 2`
  - `aspectRatioXY: number`
  - `aspectRatioZY?: number`
  - `quadCorners?: [Point2D, Point2D, Point2D, Point2D]` (strict clockwise `[TL, TR, BR, BL]` mapped to `(0,1), (1,1), (1,0), (0,0)`)
  - `homographyMatrix?: number[][]`
  - `vDividers: NormalizedSegment[]`
  - `hShelves: NormalizedSegment[]`
  - `shelfMode: 'equidistant' | 'custom'`
  - `equalShelfCount: number`
  - `hasBackPanel: boolean`
  - `detectionSource?: 'manual' | 'auto' | 'preset'` *(v2.1)*
  - `detectionConfidence?: number` *(v2.1, range `0..1`; `< 0.5` triggers manual-review prompt)*
- `ScaleAndBoardParams`:
  - `targetDimensions: { x: number; y: number; z: number }`
  - `referenceDimensions: { x: number; y: number; z: number }`
  - `boardThickness: number` (default `18`)
  - `backPanelThickness: number` (default `3`)
  - `sheetDimensions: { width: number; height: number }` (default `{ width: 2440, height: 1220 }`; Chile option `{ width: 2500, height: 1830 }`)
  - `backPanelSheetDimensions?: { width: number; height: number }` *(v2.1, default = `sheetDimensions`; Chile Durolac option `{ width: 2440, height: 1520 }`)*
  - `trimMm?: number` *(v2.1, squaring trim per edge, default `0`; shop option `10`–`15` mm)*
  - `kerf: number` (default `4.0`, range `3.2`–`4.0`)
  - `respectGrain: boolean`
  - `packingStrategy?: 'guillotine' | 'maxrects'` *(v2.1, default `'guillotine'`)*
  - `cornerJointType: 'topOverSides' | 'topBetweenSides'`
  - `edgeBandingMode: 'fullPerimeter' | 'visibleEdgesOnly'`
  - `material: MelamineMaterial`
- `EdgeBandingFlags = { top: boolean; bottom: boolean; left: boolean; right: boolean }`
- `BoardPiece`:
  - `id: string; nombre: string; tipo: PieceType; ancho: number; alto: number; espesor: number; cantidad: number; respectGrain: boolean; edges: EdgeBandingFlags; posicion3D: [number, number, number]; dimensiones3D: [number, number, number]; rotacion3D: [number, number, number]; material: PieceMaterial`
- `StructuralAlert`:
  - `id: string; severidad: 'warning' | 'critical'; tipo: 'pandeo' | 'dimension_invalida' | 'sobredimension_plancha'; mensaje: string; piezaId: string; luzLibreMm?: number`
- `ShelfProgressionData = { count: number; hInteriorMm: number; clearSpanMm: number; a1: number; d: number; terms: number[] }`
- `MatrixNx5Row = { nombre: string; ancho: number; alto: number; espesor: number; cantidad: number; material: PieceMaterial }`
- `DespieceResult`:
  - `scaleFactors: { kx: number; ky: number; kz: number }`
  - `shelfProgression: ShelfProgressionData`
  - `matrizDespiece: BoardPiece[]`
  - `matrixNx3: [number, number, number][]`
  - `matrixNx5: [number, number, number, number, PieceMaterial][]`
  - `consolidatedRows: MatrixNx5Row[]`
  - `totalNetAreaM2: number; backPanelAreaM2: number; totalEdgeBandingMeters: number; alerts: StructuralAlert[]`
- `BaseMatrixScaleResult`:
  - `scaledMatrix: [number, number, number][]; originalAreaM2: number; scaledAreaM2: number; originalEdgeBandingMeters: number; scaledEdgeBandingMeters: number`
- `PlacedRectangle = { idPieza: string; nombre: string; x: number; y: number; ancho: number; alto: number; rotado: boolean }`
- `SheetLayout = { sheetId: number; espesorMm: number; materialLabel: string; anchoSheet: number; altoSheet: number; piezasColocadas: PlacedRectangle[]; usoPorcentaje: number; desperdicioPorcentaje: number }`
- `CuttingPlanResult`:
  - `sheetsUsed: SheetLayout[]; unplacedPieces: BoardPiece[]; totalSheetsCount: number; melamineSheetsCount: number; backPanelSheetsCount: number; usagePercentage: number; wastePercentage: number; svgMarkup: string`

## Pure Coordinate Helpers (`src/core/mathEngine/index.ts`)
- `exteriorToInterior(p, e, dim) = (p - e / dim) / (1 - (2 * e) / dim)`
- `interiorToExterior(p, e, dim) = p * (1 - (2 * e) / dim) + e / dim`
- Mandatory test: `exteriorToInterior(0.25, 18, 800) ≈ 0.238219895`

## Official Demo Presets Exact Verification
1. **Estantería (`estanteria`):** `V_f = (800, 1800, 320)`, `equidistant`, `N = 4`, `vDividers = []`, `hasBackPanel = false`, `topOverSides`.
   - `x_int = 764 mm` (no pandeo; triggers when `x_f > 886 mm`).
   - `H_int = 1764 mm`, `s_libre = 338.4 mm`, `d = 356.4 mm`, `terms = [356.4, 712.8, 1069.2, 1425.6]`.
2. **Rack de TV (`rack_tv`):** `V_f = (1600, 550, 400)`, `custom`, `vDividers` at exact `u = 1 / 3` and `2 / 3` (`[0, 1]`), 1 shelf at `v = 0.5` (`[1 / 3, 2 / 3]`), `hasBackPanel = false`, `topBetweenSides`.
   - Center shelf net width: `(1564 / 3) - 18 = 503.333... mm` (NOT `521.33 mm` and NOT `504.38 mm` from rounded `0.333/0.667`).
3. **Clóset (`closet`):** `V_f = (1500, 2100, 550)`, `custom`, `vDivider` at `u = 0.5`, 3 left shelves (`v = 0.25, 0.5, 0.75` on `[0, 0.5]`), 1 right shelf (`v = 0.82` on `[0.5, 1]`), `hasBackPanel = true`, `topOverSides`.
   - Left/right bay shelf widths: `723 mm` each (`18 + 723 + 18 + 723 + 18 = 1500 mm`).
   - Back panel split along `u = 0.5` into 2 panels `750 × 2100 × 3 mm`.
