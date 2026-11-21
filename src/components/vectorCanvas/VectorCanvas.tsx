/**
 * SMARTFURNITURE — VECTORCANVAS v6.0 (RECALCAR MÁRGENES → VECTORIZACIÓN EXACTA → 3D)
 * Flujo guiado en 3 pasos para cálculo milimétrico exacto sobre cualquier foto real:
 *   Paso 1 — Recalcar Contorno Exterior (1 arrastre recto o 4 esquinas H 3×3 con imán Sobel).
 *   Paso 2 — Recalcar Líneas Internas (1 sola herramienta universal: cada trazo se convierte en un
 *            vector H/V recto con snap a muros/T-junctions y particiona el mueble en celdas exactas).
 *   Paso 3 — Definir Zonas → 3D Exacto (auto-clasificadas desde los píxeles dentro de tus márgenes;
 *            1 clic para alternar Abierto / Puerta / 2 Puertas / Vidrio / Cajones / Hueco Piernas).
 * Incluye asistente opcional "Sugerir líneas auto" + barras en vivo de Márgenes vs Foto y 3D vs Foto.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Contrast,
  Crop,
  Eraser,
  Eye,
  GitBranch,
  LayoutGrid,
  Magnet,
  PenTool,
  Pipette,
  Ruler,
  Scan,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  DespieceResult,
  DiagonalSegment,
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
  classifyPartitionedZonesFromPhoto,
  computeSobelEdgeOverlayRGBA,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  evaluate3DvsPhotoSimilarity,
  evaluateMarginsAgainstPhoto,
  extractStructuralVectorLines,
  extrapolateDimensionsFromSingleMeasure,
  partitionCellsFromVectors,
  rectifyImageRGBA,
  runIterativePhotoTo3D,
  snapPointToStrongEdge,
  vectorizeUserStroke,
  type MarginEvaluationResult,
  type UserStrokeMode,
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

type TraceStep = 'frame' | 'lines' | 'zones';
type FrameMode = 'box' | 'quad';
type ExtraTool = 'none' | 'erase' | 'eyedropper' | 'calibA4';
type VisualLayerMode = 'traced_zones' | 'vectors_only' | 'photo' | 'edges';

type DragTarget =
  | { kind: 'corner'; idx: number }
  | { kind: 'drawBox'; start: Point2D }
  | { kind: 'drawVector'; start: Point2D }
  | { kind: 'vDivider'; id: string }
  | { kind: 'hShelf'; id: string };

interface LineSnapshot {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  diagonalDividers?: DiagonalSegment[];
  frontZones?: FrontZone[];
}

const CORNER_LABELS = ['1', '2', '3', '4'] as const;
const CORNER_STEP_NAMES = [
  'Esquina 1 de 4: Arriba-Izquierda',
  'Esquina 2 de 4: Arriba-Derecha',
  'Esquina 3 de 4: Abajo-Derecha',
  'Esquina 4 de 4: Abajo-Izquierda',
] as const;
const MAX_WORK_DIM = 1400;

function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const ZONE_LABELS: Record<FrontModuleKind, string> = {
  open: 'Abierto',
  door_left: 'Puerta Izq',
  door_right: 'Puerta Der',
  door_double: '2 Puertas',
  door_glass: 'Vidrio',
  drawers: 'Cajón',
  baskets: 'Canastos',
  leg_void: 'Hueco Piernas',
  void_outside: 'Sin mueble',
};

const ZONE_COLORS: Record<FrontModuleKind, { fill: string; stroke: string; dot: string }> = {
  open: { fill: 'rgba(14, 165, 233, 0.16)', stroke: '#38bdf8', dot: '#0284c7' },
  door_left: { fill: 'rgba(250, 204, 21, 0.22)', stroke: '#facc15', dot: '#ca8a04' },
  door_right: { fill: 'rgba(250, 204, 21, 0.22)', stroke: '#facc15', dot: '#ca8a04' },
  door_double: { fill: 'rgba(245, 158, 11, 0.22)', stroke: '#f59e0b', dot: '#d97706' },
  door_glass: { fill: 'rgba(125, 211, 252, 0.26)', stroke: '#7dd3fc', dot: '#0ea5e9' },
  drawers: { fill: 'rgba(249, 115, 22, 0.24)', stroke: '#fb923c', dot: '#ea580c' },
  baskets: { fill: 'rgba(16, 185, 129, 0.22)', stroke: '#34d399', dot: '#059669' },
  leg_void: { fill: 'rgba(168, 85, 247, 0.22)', stroke: '#c084fc', dot: '#9333ea' },
  void_outside: { fill: 'rgba(239, 68, 68, 0.22)', stroke: '#f87171', dot: '#dc2626' },
};

const VECTOR_ROLE_COLORS: Record<VectorLineRole, string> = {
  outer_top: '#00e5ff',
  outer_bottom: '#00e5ff',
  outer_left: '#00e5ff',
  outer_right: '#00e5ff',
  divider: '#22c55e',
  shelf: '#f59e0b',
  seam: '#ec4899',
  detail: 'rgba(203, 213, 225, 0.65)',
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

function estimateInitialDimsFromAspect(
  aspectRatioXY: number,
  currentDepthMm: number,
): { x: number; y: number; z: number } {
  const safeRatio = Math.max(0.3, Math.min(3.2, Number.isFinite(aspectRatioXY) ? aspectRatioXY : 1));
  const round10 = (v: number) => Math.max(450, Math.min(2200, Math.round(v / 10) * 10));
  if (safeRatio >= 1.15) {
    const x = 1400;
    const y = round10(x / safeRatio);
    return { x, y, z: Math.max(300, Math.min(700, currentDepthMm)) };
  }
  const y = 1800;
  const x = round10(y * safeRatio);
  return { x, y, z: Math.max(280, Math.min(650, currentDepthMm)) };
}

function inferMaterialFromRectBorder(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  exteriorBgRgb: [number, number, number],
): MelamineMaterial {
  let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
  const bx = Math.max(3, Math.round(W * 0.04));
  const by = Math.max(3, Math.round(H * 0.04));

  const sample = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    if (rgba[i + 3] < 128) return;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (Math.hypot(r - exteriorBgRgb[0], g - exteriorBgRgb[1], b - exteriorBgRgb[2]) < 32) return;
    sumR += r;
    sumG += g;
    sumB += b;
    cnt++;
  };

  for (let x = bx; x < W - bx; x += 3) {
    sample(x, by);
    sample(x, by + 2);
  }
  for (let y = by; y < H - by; y += 3) {
    sample(bx, y);
    sample(W - 1 - bx, y);
  }
  if (cnt < 10) return 'blanco';
  const r = sumR / cnt;
  const g = sumG / cnt;
  const b = sumB / cnt;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const warmth = r - b;
  if (lum >= 175 && Math.abs(r - b) < 28) return 'blanco';
  if (lum <= 96) return 'grafito';
  if (warmth > 20 && r > g - 6) return 'roble';
  return lum >= 165 ? 'blanco' : warmth > 12 ? 'roble' : 'grafito';
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
  const [traceStep, setTraceStep] = useState<TraceStep>('frame');
  // Por defecto 4 esquinas libres (Perspectiva H 3×3) para seguir líneas diagonales de fotos reales 3/4
  const [frameMode, setFrameMode] = useState<FrameMode>('quad');
  const [pickingCorners, setPickingCorners] = useState<Point2D[] | null>(null);
  const [strokeMode, setStrokeMode] = useState<UserStrokeMode>('auto');
  const [extraTool, setExtraTool] = useState<ExtraTool>('none');
  const [magneticSnap, setMagneticSnap] = useState<boolean>(true);
  const [showPrecisionTools, setShowPrecisionTools] = useState(false);
  const [showRectPreview, setShowRectPreview] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState<1 | 2>(1);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [visualLayer, setVisualLayer] = useState<VisualLayerMode>('traced_zones');
  const [isDragOver, setIsDragOver] = useState(false);

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [frontBitmap, setFrontBitmap] = useState<WorkingBitmap | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 900, h: 680 });
  const [exteriorBgRgb, setExteriorBgRgb] = useState<[number, number, number]>([242, 244, 248]);
  const [photoVectorLines, setPhotoVectorLines] = useState<VectorLine2D[]>([]);
  const [marginEval, setMarginEval] = useState<MarginEvaluationResult | null>(null);

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
  const [focal35mm, setFocal35mm] = useState<26 | 52>(26);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [cursorImgPt, setCursorImgPt] = useState<Point2D | null>(null);
  const [undoStack, setUndoStack] = useState<LineSnapshot[]>([]);

  const [knownAxis, setKnownAxis] = useState<'x' | 'y'>('x');
  const [knownMeasureMm, setKnownMeasureMm] = useState<number>(params.targetDimensions.x);

  useEffect(() => {
    setKnownMeasureMm(knownAxis === 'x' ? params.targetDimensions.x : params.targetDimensions.y);
  }, [knownAxis, params.targetDimensions.x, params.targetDimensions.y]);

  const [calibPts, setCalibPts] = useState<Point2D[]>([]);
  const [calibRefMm, setCalibRefMm] = useState<number>(297);

  const [statusMsg, setStatusMsg] = useState<string>(
    'Sube 1 foto de tu mueble: 1) Recalca el contorno exterior · 2) Traza las líneas internas (cada trazo se vuelve un vector recto exacto) · 3) Revisa tu modelo 3D en vivo.',
  );
  const [legHintDetected, setLegHintDetected] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rectPreviewRef = useRef<HTMLCanvasElement | null>(null);
  const fileFrontalInputRef = useRef<HTMLInputElement | null>(null);
  const fileSideInputRef = useRef<HTMLInputElement | null>(null);
  const lastExternalUrlRef = useRef<string | null>(null);

  const pushUndo = () => {
    setUndoStack((prev) => [
      ...prev.slice(-24),
      {
        vDividers: topology.vDividers.map((d) => ({ ...d })),
        hShelves: topology.hShelves.map((s) => ({ ...s })),
        diagonalDividers: (topology.diagonalDividers ?? []).map((dg) => ({ ...dg })),
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
        diagonalDividers: last.diagonalDividers ?? [],
        frontZones: last.frontZones,
      });
      setStatusMsg('Último trazo deshecho.');
      return prev.slice(0, -1);
    });
  };

  const handleClearLines = () => {
    if (
      topology.vDividers.length === 0 &&
      topology.hShelves.length === 0 &&
      (topology.diagonalDividers?.length ?? 0) === 0
    ) {
      return;
    }
    pushUndo();
    onUpdateTopology({
      ...topology,
      shelfMode: 'custom',
      vDividers: [],
      hShelves: [],
      diagonalDividers: [],
      frontZones: [
        { id: 'traced_zone_1', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'open', label: 'Vano 1' },
      ],
      detectionSource: 'manual',
    });
    setTraceStep('lines');
    setExtraTool('none');
    setStatusMsg('Líneas internas limpiadas. Traza tus nuevas divisiones rectas o diagonales sobre la foto.');
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

  // Carga foto real cuando el usuario elige un mueble del Catálogo QA (14 fotos reales)
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
      setExtraTool('none');
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
      setExteriorBgRgb(autoQ.exteriorBgRgb);
      setQuad(bestBox);
      setPhotoVectorLines(extBest.lines);
      setMarginEval(mEval);
      setFrameMode('quad');
      setPickingCorners(null);
      setTraceStep('lines');
      setStatusMsg(
        `Foto real cargada (${externalPhotoLabel ?? 'Catálogo QA'}): Márgenes ${mEval.overallScore}%. Puedes trazar líneas rectas o diagonales en Paso 2, o remarcar las 4 esquinas en Paso 1.`,
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

  // Caché de cara frontal rectificada (para vista previa, clasificación de celdas recalcadas y similitud 3D vs Foto)
  const rectifiedPreview = useMemo(() => {
    if (!frontBitmap || frontBitmap.w === 0 || !homography) return null;
    const w = dragTarget?.kind === 'corner' || dragTarget?.kind === 'drawBox' ? 160 : 280;
    const h = Math.max(96, Math.min(300, Math.round(w / Math.max(0.25, estimatedAspectXY))));
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
   * Re-evalúa los márgenes del contorno exterior trazado por el usuario, actualiza medidas
   * proporcionales (û_XY) y re-clasifica las celdas desde los píxeles reales dentro de ESE contorno exacto.
   */
  const commitOuterFrame = (
    bmp: WorkingBitmap,
    nextQuad: [Point2D, Point2D, Point2D, Point2D],
    opts: { resetInternalLines?: boolean; applyDims?: boolean; advanceToLines?: boolean } = {},
  ) => {
    const hom = computeQuadToUnitHomography(nextQuad);
    if (!hom) {
      setStatusMsg('Contorno inválido o cruzado. Arrastra un rectángulo limpio sobre el frente del mueble.');
      return;
    }

    const ext = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, nextQuad);
    const mEval = evaluateMarginsAgainstPhoto(bmp.rgba, bmp.w, bmp.h, nextQuad, ext, exteriorBgRgb);
    setPhotoVectorLines(ext.lines);
    setMarginEval(mEval);

    const ratio = estimateAspectRatioFixedFocal(nextQuad, bmp.w, bmp.h, focal35mm);
    const autoDims = estimateInitialDimsFromAspect(ratio, params.targetDimensions.z);
    const effDims = opts.applyDims
      ? autoDims
      : { x: params.targetDimensions.x, y: params.targetDimensions.y, z: params.targetDimensions.z };

    const rw = 260;
    const rh = Math.max(96, Math.min(280, Math.round(rw / Math.max(0.25, ratio))));
    const rectRgba = rectifyImageRGBA(bmp.rgba, bmp.w, bmp.h, hom.toCanvas, rw, rh);
    const estMat = inferMaterialFromRectBorder(rectRgba, rw, rh, exteriorBgRgb);

    if (opts.applyDims) {
      onAutoPhotoReconstructed(autoDims, estMat);
    }

    const nextVDivs = opts.resetInternalLines ? [] : topology.vDividers;
    const nextHShelves = opts.resetInternalLines ? [] : topology.hShelves;
    const nextDiags = opts.resetInternalLines ? [] : (topology.diagonalDividers ?? []);
    const cells = partitionCellsFromVectors(nextVDivs, nextHShelves);
    const zones = classifyPartitionedZonesFromPhoto(
      cells,
      rectRgba,
      rw,
      rh,
      effDims,
      opts.applyDims ? estMat : params.material,
      exteriorBgRgb,
      opts.resetInternalLines ? [] : (topology.frontZones ?? []),
    );
    const hasLegVoid = zones.some((z) => z.kind === 'leg_void');

    onUpdateTopology({
      ...topology,
      aspectRatioXY: ratio,
      quadCorners: nextQuad,
      homographyMatrix: hom.toUnit.map((r) => [...r]),
      shelfMode: 'custom',
      vDividers: nextVDivs,
      hShelves: nextHShelves,
      diagonalDividers: nextDiags,
      frontZones: zones,
      hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
      detectionSource: 'manual',
      detectionConfidence: Math.max(0.85, mEval.overallScore / 100),
    });

    if (opts.advanceToLines) {
      setPickingCorners(null);
      setTraceStep('lines');
      setExtraTool('none');
      setStatusMsg(
        `Paso 1 listo (Márgenes ${mEval.overallScore}%). Ahora en Paso 2 arrastra sobre la foto para trazar divisiones rectas o diagonales.`,
      );
    } else {
      setStatusMsg(
        `Contorno actualizado (Márgenes ${mEval.overallScore}%). Puedes seguir trazando líneas rectas o diagonales.`,
      );
    }
  };

  /**
   * Re-particiona en celdas rectangulares y actualiza el 3D inmediatamente tras agregar/mover/borrar un vector.
   */
  const syncTracedVectorsTo3D = (
    nextVDivs: NormalizedSegment[],
    nextHShelves: NormalizedSegment[],
    preservePreviousZones = true,
    nextDiags?: DiagonalSegment[],
  ) => {
    const cells = partitionCellsFromVectors(nextVDivs, nextHShelves);
    const zones = classifyPartitionedZonesFromPhoto(
      cells,
      rectifiedPreview?.rgba ?? null,
      rectifiedPreview?.w ?? 0,
      rectifiedPreview?.h ?? 0,
      params.targetDimensions,
      params.material,
      exteriorBgRgb,
      preservePreviousZones ? (topology.frontZones ?? []) : [],
    );
    const hasLegVoid = zones.some((z) => z.kind === 'leg_void');
    onUpdateTopology({
      ...topology,
      aspectRatioXY: estimatedAspectXY,
      quadCorners: quad,
      homographyMatrix: homography ? homography.toUnit.map((r) => [...r]) : topology.homographyMatrix,
      shelfMode: 'custom',
      vDividers: nextVDivs,
      hShelves: nextHShelves,
      diagonalDividers: nextDiags ?? topology.diagonalDividers ?? [],
      frontZones: zones,
      hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
      detectionSource: 'manual',
      detectionConfidence: 0.96,
    });
  };

  /**
   * Asistente opcional (1 clic): sugiere líneas internas automáticamente dentro del contorno actual del usuario.
   */
  const handleAutoSuggestInsideFrame = () => {
    if (!frontBitmap || frontBitmap.w === 0) return;
    pushUndo();
    const res = runIterativePhotoTo3D(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, {
      overrideQuad: quad,
      focal35mm,
      boardThicknessMm: params.boardThickness,
      currentDepthMm: params.targetDimensions.z,
      preferredDimsMm: { x: params.targetDimensions.x, y: params.targetDimensions.y },
      existingBackPanel: topology.hasBackPanel,
    });
    if (!res) return;

    setPhotoVectorLines(res.vectorExtraction.lines);
    setMarginEval(res.marginEval);
    setLegHintDetected(res.legsHint.possibleExternalLegs);

    const hom = computeQuadToUnitHomography(res.usedQuad);
    const det = res.detection;
    const hasLegVoid = det.inferredZones.some((z) => z.kind === 'leg_void');
    onAutoPhotoReconstructed(res.estimatedDimsMm, det.detectedMaterial);
    onUpdateTopology({
      ...topology,
      aspectRatioXY: res.estimatedAspectXY,
      quadCorners: res.usedQuad,
      homographyMatrix: hom ? hom.toUnit.map((r) => [...r]) : undefined,
      shelfMode: 'custom',
      vDividers: det.vDividers,
      hShelves: det.hShelves,
      frontZones: det.inferredZones,
      hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
      detectionSource: 'auto',
      detectionConfidence: det.confidence,
    });
    setTraceStep('zones');
    setStatusMsg(
      `Asistente sugirió ${det.vDividers.length} divisor(es) y ${det.hShelves.length} repisa(s) (3D vs Foto ${res.similarity3D.overallScore}%). Puedes borrar/agregar líneas en Paso 2 o tocar zonas en Paso 3.`,
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
      setFrameMode('quad');
      setCalibPts([]);
      setExtraTool('none');

      // Al subir foto: iniciar en Paso 1 con modo guiado "Toca las 4 esquinas (1→2→3→4)"
      // para que sea imposible confundirse, con 1 clic para aceptar el contorno sugerido si ya calza bien.
      const autoQ = autoDetectFurnitureQuad(bmp.rgba, bmp.w, bmp.h);
      const extRaw = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, autoQ.quadCorners);
      const initQuad = isSample
        ? makeAxisAlignedQuad(165, 120, 735, 540)
        : (extRaw.refinedBox ?? autoQ.quadCorners);
      const extInit = extractStructuralVectorLines(bmp.rgba, bmp.w, bmp.h, initQuad);
      const mEval = evaluateMarginsAgainstPhoto(
        bmp.rgba,
        bmp.w,
        bmp.h,
        initQuad,
        extInit,
        autoQ.exteriorBgRgb,
      );

      setExteriorBgRgb(autoQ.exteriorBgRgb);
      setQuad(initQuad);
      setPhotoVectorLines(extInit.lines);
      setMarginEval(mEval);

      const ratio = estimateAspectRatioFixedFocal(initQuad, bmp.w, bmp.h, focal35mm);
      const autoDims = estimateInitialDimsFromAspect(ratio, params.targetDimensions.z);
      const hom = computeQuadToUnitHomography(initQuad);
      const rw = 240;
      const rh = Math.max(96, Math.min(260, Math.round(rw / Math.max(0.25, ratio))));
      const rectRgba = hom ? rectifyImageRGBA(bmp.rgba, bmp.w, bmp.h, hom.toCanvas, rw, rh) : null;
      const estMat = rectRgba
        ? inferMaterialFromRectBorder(rectRgba, rw, rh, autoQ.exteriorBgRgb)
        : 'roble';

      onAutoPhotoReconstructed(autoDims, estMat);
      onUpdateTopology({
        ...topology,
        aspectRatioXY: ratio,
        quadCorners: initQuad,
        homographyMatrix: hom ? hom.toUnit.map((r) => [...r]) : undefined,
        shelfMode: 'custom',
        vDividers: [],
        hShelves: [],
        diagonalDividers: [],
        frontZones: [
          { id: 'traced_zone_1', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'open', label: 'Cuerpo' },
        ],
        detectionSource: 'manual',
        detectionConfidence: 0.9,
      });

      setTraceStep(isSample ? 'lines' : 'frame');
      setPickingCorners(isSample ? null : []);
      setStatusMsg(
        isSample
          ? 'Muestra cargada con contorno exacto. Arrastra sobre la foto para trazar líneas rectas o diagonales.'
          : 'PASO 1: Toca sobre la foto las 4 esquinas del frente del mueble (1 Arriba-Izq → 2 Arriba-Der → 3 Abajo-Der → 4 Abajo-Izq), o pulsa "Usar contorno sugerido".',
      );
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

  const handleToggleFrameMode = (nextMode: FrameMode) => {
    setFrameMode(nextMode);
    if (nextMode === 'box') {
      setQuad((prev) => quadToBoundingBox(prev));
      setStatusMsg('Recuadro recto activado: ideal para la mayoría de muebles frontales.');
    } else {
      setStatusMsg('4 esquinas libres (Perspectiva H 3×3): ideal para fotos tomadas en ángulo 3/4.');
    }
  };

  const handleZoneKindSelect = (
    zoneId: string,
    nextKind: FrontModuleKind,
    explicitCount?: number,
  ) => {
    pushUndo();
    const zones = topology.frontZones ?? [];
    const updated = zones.map((z) => {
      if (z.id !== zoneId) return z;
      const clearOverride =
        nextKind === 'open' ||
        nextKind === 'baskets' ||
        nextKind === 'leg_void' ||
        nextKind === 'void_outside';
      return {
        ...z,
        kind: nextKind,
        drawerCount:
          nextKind === 'drawers' ? (explicitCount ?? z.drawerCount ?? 1) : undefined,
        basketCount:
          nextKind === 'baskets' ? (explicitCount ?? z.basketCount ?? 3) : undefined,
        internalShelves:
          nextKind === 'drawers' ||
          nextKind === 'baskets' ||
          nextKind === 'leg_void' ||
          nextKind === 'void_outside'
            ? undefined
            : z.internalShelves,
        materialOverride: clearOverride ? undefined : z.materialOverride,
        label: ZONE_LABELS[nextKind],
      };
    });
    onUpdateFrontZones(updated);
    setSelectedZoneId(zoneId);
    setStatusMsg(
      nextKind === 'void_outside'
        ? 'Zona marcada como "Sin mueble (Vacío exterior)" — carcasa, cubierta, lateral y fondo recortados en 3D.'
        : `Zona cambiada a "${ZONE_LABELS[nextKind]}" — 3D actualizado al instante.`,
    );
  };

  const handleZoneDrawerCount = (zoneId: string, count: number) => {
    const zones = topology.frontZones ?? [];
    const updated = zones.map((z) =>
      z.id === zoneId ? { ...z, drawerCount: Math.max(1, Math.min(6, count)) } : z,
    );
    onUpdateFrontZones(updated);
  };

  const handleZoneBasketCount = (zoneId: string, count: number) => {
    const zones = topology.frontZones ?? [];
    const updated = zones.map((z) =>
      z.id === zoneId ? { ...z, basketCount: Math.max(1, Math.min(6, count)) } : z,
    );
    onUpdateFrontZones(updated);
  };

  const handleZoneInternalShelves = (zoneId: string, count: number) => {
    const zones = topology.frontZones ?? [];
    const updated = zones.map((z) =>
      z.id === zoneId
        ? { ...z, internalShelves: count <= 0 ? undefined : Math.min(5, count) }
        : z,
    );
    onUpdateFrontZones(updated);
  };

  const handleZoneMaterialOverride = (
    zoneId: string,
    mat: MelamineMaterial | 'same',
  ) => {
    const zones = topology.frontZones ?? [];
    const updated = zones.map((z) =>
      z.id === zoneId
        ? { ...z, materialOverride: mat === 'same' ? undefined : mat }
        : z,
    );
    onUpdateFrontZones(updated);
  };

  // Pintar miniatura rectificada
  useEffect(() => {
    const previewCanvas = rectPreviewRef.current;
    if (!previewCanvas || !rectifiedPreview) return;
    previewCanvas.width = rectifiedPreview.w;
    previewCanvas.height = rectifiedPreview.h;
    const ctx = previewCanvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(
        new ImageData(
          new Uint8ClampedArray(rectifiedPreview.rgba),
          rectifiedPreview.w,
          rectifiedPreview.h,
        ),
        0,
        0,
      );
    }
  }, [rectifiedPreview]);

  // Render principal del lienzo interactivo
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

    // Oscurecer fuera del contorno del mueble para concentrar la vista en la cara frontal
    if (viewTab === 'frontal' && visualLayer === 'vectors_only') {
      ctx.fillStyle = 'rgba(10, 15, 28, 0.42)';
      ctx.fillRect(0, 0, cw, ch);
    } else if (viewTab === 'frontal' && visualLayer !== 'edges') {
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.30)';
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

    // En vista "Solo Vectores": mostrar vectores detectados de la foto como guía de borde
    if (viewTab === 'frontal' && visualLayer === 'vectors_only' && photoVectorLines.length > 0) {
      for (const ln of photoVectorLines) {
        ctx.strokeStyle = VECTOR_ROLE_COLORS[ln.role];
        ctx.lineWidth = Math.max(1.8, cw / 380);
        ctx.beginPath();
        ctx.moveTo(ln.p1.x, ln.p1.y);
        ctx.lineTo(ln.p2.x, ln.p2.y);
        ctx.stroke();
      }
    }

    // Contorno exterior (4 vectores perimetrales)
    ctx.strokeStyle = traceStep === 'frame' ? '#38bdf8' : '#00e5ff';
    ctx.lineWidth = Math.max(traceStep === 'frame' ? 3.2 : 2.4, cw / 290);
    ctx.beginPath();
    activeQuad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    if (viewTab === 'frontal' && homography) {
      const { toCanvas } = homography;
      const e = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;
      const xInt = Math.max(1, xf - 2 * e);
      const yInt = Math.max(1, yf - 2 * e);

      // Zonas resultantes de los vectores recalcados
      const zones = topology.frontZones ?? [];
      if (visualLayer === 'traced_zones' && zones.length > 0 && traceStep !== 'frame') {
        for (let zIdx = 0; zIdx < zones.length; zIdx++) {
          const z = zones[zIdx];
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
            const isSelZone = selectedZoneId === z.id;
            ctx.beginPath();
            ctx.moveTo(pTL.x, pTL.y);
            ctx.lineTo(pTR.x, pTR.y);
            ctx.lineTo(pBR.x, pBR.y);
            ctx.lineTo(pBL.x, pBL.y);
            ctx.closePath();
            ctx.fillStyle = palette.fill;
            ctx.fill();
            ctx.save();
            if (z.kind === 'void_outside') {
              ctx.setLineDash([7, 5]);
              ctx.beginPath();
              ctx.moveTo(pTL.x, pTL.y);
              ctx.lineTo(pBR.x, pBR.y);
              ctx.moveTo(pTR.x, pTR.y);
              ctx.lineTo(pBL.x, pBL.y);
              ctx.strokeStyle = 'rgba(248, 113, 113, 0.7)';
              ctx.lineWidth = Math.max(1.5, cw / 500);
              ctx.stroke();
            }
            ctx.strokeStyle = isSelZone ? '#ffffff' : palette.stroke;
            ctx.lineWidth = Math.max(isSelZone ? 3 : 1.3, cw / (isSelZone ? 280 : 540));
            ctx.beginPath();
            ctx.moveTo(pTL.x, pTL.y);
            ctx.lineTo(pTR.x, pTR.y);
            ctx.lineTo(pBR.x, pBR.y);
            ctx.lineTo(pBL.x, pBL.y);
            ctx.closePath();
            ctx.stroke();
            ctx.restore();

            const center = applyHomography(toCanvas, { x: (u0 + u1) / 2, y: (v0 + v1) / 2 });
            if (center) {
              const tagText =
                z.kind === 'drawers'
                  ? `Z${zIdx + 1}: ${z.drawerCount ?? 1} Caj.`
                  : z.kind === 'baskets'
                    ? `Z${zIdx + 1}: ${z.basketCount ?? 3} Can.`
                    : z.kind === 'void_outside'
                      ? `Z${zIdx + 1}: ✕ Vacío`
                      : `Z${zIdx + 1}: ${ZONE_LABELS[z.kind]}`;
              const fontPx = Math.max(11, Math.min(16, Math.round(cw / 66)));
              ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
              const tw = ctx.measureText(tagText).width;
              ctx.fillStyle =
                z.kind === 'void_outside'
                  ? 'rgba(185, 28, 28, 0.88)'
                  : isSelZone
                    ? 'rgba(2, 132, 199, 0.94)'
                    : 'rgba(15, 23, 42, 0.82)';
              ctx.fillRect(center.x - tw / 2 - 5, center.y - fontPx * 0.7, tw + 10, fontPx * 1.4);
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, center.x, center.y);
            }
          }
        }
      }

      // Vectores estructurales recalcados por el usuario (con nodos extremos y cota en mm)
      const endR = Math.max(3.5, cw / 210);
      for (const div of topology.vDividers) {
        const isActive = dragTarget?.kind === 'vDivider' && dragTarget.id === div.id;
        ctx.strokeStyle = isActive ? '#38bdf8' : '#22c55e';
        ctx.lineWidth = Math.max(isActive ? 5 : 3.2, cw / (isActive ? 200 : 270));
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

          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, endR, 0, Math.PI * 2);
          ctx.arc(p1.x, p1.y, endR, 0, Math.PI * 2);
          ctx.fill();

          if (traceStep === 'lines') {
            const xMm = Math.round(e + div.position * xInt);
            const mx = (p0.x + p1.x) / 2;
            const my = (p0.y + p1.y) / 2;
            ctx.font = `bold ${Math.max(10, Math.round(cw / 78))}px Consolas, monospace`;
            const lbl = `${xMm}mm`;
            const lw = ctx.measureText(lbl).width;
            ctx.fillStyle = 'rgba(21, 128, 61, 0.9)';
            ctx.fillRect(mx - lw / 2 - 3, my - 8, lw + 6, 15);
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(lbl, mx, my);
          }
        }
      }

      for (const sh of topology.hShelves) {
        const isActive = dragTarget?.kind === 'hShelf' && dragTarget.id === sh.id;
        ctx.strokeStyle = isActive ? '#38bdf8' : '#f59e0b';
        ctx.lineWidth = Math.max(isActive ? 5 : 3.2, cw / (isActive ? 200 : 270));
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

          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, endR, 0, Math.PI * 2);
          ctx.arc(p1.x, p1.y, endR, 0, Math.PI * 2);
          ctx.fill();

          if (traceStep === 'lines') {
            const yMm = Math.round(e + sh.position * yInt);
            const mx = (p0.x + p1.x) / 2;
            const my = (p0.y + p1.y) / 2;
            ctx.font = `bold ${Math.max(10, Math.round(cw / 78))}px Consolas, monospace`;
            const lbl = `${yMm}mm`;
            const lw = ctx.measureText(lbl).width;
            ctx.fillStyle = 'rgba(180, 83, 9, 0.9)';
            ctx.fillRect(mx - lw / 2 - 3, my - 8, lw + 6, 15);
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(lbl, mx, my);
          }
        }
      }

      // Vectores diagonales / oblicuos reales trazados por el usuario (magenta)
      for (const diag of topology.diagonalDividers ?? []) {
        const p0 = applyHomography(toCanvas, {
          x: interiorToExterior(diag.u1, e, xf),
          y: interiorToExterior(diag.v1, e, yf),
        });
        const p1 = applyHomography(toCanvas, {
          x: interiorToExterior(diag.u2, e, xf),
          y: interiorToExterior(diag.v2, e, yf),
        });
        if (p0 && p1) {
          ctx.strokeStyle = '#d946ef';
          ctx.lineWidth = Math.max(3.4, cw / 260);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(p0.x, p0.y, endR, 0, Math.PI * 2);
          ctx.arc(p1.x, p1.y, endR, 0, Math.PI * 2);
          ctx.fill();

          if (traceStep === 'lines') {
            const dxD = (diag.u2 - diag.u1) * xInt;
            const dyD = (diag.v2 - diag.v1) * yInt;
            const lenMm = Math.round(Math.hypot(dxD, dyD));
            const deg = Math.round(Math.abs((Math.atan2(dyD, dxD) * 180) / Math.PI));
            const mx = (p0.x + p1.x) / 2;
            const my = (p0.y + p1.y) / 2;
            ctx.font = `bold ${Math.max(10, Math.round(cw / 78))}px Consolas, monospace`;
            const lbl = `${deg}° · ${lenMm}mm`;
            const lw = ctx.measureText(lbl).width;
            ctx.fillStyle = 'rgba(134, 25, 143, 0.92)';
            ctx.fillRect(mx - lw / 2 - 4, my - 8, lw + 8, 16);
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(lbl, mx, my);
          }
        }
      }

      // Vista previa EN VIVO del vector que está recalcando el usuario (Recto en perspectiva o Diagonal real)
      if (dragTarget?.kind === 'drawVector' && cursorImgPt) {
        const previewVec = vectorizeUserStroke(
          dragTarget.start,
          cursorImgPt,
          homography.toUnit,
          topology.vDividers,
          topology.hShelves,
          e,
          params.targetDimensions,
          true,
          strokeMode,
        );
        ctx.save();
        if (previewVec) {
          let pA: Point2D | null = null;
          let pB: Point2D | null = null;
          let strokeCol = '#4ade80';
          let textCol = '#86efac';
          let lbl = '';

          if (previewVec.kind === 'diagonal') {
            pA = applyHomography(toCanvas, {
              x: interiorToExterior(previewVec.segment.u1, e, xf),
              y: interiorToExterior(previewVec.segment.v1, e, yf),
            });
            pB = applyHomography(toCanvas, {
              x: interiorToExterior(previewVec.segment.u2, e, xf),
              y: interiorToExterior(previewVec.segment.v2, e, yf),
            });
            strokeCol = '#e879f9';
            textCol = '#f5d0fe';
            lbl = `⟋ Diagonal (${Math.abs(previewVec.angleDeg)}° · ${previewVec.spanMm} mm)`;
          } else if (previewVec.kind === 'hShelf') {
            pA = applyHomography(toCanvas, {
              x: interiorToExterior(previewVec.segment.start, e, xf),
              y: interiorToExterior(previewVec.segment.position, e, yf),
            });
            pB = applyHomography(toCanvas, {
              x: interiorToExterior(previewVec.segment.end, e, xf),
              y: interiorToExterior(previewVec.segment.position, e, yf),
            });
            strokeCol = '#fbbf24';
            textCol = '#fde68a';
            lbl = `→ Repisa (${previewVec.positionMm} mm)`;
          } else {
            pA = applyHomography(toCanvas, {
              x: interiorToExterior(previewVec.segment.position, e, xf),
              y: interiorToExterior(previewVec.segment.start, e, yf),
            });
            pB = applyHomography(toCanvas, {
              x: interiorToExterior(previewVec.segment.position, e, xf),
              y: interiorToExterior(previewVec.segment.end, e, yf),
            });
            strokeCol = '#4ade80';
            textCol = '#86efac';
            lbl = `↓ Divisor (${previewVec.positionMm} mm)`;
          }

          if (pA && pB) {
            ctx.strokeStyle = strokeCol;
            ctx.lineWidth = Math.max(4, cw / 220);
            ctx.setLineDash([10, 6]);
            ctx.beginPath();
            ctx.moveTo(pA.x, pA.y);
            ctx.lineTo(pB.x, pB.y);
            ctx.stroke();

            const mx = (pA.x + pB.x) / 2;
            const my = (pA.y + pB.y) / 2;
            ctx.setLineDash([]);
            ctx.font = `bold ${Math.max(12, Math.round(cw / 62))}px system-ui, sans-serif`;
            const lw = ctx.measureText(lbl).width;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
            ctx.fillRect(mx - lw / 2 - 6, my - 12, lw + 12, 22);
            ctx.fillStyle = textCol;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(lbl, mx, my);
          }
        } else {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(dragTarget.start.x, dragTarget.start.y);
          ctx.lineTo(cursorImgPt.x, cursorImgPt.y);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Calibración A4
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
    }

    // Modo guiado "Toca las 4 esquinas (1→2→3→4)" sobre la foto con líneas de proyección de perspectiva
    if (viewTab === 'frontal' && pickingCorners !== null) {
      const pickR = Math.max(12, cw / 72);
      ctx.save();
      if (pickingCorners.length >= 1) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = Math.max(3, cw / 260);
        ctx.beginPath();
        pickingCorners.forEach((pt, idx) =>
          idx === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y),
        );
        ctx.stroke();

        // Línea guía punteada hacia el puntero actual
        if (cursorImgPt) {
          const lastPt = pickingCorners[pickingCorners.length - 1];
          ctx.setLineDash([7, 5]);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = Math.max(2, cw / 360);
          ctx.beginPath();
          ctx.moveTo(lastPt.x, lastPt.y);
          ctx.lineTo(cursorImgPt.x, cursorImgPt.y);
          if (pickingCorners.length === 3) {
            ctx.lineTo(pickingCorners[0].x, pickingCorners[0].y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Al tener 3 esquinas, proyectar paralelogramo fantasma para la 4ª esquina
        if (pickingCorners.length === 3) {
          const proj4 = {
            x: pickingCorners[0].x + (pickingCorners[2].x - pickingCorners[1].x),
            y: pickingCorners[0].y + (pickingCorners[2].y - pickingCorners[1].y),
          };
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(proj4.x, proj4.y, pickR * 0.8, 0, Math.PI * 2);
          ctx.stroke();
        }

        pickingCorners.forEach((pt, idx) => {
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pickR, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.fillStyle = '#0f172a';
          ctx.font = `bold ${Math.round(pickR * 1.1)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(idx + 1), pt.x, pt.y);
        });
      }
      ctx.restore();
    } else {
      // Guías sutiles de fuga al ajustar una esquina en perspectiva (ayuda a alinear esquinas en el aire!)
      if (viewTab === 'frontal' && dragTarget?.kind === 'corner' && homography) {
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
        ctx.lineWidth = 1.5;
        for (const t of [0.33, 0.5, 0.67]) {
          const h0 = applyHomography(homography.toCanvas, { x: 0, y: t });
          const h1 = applyHomography(homography.toCanvas, { x: 1, y: t });
          if (h0 && h1) {
            ctx.beginPath();
            ctx.moveTo(h0.x, h0.y);
            ctx.lineTo(h1.x, h1.y);
            ctx.stroke();
          }
          const v0 = applyHomography(homography.toCanvas, { x: t, y: 0 });
          const v1 = applyHomography(homography.toCanvas, { x: t, y: 1 });
          if (v0 && v1) {
            ctx.beginPath();
            ctx.moveTo(v0.x, v0.y);
            ctx.lineTo(v1.x, v1.y);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Manijas numeradas del marco exterior (grandes en Paso 1, discretas en Paso 2 y 3)
      const nodeR = Math.max(traceStep === 'frame' ? 14 : 8, cw / (traceStep === 'frame' ? 66 : 110));
      activeQuad.forEach((p, idx) => {
        const isDraggingCorner = dragTarget?.kind === 'corner' && dragTarget.idx === idx;
        if (frameMode === 'box' && viewTab === 'frontal') {
          const hs = nodeR * 1.35;
          ctx.fillStyle = isDraggingCorner ? '#f59e0b' : '#0284c7';
          ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.2;
          ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
        } else {
          ctx.fillStyle = isDraggingCorner ? '#f59e0b' : '#0284c7';
          ctx.beginPath();
          ctx.arc(p.x, p.y, nodeR, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.4;
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.round(nodeR * 1.05)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(CORNER_LABELS[idx], p.x, p.y);
        }
      });
    }

    // Lupa 4× al marcar esquinas (hover), arrastrar esquina o trazar vector
    const showLoupe =
      cursorImgPt !== null &&
      (pickingCorners !== null ||
        dragTarget?.kind === 'corner' ||
        dragTarget?.kind === 'drawVector');
    if (showLoupe && cursorImgPt) {
      const magSize = Math.min(165, Math.round(cw * 0.22));
      const zoom = 4;
      const srcSpan = magSize / zoom;
      const mx = cursorImgPt.x < cw / 2 ? cw - magSize - 14 : 14;
      const my = cursorImgPt.y < ch / 2 ? ch - magSize - 14 : 14;

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
      ctx.moveTo(mx + magSize / 2 - 11, my + magSize / 2);
      ctx.lineTo(mx + magSize / 2 + 11, my + magSize / 2);
      ctx.moveTo(mx + magSize / 2, my + magSize / 2 - 11);
      ctx.lineTo(mx + magSize / 2, my + magSize / 2 + 11);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    viewTab,
    traceStep,
    frameMode,
    pickingCorners,
    strokeMode,
    selectedZoneId,
    frontBitmap,
    sideBitmap,
    quad,
    sideQuad,
    photoVectorLines,
    homography,
    topology.vDividers,
    topology.hShelves,
    topology.diagonalDividers,
    topology.frontZones,
    params.boardThickness,
    params.targetDimensions,
    dragTarget,
    cursorImgPt,
    calibPts,
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

  const applyMagneticEdge = (pt: Point2D): Point2D => {
    if (!magneticSnap || viewTab !== 'frontal' || !frontBitmap) return pt;
    return snapPointToStrongEdge(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, pt, 9).snapped;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rawPt = toCanvasCoords(e);
    const activeQuad = viewTab === 'frontal' ? quad : sideQuad;
    const eMm = params.boardThickness;
    const xf = params.targetDimensions.x;
    const yf = params.targetDimensions.y;

    // 1. Herramientas auxiliares puntuales (Borrar / Gotero / A4)
    if (viewTab === 'frontal' && extraTool !== 'none' && homography) {
      const unitPt = applyHomography(homography.toUnit, rawPt);
      if (!unitPt) return;

      if (extraTool === 'calibA4') {
        setCalibPts((prev) => (prev.length >= 2 ? [rawPt] : [...prev, rawPt]));
        return;
      }

      if (extraTool === 'eyedropper' && frontBitmap) {
        const res = runIterativePhotoTo3D(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, {
          overrideQuad: quad,
          seedPoint: {
            u: Math.max(0, Math.min(1, unitPt.x)),
            v: Math.max(0, Math.min(1, unitPt.y)),
          },
          focal35mm,
          boardThicknessMm: eMm,
          currentDepthMm: params.targetDimensions.z,
          preferredDimsMm: { x: xf, y: yf },
        });
        if (res) {
          onAutoPhotoReconstructed(res.estimatedDimsMm, res.detection.detectedMaterial);
          setStatusMsg(`Color muestreado: ${res.detection.detectedMaterial}.`);
        }
        setExtraTool('none');
        return;
      }

      if (extraTool === 'erase') {
        const uClick = exteriorToInterior(unitPt.x, eMm, xf);
        const vClick = exteriorToInterior(unitPt.y, eMm, yf);
        let bestDist = 0.055;
        let targetKind: 'div' | 'shelf' | 'diag' | null = null;
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
        for (const dg of topology.diagonalDividers ?? []) {
          const dist = pointToSegmentDist(
            { x: uClick, y: vClick },
            { x: dg.u1, y: dg.v1 },
            { x: dg.u2, y: dg.v2 },
          );
          if (dist < bestDist) {
            bestDist = dist;
            targetKind = 'diag';
            targetId = dg.id;
          }
        }

        if (targetKind === 'div') {
          pushUndo();
          syncTracedVectorsTo3D(
            topology.vDividers.filter((d) => d.id !== targetId),
            topology.hShelves,
          );
          setStatusMsg('Vector divisor borrado (Ctrl+Z para deshacer).');
        } else if (targetKind === 'shelf') {
          pushUndo();
          syncTracedVectorsTo3D(
            topology.vDividers,
            topology.hShelves.filter((s) => s.id !== targetId),
          );
          setStatusMsg('Vector repisa borrado (Ctrl+Z para deshacer).');
        } else if (targetKind === 'diag') {
          pushUndo();
          syncTracedVectorsTo3D(
            topology.vDividers,
            topology.hShelves,
            true,
            (topology.diagonalDividers ?? []).filter((dg) => dg.id !== targetId),
          );
          setStatusMsg('Vector diagonal borrado (Ctrl+Z para deshacer).');
        }
        return;
      }
    }

    // 1B. MODO GUIADO DE 4 TOQUES PARA CONTORNO EXTERIOR (1 Arriba-Izq → 2 Arriba-Der → 3 Abajo-Der → 4 Abajo-Izq)
    if (viewTab === 'frontal' && pickingCorners !== null) {
      const snapped = applyMagneticEdge(rawPt);
      const nextPicked = [...pickingCorners, snapped];
      if (nextPicked.length < 4) {
        setPickingCorners(nextPicked);
        setStatusMsg(
          `Esquina ${nextPicked.length}/4 marcada. Ahora toca: ${CORNER_STEP_NAMES[nextPicked.length]}.`,
        );
      } else {
        const nextQuad: [Point2D, Point2D, Point2D, Point2D] = [
          nextPicked[0],
          nextPicked[1],
          nextPicked[2],
          nextPicked[3],
        ];
        setFrameMode('quad');
        setQuad(nextQuad);
        setPickingCorners(null);
        if (frontBitmap) {
          commitOuterFrame(frontBitmap, nextQuad, {
            resetInternalLines: true,
            applyDims: true,
            advanceToLines: true,
          });
        }
      }
      return;
    }

    // 2. Agarrar esquina numerada del marco exterior (libre en 4 pts o recto en box)
    const hitTol = Math.max(28, (canvasRef.current?.width ?? 900) * 0.044);
    const hitIdx = activeQuad.findIndex((p) => Math.hypot(p.x - rawPt.x, p.y - rawPt.y) <= hitTol);
    if (hitIdx !== -1 || viewTab === 'lateral') {
      if (hitIdx !== -1) {
        setDragTarget({ kind: 'corner', idx: hitIdx });
        setCursorImgPt(rawPt);
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }
      return;
    }

    // 3. PASO 1 (CONTORNO EXTERIOR):
    //    - Si está en modo 4 esquinas libres (quad), arrastrar la esquina más cercana sin destruir la perspectiva!
    //    - Si está en modo Recto (box), arrastrar rectángulo nuevo en 1 gesto.
    if (traceStep === 'frame') {
      const startPt = applyMagneticEdge(rawPt);
      if (frameMode === 'quad') {
        let nearestIdx = 0;
        let nearestD = Infinity;
        activeQuad.forEach((p, i) => {
          const d = Math.hypot(p.x - rawPt.x, p.y - rawPt.y);
          if (d < nearestD) {
            nearestD = d;
            nearestIdx = i;
          }
        });
        setDragTarget({ kind: 'corner', idx: nearestIdx });
        setCursorImgPt(startPt);
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      } else {
        setDragTarget({ kind: 'drawBox', start: startPt });
        setCursorImgPt(startPt);
        setQuad(makeAxisAlignedQuad(startPt.x, startPt.y, startPt.x + 12, startPt.y + 12));
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }
      return;
    }

    // 4. PASO 2 (DIVISIONES -> VECTORES): permite arrastrar líneas existentes O trazar nuevas (rectas o diagonales)
    if (traceStep === 'lines' && homography) {
      const unitPt = applyHomography(homography.toUnit, rawPt);
      if (unitPt) {
        const uClick = exteriorToInterior(unitPt.x, eMm, xf);
        const vClick = exteriorToInterior(unitPt.y, eMm, yf);
        let bestDist = 0.026;
        let hitLine: DragTarget | null = null;
        for (const d of topology.vDividers) {
          if (vClick >= d.start - 0.02 && vClick <= d.end + 0.02) {
            const dist = Math.abs(d.position - uClick);
            if (dist < bestDist) {
              bestDist = dist;
              hitLine = { kind: 'vDivider', id: d.id };
            }
          }
        }
        for (const s of topology.hShelves) {
          if (uClick >= s.start - 0.02 && uClick <= s.end + 0.02) {
            const dist = Math.abs(s.position - vClick);
            if (dist < bestDist) {
              bestDist = dist;
              hitLine = { kind: 'hShelf', id: s.id };
            }
          }
        }
        if (hitLine) {
          pushUndo();
          setDragTarget(hitLine);
          setCursorImgPt(rawPt);
          (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
          return;
        }
      }

      const startPt = applyMagneticEdge(rawPt);
      setDragTarget({ kind: 'drawVector', start: startPt });
      setCursorImgPt(startPt);
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      return;
    }

    // 5. PASO 3 (ZONAS -> 3D): tocar una celda la selecciona en el Inspector Contextual (o arrastrar líneas)
    if (traceStep === 'zones' && homography) {
      const unitPt = applyHomography(homography.toUnit, rawPt);
      if (!unitPt) return;
      const uClick = exteriorToInterior(unitPt.x, eMm, xf);
      const vClick = exteriorToInterior(unitPt.y, eMm, yf);

      let bestDist = 0.028;
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
        setCursorImgPt(rawPt);
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
        return;
      }

      const zones = topology.frontZones ?? [];
      const hitZone = zones.find(
        (z) =>
          uClick >= z.uStart &&
          uClick <= z.uEnd &&
          vClick >= z.vStart &&
          vClick <= z.vEnd,
      );
      if (hitZone) {
        setSelectedZoneId(hitZone.id);
        setStatusMsg(
          `Zona seleccionada (${ZONE_LABELS[hitZone.kind]}). Elige abajo qué es (Abierto, Puerta, 1 Cajón, Canastos o ✕ Sin mueble) y su color.`,
        );
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rawPt = toCanvasCoords(e);
    if (!dragTarget) {
      // Mostrar lupa 4× y guía en vivo al apuntar las 4 esquinas del contorno
      if (viewTab === 'frontal' && pickingCorners !== null) {
        setCursorImgPt(rawPt);
      }
      return;
    }

    if (dragTarget.kind === 'drawVector') {
      setCursorImgPt(applyMagneticEdge(rawPt));
      return;
    }

    setCursorImgPt(rawPt);

    if (dragTarget.kind === 'drawBox') {
      const cw = frontBitmap?.w ?? 900;
      const ch = frontBitmap?.h ?? 680;
      const snappedEnd = applyMagneticEdge(rawPt);
      setQuad(
        makeAxisAlignedQuad(
          dragTarget.start.x,
          dragTarget.start.y,
          Math.max(2, Math.min(cw - 2, snappedEnd.x)),
          Math.max(2, Math.min(ch - 2, snappedEnd.y)),
        ),
      );
      return;
    }

    if (dragTarget.kind === 'corner') {
      const snappedCorner = applyMagneticEdge(rawPt);
      if (viewTab === 'frontal') {
        if (frameMode === 'box') {
          const cw = frontBitmap?.w ?? 900;
          const ch = frontBitmap?.h ?? 680;
          setQuad((prev) => resizeBoxCorner(prev, dragTarget.idx, snappedCorner, cw, ch));
        } else {
          setQuad((prev) => {
            const copy: [Point2D, Point2D, Point2D, Point2D] = [
              { ...prev[0] },
              { ...prev[1] },
              { ...prev[2] },
              { ...prev[3] },
            ];
            copy[dragTarget.idx] = snappedCorner;
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
          copy[dragTarget.idx] = rawPt;
          return copy;
        });
      }
      return;
    }

    if (!homography) return;
    const unitPt = applyHomography(homography.toUnit, rawPt);
    if (!unitPt) return;

    const eMm = params.boardThickness;
    if (dragTarget.kind === 'vDivider') {
      const nextU = Math.max(
        0.04,
        Math.min(0.96, exteriorToInterior(unitPt.x, eMm, params.targetDimensions.x)),
      );
      const nextDivs = topology.vDividers.map((d) =>
        d.id === dragTarget.id ? { ...d, position: Number(nextU.toFixed(4)) } : d,
      );
      syncTracedVectorsTo3D(nextDivs, topology.hShelves, true);
    } else if (dragTarget.kind === 'hShelf') {
      const nextV = Math.max(
        0.04,
        Math.min(0.96, exteriorToInterior(unitPt.y, eMm, params.targetDimensions.y)),
      );
      const nextShelves = topology.hShelves.map((s) =>
        s.id === dragTarget.id ? { ...s, position: Number(nextV.toFixed(4)) } : s,
      );
      syncTracedVectorsTo3D(topology.vDividers, nextShelves, true);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragTarget) return;
    const finished = dragTarget;
    const endRaw = toCanvasCoords(e);
    setDragTarget(null);
    setCursorImgPt(null);

    if (finished.kind === 'drawBox') {
      const endPt = applyMagneticEdge(endRaw);
      const boxW = Math.abs(endPt.x - finished.start.x);
      const boxH = Math.abs(endPt.y - finished.start.y);
      if (frontBitmap && boxW >= 32 && boxH >= 32) {
        const nextQuad = makeAxisAlignedQuad(finished.start.x, finished.start.y, endPt.x, endPt.y);
        setQuad(nextQuad);
        commitOuterFrame(frontBitmap, nextQuad, {
          resetInternalLines: true,
          applyDims: true,
          advanceToLines: true,
        });
      } else {
        setStatusMsg('Arrastra de esquina a esquina cubriendo toda la cara frontal del mueble.');
      }
      return;
    }

    if (finished.kind === 'drawVector') {
      if (!homography) return;
      const endPt = applyMagneticEdge(endRaw);
      const stroke = vectorizeUserStroke(
        finished.start,
        endPt,
        homography.toUnit,
        topology.vDividers,
        topology.hShelves,
        params.boardThickness,
        params.targetDimensions,
        true,
        strokeMode,
      );
      if (!stroke) {
        setStatusMsg('Trazo demasiado corto. Arrastra una línea recta o diagonal sobre la foto.');
        return;
      }

      pushUndo();
      if (stroke.kind === 'vDivider') {
        const nextV = [...topology.vDividers, stroke.segment];
        syncTracedVectorsTo3D(nextV, topology.hShelves, true);
        setStatusMsg(
          `Vector divisor trazado en X = ${stroke.positionMm} mm (largo ${stroke.spanMm} mm) → 3D actualizado.`,
        );
      } else if (stroke.kind === 'hShelf') {
        const nextH = [...topology.hShelves, stroke.segment];
        syncTracedVectorsTo3D(topology.vDividers, nextH, true);
        setStatusMsg(
          `Vector repisa trazado en Y = ${stroke.positionMm} mm (luz ${stroke.spanMm} mm) → 3D actualizado.`,
        );
      } else {
        const nextDiags = [...(topology.diagonalDividers ?? []), stroke.segment];
        syncTracedVectorsTo3D(topology.vDividers, topology.hShelves, true, nextDiags);
        setStatusMsg(
          `Vector DIAGONAL trazado (${Math.abs(stroke.angleDeg)}° · largo ${stroke.spanMm} mm) → tablero inclinado creado en 3D.`,
        );
      }
      return;
    }

    if (finished.kind === 'corner') {
      if (viewTab === 'frontal' && frontBitmap) {
        commitOuterFrame(frontBitmap, quad, {
          resetInternalLines: false,
          applyDims: false,
          advanceToLines: false,
        });
      } else if (viewTab === 'lateral' && sideBitmap) {
        const ratioZY = estimateAspectRatioFixedFocal(sideQuad, sideBitmap.w, sideBitmap.h, focal35mm);
        const estDepth = Math.max(200, Math.min(800, Math.round(params.targetDimensions.y * ratioZY)));
        onUpdateTopology({ ...topology, viewsMode: 2, aspectRatioZY: ratioZY });
        onSelectDepthMm(estDepth);
        setStatusMsg(`Profundidad Z actualizada desde foto lateral: ${estDepth} mm.`);
      }
      return;
    }

    setStatusMsg('Vector movido y recalculado en 3D.');
  };

  const handleApplySingleMeasure = () => {
    const ext = extrapolateDimensionsFromSingleMeasure(
      estimatedAspectXY,
      knownAxis,
      knownMeasureMm,
      params.targetDimensions.z,
    );
    onApplyCalibratedDims(ext);
    setStatusMsg(`Escala exacta aplicada: ${ext.x} × ${ext.y} × ${ext.z} mm.`);
  };

  const handleApplyCalibA4 = () => {
    if (calibPts.length !== 2 || !homography) return;
    const [p1, p2] = calibPts;
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
      }
    }
  };

  const activeBmp = viewTab === 'frontal' ? frontBitmap : sideBitmap;
  const hasPhoto = Boolean(frontBitmap);
  const zones = topology.frontZones ?? [];
  const diagCount = topology.diagonalDividers?.length ?? 0;
  const internalLineCount = topology.vDividers.length + topology.hShelves.length + diagCount;
  const totalUserVectors = 4 + internalLineCount;
  const canvasCursor =
    dragTarget !== null
      ? 'grabbing'
      : extraTool === 'erase'
        ? 'pointer'
        : pickingCorners !== null || extraTool !== 'none' || traceStep === 'frame' || traceStep === 'lines'
          ? 'crosshair'
          : 'pointer';

  return (
    <div className="vector-card">
      <div className="card-header-row">
        <div>
          <h3>Recalcar Contorno (4 pts) y Divisiones (Rectas + Diagonales) → 3D</h3>
          <p className="muted small-note">
            Toca las 4 esquinas del mueble (sigue perspectiva 3/4) y traza divisiones rectas o diagonales directo al 3D.
          </p>
        </div>
        <div className="chip-row">
          <button
            type="button"
            className="btn-primary"
            onClick={() => fileFrontalInputRef.current?.click()}
          >
            <Camera size={14} /> {hasPhoto ? 'Cambiar foto' : 'Subir foto'}
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
        </div>
      </div>

      {/* BARRA GUIADA DE 3 PASOS PARA RECALCAR MÁRGENES Y VECTORIZAR */}
      {hasPhoto && viewTab === 'frontal' && (
        <div className="trace-stepper">
          <button
            type="button"
            className={
              traceStep === 'frame' && extraTool === 'none'
                ? 'trace-step-btn active'
                : 'trace-step-btn'
            }
            onClick={() => {
              setTraceStep('frame');
              setExtraTool('none');
              setStatusMsg(
                'Paso 1 (Contorno): pulsa "Marcar 4 esquinas" para tocar 1→2→3→4 sobre la foto, o arrastra los círculos numerados.',
              );
            }}
          >
            <Crop size={14} /> <strong>1. Contorno exterior</strong>
          </button>
          <button
            type="button"
            className={
              traceStep === 'lines' && extraTool === 'none'
                ? 'trace-step-btn active'
                : 'trace-step-btn'
            }
            onClick={() => {
              setPickingCorners(null);
              setTraceStep('lines');
              setExtraTool('none');
              setStatusMsg(
                'Paso 2 (Divisiones): arrastra sobre la foto para trazar líneas rectas (siguen perspectiva) o diagonales reales.',
              );
            }}
          >
            <PenTool size={14} /> <strong>2. Divisiones ({internalLineCount})</strong>
          </button>
          <button
            type="button"
            className={
              traceStep === 'zones' && extraTool === 'none'
                ? 'trace-step-btn active'
                : 'trace-step-btn'
            }
            onClick={() => {
              setPickingCorners(null);
              setTraceStep('zones');
              setExtraTool('none');
              setStatusMsg(
                'Paso 3 (Zonas → 3D): toca cualquier recuadro en la foto o usa las etiquetas de abajo para elegir Puerta, Cajones, Vidrio, Abierto o Hueco Piernas.',
              );
            }}
          >
            <LayoutGrid size={14} /> <strong>3. Definir zonas ({zones.length})</strong>
          </button>
        </div>
      )}

      {/* BANNER VISUAL IMPOSIBLE DE PERDER JUSTO ENCIMA DE LA FOTO */}
      {hasPhoto && viewTab === 'frontal' && (
        <div
          className={`canvas-guide-banner ${
            traceStep === 'lines' ? 'step-lines' : traceStep === 'zones' ? 'step-zones' : ''
          }`}
        >
          {traceStep === 'frame' ? (
            <>
              <span className="guide-banner-text">
                <span className="guide-step-pill">
                  {pickingCorners !== null ? `TOQUE ${pickingCorners.length + 1}/4` : 'PASO 1'}
                </span>
                {pickingCorners !== null
                  ? `Toca sobre la foto → ${CORNER_STEP_NAMES[Math.min(3, pickingCorners.length)]} (solo frente de melamina, sin patas/ruedas ni costado 3/4)`
                  : 'Arrastra ① ② ③ ④ sobre el frente de melamina (si es escalonado, proyecta la esquina superior y marca ese bloque como "✕ Sin mueble")'}
              </span>
              <div className="guide-banner-actions">
                <button
                  type="button"
                  className={pickingCorners !== null ? 'guide-btn active' : 'guide-btn'}
                  onClick={() => {
                    setFrameMode('quad');
                    setPickingCorners([]);
                    setExtraTool('none');
                    setStatusMsg(
                      'Toca las 4 esquinas del frente del mueble: 1 Arriba-Izq → 2 Arriba-Der → 3 Abajo-Der → 4 Abajo-Izq.',
                    );
                  }}
                >
                  📍 Marcar 4 esquinas (1→2→3→4)
                </button>
                {pickingCorners !== null ? (
                  <button
                    type="button"
                    className="guide-btn"
                    onClick={() => {
                      setPickingCorners(null);
                      setTraceStep('lines');
                      setStatusMsg(
                        'Contorno sugerido aceptado. Ahora en Paso 2 traza líneas rectas o diagonales sobre la foto.',
                      );
                    }}
                  >
                    ✓ Usar contorno sugerido
                  </button>
                ) : (
                  <button
                    type="button"
                    className="guide-btn"
                    onClick={() => {
                      setTraceStep('lines');
                      setExtraTool('none');
                    }}
                  >
                    Listo → Ir a Paso 2
                  </button>
                )}
              </div>
            </>
          ) : traceStep === 'lines' ? (
            <>
              <span className="guide-banner-text">
                <span className="guide-step-pill">PASO 2</span>
                Arrastra sobre la foto para trazar divisiones (rectas siguen perspectiva · inclinadas = diagonal 3D)
              </span>
              <div className="guide-banner-actions">
                <button
                  type="button"
                  className={strokeMode === 'auto' ? 'guide-btn active' : 'guide-btn'}
                  onClick={() => setStrokeMode('auto')}
                  title="Trazos casi H/V se enderezan en perspectiva; trazos entre 18° y 72° quedan como diagonales reales"
                >
                  Auto (Recta + Diag)
                </button>
                <button
                  type="button"
                  className={strokeMode === 'diagonal' ? 'guide-btn active' : 'guide-btn'}
                  onClick={() => setStrokeMode('diagonal')}
                  title="Conserva cualquier ángulo diagonal libre sin forzar nunca a línea recta"
                >
                  ⟋ Diagonal / Libre
                </button>
                <button
                  type="button"
                  className={strokeMode === 'ortho' ? 'guide-btn active' : 'guide-btn'}
                  onClick={() => setStrokeMode('ortho')}
                  title="Endereza siempre a horizontal o vertical siguiendo la perspectiva del contorno"
                >
                  ┼ Solo Rectas
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="guide-banner-text">
                <span className="guide-step-pill">PASO 3</span>
                Toca cualquier recuadro sobre la foto (o las etiquetas de abajo) para elegir Puerta, Cajón, Vidrio o Abierto
              </span>
              <div className="guide-banner-actions">
                <button
                  type="button"
                  className="guide-btn"
                  onClick={() => setTraceStep('lines')}
                >
                  + Trazar más líneas
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Barra secundaria compacta: Imán + Deshacer + Borrar + Asistente opcional */}
      {hasPhoto && viewTab === 'frontal' && (
        <div className="canvas-toolbar">
          <button
            type="button"
            className={magneticSnap ? 'chip-btn active' : 'chip-btn'}
            onClick={() => setMagneticSnap((v) => !v)}
            title="Imán Sobel: atrae automáticamente tus trazos al borde real de la melamina"
          >
            <Magnet size={12} /> Imán bordes: {magneticSnap ? 'ON' : 'OFF'}
          </button>
          <button
            type="button"
            className={extraTool === 'erase' ? 'chip-btn active' : 'chip-btn'}
            onClick={() => setExtraTool((t) => (t === 'erase' ? 'none' : 'erase'))}
            disabled={internalLineCount === 0}
          >
            <Eraser size={12} /> Borrar línea
          </button>
          <button
            type="button"
            className="chip-btn"
            onClick={handleUndo}
            disabled={undoStack.length === 0}
          >
            <Undo2 size={12} /> Deshacer
          </button>
          <button
            type="button"
            className="chip-btn"
            onClick={handleClearLines}
            disabled={internalLineCount === 0}
          >
            <Trash2 size={12} /> Limpiar
          </button>
          <span className="toolbar-sep" />
          <button
            type="button"
            className="chip-btn"
            onClick={handleAutoSuggestInsideFrame}
            title="Opcional: deja que el software sugiera líneas automáticamente dentro de tu contorno"
          >
            <Wand2 size={12} /> Sugerir líneas auto
          </button>
          <button
            type="button"
            className={frameMode === 'quad' ? 'chip-btn active' : 'chip-btn'}
            onClick={() => handleToggleFrameMode(frameMode === 'box' ? 'quad' : 'box')}
            title="4 esquinas libres (perspectiva) vs recuadro recto"
          >
            {frameMode === 'quad' ? '4 pts libres (3/4)' : 'Marco recto'}
          </button>
          <button
            type="button"
            className={showPrecisionTools ? 'chip-btn active' : 'chip-btn'}
            onClick={() => setShowPrecisionTools((v) => !v)}
          >
            <SlidersHorizontal size={12} /> Más
          </button>
        </div>
      )}

      {/* Herramientas avanzadas colapsables (Vista lateral, A4, Gotero, Capas) */}
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
                  className={visualLayer === 'traced_zones' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setVisualLayer('traced_zones')}
                >
                  Vectores + Zonas
                </button>
                <button
                  type="button"
                  className={visualLayer === 'vectors_only' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setVisualLayer('vectors_only')}
                >
                  <GitBranch size={12} /> Bordes Foto
                </button>
                <button
                  type="button"
                  className={visualLayer === 'photo' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setVisualLayer('photo')}
                >
                  Foto limpia
                </button>
                <button
                  type="button"
                  className={visualLayer === 'edges' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setVisualLayer('edges')}
                >
                  <Contrast size={12} /> Sobel
                </button>
                <span className="toolbar-sep" />
                <button
                  type="button"
                  className={extraTool === 'eyedropper' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setExtraTool((t) => (t === 'eyedropper' ? 'none' : 'eyedropper'))}
                  disabled={!hasPhoto}
                >
                  <Pipette size={12} /> Gotero color
                </button>
                <button
                  type="button"
                  className={extraTool === 'calibA4' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => {
                    setCalibPts([]);
                    setExtraTool((t) => (t === 'calibA4' ? 'none' : 'calibA4'));
                  }}
                  disabled={!hasPhoto}
                >
                  <Ruler size={12} /> Calibrar A4
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => {
                    if (!frontBitmap) return;
                    const aq = autoDetectFurnitureQuad(frontBitmap.rgba, frontBitmap.w, frontBitmap.h);
                    const ext = extractStructuralVectorLines(
                      frontBitmap.rgba,
                      frontBitmap.w,
                      frontBitmap.h,
                      aq.quadCorners,
                    );
                    const q = ext.refinedBox ?? aq.quadCorners;
                    setQuad(q);
                    commitOuterFrame(frontBitmap, q, { applyDims: true, advanceToLines: true });
                  }}
                  disabled={!hasPhoto}
                >
                  <Scan size={12} /> Auto-contorno
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {legHintDetected && !topology.hasExternalLegs && (
        <div className="alert-box warning compact-alert">
          <span>Posibles patas detectadas debajo del mueble.</span>
          <button
            type="button"
            className="btn-small"
            onClick={() => onToggleExternalLegs(true, 150, 4)}
          >
            Activar patas (15 cm)
          </button>
        </div>
      )}

      {/* Lienzo a ANCHO COMPLETO (+35% más grande para calcar con precisión) + Franja compacta de métricas */}
      <div className="canvas-full-layout">
        <div
          className={`${isDragOver ? 'photo-canvas-wrap drag-over' : 'photo-canvas-wrap'}${
            canvasZoom === 2 ? ' zoomed' : ''
          }`}
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
              className={canvasZoom === 2 ? 'photo-canvas zoom-2x' : 'photo-canvas'}
              style={{ cursor: canvasCursor }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={() => {
                if (!dragTarget) setCursorImgPt(null);
              }}
            />
          ) : (
            <div className="photo-dropzone">
              <Upload size={34} />
              <strong>Sube la foto de tu mueble y recalca sus márgenes para un 3D exacto</strong>
              <p className="small-note muted">
                1) Toca las 4 esquinas del cuerpo frontal (sin patas ni ruedas) · 2) Traza divisiones rectas o diagonales · 3) Marca zonas (puertas, cajones, canastos o vacío exterior escalonado).
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
                    <Sparkles size={14} /> Probar con escritorio
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Franja horizontal compacta de Zoom + Métricas en vivo + Vista Rectificada opcional */}
        {hasPhoto && (
          <div className="eval-strip-bar">
            <div className="eval-strip-meters">
              {marginEval && (
                <span className="eval-inline-pill">
                  <span>Contorno</span>
                  <span className="eval-mini-bar">
                    <i
                      className={`eval-bar-fill ${scoreToneClass(marginEval.overallScore)}`}
                      style={{ width: `${marginEval.overallScore}%` }}
                    />
                  </span>
                  <strong className={scoreToneClass(marginEval.overallScore)}>
                    {marginEval.overallScore}%
                  </strong>
                </span>
              )}
              {live3DSimilarity && (
                <span className="eval-inline-pill">
                  <span>3D vs Foto</span>
                  <span className="eval-mini-bar">
                    <i
                      className={`eval-bar-fill ${scoreToneClass(live3DSimilarity.overallScore)}`}
                      style={{ width: `${live3DSimilarity.overallScore}%` }}
                    />
                  </span>
                  <strong className={scoreToneClass(live3DSimilarity.overallScore)}>
                    {live3DSimilarity.overallScore}%
                  </strong>
                </span>
              )}
              <span className="eval-sub mono">
                {totalUserVectors} vec ({topology.vDividers.length}V·{topology.hShelves.length}H
                {diagCount > 0 ? `·${diagCount}D` : ''})
                {cameraPose ? ` · ~${cameraPose.distanceMeters.toFixed(1)}m` : ''}
              </span>
              <div className="vector-legend-mini">
                <span><i style={{ background: '#00e5ff' }} />Contorno</span>
                <span><i style={{ background: '#22c55e' }} />V</span>
                <span><i style={{ background: '#f59e0b' }} />H</span>
                <span><i style={{ background: '#d946ef' }} />Diag</span>
              </div>
            </div>

            <div className="chip-row">
              <button
                type="button"
                className={canvasZoom === 2 ? 'chip-btn active' : 'chip-btn'}
                onClick={() => setCanvasZoom((z) => (z === 1 ? 2 : 1))}
                title="Acercar foto 2× para calcar bordes finos con precisión"
              >
                {canvasZoom === 2 ? <ZoomOut size={12} /> : <ZoomIn size={12} />}
                {canvasZoom === 2 ? 'Zoom 2×' : 'Zoom 1×'}
              </button>
              <button
                type="button"
                className={showRectPreview ? 'chip-btn active' : 'chip-btn'}
                onClick={() => setShowRectPreview((v) => !v)}
              >
                <Eye size={12} /> Rectificado
              </button>
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
          </div>
        )}

        {hasPhoto && showRectPreview && (
          <div className="rect-drawer-box">
            <canvas ref={rectPreviewRef} className="rect-preview-canvas" />
            <div className="eval-sub">
              <strong>Frente rectificado por Homografía H 3×3</strong>
              <br />
              Relación ancho/alto W/H = {estimatedAspectXY.toFixed(2)}
              {live3DSimilarity && (
                <>
                  <br />
                  Silueta {Math.round(live3DSimilarity.silhouetteMatch * 100)}% · Bordes{' '}
                  {Math.round(live3DSimilarity.edgeStructureMatch * 100)}% · Color{' '}
                  {Math.round(live3DSimilarity.colorPaletteMatch * 100)}%
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* INSPECTOR CONTEXTUAL DE ZONAS (1 clic para elegir qué es cada espacio, incluyendo ✕ Sin mueble, Canastos y Bicolor) */}
      {hasPhoto && viewTab === 'frontal' && zones.length > 0 && (() => {
        const activeZone =
          zones.find((z) => z.id === selectedZoneId) ?? zones[0];
        const activeIdx = zones.findIndex((z) => z.id === activeZone.id);
        const zWcm = Math.round(((activeZone.uEnd - activeZone.uStart) * params.targetDimensions.x) / 10);
        const zHcm = Math.round(((activeZone.vEnd - activeZone.vStart) * params.targetDimensions.y) / 10);
        const isClosedFront =
          activeZone.kind === 'door_left' ||
          activeZone.kind === 'door_right' ||
          activeZone.kind === 'door_double' ||
          activeZone.kind === 'door_glass' ||
          activeZone.kind === 'drawers';
        const supportsInternalShelves =
          activeZone.kind === 'open' ||
          activeZone.kind === 'door_left' ||
          activeZone.kind === 'door_right' ||
          activeZone.kind === 'door_double' ||
          activeZone.kind === 'door_glass';

        return (
          <div className="zone-inspector-card">
            <div className="zone-inspector-head">
              <div className="zone-tabs-row">
                <strong>Zonas ({zones.length}):</strong>
                {zones.map((z, idx) => (
                  <button
                    key={z.id}
                    type="button"
                    className={`zone-tab-chip${z.id === activeZone.id ? ' active' : ''}${
                      z.kind === 'void_outside' ? ' is-void' : ''
                    }`}
                    onClick={() => setSelectedZoneId(z.id)}
                  >
                    <i style={{ background: ZONE_COLORS[z.kind].dot }} />
                    Z{idx + 1}:{' '}
                    {z.kind === 'drawers'
                      ? `${z.drawerCount ?? 1} Caj.`
                      : z.kind === 'baskets'
                        ? `${z.basketCount ?? 3} Can.`
                        : ZONE_LABELS[z.kind]}
                  </button>
                ))}
              </div>
              <span className="mono small-note muted">
                Z{activeIdx + 1} ≈ {zWcm} × {zHcm} cm
              </span>
            </div>

            <div className="zone-kind-grid">
              <button
                type="button"
                className={activeZone.kind === 'open' ? 'zone-kind-btn active' : 'zone-kind-btn'}
                onClick={() => handleZoneKindSelect(activeZone.id, 'open')}
              >
                Abierto
              </button>
              <button
                type="button"
                className={activeZone.kind === 'baskets' ? 'zone-kind-btn active' : 'zone-kind-btn'}
                onClick={() => handleZoneKindSelect(activeZone.id, 'baskets', activeZone.basketCount ?? 3)}
              >
                Canastos
              </button>
              <button
                type="button"
                className={activeZone.kind === 'door_left' ? 'zone-kind-btn active' : 'zone-kind-btn'}
                onClick={() => handleZoneKindSelect(activeZone.id, 'door_left')}
              >
                Puerta Izq
              </button>
              <button
                type="button"
                className={activeZone.kind === 'door_right' ? 'zone-kind-btn active' : 'zone-kind-btn'}
                onClick={() => handleZoneKindSelect(activeZone.id, 'door_right')}
              >
                Puerta Der
              </button>
              <button
                type="button"
                className={activeZone.kind === 'door_double' ? 'zone-kind-btn active' : 'zone-kind-btn'}
                onClick={() => handleZoneKindSelect(activeZone.id, 'door_double')}
              >
                2 Puertas
              </button>
              <button
                type="button"
                className={activeZone.kind === 'door_glass' ? 'zone-kind-btn active' : 'zone-kind-btn'}
                onClick={() => handleZoneKindSelect(activeZone.id, 'door_glass')}
              >
                Vidrio
              </button>
              <button
                type="button"
                className={
                  activeZone.kind === 'drawers' && (activeZone.drawerCount ?? 1) === 1
                    ? 'zone-kind-btn active'
                    : 'zone-kind-btn'
                }
                onClick={() => handleZoneKindSelect(activeZone.id, 'drawers', 1)}
              >
                1 Cajón
              </button>
              <button
                type="button"
                className={
                  activeZone.kind === 'drawers' && (activeZone.drawerCount ?? 1) > 1
                    ? 'zone-kind-btn active'
                    : 'zone-kind-btn'
                }
                onClick={() =>
                  handleZoneKindSelect(
                    activeZone.id,
                    'drawers',
                    (activeZone.drawerCount ?? 1) > 1 ? activeZone.drawerCount : 3,
                  )
                }
              >
                Cajonera
              </button>
              <button
                type="button"
                className={activeZone.kind === 'leg_void' ? 'zone-kind-btn active' : 'zone-kind-btn'}
                onClick={() => handleZoneKindSelect(activeZone.id, 'leg_void')}
              >
                Hueco Piernas
              </button>
              <button
                type="button"
                className={
                  activeZone.kind === 'void_outside'
                    ? 'zone-kind-btn void-btn active'
                    : 'zone-kind-btn void-btn'
                }
                onClick={() => handleZoneKindSelect(activeZone.id, 'void_outside')}
                title="Este espacio está fuera del mueble (recorta cubierta, lateral y fondo en muebles escalonados)"
              >
                ✕ Sin mueble (Vacío)
              </button>
            </div>

            <div className="zone-sub-row">
              {activeZone.kind === 'drawers' && (
                <div className="chip-row">
                  <span>Cantidad cajones:</span>
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={(activeZone.drawerCount ?? 1) === n ? 'chip-btn active' : 'chip-btn'}
                      onClick={() => handleZoneDrawerCount(activeZone.id, n)}
                    >
                      ×{n}
                    </button>
                  ))}
                </div>
              )}

              {activeZone.kind === 'baskets' && (
                <div className="chip-row">
                  <span>Canastos extraíbles:</span>
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={(activeZone.basketCount ?? 3) === n ? 'chip-btn active' : 'chip-btn'}
                      onClick={() => handleZoneBasketCount(activeZone.id, n)}
                    >
                      ×{n}
                    </button>
                  ))}
                </div>
              )}

              {supportsInternalShelves && (
                <div className="chip-row">
                  <span>Repisas internas:</span>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={(activeZone.internalShelves ?? 0) === n ? 'chip-btn active' : 'chip-btn'}
                      onClick={() => handleZoneInternalShelves(activeZone.id, n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}

              {isClosedFront && (
                <div className="chip-row">
                  <span>Color frente:</span>
                  <button
                    type="button"
                    className={!activeZone.materialOverride ? 'chip-btn active' : 'chip-btn'}
                    onClick={() => handleZoneMaterialOverride(activeZone.id, 'same')}
                  >
                    Carcasa
                  </button>
                  {(['blanco', 'roble', 'grafito'] as MelamineMaterial[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={
                        activeZone.materialOverride === m
                          ? 'chip-btn swatch-btn active'
                          : 'chip-btn swatch-btn'
                      }
                      onClick={() => handleZoneMaterialOverride(activeZone.id, m)}
                    >
                      <i className={`swatch-dot swatch-${m}`} />
                      {m === 'blanco' ? 'Blanco' : m === 'roble' ? 'Roble' : 'Grafito'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <p className="status-line">{statusMsg}</p>

      {/* Calibración exacta por 1 medida real */}
      {viewTab === 'frontal' && hasPhoto && (
        <div className="calib-box">
          <strong>Medida exacta de tu mueble:</strong>
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
            Aplicar escala exacta
          </button>

          {extraTool === 'calibA4' && (
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
