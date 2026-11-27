import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  FurnitureTopology,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  CHILE_DUROLAC_SHEET,
  CHILE_MELAMINE_SHEET,
  ETAPA2_BASE_MATRIX_M0,
  buildCornerFilletCutSpec,
  calculateDespiece,
  clonePreset,
  computeQuadToUnitHomography,
  interiorToExterior,
  scaleBaseMatrix,
  type PresetKey,
} from '../../core/mathEngine';
import { isHandDrawnSketchImage, vectorizeUserStroke, classifyPartitionedZonesFromPhoto, partitionCellsFromVectors } from '../../core/vision';
import {
  estimateProjectBomAndCost,
  formatClp,
  generateCuttingPlan,
} from '../../core/cuttingStock';
import { CATALOG_14_MUEBLES, cloneCatalogFurniture } from '../../core/vectorBlueprint';
import { NumericInput } from '../NumericInput';
import { ZoneInspector } from '../vectorCanvas/ZoneInspector';
import { LineSelectionBar } from '../vectorCanvas/LineSelectionBar';
import { CanvasTopBars } from '../vectorCanvas/CanvasToolbars';
import { buildSnapshotFromState } from '../vectorCanvas/useCanvasHistory';
import { MathPanel } from '../mathPanel/MathPanel';
import { VectorBlueprintPanel } from '../vectorBlueprint/VectorBlueprintPanel';
import type { Viewer3DProps } from '../viewer3d/Viewer3D';
import {
  canEditPiecePositionIn3D,
  changeZoneKindFrom3D,
  compute3DEditHandlePositions,
  nudgeDividerMmIn3D,
  nudgeShelfMmIn3D,
  removeDividerIn3D,
  removeShelfIn3D,
  splitZoneIn3D,
  updateCubiertaMaterialIn3D,
  updateZoneFrom3D,
} from '../viewer3d/viewer3dEditHelpers';
import {
  PAPER_GRID_STEP_PRESETS,
  computePaperGridSpacing,
  findMergeableNeighbors,
  fitBlankSketchDrawnOuterBox,
  getZoneInteriorDimsMm,
  hitTestFrameScreenPx,
  hitTestLinesScreenPx,
  hitTestPlaneLinesScreenPx,
  makeAxisAlignedQuad,
  matchZoneIdByCentroid,
  mergeZoneWithNeighbor,
  resizeZoneDimensionMm,
  snapNormToPaperGridMm,
  snapPointInUnitQuad,
  snapPointToStructuralAnchors,
  splitZoneTopology,
} from '../vectorCanvas/geometryHelpers';

const noop = () => {};

function makeTestParams(overrides?: Partial<ScaleAndBoardParams>): ScaleAndBoardParams {
  return {
    targetDimensions: { x: 1000, y: 800, z: 400 },
    referenceDimensions: { x: 1000, y: 800, z: 400 },
    boardThickness: 18,
    backPanelThickness: 3,
    sheetDimensions: { ...CHILE_MELAMINE_SHEET },
    backPanelSheetDimensions: { ...CHILE_DUROLAC_SHEET },
    trimMm: 0,
    kerf: 4,
    respectGrain: true,
    packingStrategy: 'guillotine',
    cornerJointType: 'topOverSides',
    edgeBandingMode: 'visibleEdgesOnly',
    material: 'blanco',
    ...overrides,
  };
}

function makeTwoColumnTopology(): FurnitureTopology {
  return {
    viewsMode: 1,
    aspectRatioXY: 1000 / 800,
    vDividers: [{ id: 'div_mid', position: 0.5, start: 0, end: 1 }],
    hShelves: [],
    shelfMode: 'custom',
    equalShelfCount: 0,
    hasBackPanel: true,
    detectionSource: 'manual',
    frontZones: [
      { id: 'z_left', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 1, kind: 'open', label: 'Vano Izq' },
      {
        id: 'z_right',
        uStart: 0.5,
        uEnd: 1,
        vStart: 0,
        vEnd: 1,
        kind: 'baskets',
        basketCount: 4,
        label: 'Canastos Der',
      },
    ],
    hardwareItems: [],
  };
}

function makeSingleZoneTopology(): FurnitureTopology {
  return {
    viewsMode: 1,
    aspectRatioXY: 1000 / 800,
    vDividers: [],
    hShelves: [],
    shelfMode: 'custom',
    equalShelfCount: 0,
    hasBackPanel: false,
    detectionSource: 'manual',
    frontZones: [
      { id: 'z_root', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'open', label: 'Cuerpo' },
    ],
    hardwareItems: [],
  };
}

describe('SmartFurniture v8.0 — 1. Smoke SSR / Renderización UI sin crash', () => {
  it('NumericInput renderiza correctamente ariaLabel, unitSuffix y value (entero y decimal)', () => {
    const htmlInt = renderToStaticMarkup(
      <NumericInput
        value={1250}
        min={300}
        max={2600}
        step={10}
        unitSuffix="mm"
        ariaLabel="Ancho objetivo en mm"
        onCommit={noop}
      />,
    );

    expect(htmlInt).toContain('aria-label="Ancho objetivo en mm"');
    expect(htmlInt).toContain('value="1250"');
    expect(htmlInt).toContain('inputMode="numeric"');
    expect(htmlInt).toContain('class="numeric-unit-suffix"');
    expect(htmlInt).toContain('>mm<');

    const htmlDec = renderToStaticMarkup(
      <NumericInput
        value={82.5}
        min={30}
        max={260}
        step={0.5}
        allowDecimals
        unitSuffix="cm"
        ariaLabel="Ancho objetivo en cm"
        onCommit={noop}
      />,
    );

    expect(htmlDec).toContain('aria-label="Ancho objetivo en cm"');
    expect(htmlDec).toContain('value="82.5"');
    expect(htmlDec).toContain('inputMode="decimal"');
    expect(htmlDec).toContain('>cm<');
  });

  it('ZoneInspector muestra medidas interiores reales (x_f - 2e), Split/Merge, paleta de 9 tipos, canastos 1..6 y repisas 0..5', () => {
    const params = makeTestParams({ targetDimensions: { x: 1000, y: 800, z: 400 }, boardThickness: 18 });
    const topology = makeTwoColumnTopology();

    // Zona izquierda abierta (u:[0, 0.5], v:[0, 1]) -> xInt = 964 -> 482 mm; yInt = 764 mm (NO 500×800)
    const htmlOpen = renderToStaticMarkup(
      <ZoneInspector
        topology={topology}
        params={params}
        selectedZoneId="z_left"
        hoveredZoneId={null}
        onSelectZone={noop}
        onHoverZone={noop}
        onUpdateTopology={noop}
        onUpdateFrontZones={noop}
      />,
    );

    expect(htmlOpen).toContain('482 × 764 mm');
    expect(htmlOpen).toContain('(48.2 × 76.4 cm int.)');
    expect(htmlOpen).not.toContain('500 × 800 mm');

    // Botones Split / Merge
    expect(htmlOpen).toContain('+ 2 col.');
    expect(htmlOpen).toContain('+ 2 filas');
    expect(htmlOpen).toContain('Unir con Z2 (Der.)');

    // Paleta completa de 9 tipos de parte
    const expectedKinds = [
      'Nicho abierto',
      'Puerta izq.',
      'Puerta der.',
      'Puerta doble',
      'Vitrina vidrio',
      'Cajones',
      'Canastos',
      'Hueco piernas',
      'Recorte vacío',
    ];
    for (const label of expectedKinds) {
      expect(htmlOpen).toContain(label);
    }

    // Selector de repisas interiores 0..5
    expect(htmlOpen).toContain('Repisas interiores:');
    for (let n = 0; n <= 5; n++) {
      expect(htmlOpen).toContain(`>${n}</button>`);
    }

    // Zona derecha tipo canastos -> selector canastos 1..6
    const htmlBaskets = renderToStaticMarkup(
      <ZoneInspector
        topology={topology}
        params={params}
        selectedZoneId="z_right"
        hoveredZoneId={null}
        onSelectZone={noop}
        onHoverZone={noop}
        onUpdateTopology={noop}
        onUpdateFrontZones={noop}
      />,
    );

    expect(htmlBaskets).toContain('Canastos:');
    for (let n = 1; n <= 6; n++) {
      expect(htmlBaskets).toContain(`>×${n}</button>`);
    }
  });

  it('LineSelectionBar renderiza edición en mm para vDivider, hShelf y diagonal', () => {
    const params = makeTestParams({ targetDimensions: { x: 1000, y: 800, z: 400 }, boardThickness: 18 });
    const topology: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: 1000 / 800,
      vDividers: [{ id: 'vd1', position: 0.5, start: 0, end: 1 }],
      hShelves: [{ id: 'hs1', position: 0.5, start: 0, end: 1 }],
      diagonalDividers: [{ id: 'dg1', u1: 0, v1: 0, u2: 0.5, v2: 0.5 }],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: false,
      detectionSource: 'manual',
    };

    const htmlV = renderToStaticMarkup(
      <LineSelectionBar
        selectedLine={{ kind: 'vDivider', id: 'vd1' }}
        topology={topology}
        params={params}
        onUpdateVDivider={noop}
        onUpdateHShelf={noop}
        onUpdateDiagonal={noop}
        onDeleteSelected={noop}
        onDeselect={noop}
      />,
    );
    expect(htmlV).toContain('Divisor vertical');
    expect(htmlV).toContain('Desde izq.:');
    expect(htmlV).toContain('value="500"'); // e(18) + 0.5 * 964 = 500 mm
    expect(htmlV).toContain('Largo real: <strong>764 mm</strong>');

    const htmlH = renderToStaticMarkup(
      <LineSelectionBar
        selectedLine={{ kind: 'hShelf', id: 'hs1' }}
        topology={topology}
        params={params}
        onUpdateVDivider={noop}
        onUpdateHShelf={noop}
        onUpdateDiagonal={noop}
        onDeleteSelected={noop}
        onDeselect={noop}
      />,
    );
    expect(htmlH).toContain('Repisa horizontal');
    expect(htmlH).toContain('Desde base:');
    expect(htmlH).toContain('value="400"'); // e(18) + 0.5 * 764 = 400 mm
    expect(htmlH).toContain('Luz real: <strong>964 mm</strong>');

    const htmlD = renderToStaticMarkup(
      <LineSelectionBar
        selectedLine={{ kind: 'diagonal', id: 'dg1' }}
        topology={topology}
        params={params}
        onUpdateVDivider={noop}
        onUpdateHShelf={noop}
        onUpdateDiagonal={noop}
        onDeleteSelected={noop}
        onDeselect={noop}
      />,
    );
    expect(htmlD).toContain('División diagonal');
    expect(htmlD).toContain('X1:');
    expect(htmlD).toContain('Y1:');
    expect(htmlD).toContain('X2:');
    expect(htmlD).toContain('Y2:');
    expect(htmlD).toContain('Ángulo:');
    expect(htmlD).toContain('Invertir / ↔ \\');
  });

  it('MathPanel renderiza BOM CLP completo (fasteners + externalHardware == totalClp), precios editables, n×3/n×5 y formato Chile dinámico sin 244×122', () => {
    // Usar mueble #12 (tiene tanto fijaciones automáticas como herrajes externos: ruedas, canastos, bisagras, correderas)
    const cloned12 = cloneCatalogFurniture('m12_carro_cocina_escalonado')!;
    const chileParams: ScaleAndBoardParams = {
      ...cloned12.params,
      sheetDimensions: { ...CHILE_MELAMINE_SHEET },
      backPanelSheetDimensions: { ...CHILE_DUROLAC_SHEET },
    };
    const desp12 = calculateDespiece(cloned12.topology, chileParams);
    const plan12 = generateCuttingPlan(desp12.matrizDespiece, chileParams);
    const bom12 = estimateProjectBomAndCost(desp12, plan12, chileParams);

    expect(bom12.fasteners.length).toBeGreaterThan(0);
    expect(bom12.externalHardware.length).toBeGreaterThan(0);

    // Suma exacta BOM
    const fastenersSum = bom12.fasteners.reduce((acc, it) => acc + it.subtotalClp, 0);
    const externalSum = bom12.externalHardware.reduce((acc, it) => acc + it.subtotalClp, 0);
    const computedTotal =
      bom12.melamineSheetsClp +
      bom12.backPanelSheetsClp +
      bom12.edgeBandingClp +
      fastenersSum +
      externalSum;
    expect(computedTotal).toBe(bom12.totalClp);

    const htmlHerrajes = renderToStaticMarkup(
      <MathPanel
        despiece={desp12}
        cuttingPlan={plan12}
        topology={cloned12.topology}
        params={chileParams}
        requestedTab={{ tab: 'herrajes', seq: 1 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
        onUpdateCostConfig={noop}
      />,
    );

    // Ambas secciones de tabla BOM presentes con todos sus ítems y total cuadrado
    expect(htmlHerrajes).toContain('2. Fijaciones Automáticas');
    expect(htmlHerrajes).toContain('3. Herrajes y Accesorios Externos');
    for (const f of bom12.fasteners) {
      expect(htmlHerrajes).toContain(f.nombre);
    }
    for (const h of bom12.externalHardware) {
      expect(htmlHerrajes).toContain(h.nombre);
    }
    expect(htmlHerrajes).toContain(formatClp(bom12.totalClp));

    // Precios unitarios editables en CLP
    expect(htmlHerrajes).toContain('Editar precios unitarios CLP');
    expect(htmlHerrajes).toContain('Restaurar precios Chile');
    expect(htmlHerrajes).toContain('>CLP<');

    // Formato dinámico Chile (250×183 cm / 244×152 cm), cero texto fijo 244×122
    expect(htmlHerrajes).toContain('250×183 cm');
    expect(htmlHerrajes).toContain('244×152 cm');
    expect(htmlHerrajes).not.toContain('244×122');

    // Tab Corte 2D en formato Chile
    const htmlCorte = renderToStaticMarkup(
      <MathPanel
        despiece={desp12}
        cuttingPlan={plan12}
        topology={cloned12.topology}
        params={chileParams}
        requestedTab={{ tab: 'corte', seq: 2 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
        onUpdateCostConfig={noop}
      />,
    );
    expect(htmlCorte).toContain('250×183 cm');
    expect(htmlCorte).not.toContain('244×122');

    // Etiqueta n×3 vs n×5 en pestaña Matrices
    const est = clonePreset('estanteria'); // sin fondo -> n×3
    const despEst = calculateDespiece(est.topology, est.params);
    const planEst = generateCuttingPlan(despEst.matrizDespiece, est.params);
    const htmlNx3 = renderToStaticMarkup(
      <MathPanel
        despiece={despEst}
        cuttingPlan={planEst}
        topology={est.topology}
        params={est.params}
        requestedTab={{ tab: 'matrices', seq: 1 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
      />,
    );
    expect(htmlNx3).toContain('Auto (n×3)');
    expect(htmlNx3).toContain('Base n × 3');

    const cl = clonePreset('closet'); // con fondo 3 mm -> n×5
    const despCl = calculateDespiece(cl.topology, cl.params);
    const planCl = generateCuttingPlan(despCl.matrizDespiece, cl.params);
    const htmlNx5 = renderToStaticMarkup(
      <MathPanel
        despiece={despCl}
        cuttingPlan={planCl}
        topology={cl.topology}
        params={cl.params}
        requestedTab={{ tab: 'matrices', seq: 1 }}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
        onAddHardwareItem={noop}
        onRemoveHardwareItem={noop}
      />,
    );
    expect(htmlNx5).toContain('Auto (n×5)');
    expect(htmlNx5).toContain('Extendida n × 5');
  });

  it('VectorBlueprintPanel embebe ZoneInspector y muestra formato dinámico de plancha Chile (250×183 cm)', () => {
    const cloned03 = cloneCatalogFurniture('m03_buffet_nordico')!;
    const chileParams: ScaleAndBoardParams = {
      ...cloned03.params,
      sheetDimensions: { ...CHILE_MELAMINE_SHEET },
      backPanelSheetDimensions: { ...CHILE_DUROLAC_SHEET },
    };
    const desp = calculateDespiece(cloned03.topology, chileParams);
    const plan = generateCuttingPlan(desp.matrizDespiece, chileParams);

    const html = renderToStaticMarkup(
      <VectorBlueprintPanel
        topology={cloned03.topology}
        params={chileParams}
        despiece={desp}
        cuttingPlan={plan}
        modelApproved={false}
        displayUnit="mm"
        selectedZoneId={cloned03.topology.frontZones?.[0]?.id ?? null}
        hoveredZoneId={null}
        onSelectZone={noop}
        onHoverZone={noop}
        onUpdateDim={noop}
        onUpdateTopology={noop}
        onUpdateFrontZones={noop}
        onApproveModel={noop}
      />,
    );

    // ZoneInspector embebido
    expect(html).toContain('Inspector de Zonas y Módulos Frontales');
    expect(html).toContain('class="zi-card"');
    expect(html).toContain('class="zi-palette-grid"');
    expect(html).toContain('Puerta izq.');

    // Formato dinámico Chile (250×183 cm) sin 244×122 hardcodeado
    expect(html).toContain('250×183 cm');
    expect(html).not.toContain('244×122');
  });
});

describe('SmartFurniture v8.0 — 2. Lógica UX crítica (`geometryHelpers.ts`)', () => {
  it('getZoneInteriorDimsMm descuenta estrictamente 2 * boardThickness en X e Y', () => {
    const params18 = makeTestParams({
      targetDimensions: { x: 1200, y: 900, z: 400 },
      boardThickness: 18,
    });
    const full = getZoneInteriorDimsMm(
      { uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 },
      params18,
    );
    expect(full.xInt).toBe(1164);
    expect(full.yInt).toBe(864);
    expect(full.widthMm).toBe(1164);
    expect(full.heightMm).toBe(864);

    const quarter = getZoneInteriorDimsMm(
      { uStart: 0, uEnd: 0.5, vStart: 0.25, vEnd: 0.75 },
      params18,
    );
    expect(quarter.widthMm).toBe(582);
    expect(quarter.heightMm).toBe(432);

    const params15 = makeTestParams({
      targetDimensions: { x: 1200, y: 900, z: 400 },
      boardThickness: 15,
    });
    const full15 = getZoneInteriorDimsMm(
      { uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 },
      params15,
    );
    expect(full15.widthMm).toBe(1170);
    expect(full15.heightMm).toBe(870);
  });

  it('splitZoneTopology divide en 2 columnas o 2 filas sin solapamientos y mergeZoneWithNeighbor vuelve a unirlas', () => {
    const params = makeTestParams();
    const rootTopo = makeSingleZoneTopology();

    // 1) Split en 2 columnas -> verificar cero solapamiento + divisor vertical -> Merge de vuelta
    const splitCols = splitZoneTopology(rootTopo, params, 'z_root', 'cols', 2);
    expect(splitCols).not.toBeNull();
    const colsZones = splitCols!.topology.frontZones!;
    expect(colsZones).toHaveLength(2);
    expect(splitCols!.topology.vDividers).toHaveLength(1);
    expect(splitCols!.topology.vDividers[0].position).toBeCloseTo(0.5, 4);
    expect(colsZones[0].uStart).toBe(0);
    expect(colsZones[0].uEnd).toBeCloseTo(0.5, 4);
    expect(colsZones[1].uStart).toBeCloseTo(0.5, 4);
    expect(colsZones[1].uEnd).toBe(1);

    const colNeighbors = findMergeableNeighbors(splitCols!.topology, colsZones[0].id);
    expect(colNeighbors).toHaveLength(1);
    expect(colNeighbors[0].side).toBe('right');

    const mergedCols = mergeZoneWithNeighbor(
      splitCols!.topology,
      params,
      colsZones[0].id,
      colsZones[1].id,
    );
    expect(mergedCols).not.toBeNull();
    expect(mergedCols!.topology.frontZones).toHaveLength(1);
    expect(mergedCols!.topology.vDividers).toHaveLength(0);
    expect(mergedCols!.topology.frontZones![0].uStart).toBe(0);
    expect(mergedCols!.topology.frontZones![0].uEnd).toBe(1);

    // 2) Split en 2 filas -> verificar cero solapamiento + repisa horizontal -> Merge de vuelta
    const splitRows = splitZoneTopology(rootTopo, params, 'z_root', 'rows', 2);
    expect(splitRows).not.toBeNull();
    const rowsZones = splitRows!.topology.frontZones!;
    expect(rowsZones).toHaveLength(2);
    expect(splitRows!.topology.hShelves).toHaveLength(1);
    expect(splitRows!.topology.hShelves[0].position).toBeCloseTo(0.5, 4);

    // Ordenadas de arriba hacia abajo ([0.5, 1] y [0, 0.5]) sin solapamiento
    const [topZ, botZ] = rowsZones;
    expect(topZ.vStart).toBeCloseTo(0.5, 4);
    expect(topZ.vEnd).toBe(1);
    expect(botZ.vStart).toBe(0);
    expect(botZ.vEnd).toBeCloseTo(0.5, 4);

    const mergedRows = mergeZoneWithNeighbor(
      splitRows!.topology,
      params,
      topZ.id,
      botZ.id,
    );
    expect(mergedRows).not.toBeNull();
    expect(mergedRows!.topology.frontZones).toHaveLength(1);
    expect(mergedRows!.topology.hShelves).toHaveLength(0);
    expect(mergedRows!.topology.frontZones![0].vStart).toBe(0);
    expect(mergedRows!.topology.frontZones![0].vEnd).toBe(1);
  });

  it('resizeZoneDimensionMm ajusta ancho/alto interior desplazando divisor/repisa dentro de límites válidos', () => {
    const params = makeTestParams({ targetDimensions: { x: 1000, y: 800, z: 400 }, boardThickness: 18 });
    // xInt = 964 mm, yInt = 764 mm
    const twoCols = makeTwoColumnTopology();
    const resW = resizeZoneDimensionMm(twoCols, params, 'z_left', 'width', 300);
    expect(resW).not.toBeNull();
    expect(resW!.appliedMm).toBe(300);
    expect(resW!.topology.vDividers[0].position).toBeCloseTo(300 / 964, 3);
    expect(resW!.topology.frontZones![0].uEnd).toBe(resW!.topology.frontZones![1].uStart);

    // Clamping seguro al solicitar un ancho extremo (no colapsa la celda vecina)
    const resClamped = resizeZoneDimensionMm(twoCols, params, 'z_left', 'width', 9999);
    expect(resClamped).not.toBeNull();
    expect(resClamped!.topology.vDividers[0].position).toBeLessThan(0.96);
    expect(resClamped!.topology.frontZones![1].uEnd - resClamped!.topology.frontZones![1].uStart).toBeGreaterThanOrEqual(0.045);

    // Ajuste de altura en topología de 2 filas
    const splitRows = splitZoneTopology(makeSingleZoneTopology(), params, 'z_root', 'rows', 2)!;
    const bottomZone = splitRows.topology.frontZones!.find((z) => z.vStart === 0)!;
    const resH = resizeZoneDimensionMm(splitRows.topology, params, bottomZone.id, 'height', 250);
    expect(resH).not.toBeNull();
    expect(resH!.appliedMm).toBe(250);
    expect(resH!.topology.hShelves[0].position).toBeCloseTo(250 / 764, 3);
  });

  it('matchZoneIdByCentroid mantiene la selección de zona al desplazar levemente una línea', () => {
    const prevLeft = {
      id: 'old_left',
      uStart: 0,
      uEnd: 0.5,
      vStart: 0,
      vEnd: 1,
      kind: 'open' as const,
    };
    const prevRight = {
      id: 'old_right',
      uStart: 0.5,
      uEnd: 1,
      vStart: 0,
      vEnd: 1,
      kind: 'door_right' as const,
    };
    const nextZones = [
      { id: 'new_left', uStart: 0, uEnd: 0.56, vStart: 0, vEnd: 1, kind: 'open' as const },
      { id: 'new_right', uStart: 0.56, uEnd: 1, vStart: 0, vEnd: 1, kind: 'door_right' as const },
    ];

    expect(matchZoneIdByCentroid(prevLeft, nextZones)).toBe('new_left');
    expect(matchZoneIdByCentroid(prevRight, nextZones)).toBe('new_right');
  });

  it('hitTestFrameScreenPx detecta esquina, borde, interior y exterior en píxeles reales de pantalla', () => {
    const quad = makeAxisAlignedQuad(100, 100, 500, 400);
    const scaleX = 0.5;
    const scaleY = 0.5;

    // Esquina 0 (TL) a ~4.2 px de pantalla
    expect(hitTestFrameScreenPx({ x: 106, y: 106 }, quad, scaleX, scaleY)).toEqual({
      kind: 'corner',
      idx: 0,
    });
    // Esquina 2 (BR)
    expect(hitTestFrameScreenPx({ x: 496, y: 404 }, quad, scaleX, scaleY)).toEqual({
      kind: 'corner',
      idx: 2,
    });
    // Borde superior (edgeIdx 0) a 5 px de pantalla
    expect(hitTestFrameScreenPx({ x: 300, y: 110 }, quad, scaleX, scaleY)).toEqual({
      kind: 'edge',
      edgeIdx: 0,
    });
    // Borde izquierdo (edgeIdx 3) a 4 px de pantalla
    expect(hitTestFrameScreenPx({ x: 108, y: 250 }, quad, scaleX, scaleY)).toEqual({
      kind: 'edge',
      edgeIdx: 3,
    });
    // Interior
    expect(hitTestFrameScreenPx({ x: 300, y: 250 }, quad, scaleX, scaleY)).toEqual({
      kind: 'interior',
    });
    // Exterior
    expect(hitTestFrameScreenPx({ x: 20, y: 20 }, quad, scaleX, scaleY)).toBeNull();

    // Radio táctil ampliado (21 px en pantalla -> esquina en touch, no en mouse)
    const pt21px: Point2D = { x: 142, y: 100 }; // (42 * 0.5) = 21 px desde esquina 0
    expect(hitTestFrameScreenPx(pt21px, quad, scaleX, scaleY, false)).toEqual({
      kind: 'edge',
      edgeIdx: 0,
    });
    expect(hitTestFrameScreenPx(pt21px, quad, scaleX, scaleY, true)).toEqual({
      kind: 'corner',
      idx: 0,
    });
  });
});

describe('SmartFurniture v8.0 — 3. Integridad 6 Presets (Rectos y en L) + Etapa 2 + Catálogo 14 + Bicolor + BOM CLP', () => {
  it('Los 6 Presets oficiales y en L cumplen detectionSource="preset", corte completo sin piezas fuera y BOM CLP cuadrado', () => {
    const presetKeys: PresetKey[] = [
      'estanteria',
      'rack_tv',
      'closet',
      'escritorio_l',
      'cocina_l',
      'closet_l',
    ];

    for (const key of presetKeys) {
      const { topology, params } = clonePreset(key);
      expect(topology.detectionSource).toBe('preset');

      const despiece = calculateDespiece(topology, params);
      expect(despiece.matrizDespiece.length).toBeGreaterThanOrEqual(4);

      const plan = generateCuttingPlan(despiece.matrizDespiece, params);
      expect(plan.unplacedPieces, `Preset ${key} no debe dejar piezas fuera`).toHaveLength(0);
      expect(plan.usagePercentage + plan.wastePercentage).toBeCloseTo(100, 1);

      const bom = estimateProjectBomAndCost(despiece, plan, params);
      expect(bom.totalClp).toBeGreaterThan(0);
      expect(bom.totalClp).toBe(
        bom.melamineSheetsClp +
          bom.backPanelSheetsClp +
          bom.edgeBandingClp +
          bom.fastenersClp +
          bom.externalHardwareClp,
      );
    }
  });

  it('Validación matricial Etapa 2 (M = M0 · diag(1.2, 1.2, 1)) conserva valores exactos', () => {
    const res = scaleBaseMatrix(ETAPA2_BASE_MATRIX_M0, 1.2, 1.2);
    expect(res.originalAreaM2).toBeCloseTo(0.88, 4);
    expect(res.scaledAreaM2).toBeCloseTo(1.2672, 4);
    expect(res.originalEdgeBandingMeters).toBeCloseTo(6.8, 2);
    expect(res.scaledEdgeBandingMeters).toBeCloseTo(8.16, 2);
  });

  it('Catálogo 14 completo: detectionSource="preset", separación bicolor estricta (#03 y #14) y reconciliación 100 % CLP', () => {
    expect(CATALOG_14_MUEBLES).toHaveLength(14);

    for (const spec of CATALOG_14_MUEBLES) {
      const cloned = cloneCatalogFurniture(spec.id)!;
      expect(cloned.topology.detectionSource).toBe('preset');

      const despiece = calculateDespiece(cloned.topology, cloned.params);
      const plan = generateCuttingPlan(despOrFail(despiece), cloned.params);
      expect(plan.unplacedPieces, `[${spec.id}] piezas fuera de plancha`).toHaveLength(0);
      expect(plan.usagePercentage + plan.wastePercentage).toBeCloseTo(100, 1);

      // Invariante de pureza por plancha: jamás se mezclan 2 materiales o 2 espesores en una plancha
      for (const sh of plan.sheetsUsed) {
        expect(sh.material).toBeDefined();
        for (const r of sh.piezasColocadas) {
          expect(r.material, `[${spec.id}] mezcla de material en plancha #${sh.sheetId}`).toBe(
            sh.material,
          );
        }
      }

      // Reconciliación 100 % del presupuesto CLP
      const bom = estimateProjectBomAndCost(despiece, plan, cloned.params);
      const sumParts =
        bom.melamineSheetsClp +
        bom.backPanelSheetsClp +
        bom.edgeBandingClp +
        bom.fastenersClp +
        bom.externalHardwareClp;
      expect(bom.totalClp, `[${spec.id}] totalClp desbalanceado`).toBe(sumParts);

      const matBreakdown = Object.values(bom.melamineByMaterialClp ?? {});
      const matClpSum = matBreakdown.reduce((acc, info) => acc + (info?.clp ?? 0), 0);
      const matSheetsSum = matBreakdown.reduce((acc, info) => acc + (info?.sheets ?? 0), 0);
      expect(matClpSum).toBe(bom.melamineSheetsClp);
      expect(matSheetsSum).toBe(plan.melamineSheetsCount);
    }

    // Verificación explícita bicolor en #03 (Buffet Nórdico Blanco + Roble) y #14 (Cocina Bicolor Blanco + Roble)
    for (const bicolorId of ['m03_buffet_nordico', 'm14_cocina_bicolor_roble'] as const) {
      const cloned = cloneCatalogFurniture(bicolorId)!;
      const despiece = calculateDespiece(cloned.topology, cloned.params);
      const plan = generateCuttingPlan(despiece.matrizDespiece, cloned.params);
      const bom = estimateProjectBomAndCost(despiece, plan, cloned.params);

      const melamineSheets = plan.sheetsUsed.filter((s) => s.material !== 'durolac_3mm');
      const materialsPresent = new Set(melamineSheets.map((s) => s.material));
      expect(materialsPresent.has('blanco')).toBe(true);
      expect(materialsPresent.has('roble')).toBe(true);

      // Cada plancha tiene un único material y las planchas blanco vs roble son disjuntas
      for (const sh of melamineSheets) {
        const pieceMats = new Set(sh.piezasColocadas.map((p) => p.material));
        expect(pieceMats.size).toBe(1);
        expect(pieceMats.has(sh.material)).toBe(true);
      }

      expect(bom.melamineByMaterialClp?.blanco?.sheets).toBeGreaterThanOrEqual(1);
      expect(bom.melamineByMaterialClp?.roble?.sheets).toBeGreaterThanOrEqual(1);
      expect(bom.edgeBandingByMaterialMeters?.blanco).toBeGreaterThan(0);
      expect(bom.edgeBandingByMaterialMeters?.roble).toBeGreaterThan(0);
    }
  });

  it('VectorBlueprintPanel renderiza selector de Alas A/B y SVG Planta XZ cuando lShape está activo', () => {
    const desk = clonePreset('escritorio_l');
    const despiece = calculateDespiece(desk.topology, desk.params);
    const cuttingPlan = generateCuttingPlan(despiece.matrizDespiece, desk.params);

    const html = renderToStaticMarkup(
      <VectorBlueprintPanel
        topology={desk.topology}
        params={desk.params}
        despiece={despiece}
        cuttingPlan={cuttingPlan}
        modelApproved={false}
        displayUnit="mm"
        selectedZoneId="ezr2"
        editingWing="return"
        onChangeEditingWing={noop}
        onSelectZone={noop}
        onHoverZone={noop}
        onUpdateDim={noop}
        onUpdateTopology={noop}
        onUpdateFrontZones={noop}
        onApproveModel={noop}
      />,
    );

    expect(html).toContain('Ala Principal (A)');
    expect(html).toContain('Ala Retorno (B)');
    expect(html).toContain('Cajonera Retorno');
    expect(html).toContain('PLANTA SUPERIOR (PLANO XZ');
  });

  it('CanvasTopBars y MathPanel renderizan 3 vistas (Frente/Arriba/Lado), Medidas Razonables, Curva Bézier y Unidad 3 Diferencial', () => {
    const desk = clonePreset('escritorio_l');
    const curvedTop: FurnitureTopology = {
      ...desk.topology,
      viewsMode: 3,
      curvedCuts: [
        buildCornerFilletCutSpec({
          id: 'ui_curva_l',
          cornerTarget: 'l_inner',
          radiusMm: 160,
        }),
      ],
    };
    const despiece = calculateDespiece(curvedTop, desk.params);
    const cuttingPlan = generateCuttingPlan(despiece.matrizDespiece, desk.params);

    const barHtml = renderToStaticMarkup(
      <CanvasTopBars
        hasPhoto
        hasTopPhoto
        hasSidePhoto
        viewTab="frontal"
        traceStep="lines"
        frameMode="quad"
        pickingCorners={null}
        linesSubMode="smart"
        strokeMode="curve"
        subTool="none"
        magneticSnap
        calibRefMm={297}
        calibPtsCount={0}
        internalLineCount={2}
        curvedCount={1}
        zonesCount={3}
        subRegions={[]}
        xIntMm={1364}
        yIntMm={732}
        canUndo={false}
        canRedo
        undoCount={0}
        redoCount={2}
        zoom={1}
        panToolActive={false}
        isSpacePan={false}
        legHintDetected={false}
        hasExternalLegs={false}
        isCatalogReference={false}
        ranRealVisionOnCatalog={false}
        isLShape
        hasLInnerCurve
        onSelectStep={noop}
        onSetPlaneTraceStep={noop}
        onSwitchViewTab={noop}
        onUndo={noop}
        onRedo={noop}
        onZoomIn={noop}
        onZoomOut={noop}
        onZoomReset={noop}
        onTogglePanTool={noop}
        onUploadFrontPhoto={noop}
        onUploadTopPhoto={noop}
        onUploadSidePhoto={noop}
        onStartBlankSketch={noop}
        onRecognizeSketch={noop}
        onRunReasonableMeasures={noop}
        onToggleLInnerCurve={noop}
        onReturnToFrontal={noop}
        onChangeCalibRefMm={noop}
        onApplyCalibA4={noop}
        onExitSubTool={noop}
        onToggleSubTool={noop}
        onToggleFrameMode={noop}
        onStartPickCorners={noop}
        onCancelPickCorners={noop}
        onToggleMagneticSnap={noop}
        paperGridSnap
        paperGridStepMm={100}
        onTogglePaperGridSnap={noop}
        onStepPaperGridSize={noop}
        onAutoContour={noop}
        onClearLines={noop}
        onChangeLinesSubMode={noop}
        onRemoveSubRegion={noop}
        onClearSubRegions={noop}
        onDetectSubRegions={noop}
        onChangeStrokeMode={noop}
        onAutoSuggestLines={noop}
        onRunRealVisionOnCatalog={noop}
      />,
    );

    expect(barHtml).toContain('1. Frente (XY)');
    expect(barHtml).toContain('2. Arriba (XZ)');
    expect(barHtml).toContain('3. Lado (ZY)');
    expect(barHtml).toContain('Medidas razonables');
    expect(barHtml).toContain('Línea recta');
    expect(barHtml).toContain('>Curva<');
    expect(barHtml).toContain('Milimetrado');
    expect(barHtml).toContain('Rehacer (2)');
    expect(barHtml).toContain('Agrandar cuadrícula');
    expect(barHtml).toContain('Achicar cuadrícula');
    expect(barHtml).toContain('100mm');

    const topBarHtml = renderToStaticMarkup(
      <CanvasTopBars
        hasPhoto
        hasTopPhoto
        hasSidePhoto
        viewTab="superior"
        traceStep="lines"
        frameMode="quad"
        pickingCorners={null}
        linesSubMode="smart"
        strokeMode="curve"
        subTool="none"
        magneticSnap
        calibRefMm={297}
        calibPtsCount={0}
        internalLineCount={2}
        curvedCount={1}
        zonesCount={3}
        subRegions={[]}
        xIntMm={1364}
        yIntMm={732}
        canUndo={false}
        canRedo
        undoCount={0}
        redoCount={2}
        zoom={1}
        panToolActive={false}
        isSpacePan={false}
        legHintDetected={false}
        hasExternalLegs={false}
        isCatalogReference={false}
        ranRealVisionOnCatalog={false}
        isLShape
        hasLInnerCurve
        onSelectStep={noop}
        onSetPlaneTraceStep={noop}
        onSwitchViewTab={noop}
        onUndo={noop}
        onRedo={noop}
        onZoomIn={noop}
        onZoomOut={noop}
        onZoomReset={noop}
        onTogglePanTool={noop}
        onUploadFrontPhoto={noop}
        onUploadTopPhoto={noop}
        onUploadSidePhoto={noop}
        onStartBlankSketch={noop}
        onRecognizeSketch={noop}
        onRunReasonableMeasures={noop}
        onToggleLInnerCurve={noop}
        onReturnToFrontal={noop}
        onChangeCalibRefMm={noop}
        onApplyCalibA4={noop}
        onExitSubTool={noop}
        onToggleSubTool={noop}
        onToggleFrameMode={noop}
        onStartPickCorners={noop}
        onCancelPickCorners={noop}
        onToggleMagneticSnap={noop}
        paperGridSnap
        paperGridStepMm={100}
        onTogglePaperGridSnap={noop}
        onStepPaperGridSize={noop}
        onAutoContour={noop}
        onClearLines={noop}
        onChangeLinesSubMode={noop}
        onRemoveSubRegion={noop}
        onClearSubRegions={noop}
        onDetectSubRegions={noop}
        onChangeStrokeMode={noop}
        onAutoSuggestLines={noop}
        onRunRealVisionOnCatalog={noop}
      />,
    );
    expect(topBarHtml).toContain('Curva interior L');
    expect(topBarHtml).toContain('Reconocer boceto XZ');
    expect(topBarHtml).toContain('Lienzo Arriba');

    const mathHtml = renderToStaticMarkup(
      <MathPanel
        params={desk.params}
        topology={curvedTop}
        despiece={despiece}
        cuttingPlan={cuttingPlan}
        onAddHardwareItem={noop}
        onUpdateHardwareItem={noop}
        onRemoveHardwareItem={noop}
        onFixReferenceV0={noop}
        onAddCenterDivider={noop}
      />,
    );
    expect(mathHtml).toContain('5. Geometría Diferencial en Cortes Curvos');
    expect(mathHtml).toContain('Cortes Curvos Bézier');
    expect(barHtml).toContain('Dibujar');
    expect(barHtml).toContain('Mover / Editar');
    expect(topBarHtml).toContain('Marco');
    expect(topBarHtml).toContain('Línea recta');
    expect(topBarHtml).toContain('Curva');
    expect(topBarHtml).toContain('Milimetrado');
  });

  it('Trazado consecutivo en esquinas: punta no seleccionada queda libre como esquina y segunda línea conecta sin saltar', () => {
    const quad = makeAxisAlignedQuad(140, 100, 760, 580);
    const hom = computeQuadToUnitHomography(quad)!;
    const e = 18;
    const xf = 1200;
    const yf = 900;

    // Línea 1: repisa parcial horizontal desde esquina izquierda (u=0) hasta centro-derecha (u=0.55) en v=0.55
    const shelf1 = { id: 'rep_1', position: 0.55, start: 0, end: 0.55 };
    const rightTipCanvas = {
      x:
        hom.toCanvas[0][0] * interiorToExterior(shelf1.end, e, xf) +
        hom.toCanvas[0][1] * interiorToExterior(shelf1.position, e, yf) +
        hom.toCanvas[0][2],
      y:
        hom.toCanvas[1][0] * interiorToExterior(shelf1.end, e, xf) +
        hom.toCanvas[1][1] * interiorToExterior(shelf1.position, e, yf) +
        hom.toCanvas[1][2],
    };
    const w = hom.toCanvas[2][0] * interiorToExterior(shelf1.end, e, xf) +
      hom.toCanvas[2][1] * interiorToExterior(shelf1.position, e, yf) +
      hom.toCanvas[2][2];
    const cornerPx = { x: rightTipCanvas.x / w, y: rightTipCanvas.y / w };

    // 1. Con selectedLine=null, tocar la esquina/punta derecha de rep_1 NO secuestra rep_1
    const hitCorner = hitTestLinesScreenPx(
      cornerPx,
      [],
      [shelf1],
      [],
      hom.toCanvas,
      e,
      xf,
      yf,
      1,
      1,
      null,
      false,
    );
    expect(hitCorner).toBeNull();

    // 2. El imán estructural a 5 px de esa esquina la captura exactamente como 'Esquina' (u=0.55, v=0.55)
    const snapCorner = snapPointToStructuralAnchors(
      { x: cornerPx.x + 5, y: cornerPx.y - 4 },
      hom.toUnit,
      hom.toCanvas,
      [],
      [shelf1],
      e,
      xf,
      yf,
      1,
      1,
      12,
      undefined,
      'both',
    );
    expect(snapCorner).not.toBeNull();
    expect(snapCorner!.u).toBeCloseTo(0.55, 3);
    expect(snapCorner!.v).toBeCloseTo(0.55, 3);
    expect(snapCorner!.indicator?.label).toBe('Esquina');

    // 3. Trazar Línea 2 vertical hacia abajo desde esa esquina hasta v=0.20 (sin saltar ni al 0 ni al borde)
    const targetEnd = {
      x: cornerPx.x,
      y: cornerPx.y + 150,
    };
    const line2 = vectorizeUserStroke(
      snapCorner!.snappedImg,
      targetEnd,
      hom.toUnit,
      [],
      [shelf1],
      e,
      { x: xf, y: yf },
      false,
      'auto',
      { exactStartPos: true },
    );
    expect(line2?.kind).toBe('vDivider');
    if (line2?.kind === 'vDivider') {
      expect(line2.segment.position).toBeCloseTo(0.55, 2);
      expect(line2.segment.end).toBeCloseTo(0.55, 2);
      expect(line2.segment.start).toBeGreaterThan(0.05);
      expect(line2.segment.start).toBeLessThan(0.45);
    }

    // 4. Trazar línea pegada al borde superior (v=0.99) conserva v cerca de 0.99 (no empuja a 0.96)
    const topLeftSnap = snapPointToStructuralAnchors(
      { x: quad[0].x + 12, y: quad[0].y + 10 },
      hom.toUnit,
      hom.toCanvas,
      [],
      [],
      e,
      xf,
      yf,
      1,
      1,
      12,
    );
    const topRightSnap = snapPointToStructuralAnchors(
      { x: quad[1].x - 10, y: quad[1].y + 10 },
      hom.toUnit,
      hom.toCanvas,
      [],
      [],
      e,
      xf,
      yf,
      1,
      1,
      12,
    );
    const borderLine = vectorizeUserStroke(
      topLeftSnap!.snappedImg,
      topRightSnap!.snappedImg,
      hom.toUnit,
      [],
      [],
      e,
      { x: xf, y: yf },
      false,
      'auto',
      { exactStartPos: true },
    );
    expect(borderLine?.kind).toBe('hShelf');
    if (borderLine?.kind === 'hShelf') {
      expect(borderLine.segment.position).toBeGreaterThanOrEqual(0.985);
    }

    // 5. Vista Arriba (XZ) también imanta limpiamente esquinas del marco y vértices dibujados (quad[2] = BR -> (1, 0))
    const xzSnap = snapPointInUnitQuad(
      { x: quad[2].x - 5, y: quad[2].y - 5 },
      hom.toUnit,
      hom.toCanvas,
      [{ x: 0.4, y: 0.5 }],
      1,
      1,
      12,
    );
    expect(xzSnap?.unitPt).toEqual({ x: 1, y: 0 });
    expect(xzSnap?.indicator?.label).toBe('Esquina');

    // 6. Tocar esquina AZUL exterior del marco (quad[0]) captura esquina interior (0, 1) sin perderla
    const blueOuterSnap = snapPointToStructuralAnchors(
      { x: quad[0].x + 2, y: quad[0].y + 2 },
      hom.toUnit,
      hom.toCanvas,
      [],
      [],
      e,
      800,
      500,
      1,
      1,
      12,
      undefined,
      'both',
    );
    expect(blueOuterSnap?.u).toBe(0);
    expect(blueOuterSnap?.v).toBe(1);
    expect(blueOuterSnap?.indicator?.label).toBe('Esquina');

    // 7. Arrastre horizontal (`uOnly`) sigue capturando esquina/extremo de divisor vertical y lockToStart fija vPos al inicio
    const partDiv = { id: 'div_part', position: 0.48, start: 0.3, end: 0.72 };
    const endTipCanvas = {
      x: hom.toCanvas[0][0] * interiorToExterior(partDiv.position, e, xf) +
        hom.toCanvas[0][1] * interiorToExterior(partDiv.start, e, yf) +
        hom.toCanvas[0][2],
      y: hom.toCanvas[1][0] * interiorToExterior(partDiv.position, e, xf) +
        hom.toCanvas[1][1] * interiorToExterior(partDiv.start, e, yf) +
        hom.toCanvas[1][2],
    };
    const wEnd = hom.toCanvas[2][0] * interiorToExterior(partDiv.position, e, xf) +
      hom.toCanvas[2][1] * interiorToExterior(partDiv.start, e, yf) +
      hom.toCanvas[2][2];
    const uOnlyEndSnap = snapPointToStructuralAnchors(
      { x: endTipCanvas.x / wEnd + 4, y: endTipCanvas.y / wEnd - 3 },
      hom.toUnit,
      hom.toCanvas,
      [partDiv],
      [],
      e,
      xf,
      yf,
      1,
      1,
      12,
      undefined,
      'uOnly',
    );
    expect(uOnlyEndSnap?.u).toBeCloseTo(partDiv.position, 3);

    const lockedOrtho = vectorizeUserStroke(
      cornerPx,
      { x: cornerPx.x + 190, y: cornerPx.y - 26 },
      hom.toUnit,
      [],
      [shelf1],
      e,
      { x: xf, y: yf },
      false,
      'ortho',
      { exactStartPos: true, lockToStart: true },
    );
    expect(lockedOrtho?.kind).toBe('hShelf');
    if (lockedOrtho?.kind === 'hShelf') {
      expect(lockedOrtho.segment.position).toBeCloseTo(0.55, 2);
    }

    // 8. Adaptación al papel milimetrado redondea coordenadas libres a múltiplos de 10 mm
    const mmSnap = snapPointToStructuralAnchors(
      { x: (quad[0].x + quad[2].x) * 0.43, y: (quad[0].y + quad[2].y) * 0.52 },
      hom.toUnit,
      hom.toCanvas,
      [],
      [],
      e,
      xf,
      yf,
      1,
      1,
      12,
      undefined,
      'both',
      [],
      [],
      { enabled: true, stepMm: 10 },
    );
    expect(mmSnap).not.toBeNull();
    const xPosMm = Math.round(e + mmSnap!.u * (xf - 2 * e));
    const yPosMm = Math.round(e + mmSnap!.v * (yf - 2 * e));
    expect(xPosMm % 10).toBe(0);
    expect(yPosMm % 10).toBe(0);

    // 9. Detección de dibujo sobre papel milimetrado pastel (cuadrícula tenue verde-azulada + trazo negro)
    const gw = 120;
    const gh = 90;
    const graphRgba = new Uint8ClampedArray(gw * gh * 4);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const idx = (y * gw + x) * 4;
        const isGridLine = x % 10 === 0 || y % 10 === 0;
        const isInk = (x === 20 || x === 100 || y === 15 || y === 75) && x >= 20 && x <= 100 && y >= 15 && y <= 75;
        graphRgba[idx] = isInk ? 25 : isGridLine ? 190 : 244;
        graphRgba[idx + 1] = isInk ? 25 : isGridLine ? 236 : 252;
        graphRgba[idx + 2] = isInk ? 25 : isGridLine ? 228 : 249;
        graphRgba[idx + 3] = 255;
      }
    }
    expect(isHandDrawnSketchImage(graphRgba, gw, gh).isSketch).toBe(true);

    // 10. Tocar una línea la selecciona (incluso cerca de la punta con includeUnselectedEndsForTap),
    //     y al estar seleccionada sus puntas permiten achicar o alargar (both XY & XZ/ZY)
    const tapNearEnd = hitTestLinesScreenPx(
      cornerPx,
      [],
      [shelf1],
      [],
      hom.toCanvas,
      e,
      xf,
      yf,
      1,
      1,
      null,
      false,
      true,
    );
    expect(tapNearEnd).toEqual({ kind: 'hShelf', id: 'rep_1', part: 'end', distPx: expect.any(Number) });

    const resizeSelectedEnd = hitTestLinesScreenPx(
      { x: cornerPx.x + 2, y: cornerPx.y - 2 },
      [],
      [shelf1],
      [],
      hom.toCanvas,
      e,
      xf,
      yf,
      1,
      1,
      { kind: 'hShelf', id: 'rep_1' },
      false,
      false,
    );
    expect(resizeSelectedEnd?.part).toBe('end');
    expect(resizeSelectedEnd?.id).toBe('rep_1');

    const xzLine = { id: 'pln_xz_1', u1: 0, v1: 0.5, u2: 0.7, v2: 0.5 };
    const xzEndImg = {
      x: quad[3].x + (quad[2].x - quad[3].x) * 0.7,
      y: quad[3].y + (quad[0].y - quad[3].y) * 0.5,
    };
    const xzTap = hitTestPlaneLinesScreenPx(xzEndImg, [xzLine], hom.toCanvas, 1, 1, null, false, true);
    expect(xzTap?.id).toBe('pln_xz_1');
    const xzResizeSel = hitTestPlaneLinesScreenPx(xzEndImg, [xzLine], hom.toCanvas, 1, 1, 'pln_xz_1', false, false);
    expect(xzResizeSel?.part).toBe('end');

    // En modo táctil, el extremo de una línea seleccionada tolera dedos hasta 34 px para acortar/alargar sin dibujar encima
    const selectedTouchHit = hitTestLinesScreenPx(
      { x: cornerPx.x + 28, y: cornerPx.y - 10 },
      [],
      [shelf1],
      [],
      hom.toCanvas,
      e,
      xf,
      yf,
      1,
      1,
      { kind: 'hShelf', id: 'rep_1' },
      true,
      false,
    );
    expect(selectedTouchHit?.part).toBe('end');

    // Con cuadrícula grande (stepMm = 100), puntos alejados de líneas mayores mantienen precisión fina de 10 mm sin saltos de ±50 mm
    const midGridVal = snapNormToPaperGridMm(0.432, 1000, 18, 0.5, 100);
    const midGridMm = Math.round(18 + midGridVal * 1000);
    expect(midGridMm % 10).toBe(0);
    expect(Math.abs(midGridMm - (18 + 432))).toBeLessThanOrEqual(8);

    const barWithResizeHtml = renderToStaticMarkup(
      <LineSelectionBar
        selectedLine={{ kind: 'hShelf', id: 'rep_1' }}
        topology={{ ...clonePreset('estanteria').topology, hShelves: [shelf1] }}
        params={{ ...clonePreset('estanteria').params, targetDimensions: { x: xf, y: yf, z: 400 } }}
        onUpdateVDivider={() => undefined}
        onUpdateHShelf={() => undefined}
        onUpdateDiagonal={() => undefined}
        onDeleteSelected={() => undefined}
        onDeselect={() => undefined}
      />,
    );
    expect(barWithResizeHtml).toContain('−10 largo');
    expect(barWithResizeHtml).toContain('+10 largo');
  });

  it('edición directa en 3D mueve/quita repisas y divisores, divide zonas y soporta ala L retorno', () => {
    // 1. Repisa equidistante en estantería: mover +20 mm en 3D convierte a custom sin perder las otras repisas
    const est = clonePreset('estanteria');
    const despEst = calculateDespiece(est.topology, est.params);
    const shelfPiece = despOrFail(despEst).find((p) => p.tipo === 'repisa');
    expect(shelfPiece).toBeDefined();
    expect(canEditPiecePositionIn3D(est.topology, est.params, shelfPiece!)).toBe(true);

    const handles = compute3DEditHandlePositions(
      shelfPiece!,
      [shelfPiece!.posicion3D[0] / 1000, shelfPiece!.posicion3D[1] / 1000, shelfPiece!.posicion3D[2] / 1000],
      est.topology,
      est.params,
    );
    expect(handles.map((h) => h.deltaMm)).toEqual([20, -20]);

    const afterShelfNudge = nudgeShelfMmIn3D(est.topology, est.params, shelfPiece!, 20);
    expect(afterShelfNudge).not.toBeNull();
    expect(afterShelfNudge?.shelfMode).toBe('custom');
    expect(afterShelfNudge?.hShelves.length).toBe(est.topology.equalShelfCount);
    const despAfterNudge = calculateDespiece(afterShelfNudge!, est.params);
    expect(despAfterNudge.matrizDespiece.some((p) => p.tipo === 'repisa')).toBe(true);
    expect(
      despAfterNudge.alerts.filter((a) => a.tipo === 'dimension_invalida'),
    ).toHaveLength(0);

    // Quitar una repisa reduce el conteo en 1
    const movedShelfPiece = despAfterNudge.matrizDespiece.find((p) => p.tipo === 'repisa')!;
    const afterRemoveShelf = removeShelfIn3D(afterShelfNudge!, est.params, movedShelfPiece);
    expect(afterRemoveShelf).not.toBeNull();
    expect(afterRemoveShelf?.hShelves.length).toBe(est.topology.equalShelfCount - 1);

    // 2. Zonas en Mueble de Catálogo (#03 Rack Bicolor): cambiar tipo a cajones, ajustar cantidad, dividir zona y cubierta bicolor
    const rack = cloneCatalogFurniture(CATALOG_14_MUEBLES[2].id)!;
    expect(rack).toBeDefined();
    const firstZone = rack.topology.frontZones![0];
    expect(firstZone).toBeDefined();
    const withDrawers = changeZoneKindFrom3D(rack.topology, 'main', firstZone.id, 'drawers');
    const zDrawers = withDrawers.frontZones!.find((z) => z.id === firstZone.id)!;
    expect(zDrawers.kind).toBe('drawers');
    expect(zDrawers.drawerCount).toBe(3);

    const withFiveDrawers = updateZoneFrom3D(withDrawers, 'main', firstZone.id, {
      drawerCount: 5,
      materialOverride: 'grafito',
    });
    const despFive = calculateDespiece(withFiveDrawers, rack.params);
    expect(despFive.matrizDespiece.filter((p) => p.zoneId === firstZone.id && p.tipo === 'frente_cajon')).toHaveLength(5);

    const splitRes = splitZoneIn3D(withFiveDrawers, rack.params, 'main', firstZone.id, 'cols');
    expect(splitRes).not.toBeNull();
    expect(splitRes!.topology.vDividers.length).toBe(rack.topology.vDividers.length + 1);

    const withCubGrafito = updateCubiertaMaterialIn3D(splitRes!.topology, 'main', 'grafito');
    expect(withCubGrafito.cubiertaMaterialOverride).toBe('grafito');

    // 3. Ala de retorno L (wing === 'return', probada en lado derecho e izquierdo): mover y quitar divisor 3D
    for (const side of ['right', 'left'] as const) {
      const lDesk = clonePreset('escritorio_l');
      const lTopo: FurnitureTopology = {
        ...lDesk.topology,
        lShape: {
          ...lDesk.topology.lShape!,
          side,
          vDividers: [{ id: 'ret_d1', position: 0.5, start: 0, end: 1 }],
        },
      };
      const despL = calculateDespiece(lTopo, lDesk.params);
      const retDiv = despOrFail(despL).find(
        (p) => p.tipo === 'division_vertical' && p.wing === 'return',
      );
      expect(retDiv).toBeDefined();
      expect(canEditPiecePositionIn3D(lTopo, lDesk.params, retDiv!, despL.matrizDespiece)).toBe(true);

      const retHandles = compute3DEditHandlePositions(
        retDiv!,
        [retDiv!.posicion3D[0] / 1000, retDiv!.posicion3D[1] / 1000, retDiv!.posicion3D[2] / 1000],
        lTopo,
        lDesk.params,
        despL.matrizDespiece,
      );
      expect(retHandles.map((h) => h.deltaMm)).toEqual([20, -20]);

      const afterRetMove = nudgeDividerMmIn3D(lTopo, lDesk.params, retDiv!, 25, despL.matrizDespiece);
      expect(afterRetMove).not.toBeNull();
      expect(afterRetMove!.lShape!.vDividers[0].position).toBeGreaterThan(0.5);

      const despRetMoved = calculateDespiece(afterRetMove!, lDesk.params);
      const retDivMoved = despRetMoved.matrizDespiece.find(
        (p) => p.tipo === 'division_vertical' && p.wing === 'return',
      )!;
      const afterRetDel = removeDividerIn3D(afterRetMove!, lDesk.params, retDivMoved, despRetMoved.matrizDespiece);
      expect(afterRetDel?.lShape?.vDividers).toHaveLength(0);
    }

    // 4. Verificación estática de props de Viewer3D con callbacks de edición 3D
    const propsCheck: Pick<
      Viewer3DProps,
      'onUpdateTopology' | 'onUpdateMaterialOnly' | 'onChangeBaseSupport' | 'onToggleLInnerCurve'
    > = {
      onUpdateTopology: () => undefined,
      onUpdateMaterialOnly: () => undefined,
      onChangeBaseSupport: () => undefined,
      onToggleLInnerCurve: () => undefined,
    };
    expect(typeof propsCheck.onUpdateTopology).toBe('function');
  });

  it('Historial Deshacer/Rehacer multi-vista (XY, XZ, ZY) y cuadrícula redimensionable (10..200 mm)', () => {
    expect([...PAPER_GRID_STEP_PRESETS]).toEqual([10, 20, 25, 50, 100, 200]);

    const autoSpacing = computePaperGridSpacing(1200, 500);
    const enlargedSpacing = computePaperGridSpacing(1200, 500, 100);
    expect(enlargedSpacing.minorMm).toBe(100);
    expect(enlargedSpacing.majorMm).toBe(200);
    expect(enlargedSpacing.snapMm).toBe(100);
    expect(enlargedSpacing.minorMm).toBeGreaterThan(autoSpacing.minorMm);

    const desk = clonePreset('escritorio_l');
    const quad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 100, y: 100 },
      { x: 700, y: 100 },
      { x: 700, y: 500 },
      { x: 100, y: 500 },
    ];
    const topQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 140, y: 120 },
      { x: 720, y: 120 },
      { x: 720, y: 480 },
      { x: 140, y: 480 },
    ];
    const sideQuad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 220, y: 100 },
      { x: 660, y: 100 },
      { x: 660, y: 520 },
      { x: 220, y: 520 },
    ];
    const planeLinesXZ = [{ id: 'xz_1', u1: 0, v1: 0.4, u2: 0.8, v2: 0.4 }];
    const planeLinesZY = [{ id: 'zy_1', u1: 0.2, v1: 0, u2: 0.2, v2: 1 }];

    const snap = buildSnapshotFromState(quad, desk.topology, desk.params.targetDimensions, {
      topQuad,
      sideQuad,
      planeLinesXZ,
      planeLinesZY,
    });
    expect(snap.topQuad).toEqual(topQuad);
    expect(snap.sideQuad).toEqual(sideQuad);
    expect(snap.planeLinesXZ).toEqual(planeLinesXZ);
    expect(snap.planeLinesZY).toEqual(planeLinesZY);

    // Verificar inmutabilidad del snapshot ante mutaciones posteriores de arrays origen
    planeLinesXZ[0].u2 = 0.2;
    topQuad[0].x = 999;
    expect(snap.planeLinesXZ?.[0].u2).toBe(0.8);
    expect(snap.topQuad?.[0].x).toBe(140);
  });

  it('Dibujo 2x2 cerrado en lienzo libre: cero leg_void/void_outside fantasmas y contorno ajustado exacto', () => {
    const est = clonePreset('estanteria');
    const sheetQuad = makeAxisAlignedQuad(140, 100, 760, 580);
    const sheetDims = { x: 1240, y: 960, z: 400 };
    const e = 18;

    // Caso A (Screenshot TEST): 3 verticales + 3 horizontales formando un mueble 2x2 dentro del papel
    const vDivs = [
      { id: 'v_left', position: 0.2, start: 0.2, end: 0.7 },
      { id: 'v_mid', position: 0.4, start: 0.2, end: 0.7 },
      { id: 'v_right', position: 0.6, start: 0.2, end: 0.7 },
    ];
    const hShs = [
      { id: 'h_bot', position: 0.2, start: 0.2, end: 0.6 },
      { id: 'h_mid', position: 0.45, start: 0.2, end: 0.6 },
      { id: 'h_top', position: 0.7, start: 0.2, end: 0.6 },
    ];

    // 1) Sin rectRgba de foto real, las celdas nuevas jamás producen leg_void ni void_outside
    const rawCells = partitionCellsFromVectors(vDivs, hShs);
    const blankZones = classifyPartitionedZonesFromPhoto(
      rawCells,
      null,
      0,
      0,
      sheetDims,
      'roble',
      [245, 245, 245],
      [],
      e,
    );
    expect(blankZones.some((z) => z.kind === 'leg_void' || z.kind === 'void_outside')).toBe(false);

    // 2) Auto-encuadre del rectángulo cerrado dibujado -> convierte muros exteriores en caja real y conserva interiores 2x2
    const fitted = fitBlankSketchDrawnOuterBox(vDivs, hShs, [], sheetQuad, sheetDims, e);
    expect(fitted).not.toBeNull();
    expect(fitted!.vDividers).toHaveLength(1);
    expect(fitted!.vDividers[0].position).toBeCloseTo(0.5, 2);
    expect(fitted!.hShelves).toHaveLength(1);
    expect(fitted!.hShelves[0].position).toBeCloseTo(0.5, 2);

    const desp = calculateDespiece(
      {
        ...est.topology,
        shelfMode: 'custom',
        equalShelfCount: 0,
        hasBackPanel: true,
        baseSupportType: 'none',
        lShape: undefined,
        vDividers: fitted!.vDividers,
        hShelves: fitted!.hShelves,
        frontZones: partitionCellsFromVectors(fitted!.vDividers, fitted!.hShelves).map((c) => ({
          id: c.id,
          uStart: c.uStart,
          uEnd: c.uEnd,
          vStart: c.vStart,
          vEnd: c.vEnd,
          kind: 'open',
          label: 'Cubo',
        })),
      },
      { ...est.params, targetDimensions: fitted!.nextDims },
    );

    expect(desp.matrizDespiece.some((p) => p.tipo === 'base')).toBe(true);
    expect(desp.matrizDespiece.some((p) => p.tipo === 'cubierta')).toBe(true);
    expect(desp.matrizDespiece.some((p) => p.tipo === 'fondo')).toBe(true);
    expect(desp.matrizDespiece.some((p) => p.tipo === 'faldon')).toBe(false);
    expect(desp.matrizDespiece.filter((p) => p.tipo === 'division_vertical')).toHaveLength(1);
    expect(desp.matrizDespiece.filter((p) => p.tipo === 'repisa')).toHaveLength(2);
  });
});

function despOrFail(despiece: ReturnType<typeof calculateDespiece>) {
  expect(despiece.matrizDespiece.length).toBeGreaterThan(0);
  return despiece.matrizDespiece;
}
