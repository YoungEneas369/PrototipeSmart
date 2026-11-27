/**
 * SMARTFURNITURE v8.0 — CONTROLADOR DE INTERACCIÓN 60 FPS (`useCanvasPointerController`)
 * Gestiona estado efímero de arrastre (`draftQuad`, `draftSideQuad`, `draftLines`, `liveStroke`),
 * Zoom continuo 0.75×..4× (Ctrl+Rueda / botones / pinch táctil sin bloquear scroll en 1×),
 * Pan fluido, Lupa 4× centrada en punto imantado, hit-testing en píxeles de pantalla y `onPointerCancel`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CanvasViewTab,
  CurvePlane,
  CurvedCutSpec,
  DiagonalSegment,
  FurnitureTopology,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  applyHomography,
  computeQuadToUnitHomography,
  exteriorToInterior,
  fitDifferentialCurveFromStroke,
  interiorToExterior,
  type Matrix3x3,
} from '../../core/mathEngine';
import {
  estimateAspectRatioFixedFocal,
  isConvexQuad,
  partitionCellsFromVectors,
  snapPointToStrongEdge,
  vectorizeUserStroke,
  type UserStrokeMode,
} from '../../core/vision';
import type {
  ActiveHoverTarget,
  EyedropperPreview,
  LiveStrokeDrawState,
} from './CanvasViewport';
import {
  CORNER_STEP_NAMES,
  MELAMINE_LABELS,
  clampNum,
  cloneQuad,
  computeSmoothOrthoGuide,
  distScreenPx,
  dragQuadEdge,
  hitTestFrameScreenPx,
  hitTestLinesScreenPx,
  hitTestPlaneLinesScreenPx,
  makeAxisAlignedQuad,
  resizeBoxCorner,
  round4,
  sampleEyedropperMaterial,
  snapNormToPaperGridMm,
  snapPointInUnitQuad,
  snapPointToStructuralAnchors,
  translateQuad,
  type FrameMode,
  type LineHitResult,
  type LineRef,
  type LinesSubMode,
  type OrthoGuideAxis,
  type SelectedSubRegion,
  type SnapIndicator,
  type SubTool,
  type TraceStep,
  type WorkingBitmap,
} from './geometryHelpers';

export interface DraftLinesState {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  diagonalDividers: DiagonalSegment[];
}

export interface DraftSubRegion {
  uStart: number;
  uEnd: number;
  vStart: number;
  vEnd: number;
}

type ActiveDrag =
  | {
      kind: 'corner';
      idx: number;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      pointerId: number;
    }
  | {
      kind: 'edge';
      edgeIdx: 0 | 1 | 2 | 3;
      startImg: Point2D;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      pointerId: number;
    }
  | {
      kind: 'moveFrame';
      startImg: Point2D;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      pointerId: number;
    }
  | {
      kind: 'drawBox';
      startImg: Point2D;
      startClient: Point2D;
      baseQuad: [Point2D, Point2D, Point2D, Point2D];
      movedEnough: boolean;
      pointerId: number;
    }
  | {
      kind: 'drawVector';
      startImg: Point2D;
      startU: number;
      startV: number;
      startAnchored: boolean;
      guidedEndImg: Point2D;
      points: Point2D[];
      plane: CurvePlane;
      startClient: Point2D;
      clickFallbackLine: LineRef | null;
      clickFallbackPlaneLineId?: string | null;
      pointerId: number;
    }
  | {
      kind: 'drawRegion';
      startU: number;
      startV: number;
      startClient: Point2D;
      pointerId: number;
    }
  | {
      kind: 'editLine';
      hit: LineHitResult;
      startU: number;
      startV: number;
      baseLines: DraftLinesState;
      pointerId: number;
    }
  | {
      kind: 'editPlaneLine';
      plane: 'xz' | 'zy';
      hit: { id: string; part: 'start' | 'end' | 'body'; distPx: number };
      startU: number;
      startV: number;
      baseLines: DiagonalSegment[];
      pointerId: number;
    }
  | {
      kind: 'pan';
      startClient: Point2D;
      basePan: Point2D;
      pointerId: number;
    };

export interface UseCanvasPointerControllerOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  stageRef: React.RefObject<HTMLDivElement>;
  viewTab: CanvasViewTab;
  traceStep: TraceStep;
  frameMode: FrameMode;
  linesSubMode: LinesSubMode;
  strokeMode: UserStrokeMode;
  subTool: SubTool;
  magneticSnap: boolean;
  paperGridSnap?: boolean;
  paperGridStepMm?: number;
  isSpacePan: boolean;
  frontBitmap: WorkingBitmap | null;
  topBitmap: WorkingBitmap | null;
  sideBitmap: WorkingBitmap | null;
  quad: [Point2D, Point2D, Point2D, Point2D];
  topQuad: [Point2D, Point2D, Point2D, Point2D];
  sideQuad: [Point2D, Point2D, Point2D, Point2D];
  focal35mm: 26 | 52;
  exteriorBgRgb: [number, number, number];
  committedHomography: { toUnit: Matrix3x3; toCanvas: Matrix3x3 } | null;
  materializedBase: { vDividers: NormalizedSegment[]; hShelves: NormalizedSegment[] };
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  pickingCorners: Point2D[] | null;
  selectedLine: LineRef | null;
  onSetPickingCorners: (next: Point2D[] | null) => void;
  onSetFrameMode: (mode: FrameMode) => void;
  onSetSelectedLine: (line: LineRef | null) => void;
  onSelectZone: (zoneId: string | null) => void;
  onHoverZone: (zoneId: string | null) => void;
  onAddCalibPoint: (pt: Point2D) => void;
  onEyedropperSampled: (material: MelamineMaterial) => void;
  onAddOrToggleSubRegion: (region: Omit<SelectedSubRegion, 'id'>, isCellClick: boolean) => void;
  onCommitOuterFrame: (
    bmp: WorkingBitmap,
    nextQuad: [Point2D, Point2D, Point2D, Point2D],
    opts: {
      resetInternalLines?: boolean;
      syncProportionY?: boolean;
      advanceToLines?: boolean;
      recordUndo?: boolean;
      undoBaseQuad?: [Point2D, Point2D, Point2D, Point2D];
    },
  ) => void;
  onCommitTopQuad?: (nextTop: [Point2D, Point2D, Point2D, Point2D], ratioXZ: number) => void;
  onCommitSideQuad: (nextSide: [Point2D, Point2D, Point2D, Point2D], ratioZY: number, estDepth: number) => void;
  onCommitTracedVectors: (
    vDivs: NormalizedSegment[],
    hShs: NormalizedSegment[],
    diags: DiagonalSegment[],
    opts: { preserveZones?: boolean; recordUndo?: boolean },
  ) => void;
  planeLinesXZ?: readonly DiagonalSegment[];
  planeLinesZY?: readonly DiagonalSegment[];
  selectedPlaneLineId?: string | null;
  onSetSelectedPlaneLineId?: (id: string | null) => void;
  onUpdatePlaneLine?: (plane: 'xz' | 'zy', updated: DiagonalSegment) => void;
  onCommitPlaneLine?: (plane: 'xz' | 'zy', seg: DiagonalSegment) => void;
  onCommitCurvedCut?: (cut: CurvedCutSpec) => void;
  onSetStatusMsg: (msg: string) => void;
}

export function useCanvasPointerController({
  canvasRef,
  stageRef,
  viewTab,
  traceStep,
  frameMode,
  linesSubMode,
  strokeMode,
  subTool,
  magneticSnap,
  paperGridSnap = true,
  paperGridStepMm,
  isSpacePan,
  frontBitmap,
  topBitmap,
  sideBitmap,
  quad,
  topQuad,
  sideQuad,
  focal35mm,
  exteriorBgRgb,
  committedHomography,
  materializedBase,
  topology,
  params,
  pickingCorners,
  selectedLine,
  onSetPickingCorners,
  onSetFrameMode,
  onSetSelectedLine,
  onSelectZone,
  onHoverZone,
  onAddCalibPoint,
  onEyedropperSampled,
  onAddOrToggleSubRegion,
  onCommitOuterFrame,
  onCommitTopQuad,
  onCommitSideQuad,
  onCommitTracedVectors,
  planeLinesXZ = [],
  planeLinesZY = [],
  selectedPlaneLineId = null,
  onSetSelectedPlaneLineId,
  onUpdatePlaneLine,
  onCommitPlaneLine,
  onCommitCurvedCut,
  onSetStatusMsg,
}: UseCanvasPointerControllerOptions) {
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<Point2D>({ x: 0, y: 0 });
  const [panToolActive, setPanToolActive] = useState<boolean>(false);

  const [draftQuad, setDraftQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const [draftTopQuad, setDraftTopQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(
    null,
  );
  const [draftSideQuad, setDraftSideQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(
    null,
  );
  const [draftLines, setDraftLines] = useState<DraftLinesState | null>(null);
  const [draftPlaneLines, setDraftPlaneLines] = useState<{
    plane: 'xz' | 'zy';
    lines: DiagonalSegment[];
  } | null>(null);
  const [draftRegion, setDraftRegion] = useState<DraftSubRegion | null>(null);
  const displayHomography = useMemo(
    () => computeQuadToUnitHomography(draftQuad ?? quad),
    [draftQuad, quad],
  );
  const [liveStroke, setLiveStroke] = useState<LiveStrokeDrawState | null>(null);
  const [snapIndicator, setSnapIndicator] = useState<SnapIndicator | null>(null);
  const [loupeFocusPt, setLoupeFocusPt] = useState<Point2D | null>(null);
  const [loupeSide, setLoupeSide] = useState<'left' | 'right'>('right');
  const [eyedropperPreview, setEyedropperPreview] = useState<EyedropperPreview | null>(null);
  const [hoverTarget, setHoverTarget] = useState<ActiveHoverTarget>({ kind: 'none' });
  const [isDraggingState, setIsDraggingState] = useState<boolean>(false);
  const [isPanningState, setIsPanningState] = useState<boolean>(false);

  const dragRef = useRef<ActiveDrag | null>(null);
  const draftQuadRef = useRef<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const draftTopQuadRef = useRef<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const draftSideQuadRef = useRef<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const draftLinesRef = useRef<DraftLinesState | null>(null);
  const draftPlaneLinesRef = useRef<{
    plane: 'xz' | 'zy';
    lines: DiagonalSegment[];
  } | null>(null);
  const draftRegionRef = useRef<DraftSubRegion | null>(null);
  const activeTouchMapRef = useRef<Map<number, Point2D>>(new Map());
  const pinchBaseRef = useRef<{
    dist: number;
    mid: Point2D;
    zoom: number;
    pan: Point2D;
  } | null>(null);

  const clampPanForZoom = useCallback(
    (nextPan: Point2D, nextZoom: number): Point2D => {
      const stage = stageRef.current;
      if (!stage || nextZoom <= 1.01) return { x: 0, y: 0 };
      const rect = stage.getBoundingClientRect();
      const maxX = (rect.width * (nextZoom - 1)) / 2 + 80;
      const maxY = (rect.height * (nextZoom - 1)) / 2 + 80;
      return {
        x: clampNum(nextPan.x, -maxX, maxX),
        y: clampNum(nextPan.y, -maxY, maxY),
      };
    },
    [stageRef],
  );

  const applyZoom = useCallback(
    (nextZoomRaw: number) => {
      const nextZoom = Number(clampNum(nextZoomRaw, 0.5, 5).toFixed(2));
      setZoom(nextZoom);
      setPan((prev) => clampPanForZoom(prev, nextZoom));
    },
    [clampPanForZoom],
  );

  const resetViewport = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPanToolActive(false);
  }, []);

  const clearDrafts = useCallback(() => {
    dragRef.current = null;
    draftQuadRef.current = null;
    draftTopQuadRef.current = null;
    draftSideQuadRef.current = null;
    draftLinesRef.current = null;
    draftPlaneLinesRef.current = null;
    draftRegionRef.current = null;
    pinchBaseRef.current = null;
    activeTouchMapRef.current.clear();
    setDraftQuad(null);
    setDraftTopQuad(null);
    setDraftSideQuad(null);
    setDraftLines(null);
    setDraftPlaneLines(null);
    setDraftRegion(null);
    setLiveStroke(null);
    setSnapIndicator(null);
    setLoupeFocusPt(null);
    setEyedropperPreview(null);
    setHoverTarget({ kind: 'none' });
    setIsDraggingState(false);
    setIsPanningState(false);
  }, []);

  // Zoom continuo con Ctrl+Rueda (jamás bloquea el scroll vertical normal cuando zoom = 1×)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0022);
      setZoom((prevZoom) => {
        const nextZoom = Number(clampNum(prevZoom * factor, 0.5, 5).toFixed(2));
        setPan((prevPan) => clampPanForZoom(prevPan, nextZoom));
        return nextZoom;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stageRef, clampPanForZoom]);

  const getCanvasMetrics = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { pt: { x: 0, y: 0 }, scaleX: 1, scaleY: 1 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width > 0 ? rect.width / canvas.width : 1;
      const scaleY = rect.height > 0 ? rect.height / canvas.height : 1;
      return {
        pt: {
          x: rect.width > 0 ? ((clientX - rect.left) / rect.width) * canvas.width : 0,
          y: rect.height > 0 ? ((clientY - rect.top) / rect.height) * canvas.height : 0,
        },
        scaleX,
        scaleY,
      };
    },
    [canvasRef],
  );

  const updateLoupeSide = useCallback(
    (clientX: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      setLoupeSide(clientX - rect.left < rect.width * 0.5 ? 'right' : 'left');
    },
    [stageRef],
  );

  const snapEdgeIfEnabled = useCallback(
    (
      pt: Point2D,
      altKey: boolean,
      scaleX = 1,
      scaleY = 1,
      maxJumpPx = 5,
    ): { pt: Point2D; indicator: SnapIndicator | null } => {
      if (!magneticSnap || altKey || viewTab !== 'frontal' || !frontBitmap) {
        return { pt, indicator: null };
      }
      // Radio Sobel reducido a 5 px + umbral alto para ignorar ladrillos/vetas; nunca salta > maxJumpPx
      const res = snapPointToStrongEdge(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, pt, 5, 58);
      if (res.didSnap) {
        const imgJump = Math.hypot(res.snapped.x - pt.x, res.snapped.y - pt.y);
        const screenJump = distScreenPx(pt, res.snapped, scaleX, scaleY);
        if (imgJump <= maxJumpPx && screenJump <= maxJumpPx) {
          return {
            pt: res.snapped,
            indicator: { pt: res.snapped, kind: 'edge', label: 'Imán borde' },
          };
        }
      }
      return { pt, indicator: null };
    },
    [magneticSnap, viewTab, frontBitmap],
  );

  const xyCurveEndpoints = useMemo(() => {
    const out: Point2D[] = [];
    for (const c of topology.curvedCuts ?? []) {
      if (c.plane === 'xy') {
        out.push(c.controlPoints[0], c.controlPoints[3]);
      }
    }
    return out;
  }, [topology.curvedCuts]);

  const snapForLineOperation = useCallback(
    (
      rawPt: Point2D,
      scaleX: number,
      scaleY: number,
      altKey: boolean,
      vDivs: readonly NormalizedSegment[],
      hShs: readonly NormalizedSegment[],
      excludeId?: string,
      axisLock: 'both' | 'uOnly' | 'vOnly' = 'both',
      snapTolPx = 12,
      diags: readonly DiagonalSegment[] = topology.diagonalDividers ?? [],
    ): { pt: Point2D; u: number; v: number; indicator: SnapIndicator | null } | null => {
      if (!displayHomography) return null;
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      if (!altKey) {
        const structSnap = snapPointToStructuralAnchors(
          rawPt,
          displayHomography.toUnit,
          displayHomography.toCanvas,
          vDivs,
          hShs,
          eMm,
          xf,
          yf,
          scaleX,
          scaleY,
          snapTolPx,
          excludeId,
          axisLock,
          diags,
          xyCurveEndpoints,
          { enabled: paperGridSnap && !altKey, stepMm: paperGridStepMm },
        );
        if (structSnap && structSnap.indicator) {
          return {
            pt: structSnap.snappedImg,
            u: structSnap.u,
            v: structSnap.v,
            indicator: structSnap.indicator,
          };
        }
        if (structSnap && paperGridSnap && !altKey) {
          return {
            pt: structSnap.snappedImg,
            u: structSnap.u,
            v: structSnap.v,
            indicator: null,
          };
        }
      }

      // Cuando se ancla solo un eje perpendicular durante trazo recto, evitar imán Sobel 2D que jale lateralmente
      const edgeRes =
        axisLock === 'both'
          ? snapEdgeIfEnabled(rawPt, altKey, scaleX, scaleY, 5)
          : { pt: rawPt, indicator: null };
      const unit = applyHomography(displayHomography.toUnit, edgeRes.pt);
      if (!unit) return null;
      return {
        pt: edgeRes.pt,
        u: exteriorToInterior(unit.x, eMm, xf),
        v: exteriorToInterior(unit.y, eMm, yf),
        indicator: edgeRes.indicator,
      };
    },
    [
      displayHomography,
      params.boardThickness,
      params.targetDimensions,
      snapEdgeIfEnabled,
      topology.diagonalDividers,
      xyCurveEndpoints,
      paperGridSnap,
      paperGridStepMm,
    ],
  );

  const getNonFrontUnitVertices = useCallback(
    (plane: 'xz' | 'zy'): Point2D[] => {
      const out: Point2D[] = [];
      for (const c of topology.curvedCuts ?? []) {
        if (c.plane === plane) {
          out.push(c.controlPoints[0], c.controlPoints[3]);
        }
      }
      const plines = plane === 'xz' ? planeLinesXZ : planeLinesZY;
      for (const ln of plines) {
        out.push({ x: ln.u1, y: ln.v1 }, { x: ln.u2, y: ln.v2 });
      }
      return out;
    },
    [topology.curvedCuts, planeLinesXZ, planeLinesZY],
  );

  const resolveGuidedStrokeEnd = useCallback(
    (
      startU: number,
      startV: number,
      rawEndPt: Point2D,
      hom: { toUnit: Matrix3x3; toCanvas: Matrix3x3 },
      scaleX: number,
      scaleY: number,
      altKey: boolean,
      isTouch: boolean,
      fallbackPt?: Point2D,
    ): { endPt: Point2D; axis: OrthoGuideAxis; indicator: SnapIndicator | null } => {
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      const guide = computeSmoothOrthoGuide(
        startU,
        startV,
        rawEndPt,
        hom.toUnit,
        hom.toCanvas,
        eMm,
        xf,
        yf,
        strokeMode,
      );

      // Ancla SOLO el eje perpendicular al trazo para no jalar nunca hacia bordes paralelos
      const axisLock: 'both' | 'uOnly' | 'vOnly' =
        guide.axis === 'horizontal' || guide.axis === 'near_horizontal'
          ? 'uOnly'
          : guide.axis === 'vertical' || guide.axis === 'near_vertical'
            ? 'vOnly'
            : 'both';

      const snapped = snapForLineOperation(
        rawEndPt,
        scaleX,
        scaleY,
        altKey,
        materializedBase.vDividers,
        materializedBase.hShelves,
        undefined,
        axisLock,
        isTouch ? 16 : 12,
        topology.diagonalDividers ?? [],
      );

      let endPt = snapped?.pt ?? guide.guidedImg;
      if (guide.axis === 'horizontal') {
        const finalU = snapped ? snapped.u : guide.u;
        endPt =
          applyHomography(hom.toCanvas, {
            x: interiorToExterior(finalU, eMm, xf),
            y: interiorToExterior(startV, eMm, yf),
          }) ??
          fallbackPt ??
          guide.guidedImg;
      } else if (guide.axis === 'vertical') {
        const finalV = snapped ? snapped.v : guide.v;
        endPt =
          applyHomography(hom.toCanvas, {
            x: interiorToExterior(startU, eMm, xf),
            y: interiorToExterior(finalV, eMm, yf),
          }) ??
          fallbackPt ??
          guide.guidedImg;
      }

      return { endPt, axis: guide.axis, indicator: snapped?.indicator ?? null };
    },
    [
      params.boardThickness,
      params.targetDimensions,
      strokeMode,
      snapForLineOperation,
      materializedBase.vDividers,
      materializedBase.hShelves,
      topology.diagonalDividers,
    ],
  );

  const handlePointerCancel = useCallback(() => {
    const active = dragRef.current;
    if (active && canvasRef.current) {
      try {
        if (canvasRef.current.hasPointerCapture(active.pointerId)) {
          canvasRef.current.releasePointerCapture(active.pointerId);
        }
      } catch {
        // Ignorar si ya fue liberado
      }
    }
    clearDrafts();
  }, [canvasRef, clearDrafts]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const isTouch = e.pointerType === 'touch';

    if (isTouch) {
      activeTouchMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchMapRef.current.size === 2) {
        handlePointerCancel();
        const pts = Array.from(activeTouchMapRef.current.values());
        pinchBaseRef.current = {
          dist: Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
          mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
          zoom,
          pan,
        };
        return;
      }
    }

    if (isSpacePan || panToolActive || e.button === 1) {
      e.preventDefault();
      dragRef.current = {
        kind: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        basePan: { ...pan },
        pointerId: e.pointerId,
      };
      setIsDraggingState(true);
      setIsPanningState(true);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    const { pt: rawPt, scaleX, scaleY } = getCanvasMetrics(e.clientX, e.clientY);
    updateLoupeSide(e.clientX);

    // 1. Subherramientas temporales (`calibA4` / `eyedropper`)
    if (viewTab === 'frontal' && subTool !== 'none' && frontBitmap) {
      if (subTool === 'calibA4') {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        setSnapIndicator(snapped.indicator);
        setLoupeFocusPt(snapped.pt);
        onAddCalibPoint(snapped.pt);
        return;
      }
      if (subTool === 'eyedropper') {
        const sampled = sampleEyedropperMaterial(
          frontBitmap.rgba,
          frontBitmap.w,
          frontBitmap.h,
          rawPt,
          exteriorBgRgb,
        );
        setLoupeFocusPt(null);
        setEyedropperPreview(null);
        onEyedropperSampled(sampled.material);
        onSetStatusMsg(
          `Acabado detectado por gotero: ${MELAMINE_LABELS[sampled.material]} (RGB ${sampled.rgb.join(', ')}). Medidas y trazos intactos.`,
        );
        return;
      }
    }

    // 2. Vistas Superior XZ (Arriba) y Lateral ZY (Lado): marco solo en 'frame', trazado con snap en 'lines'
    if (viewTab === 'superior' || viewTab === 'lateral') {
      const targetQuad = viewTab === 'superior' ? topQuad : sideQuad;
      if (traceStep === 'frame') {
        const hit = hitTestFrameScreenPx(rawPt, targetQuad, scaleX, scaleY, isTouch);
        if (hit && (hit.kind === 'corner' || hit.kind === 'edge' || hit.kind === 'interior')) {
          if (hit.kind === 'corner') {
            dragRef.current = {
              kind: 'corner',
              idx: hit.idx,
              baseQuad: cloneQuad(targetQuad),
              pointerId: e.pointerId,
            };
          } else if (hit.kind === 'edge') {
            dragRef.current = {
              kind: 'edge',
              edgeIdx: hit.edgeIdx,
              startImg: rawPt,
              baseQuad: cloneQuad(targetQuad),
              pointerId: e.pointerId,
            };
          } else {
            dragRef.current = {
              kind: 'moveFrame',
              startImg: rawPt,
              baseQuad: cloneQuad(targetQuad),
              pointerId: e.pointerId,
            };
          }
          setIsDraggingState(true);
          setLoupeFocusPt(rawPt);
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }

      // Selección o achicar/alargar de líneas trazadas en Arriba (XZ) o Lado (ZY)
      const nonFrontPlane: CurvePlane = viewTab === 'superior' ? 'xz' : 'zy';
      const planeW = nonFrontPlane === 'xz' ? params.targetDimensions.x : params.targetDimensions.z;
      const planeH = nonFrontPlane === 'xz' ? params.targetDimensions.z : params.targetDimensions.y;
      const plines = nonFrontPlane === 'xz' ? planeLinesXZ : planeLinesZY;
      const planeHom = computeQuadToUnitHomography(targetQuad);
      const pHit = planeHom
        ? hitTestPlaneLinesScreenPx(
            rawPt,
            plines,
            planeHom.toCanvas,
            scaleX,
            scaleY,
            selectedPlaneLineId,
            isTouch,
            false,
          )
        : null;
      const pTapHit =
        pHit ??
        (planeHom
          ? hitTestPlaneLinesScreenPx(
              rawPt,
              plines,
              planeHom.toCanvas,
              scaleX,
              scaleY,
              selectedPlaneLineId,
              isTouch,
              true,
            )
          : null);
      const isSelPlaneEnd =
        pHit !== null &&
        selectedPlaneLineId === pHit.id &&
        (pHit.part === 'start' || pHit.part === 'end');

      if (
        planeHom &&
        pHit &&
        strokeMode !== 'curve' &&
        (linesSubMode === 'smart' || isSelPlaneEnd)
      ) {
        const unit = applyHomography(planeHom.toUnit, rawPt);
        if (unit) {
          const baseCopy = plines.map((ln) => ({ ...ln }));
          onSetSelectedPlaneLineId?.(pHit.id);
          draftPlaneLinesRef.current = { plane: nonFrontPlane, lines: baseCopy };
          setDraftPlaneLines(draftPlaneLinesRef.current);
          dragRef.current = {
            kind: 'editPlaneLine',
            plane: nonFrontPlane,
            hit: pHit,
            startU: clampNum(unit.x, 0, 1),
            startV: clampNum(unit.y, 0, 1),
            baseLines: baseCopy,
            pointerId: e.pointerId,
          };
          setIsDraggingState(true);
          setLoupeFocusPt(rawPt);
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }

      const unitSnap =
        planeHom && !e.altKey
          ? snapPointInUnitQuad(
              rawPt,
              planeHom.toUnit,
              planeHom.toCanvas,
              getNonFrontUnitVertices(nonFrontPlane),
              scaleX,
              scaleY,
              isTouch ? 16 : 12,
              { wMm: planeW, hMm: planeH, enabled: paperGridSnap && !e.altKey, stepMm: paperGridStepMm },
            )
          : null;
      const startPt = unitSnap?.snappedImg ?? rawPt;
      setSnapIndicator(unitSnap?.indicator ?? null);
      setLoupeFocusPt(startPt);
      setLiveStroke({
        startImg: startPt,
        currentImg: startPt,
        points: [startPt],
        orthoGuide: strokeMode === 'curve' ? 'diagonal' : null,
      });
      dragRef.current = {
        kind: 'drawVector',
        startImg: startPt,
        startU: unitSnap?.unitPt.x ?? 0.5,
        startV: unitSnap?.unitPt.y ?? 0.5,
        startAnchored: Boolean(unitSnap?.indicator),
        guidedEndImg: startPt,
        points: [startPt],
        plane: nonFrontPlane,
        startClient: { x: e.clientX, y: e.clientY },
        clickFallbackLine: null,
        clickFallbackPlaneLineId: pTapHit?.id ?? null,
        pointerId: e.pointerId,
      };
      setIsDraggingState(true);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 3. Paso 1 — Contorno exterior
    if (traceStep === 'frame') {
      if (pickingCorners !== null) {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        const nextPicked = [...pickingCorners, snapped.pt];
        if (nextPicked.length < 4) {
          onSetPickingCorners(nextPicked);
          setLoupeFocusPt(snapped.pt);
          onSetStatusMsg(
            `Esquina ${nextPicked.length}/4 marcada. Ahora toca: ${CORNER_STEP_NAMES[nextPicked.length]}.`,
          );
        } else {
          const nextQuad: [Point2D, Point2D, Point2D, Point2D] = [
            nextPicked[0],
            nextPicked[1],
            nextPicked[2],
            nextPicked[3],
          ];
          onSetFrameMode('quad');
          onSetPickingCorners(null);
          setLoupeFocusPt(null);
          setSnapIndicator(null);
          if (frontBitmap) {
            onCommitOuterFrame(frontBitmap, nextQuad, {
              resetInternalLines: false,
              syncProportionY: true,
              advanceToLines: true,
              recordUndo: true,
              undoBaseQuad: quad,
            });
          }
        }
        return;
      }

      const hit = hitTestFrameScreenPx(rawPt, quad, scaleX, scaleY, isTouch);
      if (hit?.kind === 'corner') {
        dragRef.current = {
          kind: 'corner',
          idx: hit.idx,
          baseQuad: cloneQuad(quad),
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(quad[hit.idx]);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (hit?.kind === 'edge') {
        dragRef.current = {
          kind: 'edge',
          edgeIdx: hit.edgeIdx,
          startImg: rawPt,
          baseQuad: cloneQuad(quad),
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(rawPt);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (hit?.kind === 'interior') {
        dragRef.current = {
          kind: 'moveFrame',
          startImg: rawPt,
          baseQuad: cloneQuad(quad),
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (frameMode === 'box') {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        dragRef.current = {
          kind: 'drawBox',
          startImg: snapped.pt,
          startClient: { x: e.clientX, y: e.clientY },
          baseQuad: cloneQuad(quad),
          movedEnough: false,
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(snapped.pt);
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    // 4. Paso 2 — Líneas internas (modo inteligente 'smart' por defecto: edita sobre línea, traza en libre)
    if (traceStep === 'lines' && displayHomography) {
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;
      const vDivs = materializedBase.vDividers;
      const hShs = materializedBase.hShelves;
      const diags = topology.diagonalDividers ?? [];

      // 4A. Modo Multi-Sección ('regions'): arrastrar rectángulos o clic en celda existente
      if (linesSubMode === 'regions') {
        const unit = applyHomography(displayHomography.toUnit, rawPt);
        if (!unit) return;
        const uRaw = exteriorToInterior(unit.x, eMm, xf);
        const vRaw = exteriorToInterior(unit.y, eMm, yf);
        if (uRaw < -0.06 || uRaw > 1.06 || vRaw < -0.06 || vRaw > 1.06) return;

        const snapped = snapForLineOperation(
          rawPt,
          scaleX,
          scaleY,
          e.altKey,
          vDivs,
          hShs,
          undefined,
          'both',
        );
        const startU = clampNum(snapped?.u ?? uRaw, 0, 1);
        const startV = clampNum(snapped?.v ?? vRaw, 0, 1);
        dragRef.current = {
          kind: 'drawRegion',
          startU,
          startV,
          startClient: { x: e.clientX, y: e.clientY },
          pointerId: e.pointerId,
        };
        draftRegionRef.current = { uStart: startU, uEnd: startU, vStart: startV, vEnd: startV };
        setDraftRegion(draftRegionRef.current);
        setIsDraggingState(true);
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      const hit = hitTestLinesScreenPx(
        rawPt,
        vDivs,
        hShs,
        diags,
        displayHomography.toCanvas,
        eMm,
        xf,
        yf,
        scaleX,
        scaleY,
        selectedLine,
        isTouch,
        false,
      );
      const tapHit =
        hit ??
        hitTestLinesScreenPx(
          rawPt,
          vDivs,
          hShs,
          diags,
          displayHomography.toCanvas,
          eMm,
          xf,
          yf,
          scaleX,
          scaleY,
          selectedLine,
          isTouch,
          true,
        );

      // En 'smart': editar cuerpo o extremos. En 'draw_only': al tocar los extremos de la línea YA
      // seleccionada (`isSelectedEndpointHit`), se permite achicar o alargar sin afectar las esquinas libres.
      const isSelectedEndpointHit =
        hit !== null &&
        selectedLine !== null &&
        hit.kind === selectedLine.kind &&
        hit.id === selectedLine.id &&
        (hit.part === 'start' || hit.part === 'end');

      const shouldEditLine =
        hit !== null &&
        strokeMode !== 'curve' &&
        (linesSubMode === 'smart' || isSelectedEndpointHit);

      if (shouldEditLine && hit) {
        const unit = applyHomography(displayHomography.toUnit, rawPt);
        if (!unit) return;
        const baseLines: DraftLinesState = {
          vDividers: vDivs.map((d) => ({ ...d })),
          hShelves: hShs.map((s) => ({ ...s })),
          diagonalDividers: diags.map((dg) => ({ ...dg })),
        };
        onSetSelectedLine({ kind: hit.kind, id: hit.id });
        draftLinesRef.current = baseLines;
        setDraftLines(baseLines);
        dragRef.current = {
          kind: 'editLine',
          hit,
          startU: exteriorToInterior(unit.x, eMm, xf),
          startV: exteriorToInterior(unit.y, eMm, yf),
          baseLines,
          pointerId: e.pointerId,
        };
        setIsDraggingState(true);
        setLoupeFocusPt(rawPt);
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // Espacio libre o modo 'Dibujar': snap limpio a esquinas, puntas, diagonales e intersecciones
      const snappedStart = snapForLineOperation(
        rawPt,
        scaleX,
        scaleY,
        e.altKey,
        vDivs,
        hShs,
        undefined,
        'both',
        isTouch ? 16 : 12,
        diags,
      );
      const startPt = snappedStart?.pt ?? rawPt;
      const startUnit = applyHomography(displayHomography.toUnit, startPt);
      const startU = snappedStart?.u ?? (startUnit ? exteriorToInterior(startUnit.x, eMm, xf) : 0.5);
      const startV = snappedStart?.v ?? (startUnit ? exteriorToInterior(startUnit.y, eMm, yf) : 0.5);
      setSnapIndicator(snappedStart?.indicator ?? null);
      setLoupeFocusPt(startPt);
      setLiveStroke({ startImg: startPt, currentImg: startPt, points: [startPt], orthoGuide: null });
      dragRef.current = {
        kind: 'drawVector',
        startImg: startPt,
        startU,
        startV,
        startAnchored: Boolean(snappedStart?.indicator),
        guidedEndImg: startPt,
        points: [startPt],
        plane: 'xy',
        startClient: { x: e.clientX, y: e.clientY },
        clickFallbackLine: tapHit ? { kind: tapHit.kind, id: tapHit.id } : null,
        pointerId: e.pointerId,
      };
      setIsDraggingState(true);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 5. Paso 3 — Partes / Zonas
    if (traceStep === 'zones' && displayHomography) {
      const unit = applyHomography(displayHomography.toUnit, rawPt);
      if (!unit) return;
      const uClick = exteriorToInterior(unit.x, params.boardThickness, params.targetDimensions.x);
      const vClick = exteriorToInterior(unit.y, params.boardThickness, params.targetDimensions.y);
      const hitZone = (topology.frontZones ?? []).find(
        (z) => uClick >= z.uStart && uClick <= z.uEnd && vClick >= z.vStart && vClick <= z.vEnd,
      );
      if (hitZone) {
        onSelectZone(hitZone.id);
        onSetStatusMsg(
          'Celda seleccionada: elige su tipo, cajones, canastos o acabado bicolor abajo.',
        );
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const isTouch = e.pointerType === 'touch';

    if (isTouch && activeTouchMapRef.current.has(e.pointerId)) {
      activeTouchMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchMapRef.current.size === 2 && pinchBaseRef.current) {
        const pts = Array.from(activeTouchMapRef.current.values());
        const dist = Math.max(10, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const base = pinchBaseRef.current;
        const nextZoom = Number(clampNum(base.zoom * (dist / base.dist), 0.5, 5).toFixed(2));
        setZoom(nextZoom);
        setPan(
          clampPanForZoom(
            { x: base.pan.x + (mid.x - base.mid.x), y: base.pan.y + (mid.y - base.mid.y) },
            nextZoom,
          ),
        );
        return;
      }
    }

    const active = dragRef.current;
    const { pt: rawPt, scaleX, scaleY } = getCanvasMetrics(e.clientX, e.clientY);
    updateLoupeSide(e.clientX);

    if (!active) {
      if (viewTab === 'frontal' && subTool === 'eyedropper' && frontBitmap) {
        setLoupeFocusPt(rawPt);
        setEyedropperPreview(
          sampleEyedropperMaterial(
            frontBitmap.rgba,
            frontBitmap.w,
            frontBitmap.h,
            rawPt,
            exteriorBgRgb,
          ),
        );
        setSnapIndicator(null);
        return;
      }
      if (viewTab === 'frontal' && subTool === 'calibA4') {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        setLoupeFocusPt(snapped.pt);
        setSnapIndicator(snapped.indicator);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'frame' && pickingCorners !== null) {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
        setLoupeFocusPt(snapped.pt);
        setSnapIndicator(snapped.indicator);
        return;
      }
      if (traceStep === 'frame') {
        const q = viewTab === 'frontal' ? quad : viewTab === 'superior' ? topQuad : sideQuad;
        const hit = hitTestFrameScreenPx(rawPt, q, scaleX, scaleY, isTouch);
        if (!hit) setHoverTarget({ kind: 'none' });
        else if (hit.kind === 'corner') setHoverTarget({ kind: 'corner', idx: hit.idx });
        else if (hit.kind === 'edge') setHoverTarget({ kind: 'edge', edgeIdx: hit.edgeIdx });
        else setHoverTarget({ kind: 'frameInterior' });
        setLoupeFocusPt(null);
        setSnapIndicator(null);
        return;
      }
      if (viewTab !== 'frontal') {
        const q = viewTab === 'superior' ? topQuad : sideQuad;
        const planeHom = computeQuadToUnitHomography(q);
        const nonFrontPlane: CurvePlane = viewTab === 'superior' ? 'xz' : 'zy';
        const pWMm = nonFrontPlane === 'xz' ? params.targetDimensions.x : params.targetDimensions.z;
        const pHMm = nonFrontPlane === 'xz' ? params.targetDimensions.z : params.targetDimensions.y;
        const plines = nonFrontPlane === 'xz' ? planeLinesXZ : planeLinesZY;
        if (planeHom && strokeMode !== 'curve') {
          const pHit = hitTestPlaneLinesScreenPx(
            rawPt,
            plines,
            planeHom.toCanvas,
            scaleX,
            scaleY,
            selectedPlaneLineId,
            isTouch,
            false,
          );
          const showPlaneHover =
            pHit !== null &&
            (linesSubMode === 'smart' ||
              (selectedPlaneLineId === pHit.id && pHit.part !== 'body'));
          if (showPlaneHover && pHit) {
            setHoverTarget({
              kind: pHit.part === 'body' ? 'lineBody' : 'lineEnd',
              lineRef: { kind: 'diagonal', id: pHit.id },
              linePart: pHit.part,
            });
            setSnapIndicator(null);
            setLoupeFocusPt(null);
            return;
          }
        }
        const unitSnap =
          planeHom && !e.altKey
            ? snapPointInUnitQuad(
                rawPt,
                planeHom.toUnit,
                planeHom.toCanvas,
                getNonFrontUnitVertices(nonFrontPlane),
                scaleX,
                scaleY,
                isTouch ? 16 : 12,
                { wMm: pWMm, hMm: pHMm, enabled: paperGridSnap && !e.altKey, stepMm: paperGridStepMm },
              )
            : null;
        setHoverTarget({ kind: 'none' });
        setSnapIndicator(unitSnap?.indicator ?? null);
        setLoupeFocusPt(null);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'lines' && displayHomography) {
        if (linesSubMode === 'regions') {
          const unit = applyHomography(displayHomography.toUnit, rawPt);
          if (unit) {
            const u = exteriorToInterior(unit.x, params.boardThickness, params.targetDimensions.x);
            const v = exteriorToInterior(unit.y, params.boardThickness, params.targetDimensions.y);
            const hitZone = (topology.frontZones ?? []).find(
              (z) => u >= z.uStart && u <= z.uEnd && v >= z.vStart && v <= z.vEnd,
            );
            setHoverTarget(hitZone ? { kind: 'zone', zoneId: hitZone.id } : { kind: 'none' });
          } else {
            setHoverTarget({ kind: 'none' });
          }
          setSnapIndicator(null);
          setLoupeFocusPt(null);
          return;
        }

        if (strokeMode !== 'curve' && (linesSubMode === 'smart' || selectedLine !== null)) {
          const hit = hitTestLinesScreenPx(
            rawPt,
            materializedBase.vDividers,
            materializedBase.hShelves,
            topology.diagonalDividers ?? [],
            displayHomography.toCanvas,
            params.boardThickness,
            params.targetDimensions.x,
            params.targetDimensions.y,
            scaleX,
            scaleY,
            selectedLine,
            isTouch,
            false,
          );
          const showLineHover =
            hit !== null &&
            (linesSubMode === 'smart' ||
              (selectedLine !== null &&
                hit.kind === selectedLine.kind &&
                hit.id === selectedLine.id &&
                hit.part !== 'body'));
          if (showLineHover && hit) {
            setHoverTarget({
              kind: hit.part === 'body' ? 'lineBody' : 'lineEnd',
              lineRef: { kind: hit.kind, id: hit.id },
              linePart: hit.part,
            });
            setSnapIndicator(null);
            setLoupeFocusPt(null);
            return;
          }
        }

        setHoverTarget({ kind: 'none' });
        const snapped = snapForLineOperation(
          rawPt,
          scaleX,
          scaleY,
          e.altKey,
          materializedBase.vDividers,
          materializedBase.hShelves,
          undefined,
          'both',
          isTouch ? 16 : 12,
          topology.diagonalDividers ?? [],
        );
        setSnapIndicator(snapped?.indicator ?? null);
        setLoupeFocusPt(null);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'zones' && displayHomography) {
        const unit = applyHomography(displayHomography.toUnit, rawPt);
        if (unit) {
          const u = exteriorToInterior(unit.x, params.boardThickness, params.targetDimensions.x);
          const v = exteriorToInterior(unit.y, params.boardThickness, params.targetDimensions.y);
          const hitZone = (topology.frontZones ?? []).find(
            (z) => u >= z.uStart && u <= z.uEnd && v >= z.vStart && v <= z.vEnd,
          );
          onHoverZone(hitZone?.id ?? null);
          setHoverTarget(hitZone ? { kind: 'zone', zoneId: hitZone.id } : { kind: 'none' });
        }
      }
      return;
    }

    if (active.kind === 'pan') {
      setPan(
        clampPanForZoom(
          {
            x: active.basePan.x + (e.clientX - active.startClient.x),
            y: active.basePan.y + (e.clientY - active.startClient.y),
          },
          zoom,
        ),
      );
      return;
    }

    const bmp =
      viewTab === 'frontal' ? frontBitmap : viewTab === 'superior' ? topBitmap : sideBitmap;
    const bw = bmp?.w ?? 900;
    const bh = bmp?.h ?? 680;

    if (active.kind === 'corner') {
      const snapped =
        viewTab === 'frontal'
          ? snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5)
          : { pt: rawPt, indicator: null };
      const clampedPt = { x: clampNum(snapped.pt.x, 2, bw - 2), y: clampNum(snapped.pt.y, 2, bh - 2) };
      setSnapIndicator(snapped.indicator);
      setLoupeFocusPt(clampedPt);

      const nextQ =
        viewTab === 'frontal' && frameMode === 'box'
          ? resizeBoxCorner(active.baseQuad, active.idx, clampedPt, bw, bh)
          : (() => {
              const copy = cloneQuad(active.baseQuad);
              copy[active.idx] = clampedPt;
              const fallback =
                viewTab === 'frontal'
                  ? draftQuadRef.current
                  : viewTab === 'superior'
                    ? draftTopQuadRef.current
                    : draftSideQuadRef.current;
              return isConvexQuad(copy) ? copy : (fallback ?? active.baseQuad);
            })();

      if (viewTab === 'frontal') {
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      } else if (viewTab === 'superior') {
        draftTopQuadRef.current = nextQ;
        setDraftTopQuad(nextQ);
      } else {
        draftSideQuadRef.current = nextQ;
        setDraftSideQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'edge') {
      // Arrastre suave de borde: tope estricto de 4 px si el usuario encendió Imán ON
      const snapped =
        viewTab === 'frontal'
          ? snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 4)
          : { pt: rawPt, indicator: null };
      setSnapIndicator(snapped.indicator);
      setLoupeFocusPt(snapped.pt);
      const nextQ = dragQuadEdge(
        active.baseQuad,
        active.edgeIdx,
        snapped.pt.x - active.startImg.x,
        snapped.pt.y - active.startImg.y,
        viewTab === 'frontal' ? frameMode : 'quad',
        bw,
        bh,
      );
      if (viewTab === 'frontal') {
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      } else if (viewTab === 'superior') {
        draftTopQuadRef.current = nextQ;
        setDraftTopQuad(nextQ);
      } else {
        draftSideQuadRef.current = nextQ;
        setDraftSideQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'moveFrame') {
      const nextQ = translateQuad(
        active.baseQuad,
        rawPt.x - active.startImg.x,
        rawPt.y - active.startImg.y,
        bw,
        bh,
      );
      if (viewTab === 'frontal') {
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      } else if (viewTab === 'superior') {
        draftTopQuadRef.current = nextQ;
        setDraftTopQuad(nextQ);
      } else {
        draftSideQuadRef.current = nextQ;
        setDraftSideQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'drawBox') {
      const distScreen = Math.hypot(
        e.clientX - active.startClient.x,
        e.clientY - active.startClient.y,
      );
      const snapped = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 5);
      setSnapIndicator(snapped.indicator);
      setLoupeFocusPt(snapped.pt);
      if (distScreen >= 20) {
        active.movedEnough = true;
        const nextQ = makeAxisAlignedQuad(
          active.startImg.x,
          active.startImg.y,
          clampNum(snapped.pt.x, 2, bw - 2),
          clampNum(snapped.pt.y, 2, bh - 2),
        );
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'drawRegion' && displayHomography) {
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;
      const snapped = snapForLineOperation(
        rawPt,
        scaleX,
        scaleY,
        e.altKey,
        materializedBase.vDividers,
        materializedBase.hShelves,
        undefined,
        'both',
      );
      const unit = applyHomography(displayHomography.toUnit, rawPt);
      const curU = clampNum(
        snapped?.u ?? (unit ? exteriorToInterior(unit.x, eMm, xf) : active.startU),
        0,
        1,
      );
      const curV = clampNum(
        snapped?.v ?? (unit ? exteriorToInterior(unit.y, eMm, yf) : active.startV),
        0,
        1,
      );
      const nextReg: DraftSubRegion = {
        uStart: Math.min(active.startU, curU),
        uEnd: Math.max(active.startU, curU),
        vStart: Math.min(active.startV, curV),
        vEnd: Math.max(active.startV, curV),
      };
      draftRegionRef.current = nextReg;
      setDraftRegion(nextReg);
      setSnapIndicator(snapped?.indicator ?? null);
      return;
    }

    if (active.kind === 'drawVector') {
      const lastPt = active.points[active.points.length - 1];
      if (!lastPt || Math.hypot(rawPt.x - lastPt.x, rawPt.y - lastPt.y) >= 4) {
        active.points.push({ ...rawPt });
      }
      if (active.plane === 'xy' && displayHomography) {
        const resolved = resolveGuidedStrokeEnd(
          active.startU,
          active.startV,
          rawPt,
          displayHomography,
          scaleX,
          scaleY,
          e.altKey,
          isTouch,
        );
        active.guidedEndImg = resolved.endPt;
        setSnapIndicator(resolved.indicator);
        setLoupeFocusPt(resolved.endPt);
        setLiveStroke({
          startImg: active.startImg,
          currentImg: resolved.endPt,
          points: [...active.points],
          orthoGuide: resolved.axis,
        });
      } else if (active.plane !== 'xy') {
        const targetQuad = active.plane === 'xz' ? topQuad : sideQuad;
        const planeHom = computeQuadToUnitHomography(targetQuad);
        const pWMm = active.plane === 'xz' ? params.targetDimensions.x : params.targetDimensions.z;
        const pHMm = active.plane === 'xz' ? params.targetDimensions.z : params.targetDimensions.y;
        const unitSnap =
          planeHom && !e.altKey
            ? snapPointInUnitQuad(
                rawPt,
                planeHom.toUnit,
                planeHom.toCanvas,
                getNonFrontUnitVertices(active.plane),
                scaleX,
                scaleY,
                isTouch ? 16 : 12,
                { wMm: pWMm, hMm: pHMm, enabled: paperGridSnap && !e.altKey, stepMm: paperGridStepMm },
              )
            : null;
        let endPt = unitSnap?.snappedImg ?? rawPt;
        if (planeHom && strokeMode !== 'curve') {
          const uEnd = unitSnap?.unitPt ?? applyHomography(planeHom.toUnit, rawPt);
          if (uEnd && (strokeMode === 'ortho' || !unitSnap?.indicator)) {
            const du = Math.abs(uEnd.x - active.startU);
            const dv = Math.abs(uEnd.y - active.startV);
            const deg = (Math.atan2(dv, du) * 180) / Math.PI;
            if (strokeMode === 'ortho' ? du >= dv : deg <= 12) {
              endPt = applyHomography(planeHom.toCanvas, { x: uEnd.x, y: active.startV }) ?? endPt;
            } else if (strokeMode === 'ortho' ? dv > du : deg >= 78) {
              endPt = applyHomography(planeHom.toCanvas, { x: active.startU, y: uEnd.y }) ?? endPt;
            }
          }
        }
        active.guidedEndImg = endPt;
        setSnapIndicator(unitSnap?.indicator ?? null);
        setLoupeFocusPt(endPt);
        setLiveStroke({
          startImg: active.startImg,
          currentImg: endPt,
          points: [...active.points],
          orthoGuide: strokeMode === 'curve' ? 'diagonal' : null,
        });
      }
      return;
    }

    if (active.kind === 'editLine' && displayHomography) {
      const { hit, baseLines } = active;
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      let u: number;
      let v: number;
      let focusPt: Point2D;
      let ind: SnapIndicator | null = null;

      if (hit.part === 'body' && hit.kind !== 'diagonal') {
        // Movimiento suave de cuerpo + adaptación a papel milimetrado (si está activo)
        const edgeRes = snapEdgeIfEnabled(rawPt, e.altKey, scaleX, scaleY, 4);
        const unit = applyHomography(displayHomography.toUnit, edgeRes.pt);
        if (!unit) return;
        let nextU = exteriorToInterior(unit.x, eMm, xf);
        let nextV = exteriorToInterior(unit.y, eMm, yf);
        if (paperGridSnap && !e.altKey) {
          const xIntMm = Math.max(1, xf - 2 * eMm);
          const yIntMm = Math.max(1, yf - 2 * eMm);
          const gridStep = paperGridStepMm ?? 10;
          nextU = snapNormToPaperGridMm(nextU, xIntMm, eMm, 0.5, gridStep);
          nextV = snapNormToPaperGridMm(nextV, yIntMm, eMm, 0.5, gridStep);
        }
        u = nextU;
        v = nextV;
        focusPt = edgeRes.pt;
        ind = edgeRes.indicator;
      } else {
        const endAxisLock: 'both' | 'uOnly' | 'vOnly' =
          hit.kind === 'vDivider' ? 'vOnly' : hit.kind === 'hShelf' ? 'uOnly' : 'both';
        const snapped = snapForLineOperation(
          rawPt,
          scaleX,
          scaleY,
          e.altKey,
          baseLines.vDividers,
          baseLines.hShelves,
          hit.id,
          endAxisLock,
          isTouch ? 16 : 11,
        );
        if (!snapped) return;
        u = snapped.u;
        v = snapped.v;
        focusPt = snapped.pt;
        ind = snapped.indicator;
      }

      setSnapIndicator(ind);
      setLoupeFocusPt(focusPt);

      if (hit.kind === 'vDivider') {
        const nextVDivs = baseLines.vDividers.map((d) => {
          if (d.id !== hit.id) return d;
          if (hit.part === 'body') return { ...d, position: round4(clampNum(u, 0.03, 0.97)) };
          if (hit.part === 'start') {
            return { ...d, start: round4(clampNum(v, 0, Math.max(0, d.end - 0.05))) };
          }
          return { ...d, end: round4(clampNum(v, Math.min(1, d.start + 0.05), 1)) };
        });
        const nextDraft: DraftLinesState = {
          vDividers: nextVDivs,
          hShelves: baseLines.hShelves,
          diagonalDividers: baseLines.diagonalDividers,
        };
        draftLinesRef.current = nextDraft;
        setDraftLines(nextDraft);
      } else if (hit.kind === 'hShelf') {
        const nextHShelves = baseLines.hShelves.map((s) => {
          if (s.id !== hit.id) return s;
          if (hit.part === 'body') return { ...s, position: round4(clampNum(v, 0.03, 0.97)) };
          if (hit.part === 'start') {
            return { ...s, start: round4(clampNum(u, 0, Math.max(0, s.end - 0.05))) };
          }
          return { ...s, end: round4(clampNum(u, Math.min(1, s.start + 0.05), 1)) };
        });
        const nextDraft: DraftLinesState = {
          vDividers: baseLines.vDividers,
          hShelves: nextHShelves,
          diagonalDividers: baseLines.diagonalDividers,
        };
        draftLinesRef.current = nextDraft;
        setDraftLines(nextDraft);
      } else {
        const nextDiags = baseLines.diagonalDividers.map((dg) => {
          if (dg.id !== hit.id) return dg;
          if (hit.part === 'start') {
            const nu1 = round4(clampNum(u, 0, 1));
            const nv1 = round4(clampNum(v, 0, 1));
            if (Math.hypot(dg.u2 - nu1, dg.v2 - nv1) < 0.04) return dg;
            return { ...dg, u1: nu1, v1: nv1 };
          }
          if (hit.part === 'end') {
            const nu2 = round4(clampNum(u, 0, 1));
            const nv2 = round4(clampNum(v, 0, 1));
            if (Math.hypot(nu2 - dg.u1, nv2 - dg.v1) < 0.04) return dg;
            return { ...dg, u2: nu2, v2: nv2 };
          }
          const effDu = clampNum(
            u - active.startU,
            -Math.min(dg.u1, dg.u2),
            1 - Math.max(dg.u1, dg.u2),
          );
          const effDv = clampNum(
            v - active.startV,
            -Math.min(dg.v1, dg.v2),
            1 - Math.max(dg.v1, dg.v2),
          );
          return {
            ...dg,
            u1: round4(dg.u1 + effDu),
            v1: round4(dg.v1 + effDv),
            u2: round4(dg.u2 + effDu),
            v2: round4(dg.v2 + effDv),
          };
        });
        const nextDraft: DraftLinesState = {
          vDividers: baseLines.vDividers,
          hShelves: baseLines.hShelves,
          diagonalDividers: nextDiags,
        };
        draftLinesRef.current = nextDraft;
        setDraftLines(nextDraft);
      }
      return;
    }

    if (active.kind === 'editPlaneLine') {
      const targetQuad = active.plane === 'xz' ? topQuad : sideQuad;
      const planeHom = computeQuadToUnitHomography(targetQuad);
      if (!planeHom) return;
      const pWMm = active.plane === 'xz' ? params.targetDimensions.x : params.targetDimensions.z;
      const pHMm = active.plane === 'xz' ? params.targetDimensions.z : params.targetDimensions.y;
      const otherVertices: Point2D[] = [];
      for (const ln of active.baseLines) {
        if (ln.id === active.hit.id) continue;
        otherVertices.push({ x: ln.u1, y: ln.v1 }, { x: ln.u2, y: ln.v2 });
      }
      const unitSnap =
        active.hit.part === 'body'
          ? null
          : snapPointInUnitQuad(
              rawPt,
              planeHom.toUnit,
              planeHom.toCanvas,
              otherVertices,
              scaleX,
              scaleY,
              isTouch ? 16 : 12,
              { wMm: pWMm, hMm: pHMm, enabled: paperGridSnap && !e.altKey, stepMm: paperGridStepMm },
            );
      const rawUnit = applyHomography(planeHom.toUnit, rawPt);
      if (!rawUnit && !unitSnap) return;
      const u = clampNum(unitSnap?.unitPt.x ?? rawUnit!.x, 0, 1);
      const v = clampNum(unitSnap?.unitPt.y ?? rawUnit!.y, 0, 1);
      setSnapIndicator(unitSnap?.indicator ?? null);
      setLoupeFocusPt(unitSnap?.snappedImg ?? rawPt);

      const nextLines = active.baseLines.map((ln) => {
        if (ln.id !== active.hit.id) return ln;
        if (active.hit.part === 'start') {
          const nu1 = round4(u);
          const nv1 = round4(v);
          if (Math.hypot(ln.u2 - nu1, ln.v2 - nv1) < 0.03) return ln;
          return { ...ln, u1: nu1, v1: nv1 };
        }
        if (active.hit.part === 'end') {
          const nu2 = round4(u);
          const nv2 = round4(v);
          if (Math.hypot(nu2 - ln.u1, nv2 - ln.v1) < 0.03) return ln;
          return { ...ln, u2: nu2, v2: nv2 };
        }
        const effDu = clampNum(
          u - active.startU,
          -Math.min(ln.u1, ln.u2),
          1 - Math.max(ln.u1, ln.u2),
        );
        const effDv = clampNum(
          v - active.startV,
          -Math.min(ln.v1, ln.v2),
          1 - Math.max(ln.v1, ln.v2),
        );
        return {
          ...ln,
          u1: round4(ln.u1 + effDu),
          v1: round4(ln.v1 + effDv),
          u2: round4(ln.u2 + effDu),
          v2: round4(ln.v2 + effDv),
        };
      });
      draftPlaneLinesRef.current = { plane: active.plane, lines: nextLines };
      setDraftPlaneLines(draftPlaneLinesRef.current);
      return;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      activeTouchMapRef.current.delete(e.pointerId);
      if (activeTouchMapRef.current.size < 2) pinchBaseRef.current = null;
    }

    const finished = dragRef.current;
    if (!finished) return;

    if (canvasRef.current) {
      try {
        if (canvasRef.current.hasPointerCapture(finished.pointerId)) {
          canvasRef.current.releasePointerCapture(finished.pointerId);
        }
      } catch {
        // Ignorar
      }
    }

    const { pt: endRaw, scaleX, scaleY } = getCanvasMetrics(e.clientX, e.clientY);
    const isTouch = e.pointerType === 'touch';
    dragRef.current = null;
    setIsDraggingState(false);
    setIsPanningState(false);
    setLiveStroke(null);
    setSnapIndicator(null);
    setLoupeFocusPt(null);

    if (finished.kind === 'pan') return;

    if (finished.kind === 'corner' || finished.kind === 'edge' || finished.kind === 'moveFrame') {
      if (viewTab === 'frontal') {
        const finalQuad = draftQuadRef.current;
        draftQuadRef.current = null;
        setDraftQuad(null);
        if (finalQuad && frontBitmap) {
          onCommitOuterFrame(frontBitmap, finalQuad, {
            resetInternalLines: false,
            syncProportionY: finished.kind !== 'moveFrame',
            advanceToLines: false,
            recordUndo: true,
            undoBaseQuad: finished.baseQuad,
          });
        }
      } else if (viewTab === 'superior') {
        const finalTop = draftTopQuadRef.current;
        draftTopQuadRef.current = null;
        setDraftTopQuad(null);
        if (finalTop && topBitmap && onCommitTopQuad) {
          const ratioXZ = estimateAspectRatioFixedFocal(
            finalTop,
            topBitmap.w,
            topBitmap.h,
            focal35mm,
          );
          onCommitTopQuad(finalTop, ratioXZ);
        }
      } else {
        const finalSide = draftSideQuadRef.current;
        draftSideQuadRef.current = null;
        setDraftSideQuad(null);
        if (finalSide && sideBitmap) {
          const ratioZY = estimateAspectRatioFixedFocal(
            finalSide,
            sideBitmap.w,
            sideBitmap.h,
            focal35mm,
          );
          const estDepth = clampNum(Math.round(params.targetDimensions.y * ratioZY), 200, 800);
          onCommitSideQuad(finalSide, ratioZY, estDepth);
        }
      }
      return;
    }

    if (finished.kind === 'drawBox') {
      const finalBox = draftQuadRef.current;
      draftQuadRef.current = null;
      setDraftQuad(null);
      const distScreen = Math.hypot(
        e.clientX - finished.startClient.x,
        e.clientY - finished.startClient.y,
      );
      if (finished.movedEnough && finalBox && distScreen >= 24 && frontBitmap) {
        const boxW = Math.abs(finalBox[1].x - finalBox[0].x);
        const boxH = Math.abs(finalBox[2].y - finalBox[1].y);
        if (boxW >= 24 && boxH >= 24) {
          onCommitOuterFrame(frontBitmap, finalBox, {
            resetInternalLines: false,
            syncProportionY: true,
            advanceToLines: true,
            recordUndo: true,
            undoBaseQuad: finished.baseQuad,
          });
          return;
        }
      }
      onSetStatusMsg('Gesto corto cancelado: se conservó el contorno anterior.');
      return;
    }

    if (finished.kind === 'drawRegion') {
      const finalReg = draftRegionRef.current;
      draftRegionRef.current = null;
      setDraftRegion(null);
      const distScreen = Math.hypot(
        e.clientX - finished.startClient.x,
        e.clientY - finished.startClient.y,
      );
      if (distScreen < 8) {
        // Clic directo sobre una celda existente -> agregar/alternar como sección
        const existingZones =
          (topology.frontZones?.length ?? 0) > 0
            ? topology.frontZones!
            : partitionCellsFromVectors(materializedBase.vDividers, materializedBase.hShelves);
        const hitCell = existingZones.find(
          (z) =>
            finished.startU >= z.uStart &&
            finished.startU <= z.uEnd &&
            finished.startV >= z.vStart &&
            finished.startV <= z.vEnd,
        );
        if (hitCell) {
          onAddOrToggleSubRegion(
            {
              uStart: round4(hitCell.uStart),
              uEnd: round4(hitCell.uEnd),
              vStart: round4(hitCell.vStart),
              vEnd: round4(hitCell.vEnd),
            },
            true,
          );
        }
        return;
      }
      if (
        finalReg &&
        finalReg.uEnd - finalReg.uStart >= 0.04 &&
        finalReg.vEnd - finalReg.vStart >= 0.04
      ) {
        onAddOrToggleSubRegion(
          {
            uStart: round4(finalReg.uStart),
            uEnd: round4(finalReg.uEnd),
            vStart: round4(finalReg.vStart),
            vEnd: round4(finalReg.vEnd),
          },
          false,
        );
      } else {
        onSetStatusMsg(
          'Sección muy pequeña. Arrastra un recuadro dentro del mueble o haz clic sobre una celda.',
        );
      }
      return;
    }

    if (finished.kind === 'drawVector') {
      const distScreen = Math.hypot(
        e.clientX - finished.startClient.x,
        e.clientY - finished.startClient.y,
      );
      if (distScreen < 5) {
        if (finished.plane !== 'xy') {
          if (finished.clickFallbackPlaneLineId) {
            onSetSelectedPlaneLineId?.(finished.clickFallbackPlaneLineId);
            onSetStatusMsg(
              'Línea seleccionada: arrastra los círculos en las puntas para achicar o alargar, o ajusta abajo.',
            );
          } else {
            onSetSelectedPlaneLineId?.(null);
          }
          return;
        }
        if (finished.clickFallbackLine) {
          onSetSelectedLine(finished.clickFallbackLine);
          onSetStatusMsg(
            'Línea seleccionada: arrastra los círculos en las puntas para achicar o alargar, o ajusta abajo.',
          );
        } else {
          onSetSelectedLine(null);
        }
        return;
      }

      const planeHom =
        finished.plane === 'xy'
          ? committedHomography
          : computeQuadToUnitHomography(finished.plane === 'xz' ? topQuad : sideQuad);
      if (!planeHom) return;

      const planeW =
        finished.plane === 'xy'
          ? Math.max(1, params.targetDimensions.x - 2 * params.boardThickness)
          : finished.plane === 'xz'
            ? params.targetDimensions.x
            : params.targetDimensions.z;
      const planeH =
        finished.plane === 'xy'
          ? Math.max(1, params.targetDimensions.y - 2 * params.boardThickness)
          : finished.plane === 'xz'
            ? params.targetDimensions.z
            : params.targetDimensions.y;

      const resolvedXY =
        finished.plane === 'xy' && committedHomography
          ? resolveGuidedStrokeEnd(
              finished.startU,
              finished.startV,
              endRaw,
              committedHomography,
              scaleX,
              scaleY,
              e.altKey,
              isTouch,
              finished.guidedEndImg,
            )
          : null;

      const unitSnapNonFront =
        finished.plane !== 'xy' && !e.altKey
          ? snapPointInUnitQuad(
              endRaw,
              planeHom.toUnit,
              planeHom.toCanvas,
              getNonFrontUnitVertices(finished.plane),
              scaleX,
              scaleY,
              isTouch ? 16 : 12,
              { wMm: planeW, hMm: planeH, enabled: paperGridSnap && !e.altKey, stepMm: paperGridStepMm },
            )
          : null;

      const snappedEndImg =
        finished.plane === 'xy'
          ? (resolvedXY?.endPt ?? endRaw)
          : (unitSnapNonFront?.snappedImg ?? finished.guidedEndImg ?? endRaw);

      if (strokeMode === 'curve' || strokeMode === 'auto') {
        const rawStrokePts = [
          finished.startImg,
          ...(finished.points.length > 2 ? finished.points.slice(1, -1) : []),
          snappedEndImg,
        ];
        const pointsMm: Point2D[] = [];
        for (const sp of rawStrokePts) {
          const uPt = applyHomography(planeHom.toUnit, sp);
          if (!uPt) continue;
          const uNorm =
            finished.plane === 'xy'
              ? exteriorToInterior(uPt.x, params.boardThickness, params.targetDimensions.x)
              : clampNum(uPt.x, 0, 1);
          const vNorm =
            finished.plane === 'xy'
              ? exteriorToInterior(uPt.y, params.boardThickness, params.targetDimensions.y)
              : clampNum(uPt.y, 0, 1);
          pointsMm.push({ x: uNorm * planeW, y: vNorm * planeH });
        }

        const curveFit = fitDifferentialCurveFromStroke(pointsMm, strokeMode === 'curve');
        if (curveFit?.isCurved && onCommitCurvedCut) {
          const toNorm = (pMm: Point2D): Point2D => ({
            x: Number(clampNum(pMm.x / planeW, 0, 1).toFixed(4)),
            y: Number(clampNum(pMm.y / planeH, 0, 1).toFixed(4)),
          });
          onCommitCurvedCut({
            id: `usr_curve_${Date.now()}`,
            plane: finished.plane,
            kind: 'free_bezier',
            controlPoints: [
              toNorm(curveFit.controlPoints[0]),
              toNorm(curveFit.controlPoints[1]),
              toNorm(curveFit.controlPoints[2]),
              toNorm(curveFit.controlPoints[3]),
            ],
            label: `Curva ${finished.plane.toUpperCase()} (s=${Math.round(curveFit.arcLengthMm)} mm)`,
            arcLengthMm: curveFit.arcLengthMm,
            minRadiusMm: curveFit.minRadiusMm,
            maxCurvature: curveFit.maxCurvature,
          });
          return;
        }
        if (strokeMode === 'curve') {
          onSetStatusMsg(
            'En modo "Curva" dibuja un arco suave (o pulsa "Línea recta" para trazar divisiones rectas).',
          );
          return;
        }
      }

      if (finished.plane !== 'xy') {
        const planeHomXZ = planeHom;
        const nonFrontPlane = finished.plane;
        let endUnit =
          unitSnapNonFront?.unitPt ?? applyHomography(planeHomXZ.toUnit, snappedEndImg);
        if (endUnit && (strokeMode === 'ortho' || !unitSnapNonFront?.indicator)) {
          const du = Math.abs(endUnit.x - finished.startU);
          const dv = Math.abs(endUnit.y - finished.startV);
          const deg = (Math.atan2(dv, du) * 180) / Math.PI;
          if (strokeMode === 'ortho' ? du >= dv : deg <= 12) {
            endUnit = { x: endUnit.x, y: finished.startV };
          } else if (strokeMode === 'ortho' ? dv > du : deg >= 78) {
            endUnit = { x: finished.startU, y: endUnit.y };
          }
        }
        if (endUnit && onCommitPlaneLine) {
          const u1 = Number(clampNum(finished.startU, 0, 1).toFixed(4));
          const v1 = Number(clampNum(finished.startV, 0, 1).toFixed(4));
          const u2 = Number(clampNum(endUnit.x, 0, 1).toFixed(4));
          const v2 = Number(clampNum(endUnit.y, 0, 1).toFixed(4));
          if (Math.hypot(u2 - u1, v2 - v1) >= 0.03) {
            onCommitPlaneLine(nonFrontPlane, {
              id: `pln_${nonFrontPlane}_${Date.now()}`,
              u1,
              v1,
              u2,
              v2,
            });
            onSetStatusMsg(
              `Línea trazada en vista ${nonFrontPlane === 'xz' ? 'Arriba (XZ)' : 'Lado (ZY)'} adaptada a esquinas/papel milimetrado.`,
            );
            return;
          }
        }
        onSetStatusMsg('Trazo demasiado corto. Arrastra entre dos puntos para dibujar.');
        return;
      }
      if (!committedHomography || !resolvedXY) return;

      // En trazado interactivo directo usamos las coordenadas ya imantadas a esquina/papel milimetrado
      // y ancladas al vértice inicial para cero saltos al soltar.
      const stroke = vectorizeUserStroke(
        finished.startImg,
        resolvedXY.endPt,
        committedHomography.toUnit,
        materializedBase.vDividers,
        materializedBase.hShelves,
        params.boardThickness,
        params.targetDimensions,
        false,
        strokeMode,
        {
          exactStartPos: true,
          lockToStart: finished.startAnchored || strokeMode === 'ortho',
        },
      );
      if (!stroke) {
        onSetStatusMsg('Trazo demasiado corto. Arrastra una línea recta o diagonal sobre la foto.');
        return;
      }

      if (stroke.kind === 'vDivider') {
        onCommitTracedVectors(
          [...materializedBase.vDividers, stroke.segment],
          materializedBase.hShelves,
          topology.diagonalDividers ?? [],
          { recordUndo: true },
        );
        onSetSelectedLine(null);
        onSetStatusMsg(
          `Divisor vertical creado en X = ${stroke.positionMm} mm (largo ${stroke.spanMm} mm). Puedes seguir conectando otra línea en su esquina.`,
        );
      } else if (stroke.kind === 'hShelf') {
        onCommitTracedVectors(
          materializedBase.vDividers,
          [...materializedBase.hShelves, stroke.segment],
          topology.diagonalDividers ?? [],
          { recordUndo: true },
        );
        onSetSelectedLine(null);
        onSetStatusMsg(
          `Repisa horizontal creada en Y = ${stroke.positionMm} mm (luz ${stroke.spanMm} mm). Puedes seguir conectando otra línea en su esquina.`,
        );
      } else {
        onCommitTracedVectors(
          materializedBase.vDividers,
          materializedBase.hShelves,
          [...(topology.diagonalDividers ?? []), stroke.segment],
          { recordUndo: true },
        );
        onSetSelectedLine(null);
        onSetStatusMsg(
          `División diagonal creada (${Math.abs(stroke.angleDeg)}° · largo ${stroke.spanMm} mm). Puedes seguir conectando otra línea en su esquina.`,
        );
      }
      return;
    }

    if (finished.kind === 'editLine') {
      const finalLines = draftLinesRef.current;
      draftLinesRef.current = null;
      setDraftLines(null);
      if (finalLines) {
        const moved =
          JSON.stringify(finalLines.vDividers) !== JSON.stringify(finished.baseLines.vDividers) ||
          JSON.stringify(finalLines.hShelves) !== JSON.stringify(finished.baseLines.hShelves) ||
          JSON.stringify(finalLines.diagonalDividers) !==
            JSON.stringify(finished.baseLines.diagonalDividers);
        if (moved) {
          onCommitTracedVectors(
            finalLines.vDividers,
            finalLines.hShelves,
            finalLines.diagonalDividers,
            { recordUndo: true },
          );
          onSetStatusMsg('Línea actualizada (Ctrl+Z para deshacer). Arrastra las puntas si quieres achicar o alargar más.');
        } else {
          onSetStatusMsg('Línea seleccionada: arrastra los círculos en las puntas para achicar o alargar.');
        }
      }
      return;
    }

    if (finished.kind === 'editPlaneLine') {
      const finalPlaneDraft = draftPlaneLinesRef.current;
      draftPlaneLinesRef.current = null;
      setDraftPlaneLines(null);
      if (finalPlaneDraft && onUpdatePlaneLine) {
        const updated = finalPlaneDraft.lines.find((l) => l.id === finished.hit.id);
        const orig = finished.baseLines.find((l) => l.id === finished.hit.id);
        if (updated && orig && JSON.stringify(updated) !== JSON.stringify(orig)) {
          onUpdatePlaneLine(finished.plane, updated);
          onSetStatusMsg('Línea actualizada en vista Arriba / Lado.');
        }
      }
      return;
    }
  };

  const handlePointerLeave = useCallback(() => {
    if (!dragRef.current) {
      setLoupeFocusPt(null);
      setSnapIndicator(null);
      setEyedropperPreview(null);
      setHoverTarget({ kind: 'none' });
      if (traceStep === 'zones') onHoverZone(null);
    }
  }, [traceStep, onHoverZone]);

  const canvasCursor = useMemo(() => {
    if (isDraggingState) return 'grabbing';
    if (isSpacePan || panToolActive) return 'grab';
    if (subTool !== 'none') return 'crosshair';
    if (traceStep === 'frame') {
      if (pickingCorners !== null) return 'crosshair';
      if (hoverTarget.kind === 'corner') return 'grab';
      if (hoverTarget.kind === 'edge') {
        return hoverTarget.edgeIdx === 0 || hoverTarget.edgeIdx === 2 ? 'ns-resize' : 'ew-resize';
      }
      if (hoverTarget.kind === 'frameInterior') return strokeMode === 'curve' ? 'crosshair' : 'move';
      return frameMode === 'box' || strokeMode === 'curve' ? 'crosshair' : 'default';
    }
    if (viewTab !== 'frontal') {
      if (traceStep === 'lines' && hoverTarget.kind === 'lineEnd') return 'grab';
      if (traceStep === 'lines' && hoverTarget.kind === 'lineBody') return 'move';
      return 'crosshair';
    }
    if (traceStep === 'lines') {
      if (linesSubMode === 'regions') return 'crosshair';
      if (hoverTarget.kind === 'lineEnd') return 'grab';
      if (linesSubMode === 'smart' && hoverTarget.kind === 'lineBody') {
        if (hoverTarget.lineRef?.kind === 'vDivider') return 'ew-resize';
        if (hoverTarget.lineRef?.kind === 'hShelf') return 'ns-resize';
        return 'move';
      }
      return 'crosshair';
    }
    return hoverTarget.kind === 'zone' ? 'pointer' : 'default';
  }, [
    isDraggingState,
    isSpacePan,
    panToolActive,
    subTool,
    viewTab,
    traceStep,
    pickingCorners,
    hoverTarget,
    frameMode,
    linesSubMode,
  ]);

  return {
    displayHomography,
    zoom,
    pan,
    panToolActive,
    setPanToolActive,
    applyZoom,
    resetViewport,
    draftQuad,
    draftTopQuad,
    draftSideQuad,
    draftLines,
    draftPlaneLines,
    draftRegion,
    liveStroke,
    snapIndicator,
    loupeFocusPt,
    setLoupeFocusPt,
    loupeSide,
    eyedropperPreview,
    setEyedropperPreview,
    hoverTarget,
    isDraggingState,
    isPanning: isPanningState,
    canvasCursor,
    clearDrafts,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handlePointerLeave,
  };
}
