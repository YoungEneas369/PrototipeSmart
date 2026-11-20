# SmartFurniture Frozen Contracts Reference (`src/types/contracts.ts`)

## Exact Required Types
- `MelamineMaterial = 'blanco' | 'roble' | 'grafito'`
- `PieceMaterial = MelamineMaterial | 'durolac_3mm'`
- `PieceType = 'cubierta' | 'base' | 'lateral' | 'division_vertical' | 'repisa' | 'fondo'`
- `Point2D = { x: number; y: number }`
- `NormalizedSegment = { id: string; position: number; start: number; end: number }`
  - Space: interior `[0, 1]^2`; `u = 0` left -> `1` right; `v = 0` base -> `1` top.
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
- `ScaleAndBoardParams`:
  - `targetDimensions: { x: number; y: number; z: number }`
  - `referenceDimensions: { x: number; y: number; z: number }`
  - `boardThickness: number` (default `18`)
  - `backPanelThickness: number` (default `3`)
  - `sheetDimensions: { width: number; height: number }` (default `{ width: 2440, height: 1220 }`)
  - `kerf: number` (default `4.0`, range `3.2`–`4.0`)
  - `respectGrain: boolean`
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

## Official Demo Presets Exact Verification
1. **Estantería (`estanteria`):** `V_f = (800, 1800, 320)`, `equidistant`, `N = 4`, `vDividers = []`, `hasBackPanel = false`, `topOverSides`.
   - `x_int = 764 mm` (no pandeo; triggers when `x_f > 886 mm`).
   - `H_int = 1764 mm`, `s_libre = 338.4 mm`, `d = 356.4 mm`, `terms = [356.4, 712.8, 1069.2, 1425.6]`.
2. **Rack de TV (`rack_tv`):** `V_f = (1600, 550, 400)`, `custom`, `vDividers` at `u = 1/3, 2/3` (`[0, 1]`), 1 shelf at `v = 0.5` (`[1/3, 2/3]`), `hasBackPanel = false`, `topBetweenSides`.
   - Center shelf net width: `(1564 / 3) - 18 ≈ 503.33 mm` (NOT `521.33 mm`).
3. **Clóset (`closet`):** `V_f = (1500, 2100, 550)`, `custom`, `vDivider` at `u = 0.5`, 3 left shelves (`v = 0.25, 0.5, 0.75` on `[0, 0.5]`), 1 right shelf (`v = 0.82` on `[0.5, 1]`), `hasBackPanel = true`, `topOverSides`.
   - Left/right bay shelf widths: `723 mm` each (`18 + 723 + 18 + 723 + 18 = 1500 mm`).
   - Back panel split along `u = 0.5` into 2 panels `750 × 2100 × 3 mm`.
