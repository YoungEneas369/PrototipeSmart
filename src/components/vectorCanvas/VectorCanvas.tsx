/**
 * SMARTFURNITURE — VECTORCANVAS v5.0 (SIMULACIÓN DE CLIENTE + LÍNEAS VECTORIALES + EVALUADOR MÁRGENES/3D)
 * - Resalta cada línea estructural de la foto como un vector geométrico 2D (`VectorLine2D`: p1, p2, û, rol).
 * - Evalúa automáticamente Márgenes vs Foto (`MarginEvaluationResult`) y 3D vs Foto (`Visual3DSimilarityResult`),
 *   mostrando barras de similitud en vivo y ejecutando auto-iteración (Band/Híbrido vs Vector-First + acabado).
 * - Interfaz diseñada por simulación de cliente: encuadre 1-arrastre por defecto, chips táctiles de zonas
 *   debajo de la foto para cambiar Abierto/Puerta/Cajones/Vidrio/Hueco sin pelear con clics pequeños.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Contrast,
  Crop,
  Eraser,
  GitBranch,
  LayoutGrid,
  Move,
  Pipette,
  RefreshCw,
  Ruler,
  Scan,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import type {
  DespieceResult,
  FrontModuleKind,
  FrontZone,
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
  interiorToExterior,
} from '../../core/mathEngine';
import {
  autoDetectFurnitureQuad,
  computeSobelEdgeOverlayRGBA,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  evaluate3DvsPhotoSimilarity,
  evaluateMarginsAgainstPhoto,
  extractStructuralVectorLines,
  extrapolateDimensionsFromSingleMeasure,
  rectifyImageRGBA,
  runIterativePhotoTo3D,
  type MarginEvaluationResult,
  type VectorLine2D,
  type VectorLineRole,
  type Visual3DSimilarityResult,
} from '../../core/vision';
import { NumericInput } from '../NumericInput';

interface VectorCanvasProps {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  despiece: DespieceResult;
  externalPhotoUrl?: string | null;
  externalPhotoLabel?: string | null;
  onUpdateTopology: (next: FurnitureTopology) => void;
  onUpdateFrontZones: (zones: FrontZone[]) => void;
  onApplyCalibratedDims: (dims: { x: number; y: number; z: number }) => void;
  onAutoPhotoReconstructed: (
    dims: { x: number; y: number; z: number },
    detectedMaterial?: MelamineMaterial,
  ) => void;
  onToggleExternalLegs: (checked: boolean, heightMm?: number, count?: number) => void;
  onSelectDepthMm: (zMm: number) => void;
}

type FrameMode = 'box' | 'quad';

type ToolMode =
  | 'corners'
  | 'drawBox'
  | 'vDivider'
  | 'hShelf'
  | 'eyedropper'
  | 'calibA4'
  | 'erase';

type VisualLayerMode = 'vectors_zones' | 'vectors' | 'margins' | 'photo' | 'edges';

type DragTarget =
  | { kind: 'corner'; idx: number }
  | { kind: 'drawBox'; start: Point2D }
  | { kind: 'vDivider'; id: string }
  | { kind: 'hShelf'; id: string };

interface LineSnapshot {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  frontZones?: FrontZone[];
}

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;
const SNAP_TOL = 0.03;
const MAX_WORK_DIM = 1400;

const ZONE_CYCLE: readonly FrontModuleKind[] = [
  'open',
  'door_left',
  'door_double',
  'drawers',
  'door_glass',
  'leg_void',
];

const ZONE_LABELS: Record<FrontModuleKind, string> = {
  open: 'Abierto',
  door_left: 'Puerta Izq',
  door_right: 'Puerta Der',
  door_double: '2 Puertas',
  door_glass: 'Vidrio',
  drawers: 'Cajones',
  leg_void: 'Hueco Piernas',
};

const ZONE_COLORS: Record<FrontModuleKind, { fill: string; stroke: string; dot: string }> = {
  open: { fill: 'rgba(14, 165, 233, 0.18)', stroke: '#38bdf8', dot: '#0284c7' },
  door_left: { fill: 'rgba(250, 204, 21, 0.22)', stroke: '#facc15', dot: '#ca8a04' },
  door_right: { fill: 'rgba(250, 204, 21, 0.22)', stroke: '#facc15', dot: '#ca8a04' },
  door_double: { fill: 'rgba(245, 158, 11, 0.22)', stroke: '#f59e0b', dot: '#d97706' },
  door_glass: { fill: 'rgba(125, 211, 252, 0.26)', stroke: '#7dd3fc', dot: '#0ea5e9' },
  drawers: { fill: 'rgba(249, 115, 22, 0.24)', stroke: '#fb923c', dot: '#ea580c' },
  leg_void: { fill: 'rgba(168, 85, 247, 0.22)', stroke: '#c084fc', dot: '#9333ea' },
};

const VECTOR_ROLE_COLORS: Record<VectorLineRole, string> = {
  outer_top: '#00e5ff',
  outer_bottom: '#00e5ff',
  outer_left: '#00e5ff',
  outer_right: '#00e5ff',
  divider: '#22c55e',
  shelf: '#f59e0b',
  seam: '#ec4899',
  detail: 'rgba(203, 213, 225, 0.72)',
};

interface WorkingBitmap {
  canvas: HTMLCanvasElement;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}

function prepareWorkingBitmap(image: HTMLImageElement): WorkingBitmap {
  const nw = Math.max(1, image.naturalWidth);
  const nh = Math.max(1, image.naturalHeight);
  const scale = Math.min(1, MAX_WORK_DIM / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  if (!ctx) {
    return { canvas: off, rgba: new Uint8ClampedArray(0), w: 0, h: 0 };
  }
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { canvas: off, rgba: data.data, w, h };
}

function makeAxisAlignedQuad(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

function quadToBoundingBox(
  q: readonly [Point2D, Point2D, Point2D, Point2D],
): [Point2D, Point2D, Point2D, Point2D] {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  return makeAxisAlignedQuad(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function resizeBoxCorner(
  prev: readonly [Point2D, Point2D, Point2D, Point2D],
  idx: number,
  pt: Point2D,
  w: number,
  h: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const minGap = 24;
  let minX = Math.min(prev[0].x, prev[3].x);
  let maxX = Math.max(prev[1].x, prev[2].x);
  let minY = Math.min(prev[0].y, prev[1].y);
  let maxY = Math.max(prev[2].y, prev[3].y);

  const cx = Math.max(2, Math.min(w - 2, pt.x));
  const cy = Math.max(2, Math.min(h - 2, pt.y));

  if (idx === 0) {
    minX = Math.min(cx, maxX - minGap);
    minY = Math.min(cy, maxY - minGap);
  } else if (idx === 1) {
    maxX = Math.max(cx, minX + minGap);
    minY = Math.min(cy, maxY - minGap);
  } else if (idx === 2) {
    maxX = Math.max(cx, minX + minGap);
    maxY = Math.max(cy, minY + minGap);
  } else {
    minX = Math.min(cx, maxX - minGap);
    maxY = Math.max(cy, minY + minGap);
  }

  return makeAxisAlignedQuad(minX, minY, maxX, maxY);
}

function snapValue(val: number, anchors: readonly number[]): number {
  for (const a of anchors) {
    if (Math.abs(val - a) <= SNAP_TOL) return a;
  }
  return val;
}

function scoreToneClass(score: number): 'score-good' | 'score-mid' | 'score-low' {
  return score >= 72 ? 'score-good' : score >= 52 ? 'score-mid' : 'score-low';
}

function generateSampleFurnitureDataUrl(): string {
  const w = 900;
  const h = 680;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return '';

  const wallGrad = ctx.createLinearGradient(0, 0, w, 0);
  wallGrad.addColorStop(0, '#e2e8f0');
  wallGrad.addColorStop(1, '#f1f5f9');
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, w, 585);
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(0, 585, w, 95);

  const quad = makeAxisAlignedQuad(165, 120, 735, 540);
  const hom = computeQuadToUnitHomography(quad);
  const fillPoly = (pts: Point2D[], fill: string) => {
    ctx.beginPath();
    pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  if (hom) {
    const mapRect = (u0: number, v0: number, u1: number, v1: number, color: string) => {
      const p0 = applyHomography(hom.toCanvas, { x: u0, y: v1 });
      const p1 = applyHomography(hom.toCanvas, { x: u1, y: v1 });
      const p2 = applyHomography(hom.toCanvas, { x: u1, y: v0 });
      const p3 = applyHomography(hom.toCanvas, { x: u0, y: v0 });
      if (p0 && p1 && p2 && p3) fillPoly([p0, p1, p2, p3], color);
    };

    const woodCol = '#cfa06e';
    const seamCol = '#3b2412';
    const eU = 0.025;
    const eV = 0.032;

    mapRect(0, 1 - eV, 1, 1, woodCol);
    mapRect(0, 0, eU, 1, woodCol);
    mapRect(1 - eU, 0, 1, 1, woodCol);
    mapRect(0.64, 0.50, 1 - eU, 1 - eV, '#c79663');
    mapRect(0.64 - 0.008, 0.50, 0.64 + 0.008, 1 - eV, seamCol);
    mapRect(0.64, 0.50 - 0.01, 1 - eU, 0.50 + 0.01, seamCol);
    mapRect(0.64, 0.74 - 0.008, 1 - eU, 0.74 + 0.008, seamCol);
    mapRect(0.79, 0.85, 0.85, 0.87, '#1e293b');
    mapRect(0.79, 0.61, 0.85, 0.63, '#1e293b');
  }

  return c.toDataURL('image/png');
}

export function VectorCanvas({
  topology,
  params,
  despiece,
  externalPhotoUrl,
  externalPhotoLabel,
  onUpdateTopology,
  onUpdateFrontZones,
  onApplyCalibratedDims,
  onAutoPhotoReconstructed,
  onToggleExternalLegs,
  onSelectDepthMm,
}: VectorCanvasProps) {
  const [viewTab, setViewTab] = useState<'frontal' | 'lateral'>('frontal');
  const [frameMode, setFrameMode] = useState<FrameMode>('box');
  const [showPrecisionTools, setShowPrecisionTools] = useState(false);
  const [visualLayer, setVisualLayer] = useState<VisualLayerMode>('vectors_zones');
  const [isDragOver, setIsDragOver] = useState(false);

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [frontBitmap, setFrontBitmap] = useState<WorkingBitmap | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 900, h: 680 });
  const [exteriorBgRgb, setExteriorBgRgb] = useState<[number, number, number]>([242, 244, 248]);
  const [rawAutoQuad, setRawAutoQuad] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(null);
  const [vectorLines, setVectorLines] = useState<VectorLine2D[]>([]);
  const [marginEval, setMarginEval] = useState<MarginEvaluationResult | null>(null);
  const [lastIterationsRun, setLastIterationsRun] = useState<number>(0);

  const [sideImgUrl, setSideImgUrl] = useState<string | null>(null);
  const [sideBitmap, setSideBitmap] = useState<WorkingBitmap | null>(null);
  const [sideQuad, setSideQuad] = useState<[Point2D, Point2D, Point2D, Point2D]>([
    { x: 180, y: 100 },
    { x: 460, y: 100 },
    { x: 470, y: 520 },
    { x: 170, y: 520 },
  ]);

  const [quad, setQuad] = useState<[Point2D, Point2D, Point2D, Point2D]>(
    topology.quadCorners ?? makeAxisAlignedQuad(165, 120, 735, 540),
  );
  const [tool, setTool] = useState<ToolMode>('corners');
  const [focal35mm, setFocal35mm] = useState<26 | 52>(26);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [cursorImgPt, setCursorImgPt] = useState<Point2D | null>(null);
  const [draftLineStart, setDraftLineStart] = useState<Point2D | null>(null);
  const [undoStack, setUndoStack] = useState<LineSnapshot[]>([]);

  const [knownAxis, setKnownAxis] = useState<'x' | 'y'>('x');
  const [knownMeasureMm, setKnownMeasureMm] = useState<number>(params.targetDimensions.x);

  useEffect(() => {
    setKnownMeasureMm(knownAxis === 'x' ? params.targetDimensions.x : params.targetDimensions.y);
  }, [knownAxis, params.targetDimensions.x, params.targetDimensions.y]);

  const [calibPts, setCalibPts] = useState<Point2D[]>([]);
  const [calibRefMm, setCalibRefMm] = useState<number>(297);

  const [statusMsg, setStatusMsg] = useState<string>(
    'Sube 1 foto de tu mueble (o elige una de las 14 fotos reales arriba): resaltamos cada línea como vector 2D, evaluamos los márgenes y comparamos el 3D contra tu foto automáticamente.',
  );
  const [legHintDetected, setLegHintDetected] = useState<boolean>(false);
  const [detectedHandlesPts, setDetectedHandlesPts] = useState<Point2D[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rectPreviewRef = useRef<HTMLCanvasElement | null>(null);
  const fileFrontalInputRef = useRef<HTMLInputElement | null>(null);
  const fileSideInputRef = useRef<HTMLInputElement | null>(null);
  const lastExternalUrlRef = useRef<string | null>(null);

  const pushUndo = () => {
    setUndoStack((prev) => [
      ...prev.slice(-19),
      {
        vDividers: topology.vDividers.map((d) => ({ ...d })),
        hShelves: topology.hShelves.map((s) => ({ ...s })),
        frontZones: (topology.frontZones ?? []).map((z) => ({ ...z })),
      },
    ]);
  };

  const handleUndo = () => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      onUpdateTopology({
        ...topology,
        shelfMode: 'custom',
        vDividers: last.vDividers,
        hShelves: last.hShelves,
        frontZones: last.frontZones,
      });
      setStatusMsg('Último cambio deshecho.');
      return prev.slice(0, -1);
    });
  };

  const handleClearLines = () => {
    if (topology.vDividers.length === 0 && topology.hShelves.length === 0) return;
    pushUndo();
    onUpdateTopology({
      ...topology,
      shelfMode: 'custom',
      vDividers: [],
      hShelves: [],
      frontZones: [
        { id: 'zone_full', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'open', label: 'Vano Principal' },
      ],
      detectionSource: 'manual',
    });
    setStatusMsg('Líneas internas limpiadas. Pulsa "Auto-Iterar 3D" para reconstruir desde los vectores.');
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && undoStack.length > 0) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    return () => {
      if (imgUrl && imgUrl.startsWith('blob:')) URL.revokeObjectURL(imgUrl);
    };
  }, [imgUrl]);

  useEffect(() => {
    return () => {
      if (sideImgUrl && sideImgUrl.startsWith('blob:')) URL.revokeObjectURL(sideImgUrl);
    };
  }, [sideImgUrl]);

  // Carga foto real cuando el usuario elige un mueble del Catálogo QA (evaluando sus vectores y márgenes en vivo)
  useEffect(() => {
    if (!externalPhotoUrl || externalPhotoUrl === lastExternalUrlRef.current) return;
    lastExternalUrlRef.current = externalPhotoUrl;
    const img = new Image();
    img.onload = () => {
      const bmp = prepareWorkingBitmap(img);
      setImgUrl(externalPhotoUrl);
      setFrontBitmap(bmp);
      setImgSize({ w: bmp.w, h: bmp.h });
      setViewTab('frontal');
      setCalibPts([]);
      setTool('corners');
      const autoQ = autoDetectFurnitureQuad(bmp.rgba, bmp.w, bmp.h);
      const extRaw = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, autoQ.quadCorners);
      const bestBox = extRaw.refinedBox ?? autoQ.quadCorners;
      const extBest =
        bestBox === autoQ.quadCorners
          ? extRaw
          : extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, bestBox);
      const mEval = evaluateMarginsAgainstPhoto(
        bmp.rgba,
        bmp.w,
        bmp.h,
        bestBox,
        extBest,
        autoQ.exteriorBgRgb,
      );
      setRawAutoQuad(autoQ.quadCorners);
      setExteriorBgRgb(autoQ.exteriorBgRgb);
      setQuad(bestBox);
      setVectorLines(extBest.lines);
      setMarginEval(mEval);
      setFrameMode('box');
      setDetectedHandlesPts([]);
      setLastIterationsRun(2);
      setStatusMsg(
        `Foto real cargada (${externalPhotoLabel ?? 'Catálogo QA'}): ${extBest.lines.length} vectores trazados · Márgenes ${mEval.overallScore}%. Pulsa "Auto-Iterar 3D" para reconstruir desde cero con visión o edita las zonas abajo.`,
      );
    };
    img.src = externalPhotoUrl;
  }, [externalPhotoUrl, externalPhotoLabel]);

  const homography = useMemo(() => computeQuadToUnitHomography(quad), [quad]);

  const estimatedAspectXY = useMemo(() => {
    return estimateAspectRatioFixedFocal(quad, imgSize.w, imgSize.h, focal35mm);
  }, [quad, imgSize.w, imgSize.h, focal35mm]);

  const cameraPose = useMemo(() => {
    if (!frontBitmap || !homography) return null;
    return estimateCameraPoseMeters(
      quad,
      imgSize.w,
      imgSize.h,
      knownAxis,
      knownMeasureMm,
      focal35mm,
    );
  }, [frontBitmap, homography, quad, imgSize.w, imgSize.h, knownAxis, knownMeasureMm, focal35mm]);

  // Imagen rectificada en caché (reutilizada tanto para la vista previa como para evaluar el parecido 3D vs Foto en vivo)
  const rectifiedPreview = useMemo(() => {
    if (!frontBitmap || frontBitmap.w === 0 || !homography) return null;
    const w = dragTarget?.kind === 'corner' || dragTarget?.kind === 'drawBox' ? 160 : 260;
    const h = Math.max(96, Math.min(280, Math.round(w / Math.max(0.25, estimatedAspectXY))));
    const rgba = rectifyImageRGBA(
      frontBitmap.rgba,
      frontBitmap.w,
      frontBitmap.h,
      homography.toCanvas,
      w,
      h,
    );
    return { rgba, w, h };
  }, [frontBitmap, homography, estimatedAspectXY, dragTarget]);

  // Evaluación EN VIVO del parecido 3D vs Foto subida (se recalcula instantáneamente al editar zonas, medidas o color)
  const live3DSimilarity = useMemo<Visual3DSimilarityResult | null>(() => {
    if (!rectifiedPreview) return null;
    return evaluate3DvsPhotoSimilarity(
      rectifiedPreview.rgba,
      rectifiedPreview.w,
      rectifiedPreview.h,
      despiece,
      topology,
      params,
      exteriorBgRgb,
    );
  }, [rectifiedPreview, despiece, topology, params, exteriorBgRgb]);

  const sobelCanvas = useMemo(() => {
    if (visualLayer !== 'edges' || !frontBitmap || frontBitmap.w === 0) return null;
    const edgeRgba = computeSobelEdgeOverlayRGBA(frontBitmap.rgba, frontBitmap.w, frontBitmap.h);
    const c = document.createElement('canvas');
    c.width = frontBitmap.w;
    c.height = frontBitmap.h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(edgeRgba), frontBitmap.w, frontBitmap.h),
      0,
      0,
    );
    return c;
  }, [visualLayer, frontBitmap]);

  /**
   * Ejecuta el motor auto-iterativo v5.0 completo:
   * Líneas Vectoriales 2D -> Evaluación de Márgenes -> Candidatos 3D (Band vs Vector-First + Material) -> Mejor 3D.
   */
  const executeIterativePipeline = (
    bmp: WorkingBitmap,
    opts: {
      overrideQuad?: [Point2D, Point2D, Point2D, Point2D];
      seedPoint?: { u: number; v: number };
      applyProportionalDims?: boolean;
      recordUndo?: boolean;
      notePrefix?: string;
    } = {},
  ) => {
    if (!bmp || bmp.w === 0) return;
    if (opts.recordUndo) pushUndo();

    const result = runIterativePhotoTo3D(bmp.rgba, bmp.w, bmp.h, {
      overrideQuad: opts.overrideQuad,
      seedPoint: opts.seedPoint,
      focal35mm,
      boardThicknessMm: params.boardThickness,
      currentDepthMm: params.targetDimensions.z,
      preferredDimsMm: opts.applyProportionalDims
        ? undefined
        : { x: params.targetDimensions.x, y: params.targetDimensions.y },
      existingBackPanel: topology.hasBackPanel,
    });

    if (!result) {
      setStatusMsg('Marco inválido o cruzado. Usa "Encuadrar (1 arrastre)" sobre el frente del mueble.');
      return;
    }

    setRawAutoQuad(result.rawQuad);
    setExteriorBgRgb(result.autoQuad.exteriorBgRgb);
    setQuad(result.usedQuad);
    setVectorLines(result.vectorExtraction.lines);
    setMarginEval(result.marginEval);
    setLegHintDetected(result.legsHint.possibleExternalLegs);
    setLastIterationsRun(result.iterationsRun);

    const hom = computeQuadToUnitHomography(result.usedQuad);
    const det = result.detection;

    if (opts.applyProportionalDims) {
      onAutoPhotoReconstructed(result.estimatedDimsMm, det.detectedMaterial);
    }

    const manualHardware = (topology.hardwareItems ?? []).filter((h) => h.origen !== 'detectado');
    const nextHardware = [...manualHardware];
    const projectedHandles: Point2D[] = [];
    if (hom && det.detectedHandles.length > 0) {
      for (const hPt of det.detectedHandles) {
        const mapped = applyHomography(hom.toCanvas, { x: hPt.u, y: hPt.v });
        if (mapped) projectedHandles.push(mapped);
      }
      nextHardware.push({
        id: 'hw_tiradores_auto',
        categoria: 'tiradores',
        descripcion: `Tiradores detectados en frente (${det.detectedHandles.length} u.)`,
        cantidad: det.detectedHandles.length,
        notaCompra: 'Adquirir tiradores aparte (no melamina).',
        origen: 'detectado',
      });
    }
    setDetectedHandlesPts(projectedHandles);

    const hasLegVoid = det.inferredZones.some((z) => z.kind === 'leg_void');

    onUpdateTopology({
      ...topology,
      aspectRatioXY: result.estimatedAspectXY,
      quadCorners: result.usedQuad,
      homographyMatrix: hom ? hom.toUnit.map((r) => [...r]) : undefined,
      shelfMode: 'custom',
      vDividers: det.vDividers,
      hShelves: det.hShelves,
      frontZones: det.inferredZones,
      hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
      hasExternalLegs: !hasLegVoid && result.legsHint.possibleExternalLegs
        ? true
        : topology.hasExternalLegs,
      hardwareItems: nextHardware,
      detectionSource: 'auto',
      detectionConfidence: det.confidence,
    });

    const prefix = opts.notePrefix ? `${opts.notePrefix} ` : '';
    const stratLabel =
      result.selectedStrategy === 'vector_first' ? 'Vectores 2D' : 'Híbrido';
    setStatusMsg(
      `${prefix}${result.vectorExtraction.lines.length} vectores trazados · Márgenes ${result.marginEval.overallScore}% · 3D vs Foto ${result.similarity3D.overallScore}% (${result.iterationsRun} iteraciones · ${stratLabel}). Si alguna zona difiere, cámbiala en 1 clic abajo.`,
    );
  };

  const loadFrontalFromUrl = (url: string, isSample = false) => {
    lastExternalUrlRef.current = null;
    const img = new Image();
    img.onload = () => {
      const bmp = prepareWorkingBitmap(img);
      setImgUrl(url);
      setFrontBitmap(bmp);
      setImgSize({ w: bmp.w, h: bmp.h });
      setViewTab('frontal');
      setFrameMode('box');
      setCalibPts([]);
      setTool('corners');
      executeIterativePipeline(bmp, {
        overrideQuad: isSample ? makeAxisAlignedQuad(165, 120, 735, 540) : undefined,
        applyProportionalDims: true,
        recordUndo: false,
        notePrefix: isSample ? 'Escritorio de muestra:' : 'Auto-análisis completado:',
      });
    };
    img.src = url;
  };

  const loadSideFromFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const bmp = prepareWorkingBitmap(img);
      setSideImgUrl(url);
      setSideBitmap(bmp);
      setSideQuad(
        makeAxisAlignedQuad(
          Math.round(bmp.w * 0.25),
          Math.round(bmp.h * 0.14),
          Math.round(bmp.w * 0.75),
          Math.round(bmp.h * 0.86),
        ),
      );
    };
    img.src = url;
  };

  const handleFileFrontal = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadFrontalFromUrl(URL.createObjectURL(file), false);
    e.target.value = '';
  };

  const handleFileSide = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadSideFromFile(file);
    e.target.value = '';
  };

  const handleDropFile = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (viewTab === 'frontal') {
      loadFrontalFromUrl(URL.createObjectURL(file), false);
    } else {
      loadSideFromFile(file);
    }
  };

  const handleAutoIterate = () => {
    if (!frontBitmap || frontBitmap.w === 0) return;
    executeIterativePipeline(frontBitmap, {
      overrideQuad: quad,
      applyProportionalDims: false,
      recordUndo: true,
      notePrefix: 'Auto-iteración 3D:',
    });
  };

  const handleAutoFrame = () => {
    if (!frontBitmap || frontBitmap.w === 0) return;
    setFrameMode('box');
    setTool('corners');
    executeIterativePipeline(frontBitmap, {
      applyProportionalDims: true,
      recordUndo: true,
      notePrefix: 'Márgenes recalculados:',
    });
  };

  const handleToggleFrameMode = (nextMode: FrameMode) => {
    setFrameMode(nextMode);
    if (nextMode === 'box') {
      setQuad((prev) => quadToBoundingBox(prev));
      setStatusMsg('Recuadro recto activado: arrastra cualquier esquina sin deformar el marco.');
    } else {
      setStatusMsg('Perspectiva 4 pts (H 3×3) activada: ajusta TL/TR/BR/BL en fotos inclinadas.');
    }
  };

  const handleZoneKindSelect = (zoneId: string, nextKind: FrontModuleKind) => {
    pushUndo();
    const zones = topology.frontZones ?? [];
    const updated = zones.map((z) =>
      z.id === zoneId
        ? {
            ...z,
            kind: nextKind,
            drawerCount: nextKind === 'drawers' ? (z.drawerCount ?? 2) : undefined,
            label: ZONE_LABELS[nextKind],
          }
        : z,
    );
    onUpdateFrontZones(updated);
    setStatusMsg(`Zona actualizada a "${ZONE_LABELS[nextKind]}" — 3D y similitud recalculados en vivo.`);
  };

  // Pintar miniatura rectificada desde caché
  useEffect(() => {
    const previewCanvas = rectPreviewRef.current;
    if (!previewCanvas || !rectifiedPreview) return;
    previewCanvas.width = rectifiedPreview.w;
    previewCanvas.height = rectifiedPreview.h;
    const ctx = previewCanvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(rectifiedPreview.rgba), rectifiedPreview.w, rectifiedPreview.h),
        0,
        0,
      );
    }
  }, [rectifiedPreview]);

  // Dibujo del lienzo principal con Vectores 2D + Márgenes + Zonas Interactivas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const activeBmp = viewTab === 'frontal' ? frontBitmap : sideBitmap;
    const activeQuad = viewTab === 'frontal' ? quad : sideQuad;
    if (!activeBmp) return;

    const cw = activeBmp.w;
    const ch = activeBmp.h;
    canvas.width = cw;
    canvas.height = ch;

    if (viewTab === 'frontal' && visualLayer === 'edges' && sobelCanvas) {
      ctx.drawImage(sobelCanvas, 0, 0, cw, ch);
    } else {
      ctx.drawImage(activeBmp.canvas, 0, 0, cw, ch);
    }

    // Atenuación para resaltar vectores o el recuadro frontal
    if (viewTab === 'frontal' && visualLayer === 'vectors') {
      ctx.fillStyle = 'rgba(10, 15, 28, 0.36)';
      ctx.fillRect(0, 0, cw, ch);
    } else if (viewTab === 'frontal' && visualLayer !== 'edges') {
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.25)';
      ctx.beginPath();
      ctx.rect(0, 0, cw, ch);
      ctx.moveTo(activeQuad[0].x, activeQuad[0].y);
      ctx.lineTo(activeQuad[3].x, activeQuad[3].y);
      ctx.lineTo(activeQuad[2].x, activeQuad[2].y);
      ctx.lineTo(activeQuad[1].x, activeQuad[1].y);
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.restore();
    }

    // Capa de LÍNEAS VECTORIALES 2D extraídas de la foto (cada línea es un vector p1 -> p2)
    if (
      viewTab === 'frontal' &&
      (visualLayer === 'vectors' || visualLayer === 'vectors_zones') &&
      vectorLines.length > 0
    ) {
      const dotR = Math.max(2, cw / 320);
      for (const ln of vectorLines) {
        if (visualLayer === 'vectors_zones' && ln.role === 'detail') continue;
        ctx.strokeStyle = VECTOR_ROLE_COLORS[ln.role];
        ctx.lineWidth = ln.role.startsWith('outer_')
          ? Math.max(2.6, cw / 290)
          : Math.max(1.8, cw / 380);
        ctx.beginPath();
        ctx.moveTo(ln.p1.x, ln.p1.y);
        ctx.lineTo(ln.p2.x, ln.p2.y);
        ctx.stroke();

        // Extremos del vector (origen y destino)
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ln.p1.x, ln.p1.y, dotR, 0, Math.PI * 2);
        ctx.arc(ln.p2.x, ln.p2.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // En capa "Márgenes": mostrar también el marco inicial (rojo punteado) vs márgenes refinados (cian)
    if (viewTab === 'frontal' && visualLayer === 'margins' && rawAutoQuad) {
      ctx.save();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = Math.max(2, cw / 380);
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      rawAutoQuad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // Contorno del marco frontal activo
    ctx.strokeStyle = frameMode === 'box' ? '#00e5ff' : '#38bdf8';
    ctx.lineWidth = Math.max(2.5, cw / 320);
    ctx.beginPath();
    activeQuad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    if (viewTab === 'frontal' && homography) {
      const { toCanvas } = homography;
      const e = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      // Capa de Zonas Funcionales interactivas
      const zones = topology.frontZones ?? [];
      if ((visualLayer === 'vectors_zones' || visualLayer === 'margins') && zones.length > 0) {
        for (const z of zones) {
          const u0 = interiorToExterior(z.uStart, e, xf);
          const u1 = interiorToExterior(z.uEnd, e, xf);
          const v0 = interiorToExterior(z.vStart, e, yf);
          const v1 = interiorToExterior(z.vEnd, e, yf);
          const pTL = applyHomography(toCanvas, { x: u0, y: v1 });
          const pTR = applyHomography(toCanvas, { x: u1, y: v1 });
          const pBR = applyHomography(toCanvas, { x: u1, y: v0 });
          const pBL = applyHomography(toCanvas, { x: u0, y: v0 });
          if (pTL && pTR && pBR && pBL) {
            const palette = ZONE_COLORS[z.kind];
            ctx.beginPath();
            ctx.moveTo(pTL.x, pTL.y);
            ctx.lineTo(pTR.x, pTR.y);
            ctx.lineTo(pBR.x, pBR.y);
            ctx.lineTo(pBL.x, pBL.y);
            ctx.closePath();
            ctx.fillStyle = palette.fill;
            ctx.fill();
            ctx.strokeStyle = palette.stroke;
            ctx.lineWidth = Math.max(1.4, cw / 520);
            ctx.stroke();

            const center = applyHomography(toCanvas, { x: (u0 + u1) / 2, y: (v0 + v1) / 2 });
            if (center) {
              const tagText =
                z.kind === 'drawers'
                  ? `${z.drawerCount ?? 2} Caj.`
                  : ZONE_LABELS[z.kind];
              const fontPx = Math.max(11, Math.min(17, Math.round(cw / 64)));
              ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
              const tw = ctx.measureText(tagText).width;
              ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
              ctx.fillRect(center.x - tw / 2 - 5, center.y - fontPx * 0.7, tw + 10, fontPx * 1.4);
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, center.x, center.y);
            }
          }
        }
      }

      // Divisores verticales y repisas del modelo reconstruido
      if (visualLayer !== 'vectors') {
        for (const div of topology.vDividers) {
          const isActive = dragTarget?.kind === 'vDivider' && dragTarget.id === div.id;
          ctx.strokeStyle = isActive ? '#38bdf8' : '#22c55e';
          ctx.lineWidth = Math.max(isActive ? 5 : 2.8, cw / (isActive ? 210 : 300));
          const uExt = interiorToExterior(div.position, e, xf);
          const v0 = interiorToExterior(div.start, e, yf);
          const v1 = interiorToExterior(div.end, e, yf);
          const p0 = applyHomography(toCanvas, { x: uExt, y: v0 });
          const p1 = applyHomography(toCanvas, { x: uExt, y: v1 });
          if (p0 && p1) {
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
          }
        }

        for (const sh of topology.hShelves) {
          const isActive = dragTarget?.kind === 'hShelf' && dragTarget.id === sh.id;
          ctx.strokeStyle = isActive ? '#38bdf8' : '#f59e0b';
          ctx.lineWidth = Math.max(isActive ? 5 : 2.8, cw / (isActive ? 210 : 300));
          const vExt = interiorToExterior(sh.position, e, yf);
          const u0 = interiorToExterior(sh.start, e, xf);
          const u1 = interiorToExterior(sh.end, e, xf);
          const p0 = applyHomography(toCanvas, { x: u0, y: vExt });
          const p1 = applyHomography(toCanvas, { x: u1, y: vExt });
          if (p0 && p1) {
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p1.x, p1.y);
            ctx.stroke();
          }
        }
      }

      // Segmento A4
      const markerR = Math.max(7, cw / 110);
      if (calibPts.length >= 1) {
        ctx.fillStyle = '#ec4899';
        for (const cp of calibPts) {
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, markerR, 0, Math.PI * 2);
          ctx.fill();
        }
        if (calibPts.length === 2) {
          ctx.strokeStyle = '#ec4899';
          ctx.lineWidth = Math.max(3, cw / 300);
          ctx.beginPath();
          ctx.moveTo(calibPts[0].x, calibPts[0].y);
          ctx.lineTo(calibPts[1].x, calibPts[1].y);
          ctx.stroke();
        }
      }

      // Vista previa al arrastrar repisa manual
      if (tool === 'hShelf' && draftLineStart && cursorImgPt) {
        ctx.save();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = Math.max(3, cw / 280);
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.moveTo(draftLineStart.x, draftLineStart.y);
        ctx.lineTo(cursorImgPt.x, cursorImgPt.y);
        ctx.stroke();
        ctx.restore();
      }

      // Tiradores detectados
      const hwR = Math.max(5.5, cw / 130);
      for (const hm of detectedHandlesPts) {
        ctx.fillStyle = '#a855f7';
        ctx.beginPath();
        ctx.arc(hm.x, hm.y, hwR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }

    // Manijas del marco
    const nodeR = Math.max(9, cw / 92);
    activeQuad.forEach((p, idx) => {
      const isDraggingCorner = dragTarget?.kind === 'corner' && dragTarget.idx === idx;
      if (frameMode === 'box' && viewTab === 'frontal') {
        const hs = nodeR * 1.35;
        ctx.fillStyle = isDraggingCorner ? '#f59e0b' : '#0284c7';
        ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
      } else {
        ctx.fillStyle = isDraggingCorner ? '#f59e0b' : '#0284c7';
        ctx.beginPath();
        ctx.arc(p.x, p.y, nodeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(nodeR * 1.02)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(CORNER_LABELS[idx], p.x, p.y);
      }
    });

    // Lupa 4× al arrastrar esquina
    if (dragTarget?.kind === 'corner' && cursorImgPt) {
      const magSize = Math.min(180, Math.round(cw * 0.24));
      const zoom = 4;
      const srcSpan = magSize / zoom;
      const mx = cursorImgPt.x < cw / 2 ? cw - magSize - 16 : 16;
      const my = 16;

      ctx.save();
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(mx - 3, my - 3, magSize + 6, magSize + 6);
      ctx.drawImage(
        activeBmp.canvas,
        cursorImgPt.x - srcSpan / 2,
        cursorImgPt.y - srcSpan / 2,
        srcSpan,
        srcSpan,
        mx,
        my,
        magSize,
        magSize,
      );
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(mx, my, magSize, magSize);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx + magSize / 2 - 12, my + magSize / 2);
      ctx.lineTo(mx + magSize / 2 + 12, my + magSize / 2);
      ctx.moveTo(mx + magSize / 2, my + magSize / 2 - 12);
      ctx.lineTo(mx + magSize / 2, my + magSize / 2 + 12);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    viewTab,
    frameMode,
    frontBitmap,
    sideBitmap,
    quad,
    sideQuad,
    rawAutoQuad,
    vectorLines,
    homography,
    topology.vDividers,
    topology.hShelves,
    topology.frontZones,
    params.boardThickness,
    params.targetDimensions.x,
    params.targetDimensions.y,
    dragTarget,
    cursorImgPt,
    draftLineStart,
    tool,
    calibPts,
    detectedHandlesPts,
    visualLayer,
    sobelCanvas,
  ]);

  const toCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>): Point2D => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toCanvasCoords(e);
    const activeQuad = viewTab === 'frontal' ? quad : sideQuad;
    const eMm = params.boardThickness;
    const xf = params.targetDimensions.x;
    const yf = params.targetDimensions.y;

    if (viewTab === 'frontal' && tool === 'drawBox') {
      setFrameMode('box');
      setDragTarget({ kind: 'drawBox', start: pt });
      setCursorImgPt(pt);
      setQuad(makeAxisAlignedQuad(pt.x, pt.y, pt.x + 12, pt.y + 12));
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      return;
    }

    if (tool === 'corners' || viewTab === 'lateral') {
      const hitTol = Math.max(26, (canvasRef.current?.width ?? 900) * 0.038);
      const hitIdx = activeQuad.findIndex((p) => Math.hypot(p.x - pt.x, p.y - pt.y) <= hitTol);
      if (hitIdx !== -1) {
        setDragTarget({ kind: 'corner', idx: hitIdx });
        setCursorImgPt(pt);
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
        return;
      }

      if (viewTab === 'frontal' && homography) {
        const unitPt = applyHomography(homography.toUnit, pt);
        if (unitPt) {
          const uClick = exteriorToInterior(unitPt.x, eMm, xf);
          const vClick = exteriorToInterior(unitPt.y, eMm, yf);
          let bestDist = 0.032;
          let found: DragTarget | null = null;

          for (const d of topology.vDividers) {
            if (vClick >= d.start - 0.02 && vClick <= d.end + 0.02) {
              const dist = Math.abs(d.position - uClick);
              if (dist < bestDist) {
                bestDist = dist;
                found = { kind: 'vDivider', id: d.id };
              }
            }
          }
          for (const s of topology.hShelves) {
            if (uClick >= s.start - 0.02 && uClick <= s.end + 0.02) {
              const dist = Math.abs(s.position - vClick);
              if (dist < bestDist) {
                bestDist = dist;
                found = { kind: 'hShelf', id: s.id };
              }
            }
          }

          if (found) {
            pushUndo();
            setDragTarget(found);
            setCursorImgPt(pt);
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            return;
          }

          const zones = topology.frontZones ?? [];
          if ((visualLayer === 'vectors_zones' || visualLayer === 'margins') && zones.length > 0) {
            const hitZone = zones.find(
              (z) =>
                uClick >= z.uStart &&
                uClick <= z.uEnd &&
                vClick >= z.vStart &&
                vClick <= z.vEnd,
            );
            if (hitZone) {
              const curIdx = ZONE_CYCLE.indexOf(hitZone.kind);
              const nextKind = ZONE_CYCLE[(curIdx + 1) % ZONE_CYCLE.length];
              handleZoneKindSelect(hitZone.id, nextKind);
              return;
            }
          }
        }
      }
      return;
    }

    if (!homography) return;
    const unitPt = applyHomography(homography.toUnit, pt);
    if (!unitPt) return;

    if (tool === 'eyedropper' && frontBitmap) {
      executeIterativePipeline(frontBitmap, {
        overrideQuad: quad,
        seedPoint: {
          u: Math.max(0, Math.min(1, unitPt.x)),
          v: Math.max(0, Math.min(1, unitPt.y)),
        },
        applyProportionalDims: false,
        recordUndo: true,
        notePrefix: 'Color muestreado:',
      });
      setTool('corners');
      return;
    }

    if (tool === 'calibA4') {
      setCalibPts((prev) => (prev.length >= 2 ? [pt] : [...prev, pt]));
      return;
    }

    if (tool === 'vDivider') {
      const uInt = exteriorToInterior(unitPt.x, eMm, xf);
      if (uInt > 0.04 && uInt < 0.96) {
        pushUndo();
        const nextDiv: NormalizedSegment = {
          id: `man_div_${Date.now()}`,
          position: Number(uInt.toFixed(4)),
          start: 0,
          end: 1,
        };
        onUpdateTopology({
          ...topology,
          aspectRatioXY: estimatedAspectXY,
          quadCorners: quad,
          homographyMatrix: homography.toUnit.map((r) => [...r]),
          shelfMode: 'custom',
          vDividers: [...topology.vDividers, nextDiv],
          detectionSource: 'manual',
        });
        setStatusMsg(`Divisor vertical agregado en ${(uInt * 100).toFixed(0)}%.`);
      }
      return;
    }

    if (tool === 'hShelf') {
      setDraftLineStart(pt);
      setCursorImgPt(pt);
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      return;
    }

    if (tool === 'erase') {
      const uClick = exteriorToInterior(unitPt.x, eMm, xf);
      const vClick = exteriorToInterior(unitPt.y, eMm, yf);
      let bestDist = 0.045;
      let targetKind: 'div' | 'shelf' | null = null;
      let targetId = '';

      for (const d of topology.vDividers) {
        if (vClick >= d.start - 0.03 && vClick <= d.end + 0.03) {
          const dist = Math.abs(d.position - uClick);
          if (dist < bestDist) {
            bestDist = dist;
            targetKind = 'div';
            targetId = d.id;
          }
        }
      }
      for (const s of topology.hShelves) {
        if (uClick >= s.start - 0.03 && uClick <= s.end + 0.03) {
          const dist = Math.abs(s.position - vClick);
          if (dist < bestDist) {
            bestDist = dist;
            targetKind = 'shelf';
            targetId = s.id;
          }
        }
      }

      if (targetKind === 'div') {
        pushUndo();
        onUpdateTopology({
          ...topology,
          vDividers: topology.vDividers.filter((d) => d.id !== targetId),
        });
        setStatusMsg('Divisor eliminado (Ctrl+Z para deshacer).');
      } else if (targetKind === 'shelf') {
        pushUndo();
        onUpdateTopology({
          ...topology,
          hShelves: topology.hShelves.filter((s) => s.id !== targetId),
        });
        setStatusMsg('Repisa eliminada (Ctrl+Z para deshacer).');
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toCanvasCoords(e);
    if (!dragTarget) {
      if (draftLineStart !== null) setCursorImgPt(pt);
      return;
    }
    setCursorImgPt(pt);

    if (dragTarget.kind === 'drawBox') {
      const cw = frontBitmap?.w ?? 900;
      const ch = frontBitmap?.h ?? 680;
      setQuad(
        makeAxisAlignedQuad(
          dragTarget.start.x,
          dragTarget.start.y,
          Math.max(2, Math.min(cw - 2, pt.x)),
          Math.max(2, Math.min(ch - 2, pt.y)),
        ),
      );
      return;
    }

    if (dragTarget.kind === 'corner') {
      if (viewTab === 'frontal') {
        if (frameMode === 'box') {
          const cw = frontBitmap?.w ?? 900;
          const ch = frontBitmap?.h ?? 680;
          setQuad((prev) => resizeBoxCorner(prev, dragTarget.idx, pt, cw, ch));
        } else {
          setQuad((prev) => {
            const copy: [Point2D, Point2D, Point2D, Point2D] = [
              { ...prev[0] },
              { ...prev[1] },
              { ...prev[2] },
              { ...prev[3] },
            ];
            copy[dragTarget.idx] = pt;
            return copy;
          });
        }
      } else {
        setSideQuad((prev) => {
          const copy: [Point2D, Point2D, Point2D, Point2D] = [
            { ...prev[0] },
            { ...prev[1] },
            { ...prev[2] },
            { ...prev[3] },
          ];
          copy[dragTarget.idx] = pt;
          return copy;
        });
      }
      return;
    }

    if (!homography) return;
    const unitPt = applyHomography(homography.toUnit, pt);
    if (!unitPt) return;

    const eMm = params.boardThickness;
    if (dragTarget.kind === 'vDivider') {
      const nextU = Math.max(
        0.04,
        Math.min(0.96, exteriorToInterior(unitPt.x, eMm, params.targetDimensions.x)),
      );
      onUpdateTopology({
        ...topology,
        shelfMode: 'custom',
        detectionSource: 'manual',
        vDividers: topology.vDividers.map((d) =>
          d.id === dragTarget.id ? { ...d, position: Number(nextU.toFixed(4)) } : d,
        ),
      });
    } else if (dragTarget.kind === 'hShelf') {
      const nextV = Math.max(
        0.04,
        Math.min(0.96, exteriorToInterior(unitPt.y, eMm, params.targetDimensions.y)),
      );
      onUpdateTopology({
        ...topology,
        shelfMode: 'custom',
        detectionSource: 'manual',
        hShelves: topology.hShelves.map((s) =>
          s.id === dragTarget.id ? { ...s, position: Number(nextV.toFixed(4)) } : s,
        ),
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragTarget) {
      const finished = dragTarget;
      setDragTarget(null);
      setCursorImgPt(null);

      if (finished.kind === 'drawBox') {
        const endPt = toCanvasCoords(e);
        const boxW = Math.abs(endPt.x - finished.start.x);
        const boxH = Math.abs(endPt.y - finished.start.y);
        setTool('corners');
        if (frontBitmap && boxW >= 30 && boxH >= 30) {
          const nextQuad = makeAxisAlignedQuad(
            finished.start.x,
            finished.start.y,
            endPt.x,
            endPt.y,
          );
          setQuad(nextQuad);
          executeIterativePipeline(frontBitmap, {
            overrideQuad: nextQuad,
            applyProportionalDims: true,
            recordUndo: true,
            notePrefix: 'Frente encuadrado:',
          });
        } else {
          setStatusMsg('Arrastra de esquina a esquina sobre la cara frontal del mueble.');
        }
        return;
      }

      if (finished.kind === 'corner') {
        if (viewTab === 'frontal' && frontBitmap && homography) {
          executeIterativePipeline(frontBitmap, {
            overrideQuad: quad,
            applyProportionalDims: false,
            recordUndo: false,
            notePrefix: 'Márgenes ajustados:',
          });
        } else if (viewTab === 'lateral' && sideBitmap) {
          const ratioZY = estimateAspectRatioFixedFocal(sideQuad, sideBitmap.w, sideBitmap.h, focal35mm);
          const estDepth = Math.max(200, Math.min(800, Math.round(params.targetDimensions.y * ratioZY)));
          onUpdateTopology({ ...topology, viewsMode: 2, aspectRatioZY: ratioZY });
          onSelectDepthMm(estDepth);
          setStatusMsg(`Profundidad Z actualizada desde Vista Lateral: ${estDepth} mm.`);
        }
      } else {
        setStatusMsg('Posición ajustada y sincronizada en 3D.');
      }
      return;
    }

    if (tool === 'hShelf' && draftLineStart && homography) {
      const endPt = toCanvasCoords(e);
      const uA = applyHomography(homography.toUnit, draftLineStart);
      const uB = applyHomography(homography.toUnit, endPt);
      setDraftLineStart(null);
      setCursorImgPt(null);
      if (!uA || !uB) return;

      const eMm = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;
      const anchors = [0, ...topology.vDividers.map((d) => d.position), 1];

      const rawStart = exteriorToInterior(Math.min(uA.x, uB.x), eMm, xf);
      const rawEnd = exteriorToInterior(Math.max(uA.x, uB.x), eMm, xf);
      const vMid = exteriorToInterior((uA.y + uB.y) / 2, eMm, yf);

      let uStart = snapValue(rawStart, anchors);
      let uEnd = snapValue(rawEnd, anchors);
      if (Math.abs(uEnd - uStart) < 0.05) {
        const sortedA = [...anchors].sort((a, b) => a - b);
        const clickU = exteriorToInterior(uA.x, eMm, xf);
        for (let i = 0; i < sortedA.length - 1; i++) {
          if (clickU >= sortedA[i] && clickU <= sortedA[i + 1]) {
            uStart = sortedA[i];
            uEnd = sortedA[i + 1];
            break;
          }
        }
      }

      if (uEnd - uStart >= 0.04 && vMid > 0.03 && vMid < 0.97) {
        pushUndo();
        const nextShelf: NormalizedSegment = {
          id: `man_rep_${Date.now()}`,
          position: Number(vMid.toFixed(4)),
          start: Number(uStart.toFixed(4)),
          end: Number(uEnd.toFixed(4)),
        };
        onUpdateTopology({
          ...topology,
          aspectRatioXY: estimatedAspectXY,
          quadCorners: quad,
          homographyMatrix: homography.toUnit.map((r) => [...r]),
          shelfMode: 'custom',
          hShelves: [...topology.hShelves, nextShelf],
          detectionSource: 'manual',
        });
        setStatusMsg(`Repisa agregada en ${(vMid * 100).toFixed(0)}%.`);
      }
    }
  };

  const handleApplySingleMeasure = () => {
    const ext = extrapolateDimensionsFromSingleMeasure(
      estimatedAspectXY,
      knownAxis,
      knownMeasureMm,
      params.targetDimensions.z,
    );
    onApplyCalibratedDims(ext);
    setStatusMsg(`Escala calibrada: ${ext.x} × ${ext.y} × ${ext.z} mm.`);
  };

  const handleApplyCalibA4 = () => {
    if (calibPts.length !== 2) return;
    const [p1, p2] = calibPts;
    if (homography) {
      const u1 = applyHomography(homography.toUnit, p1);
      const u2 = applyHomography(homography.toUnit, p2);
      if (u1 && u2) {
        const dRect = Math.hypot((u2.x - u1.x) * estimatedAspectXY, u2.y - u1.y);
        if (dRect > 1e-4) {
          const yCal = calibRefMm / dRect;
          const xCal = yCal * estimatedAspectXY;
          const dims = { x: Math.round(xCal), y: Math.round(yCal), z: params.targetDimensions.z };
          onApplyCalibratedDims(dims);
          setStatusMsg(`Calibración A4 aplicada: ${dims.x} × ${dims.y} × ${dims.z} mm.`);
          return;
        }
      }
    }
  };

  const activeBmp = viewTab === 'frontal' ? frontBitmap : sideBitmap;
  const hasPhoto = Boolean(frontBitmap);
  const zones = topology.frontZones ?? [];
  const canvasCursor =
    dragTarget !== null
      ? 'grabbing'
      : tool === 'drawBox'
        ? 'crosshair'
        : tool === 'corners' || viewTab === 'lateral'
          ? visualLayer === 'vectors_zones' || visualLayer === 'margins'
            ? 'pointer'
            : 'grab'
          : tool === 'erase'
            ? 'pointer'
            : 'crosshair';

  return (
    <div className="vector-card">
      <div className="card-header-row">
        <div>
          <h3>Foto → Líneas Vectoriales → 3D</h3>
          <p className="muted small-note">
            Cada línea estructural se traza como vector 2D y el sistema compara márgenes y 3D contra tu foto.
          </p>
        </div>
        <div className="chip-row">
          {hasPhoto && viewTab === 'frontal' && (
            <button
              type="button"
              className={frameMode === 'quad' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => handleToggleFrameMode(frameMode === 'box' ? 'quad' : 'box')}
              title="Alterna entre Recuadro recto (más fácil) y Perspectiva 4 pts (fotos inclinadas)"
            >
              {frameMode === 'quad' ? '4 pts (Perspectiva)' : 'Recuadro recto'}
            </button>
          )}
          <button
            type="button"
            className={showPrecisionTools ? 'chip-btn active' : 'chip-btn'}
            onClick={() => setShowPrecisionTools((v) => !v)}
          >
            <SlidersHorizontal size={12} /> Herramientas
          </button>
        </div>
      </div>

      {/* Barra primaria orientada al cliente */}
      <div className="canvas-toolbar">
        <button
          type="button"
          className="btn-primary"
          onClick={() => fileFrontalInputRef.current?.click()}
        >
          <Camera size={14} /> {hasPhoto ? 'Cambiar foto' : 'Subir foto del mueble'}
        </button>
        <input
          ref={fileFrontalInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileFrontal}
          hidden
        />
        <input
          ref={fileSideInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSide}
          hidden
        />

        {hasPhoto && viewTab === 'frontal' && (
          <>
            <button
              type="button"
              className={tool === 'drawBox' ? 'btn-primary' : 'btn-secondary'}
              onClick={() => {
                setFrameMode('box');
                setTool((t) => (t === 'drawBox' ? 'corners' : 'drawBox'));
                setStatusMsg('Arrastra un rectángulo cubriendo solo la cara frontal del mueble.');
              }}
            >
              <Crop size={14} /> Encuadrar frente
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleAutoIterate}
              disabled={!homography}
              title="Re-extraer vectores, evaluar márgenes y auto-iterar el modelo 3D contra la foto"
            >
              <RefreshCw size={14} /> Auto-Iterar 3D
            </button>
            <span className="toolbar-sep" />
            <button
              type="button"
              className={visualLayer === 'vectors_zones' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setVisualLayer('vectors_zones')}
            >
              <LayoutGrid size={12} /> Vectores + Zonas
            </button>
            <button
              type="button"
              className={visualLayer === 'vectors' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setVisualLayer('vectors')}
            >
              <GitBranch size={12} /> Solo Vectores ({vectorLines.length})
            </button>
            <button
              type="button"
              className={visualLayer === 'margins' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setVisualLayer('margins')}
            >
              <Scan size={12} /> Márgenes
            </button>
            <button
              type="button"
              className={visualLayer === 'photo' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setVisualLayer('photo')}
            >
              Foto
            </button>
            <button
              type="button"
              className={visualLayer === 'edges' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setVisualLayer('edges')}
            >
              <Contrast size={12} /> Bordes
            </button>
          </>
        )}

        {!hasPhoto && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => loadFrontalFromUrl(generateSampleFurnitureDataUrl(), true)}
          >
            <Sparkles size={14} /> Probar escritorio de muestra
          </button>
        )}
      </div>

      {/* Herramientas avanzadas colapsables */}
      {showPrecisionTools && (
        <div className="precision-drawer">
          <div className="canvas-toolbar">
            <button
              type="button"
              className={viewTab === 'frontal' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setViewTab('frontal')}
            >
              Frontal (XY)
            </button>
            <button
              type="button"
              className={viewTab === 'lateral' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setViewTab('lateral')}
            >
              Lateral ZY (opc.)
            </button>
            {viewTab === 'lateral' ? (
              <button
                type="button"
                className="btn-small"
                onClick={() => fileSideInputRef.current?.click()}
              >
                <Camera size={13} /> Cargar foto lateral
              </button>
            ) : (
              <>
                <span className="toolbar-sep" />
                <button
                  type="button"
                  className={tool === 'corners' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setTool('corners')}
                  disabled={!hasPhoto}
                >
                  <Move size={13} /> Mover
                </button>
                <button
                  type="button"
                  className={tool === 'eyedropper' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setTool('eyedropper')}
                  disabled={!hasPhoto}
                >
                  <Pipette size={13} /> Gotero color
                </button>
                <button
                  type="button"
                  className={tool === 'calibA4' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => {
                    setCalibPts([]);
                    setTool('calibA4');
                  }}
                  disabled={!hasPhoto}
                >
                  <Ruler size={13} /> Calibrar A4
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={handleAutoFrame}
                  disabled={!hasPhoto}
                >
                  <Scan size={13} /> Auto-márgenes
                </button>
                <span className="toolbar-sep" />
                <button
                  type="button"
                  className={tool === 'vDivider' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setTool('vDivider')}
                  disabled={!hasPhoto}
                >
                  + Divisor
                </button>
                <button
                  type="button"
                  className={tool === 'hShelf' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setTool('hShelf')}
                  disabled={!hasPhoto}
                >
                  + Repisa
                </button>
                <button
                  type="button"
                  className={tool === 'erase' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setTool('erase')}
                  disabled={!hasPhoto}
                >
                  <Eraser size={13} /> Borrar
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={handleUndo}
                  disabled={undoStack.length === 0}
                >
                  <Undo2 size={13} /> Deshacer
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={handleClearLines}
                  disabled={!hasPhoto || (topology.vDividers.length === 0 && topology.hShelves.length === 0)}
                >
                  <Trash2 size={13} /> Limpiar
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {legHintDetected && !topology.hasExternalLegs && (
        <div className="alert-box warning compact-alert">
          <span>Detectamos posibles patas debajo del mueble.</span>
          <button
            type="button"
            className="btn-small"
            onClick={() => onToggleExternalLegs(true, 150, 4)}
          >
            Activar patas (15 cm)
          </button>
        </div>
      )}

      {/* Lienzo + Panel de Evaluación Visual (Vectores / Márgenes / Similitud 3D) */}
      <div className="canvas-layout">
        <div
          className={isDragOver ? 'photo-canvas-wrap drag-over' : 'photo-canvas-wrap'}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDropFile}
        >
          {activeBmp ? (
            <canvas
              ref={canvasRef}
              className="photo-canvas"
              style={{ cursor: canvasCursor }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
          ) : (
            <div className="photo-dropzone">
              <Upload size={34} />
              <strong>Sube una foto de tu mueble o elige uno de las 14 fotos reales arriba</strong>
              <p className="small-note muted">
                Paso 1: Trazamos cada línea como vector 2D · Paso 2: Evaluamos márgenes vs foto ·
                Paso 3: Generamos y verificamos tu mueble 3D al instante.
              </p>
              <div className="chip-row">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    viewTab === 'frontal'
                      ? fileFrontalInputRef.current?.click()
                      : fileSideInputRef.current?.click()
                  }
                >
                  <Camera size={14} /> Elegir foto
                </button>
                {viewTab === 'frontal' && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => loadFrontalFromUrl(generateSampleFurnitureDataUrl(), true)}
                  >
                    <Sparkles size={14} /> Probar escritorio de muestra
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="rect-preview-panel">
          <div className="card-header-row">
            <strong>Evaluación vs Foto</strong>
            <select
              className="select-mini"
              value={focal35mm}
              onChange={(e) => setFocal35mm(Number(e.target.value) as 26 | 52)}
              aria-label="Lente"
            >
              <option value={26}>1× (26mm)</option>
              <option value={52}>2× (52mm)</option>
            </select>
          </div>
          <canvas ref={rectPreviewRef} className="rect-preview-canvas" />

          {/* Barra 1: Evaluación de Márgenes vs Foto */}
          {marginEval && (
            <div className="eval-meter">
              <div className="eval-meter-head">
                <span>Márgenes vs Foto</span>
                <strong className={scoreToneClass(marginEval.overallScore)}>
                  {marginEval.overallScore}%
                </strong>
              </div>
              <div className="eval-bar-track">
                <div
                  className={`eval-bar-fill ${scoreToneClass(marginEval.overallScore)}`}
                  style={{ width: `${marginEval.overallScore}%` }}
                />
              </div>
              <div className="eval-sub">
                Vectores: <strong>{vectorLines.length}</strong> · IoU {Math.round(marginEval.silhouetteIoU * 100)}%
              </div>
            </div>
          )}

          {/* Barra 2: Evaluación en vivo del 3D vs Foto subida */}
          {live3DSimilarity && (
            <div className="eval-meter">
              <div className="eval-meter-head">
                <span>Parecido 3D vs Foto</span>
                <strong className={scoreToneClass(live3DSimilarity.overallScore)}>
                  {live3DSimilarity.overallScore}%
                </strong>
              </div>
              <div className="eval-bar-track">
                <div
                  className={`eval-bar-fill ${scoreToneClass(live3DSimilarity.overallScore)}`}
                  style={{ width: `${live3DSimilarity.overallScore}%` }}
                />
              </div>
              <div className="eval-sub">
                Silueta {Math.round(live3DSimilarity.silhouetteMatch * 100)}% · Bordes{' '}
                {Math.round(live3DSimilarity.edgeStructureMatch * 100)}% · Color{' '}
                {Math.round(live3DSimilarity.colorPaletteMatch * 100)}%
              </div>
            </div>
          )}

          {cameraPose && (
            <div className="eval-sub mono">
              Cámara ~{cameraPose.distanceMeters.toFixed(1)} m · W/H {estimatedAspectXY.toFixed(2)}
              {lastIterationsRun > 0 ? ` · ${lastIterationsRun} iter.` : ''}
            </div>
          )}

          {(visualLayer === 'vectors' || visualLayer === 'vectors_zones') && hasPhoto && (
            <div className="vector-legend-mini">
              <span><i style={{ background: '#00e5ff' }} />Contorno</span>
              <span><i style={{ background: '#22c55e' }} />Divisor</span>
              <span><i style={{ background: '#f59e0b' }} />Repisa</span>
              <span><i style={{ background: '#ec4899' }} />Ranura</span>
            </div>
          )}
        </div>
      </div>

      {/* Chips táctiles rápidos de Zonas (para que cualquier cliente cambie Puerta/Cajón/Hueco en 1 toque) */}
      {hasPhoto && viewTab === 'frontal' && zones.length > 0 && (
        <div className="quick-zones-strip">
          <span className="small-note">
            <strong>Zonas detectadas ({zones.length}):</strong>
          </span>
          {zones.map((z, idx) => (
            <label key={z.id} className="quick-zone-pill">
              <i style={{ background: ZONE_COLORS[z.kind].dot }} />
              <span>Z{idx + 1}:</span>
              <select
                value={z.kind}
                onChange={(e) => handleZoneKindSelect(z.id, e.target.value as FrontModuleKind)}
                aria-label={`Tipo de módulo para zona ${idx + 1}`}
              >
                <option value="open">Abierto</option>
                <option value="door_left">Puerta Izq</option>
                <option value="door_right">Puerta Der</option>
                <option value="door_double">2 Puertas</option>
                <option value="door_glass">Vidrio</option>
                <option value="drawers">Cajones (5 pzas)</option>
                <option value="leg_void">Hueco Piernas</option>
              </select>
            </label>
          ))}
        </div>
      )}

      <p className="status-line">{statusMsg}</p>

      {/* Calibración rápida por 1 sola medida real */}
      {viewTab === 'frontal' && hasPhoto && (
        <div className="calib-box">
          <strong>Si conoces 1 medida real:</strong>
          <select
            value={knownAxis}
            onChange={(e) => setKnownAxis(e.target.value as 'x' | 'y')}
          >
            <option value="x">Ancho total (mm)</option>
            <option value="y">Alto cuerpo (mm)</option>
          </select>
          <NumericInput
            min={300}
            max={2600}
            step={10}
            value={knownMeasureMm}
            onCommit={setKnownMeasureMm}
            style={{ width: 82 }}
            ariaLabel="Medida conocida en milímetros"
          />
          <button type="button" className="btn-small" onClick={handleApplySingleMeasure}>
            Ajustar escala real
          </button>

          {tool === 'calibA4' && (
            <>
              <span className="toolbar-sep" />
              <span>Ref. (mm):</span>
              <NumericInput
                min={50}
                max={2500}
                value={calibRefMm}
                onCommit={setCalibRefMm}
                style={{ width: 68 }}
                ariaLabel="Longitud de referencia A4 en milímetros"
              />
              <button type="button" className="chip-btn" onClick={() => setCalibRefMm(297)}>
                A4 (297)
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={calibPts.length !== 2}
                onClick={handleApplyCalibA4}
              >
                Aplicar A4 ({calibPts.length}/2)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
