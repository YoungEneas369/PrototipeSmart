/**
 * SMARTFURNITURE v8.0 — CONTROLADOR DE INTERACCIÓN 60 FPS (`useCanvasPointerController`)
 * Gestiona estado efímero de arrastre (`draftQuad`, `draftSideQuad`, `draftLines`, `liveStroke`),
 * Zoom continuo 0.75×..4× (Ctrl+Rueda / botones / pinch táctil sin bloquear scroll en 1×),
 * Pan fluido, Lupa 4× centrada en punto imantado, hit-testing en píxeles de pantalla y `onPointerCancel`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
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
  type Matrix3x3,
} from '../../core/mathEngine';
import {
  estimateAspectRatioFixedFocal,
  isConvexQuad,
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
  dragQuadEdge,
  hitTestFrameScreenPx,
  hitTestLinesScreenPx,
  makeAxisAlignedQuad,
  resizeBoxCorner,
  round4,
  sampleEyedropperMaterial,
  snapPointToStructuralAnchors,
  translateQuad,
  type FrameMode,
  type LineHitResult,
  type LineRef,
  type LinesSubMode,
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
      startClient: Point2D;
      clickFallbackLine: LineRef | null;
      pointerId: number;
    }
  | {
      kind: 'editLine';
      hit: LineHitResult;
      startImg: Point2D;
      startU: number;
      startV: number;
      baseLines: DraftLinesState;
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
  viewTab: 'frontal' | 'lateral';
  traceStep: TraceStep;
  frameMode: FrameMode;
  linesSubMode: LinesSubMode;
  strokeMode: UserStrokeMode;
  subTool: SubTool;
  magneticSnap: boolean;
  isSpacePan: boolean;
  frontBitmap: WorkingBitmap | null;
  sideBitmap: WorkingBitmap | null;
  quad: [Point2D, Point2D, Point2D, Point2D];
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
  onEyedropperSampled: (material: MelamineMaterial, rgb: [number, number, number]) => void;
  onCommitOuterFrame: (
    bmp: WorkingBitmap,
    nextQuad: [Point2D, Point2D, Point2D, Point2D],
    opts: {
      resetInternalLines?: boolean;
      applyDims?: boolean;
      advanceToLines?: boolean;
      recordUndo?: boolean;
      undoBaseQuad?: [Point2D, Point2D, Point2D, Point2D];
    },
  ) => void;
  onCommitSideQuad: (nextSide: [Point2D, Point2D, Point2D, Point2D], ratioZY: number, estDepth: number) => void;
  onCommitTracedVectors: (
    vDivs: NormalizedSegment[],
    hShs: NormalizedSegment[],
    diags: DiagonalSegment[],
    opts: { preserveZones?: boolean; recordUndo?: boolean },
  ) => void;
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
  isSpacePan,
  frontBitmap,
  sideBitmap,
  quad,
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
  onCommitOuterFrame,
  onCommitSideQuad,
  onCommitTracedVectors,
  onSetStatusMsg,
}: UseCanvasPointerControllerOptions) {
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<Point2D>({ x: 0, y: 0 });
  const [panToolActive, setPanToolActive] = useState<boolean>(false);

  const [draftQuad, setDraftQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const [draftSideQuad, setDraftSideQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(
    null,
  );
  const [draftLines, setDraftLines] = useState<DraftLinesState | null>(null);
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

  const dragRef = useRef<ActiveDrag | null>(null);
  const draftQuadRef = useRef<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const draftSideQuadRef = useRef<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const draftLinesRef = useRef<DraftLinesState | null>(null);
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
      const nextZoom = Number(clampNum(nextZoomRaw, 0.75, 4).toFixed(2));
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
    draftSideQuadRef.current = null;
    draftLinesRef.current = null;
    pinchBaseRef.current = null;
    activeTouchMapRef.current.clear();
    setDraftQuad(null);
    setDraftSideQuad(null);
    setDraftLines(null);
    setLiveStroke(null);
    setSnapIndicator(null);
    setLoupeFocusPt(null);
    setEyedropperPreview(null);
    setHoverTarget({ kind: 'none' });
    setIsDraggingState(false);
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
        const nextZoom = Number(clampNum(prevZoom * factor, 0.75, 4).toFixed(2));
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
    (pt: Point2D, altKey: boolean): { pt: Point2D; indicator: SnapIndicator | null } => {
      if (!magneticSnap || altKey || viewTab !== 'frontal' || !frontBitmap) {
        return { pt, indicator: null };
      }
      const res = snapPointToStrongEdge(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, pt, 9);
      if (res.didSnap) {
        return {
          pt: res.snapped,
          indicator: { pt: res.snapped, kind: 'edge', label: 'Imán borde' },
        };
      }
      return { pt, indicator: null };
    },
    [magneticSnap, viewTab, frontBitmap],
  );

  const snapForLineOperation = useCallback(
    (
      rawPt: Point2D,
      scaleX: number,
      scaleY: number,
      altKey: boolean,
      vDivs: readonly NormalizedSegment[],
      hShs: readonly NormalizedSegment[],
      excludeId?: string,
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
          12,
          excludeId,
        );
        if (structSnap && structSnap.indicator) {
          return {
            pt: structSnap.snappedImg,
            u: structSnap.u,
            v: structSnap.v,
            indicator: structSnap.indicator,
          };
        }
      }

      const edgeRes = snapEdgeIfEnabled(rawPt, altKey);
      const unit = applyHomography(displayHomography.toUnit, edgeRes.pt);
      if (!unit) return null;
      return {
        pt: edgeRes.pt,
        u: exteriorToInterior(unit.x, eMm, xf),
        v: exteriorToInterior(unit.y, eMm, yf),
        indicator: edgeRes.indicator,
      };
    },
    [displayHomography, params.boardThickness, params.targetDimensions, snapEdgeIfEnabled],
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
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;

    const { pt: rawPt, scaleX, scaleY } = getCanvasMetrics(e.clientX, e.clientY);
    updateLoupeSide(e.clientX);

    // 1. Subherramientas temporales (`calibA4` / `eyedropper`)
    if (viewTab === 'frontal' && subTool !== 'none' && frontBitmap) {
      if (subTool === 'calibA4') {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey);
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
        onEyedropperSampled(sampled.material, sampled.rgb);
        onSetStatusMsg(
          `Acabado detectado por gotero: ${MELAMINE_LABELS[sampled.material]} (RGB ${sampled.rgb.join(', ')}). Medidas y trazos intactos.`,
        );
        return;
      }
    }

    // 2. Vista Lateral ZY
    if (viewTab === 'lateral') {
      const hit = hitTestFrameScreenPx(rawPt, sideQuad, scaleX, scaleY, isTouch);
      if (!hit) return;
      if (hit.kind === 'corner') {
        dragRef.current = {
          kind: 'corner',
          idx: hit.idx,
          baseQuad: cloneQuad(sideQuad),
          pointerId: e.pointerId,
        };
      } else if (hit.kind === 'edge') {
        dragRef.current = {
          kind: 'edge',
          edgeIdx: hit.edgeIdx,
          startImg: rawPt,
          baseQuad: cloneQuad(sideQuad),
          pointerId: e.pointerId,
        };
      } else {
        dragRef.current = {
          kind: 'moveFrame',
          startImg: rawPt,
          baseQuad: cloneQuad(sideQuad),
          pointerId: e.pointerId,
        };
      }
      setIsDraggingState(true);
      setLoupeFocusPt(rawPt);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 3. Paso 1 — Contorno exterior
    if (traceStep === 'frame') {
      if (pickingCorners !== null) {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey);
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
              applyDims: false,
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
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey);
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

    // 4. Paso 2 — Líneas internas (CERO secuestro de esquinas del contorno exterior)
    if (traceStep === 'lines' && displayHomography) {
      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;
      const vDivs = materializedBase.vDividers;
      const hShs = materializedBase.hShelves;
      const diags = topology.diagonalDividers ?? [];

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
      );

      const shouldEditLine =
        hit !== null &&
        (linesSubMode === 'move' ||
          (hit.part !== 'body' &&
            selectedLine !== null &&
            hit.kind === selectedLine.kind &&
            hit.id === selectedLine.id));

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
          startImg: rawPt,
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

      if (linesSubMode === 'move') {
        onSetSelectedLine(null);
        return;
      }

      const snappedStart = snapForLineOperation(rawPt, scaleX, scaleY, e.altKey, vDivs, hShs);
      const startPt = snappedStart?.pt ?? rawPt;
      setSnapIndicator(snappedStart?.indicator ?? null);
      setLoupeFocusPt(startPt);
      setLiveStroke({ startImg: startPt, currentImg: startPt });
      dragRef.current = {
        kind: 'drawVector',
        startImg: startPt,
        startClient: { x: e.clientX, y: e.clientY },
        clickFallbackLine: hit ? { kind: hit.kind, id: hit.id } : null,
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
        const nextZoom = Number(clampNum(base.zoom * (dist / base.dist), 0.75, 4).toFixed(2));
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
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey);
        setLoupeFocusPt(snapped.pt);
        setSnapIndicator(snapped.indicator);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'frame' && pickingCorners !== null) {
        const snapped = snapEdgeIfEnabled(rawPt, e.altKey);
        setLoupeFocusPt(snapped.pt);
        setSnapIndicator(snapped.indicator);
        return;
      }
      if (viewTab === 'lateral' || (viewTab === 'frontal' && traceStep === 'frame')) {
        const q = viewTab === 'frontal' ? quad : sideQuad;
        const hit = hitTestFrameScreenPx(rawPt, q, scaleX, scaleY, isTouch);
        if (!hit) setHoverTarget({ kind: 'none' });
        else if (hit.kind === 'corner') setHoverTarget({ kind: 'corner', idx: hit.idx });
        else if (hit.kind === 'edge') setHoverTarget({ kind: 'edge', edgeIdx: hit.edgeIdx });
        else setHoverTarget({ kind: 'frameInterior' });
        setLoupeFocusPt(null);
        setSnapIndicator(null);
        return;
      }
      if (viewTab === 'frontal' && traceStep === 'lines' && displayHomography) {
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
        );
        setHoverTarget(
          hit
            ? {
                kind: hit.part === 'body' ? 'lineBody' : 'lineEnd',
                lineRef: { kind: hit.kind, id: hit.id },
                linePart: hit.part,
              }
            : { kind: 'none' },
        );
        if (linesSubMode === 'draw') {
          const snapped = snapForLineOperation(
            rawPt,
            scaleX,
            scaleY,
            e.altKey,
            materializedBase.vDividers,
            materializedBase.hShelves,
          );
          setSnapIndicator(snapped?.indicator ?? null);
        } else {
          setSnapIndicator(null);
        }
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

    const bmp = viewTab === 'frontal' ? frontBitmap : sideBitmap;
    const bw = bmp?.w ?? 900;
    const bh = bmp?.h ?? 680;

    if (active.kind === 'corner') {
      const snapped =
        viewTab === 'frontal' ? snapEdgeIfEnabled(rawPt, e.altKey) : { pt: rawPt, indicator: null };
      const clampedPt = { x: clampNum(snapped.pt.x, 2, bw - 2), y: clampNum(snapped.pt.y, 2, bh - 2) };
      setSnapIndicator(snapped.indicator);
      setLoupeFocusPt(clampedPt);

      const nextQ =
        viewTab === 'frontal' && frameMode === 'box'
          ? resizeBoxCorner(active.baseQuad, active.idx, clampedPt, bw, bh)
          : (() => {
              const copy = cloneQuad(active.baseQuad);
              copy[active.idx] = clampedPt;
              return isConvexQuad(copy) ? copy : (draftQuadRef.current ?? active.baseQuad);
            })();

      if (viewTab === 'frontal') {
        draftQuadRef.current = nextQ;
        setDraftQuad(nextQ);
      } else {
        draftSideQuadRef.current = nextQ;
        setDraftSideQuad(nextQ);
      }
      return;
    }

    if (active.kind === 'edge') {
      const snapped =
        viewTab === 'frontal' ? snapEdgeIfEnabled(rawPt, e.altKey) : { pt: rawPt, indicator: null };
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
      const snapped = snapEdgeIfEnabled(rawPt, e.altKey);
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

    if (active.kind === 'drawVector') {
      const snapped = snapForLineOperation(
        rawPt,
        scaleX,
        scaleY,
        e.altKey,
        materializedBase.vDividers,
        materializedBase.hShelves,
      );
      const curPt = snapped?.pt ?? rawPt;
      setSnapIndicator(snapped?.indicator ?? null);
      setLoupeFocusPt(curPt);
      setLiveStroke({ startImg: active.startImg, currentImg: curPt });
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
        const edgeRes = snapEdgeIfEnabled(rawPt, e.altKey);
        const unit = applyHomography(displayHomography.toUnit, edgeRes.pt);
        if (!unit) return;
        u = exteriorToInterior(unit.x, eMm, xf);
        v = exteriorToInterior(unit.y, eMm, yf);
        focusPt = edgeRes.pt;
        ind = edgeRes.indicator;
      } else {
        const snapped = snapForLineOperation(
          rawPt,
          scaleX,
          scaleY,
          e.altKey,
          baseLines.vDividers,
          baseLines.hShelves,
          hit.id,
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
    dragRef.current = null;
    setIsDraggingState(false);
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
            applyDims: false,
            advanceToLines: false,
            recordUndo: true,
            undoBaseQuad: finished.baseQuad,
          });
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
            applyDims: false,
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

    if (finished.kind === 'drawVector') {
      const distScreen = Math.hypot(
        e.clientX - finished.startClient.x,
        e.clientY - finished.startClient.y,
      );
      if (distScreen < 6) {
        if (finished.clickFallbackLine) {
          onSetSelectedLine(finished.clickFallbackLine);
          onSetStatusMsg('Línea seleccionada: edita sus medidas abajo o arrastra sus extremos.');
        }
        return;
      }

      if (!committedHomography) return;
      const snappedEnd = snapForLineOperation(
        endRaw,
        scaleX,
        scaleY,
        e.altKey,
        materializedBase.vDividers,
        materializedBase.hShelves,
      );
      const endPt = snappedEnd?.pt ?? endRaw;
      const stroke = vectorizeUserStroke(
        finished.startImg,
        endPt,
        committedHomography.toUnit,
        materializedBase.vDividers,
        materializedBase.hShelves,
        params.boardThickness,
        params.targetDimensions,
        !e.altKey,
        strokeMode,
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
        onSetSelectedLine({ kind: 'vDivider', id: stroke.segment.id });
        onSetStatusMsg(
          `Divisor vertical creado en X = ${stroke.positionMm} mm (largo ${stroke.spanMm} mm).`,
        );
      } else if (stroke.kind === 'hShelf') {
        onCommitTracedVectors(
          materializedBase.vDividers,
          [...materializedBase.hShelves, stroke.segment],
          topology.diagonalDividers ?? [],
          { recordUndo: true },
        );
        onSetSelectedLine({ kind: 'hShelf', id: stroke.segment.id });
        onSetStatusMsg(
          `Repisa horizontal creada en Y = ${stroke.positionMm} mm (luz ${stroke.spanMm} mm).`,
        );
      } else {
        onCommitTracedVectors(
          materializedBase.vDividers,
          materializedBase.hShelves,
          [...(topology.diagonalDividers ?? []), stroke.segment],
          { recordUndo: true },
        );
        onSetSelectedLine({ kind: 'diagonal', id: stroke.segment.id });
        onSetStatusMsg(
          `División diagonal creada (${Math.abs(stroke.angleDeg)}° · largo ${stroke.spanMm} mm).`,
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
          onSetStatusMsg('Línea actualizada en 2D y 3D (Ctrl+Z para deshacer).');
        } else {
          onSetStatusMsg('Línea seleccionada: edita sus medidas abajo o arrastra sus extremos.');
        }
      }
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
    if (viewTab === 'lateral' || traceStep === 'frame') {
      if (pickingCorners !== null) return 'crosshair';
      if (hoverTarget.kind === 'corner') return 'grab';
      if (hoverTarget.kind === 'edge') {
        return hoverTarget.edgeIdx === 0 || hoverTarget.edgeIdx === 2 ? 'ns-resize' : 'ew-resize';
      }
      if (hoverTarget.kind === 'frameInterior') return 'move';
      return frameMode === 'box' ? 'crosshair' : 'default';
    }
    if (traceStep === 'lines') {
      if (hoverTarget.kind === 'lineEnd') return 'grab';
      if (linesSubMode === 'move' && hoverTarget.kind === 'lineBody') {
        if (hoverTarget.lineRef?.kind === 'vDivider') return 'ew-resize';
        if (hoverTarget.lineRef?.kind === 'hShelf') return 'ns-resize';
        return 'move';
      }
      return linesSubMode === 'draw' ? 'crosshair' : 'default';
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
    draftSideQuad,
    draftLines,
    liveStroke,
    snapIndicator,
    loupeFocusPt,
    setLoupeFocusPt,
    loupeSide,
    eyedropperPreview,
    setEyedropperPreview,
    hoverTarget,
    isDraggingState,
    isPanning: dragRef.current?.kind === 'pan',
    canvasCursor,
    clearDrafts,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handlePointerLeave,
  };
}
