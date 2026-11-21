/**
 * SMARTFURNITURE — VECTORCANVAS v4.0
 * - Encuadre Rápido 1-Drag (Rectángulo frontal limpio) por defecto en vez de forzar 4 esquinas sueltas;
 *   modo Perspectiva 4 pts (Homografía H 3×3) disponible a 1 clic para fotos con inclinación fuerte.
 * - Detector Híbrido v4.0: fondo exterior aislado (respetando huecos de piernas en escritorios),
 *   clasificación automática de zonas (Abierto / Puerta / Cajones 5 pzas / Hueco Piernas / Bicolor)
 *   y estimación automática de acabado de melamina (Blanco / Roble / Grafito).
 * - Edición directa sin calcar líneas: toca cualquier zona en la foto (capa "Zonas") para alternar
 *   su tipo de módulo (Abierto → Puerta → Doble → Cajones → Hueco Piernas) al instante.
 * - Carga directa de fotos reales del Catálogo QA (14 muebles) y fotos propias del usuario 100% offline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Contrast,
  Crop,
  Eraser,
  LayoutGrid,
  Move,
  Pipette,
  Ruler,
  Scan,
  ScanSearch,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import type {
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
  analyzeRectifiedFurniture,
  autoDetectFurnitureQuad,
  computeRectifiedSize,
  computeSobelEdgeOverlayRGBA,
  detectLowerGapHint,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  extrapolateDimensionsFromSingleMeasure,
  rectifyImageRGBA,
  type DetectedCavity,
} from '../../core/vision';
import { NumericInput } from '../NumericInput';

interface VectorCanvasProps {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
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

type VisualLayerMode = 'photo' | 'zones' | 'edges';

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
const MAX_WORK_DIM = 1600;

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

const ZONE_COLORS: Record<FrontModuleKind, { fill: string; stroke: string }> = {
  open: { fill: 'rgba(14, 165, 233, 0.20)', stroke: '#38bdf8' },
  door_left: { fill: 'rgba(250, 204, 21, 0.24)', stroke: '#facc15' },
  door_right: { fill: 'rgba(250, 204, 21, 0.24)', stroke: '#facc15' },
  door_double: { fill: 'rgba(245, 158, 11, 0.24)', stroke: '#f59e0b' },
  door_glass: { fill: 'rgba(125, 211, 252, 0.28)', stroke: '#7dd3fc' },
  drawers: { fill: 'rgba(249, 115, 22, 0.25)', stroke: '#fb923c' },
  leg_void: { fill: 'rgba(168, 85, 247, 0.24)', stroke: '#c084fc' },
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

function makeAxisAlignedQuad(x0: number, y0: number, x1: number, y1: number): [Point2D, Point2D, Point2D, Point2D] {
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

function quadToBoundingBox(q: readonly [Point2D, Point2D, Point2D, Point2D]): [Point2D, Point2D, Point2D, Point2D] {
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
    if (Math.abs(val - a) <= SNAP_TOL) {
      return a;
    }
  }
  return val;
}

function estimateInitialProportionalDims(
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

  const quad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: 165, y: 120 },
    { x: 735, y: 120 },
    { x: 735, y: 540 },
    { x: 165, y: 540 },
  ];

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

    // Escritorio roble con hueco de piernas a la izquierda + cajonera suspendida derecha (2 cajones)
    mapRect(0, 1 - eV, 1, 1, woodCol); // Cubierta
    mapRect(0, 0, eU, 1, woodCol); // Lateral izq
    mapRect(1 - eU, 0, 1, 1, woodCol); // Lateral der
    // Cajonera derecha suspendida (u = 0.64..1, v = 0.50..1)
    mapRect(0.64, 0.50, 1 - eU, 1 - eV, '#c79663');
    mapRect(0.64 - 0.008, 0.50, 0.64 + 0.008, 1 - eV, seamCol);
    mapRect(0.64, 0.50 - 0.01, 1 - eU, 0.50 + 0.01, seamCol);
    mapRect(0.64, 0.74 - 0.008, 1 - eU, 0.74 + 0.008, seamCol); // Ranura entre 2 cajones
    // Tiradores metálicos
    mapRect(0.79, 0.85, 0.85, 0.87, '#1e293b');
    mapRect(0.79, 0.61, 0.85, 0.63, '#1e293b');
  }

  return c.toDataURL('image/png');
}

export function VectorCanvas({
  topology,
  params,
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
  const [showProtocol, setShowProtocol] = useState(false);
  const [visualLayer, setVisualLayer] = useState<VisualLayerMode>('zones');
  const [isDragOver, setIsDragOver] = useState(false);

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [frontBitmap, setFrontBitmap] = useState<WorkingBitmap | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 900, h: 680 });
  const [exteriorBgRgb, setExteriorBgRgb] = useState<[number, number, number] | undefined>(undefined);

  const [sideImgUrl, setSideImgUrl] = useState<string | null>(null);
  const [sideBitmap, setSideBitmap] = useState<WorkingBitmap | null>(null);
  const [sideQuad, setSideQuad] = useState<[Point2D, Point2D, Point2D, Point2D]>([
    { x: 180, y: 100 },
    { x: 460, y: 100 },
    { x: 470, y: 520 },
    { x: 170, y: 520 },
  ]);

  const [quad, setQuad] = useState<[Point2D, Point2D, Point2D, Point2D]>(
    topology.quadCorners ?? [
      { x: 165, y: 120 },
      { x: 735, y: 120 },
      { x: 735, y: 540 },
      { x: 165, y: 540 },
    ],
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
    'Sube una foto o elige un mueble del Catálogo QA arriba. Usa "Encuadrar (1 arrastre)" para marcar el frente rápido y toca cada zona para cambiar entre Abierto / Puerta / Cajones / Hueco Piernas.',
  );
  const [legHintDetected, setLegHintDetected] = useState<boolean>(false);
  const [detectedModeLabel, setDetectedModeLabel] = useState<string>('');
  const [detectedCavities, setDetectedCavities] = useState<DetectedCavity[]>([]);
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
    setDetectedCavities([]);
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
    setStatusMsg('Líneas internas limpiadas. Puedes pulsar "Re-analizar" o editar en Ajuste preciso.');
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

  // Carga automática de foto real cuando se elige un mueble del Catálogo QA (SIN sobrescribir su topología curada)
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
      setExteriorBgRgb(autoQ.exteriorBgRgb);
      setQuad(autoQ.quadCorners);
      setFrameMode('box');
      setDetectedCavities([]);
      setDetectedHandlesPts([]);
      setDetectedModeLabel('Catálogo QA');
      setStatusMsg(
        `Foto real cargada (${externalPhotoLabel ?? 'Catálogo QA'}). Arrastra el recuadro o pulsa "Re-analizar" para probar la visión en vivo, o haz clic en cualquier zona para editarla.`,
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

  const executeAnalysisPipeline = (
    bmp: WorkingBitmap,
    targetQuad: [Point2D, Point2D, Point2D, Point2D],
    opts: {
      seedPoint?: { u: number; v: number };
      bgRgb?: [number, number, number];
      applyProportionalDims?: boolean;
      recordUndo?: boolean;
      autoQuadNote?: string;
    } = {},
  ) => {
    const hom = computeQuadToUnitHomography(targetQuad);
    if (!bmp || bmp.w === 0 || !hom) {
      setStatusMsg('Marco inválido o cruzado. Usa "Encuadrar (1 arrastre)" o separa las esquinas.');
      return;
    }

    if (opts.recordUndo) {
      pushUndo();
    }

    const estRatio = estimateAspectRatioFixedFocal(targetQuad, bmp.w, bmp.h, focal35mm);
    const safeRatio = Math.max(0.25, Math.min(4, estRatio));

    let effX = params.targetDimensions.x;
    let effY = params.targetDimensions.y;

    if (opts.applyProportionalDims) {
      const autoDims = estimateInitialProportionalDims(safeRatio, params.targetDimensions.z);
      effX = autoDims.x;
      effY = autoDims.y;
    } else {
      const currentRatio = params.targetDimensions.x / Math.max(1, params.targetDimensions.y);
      const ratioMismatch = Math.abs(currentRatio - safeRatio) / safeRatio > 0.15;
      if (ratioMismatch) {
        effX = Math.min(1800, Math.max(800, params.targetDimensions.x));
        effY = Math.max(400, Math.min(2200, Math.round(effX / safeRatio)));
      }
    }

    const pose = estimateCameraPoseMeters(
      targetQuad,
      bmp.w,
      bmp.h,
      'x',
      effX,
      focal35mm,
    );

    const { width: dstW, height: dstH } = computeRectifiedSize(effX, effY, params.boardThickness);
    const rectRgba = rectifyImageRGBA(
      bmp.rgba,
      bmp.w,
      bmp.h,
      hom.toCanvas,
      dstW,
      dstH,
    );

    const det = analyzeRectifiedFurniture(
      rectRgba,
      dstW,
      dstH,
      { x: effX, y: effY },
      params.boardThickness,
      {
        seedPoint: opts.seedPoint,
        parallaxAware: true,
        horizonV: pose?.estimatedHorizonV ?? 0.5,
        exteriorBgRgb: opts.bgRgb ?? exteriorBgRgb,
      },
    );

    if (opts.applyProportionalDims) {
      onAutoPhotoReconstructed(
        { x: effX, y: effY, z: Math.max(300, Math.min(700, params.targetDimensions.z)) },
        det.detectedMaterial,
      );
    }

    const legsHint = detectLowerGapHint(bmp.rgba, bmp.w, bmp.h, targetQuad);
    setLegHintDetected(legsHint.possibleExternalLegs);
    setDetectedCavities(det.cavities);

    const manualHardware = (topology.hardwareItems ?? []).filter((h) => h.origen !== 'detectado');
    const nextHardware = [...manualHardware];
    const projectedHandles: Point2D[] = [];

    if (det.detectedHandles.length > 0) {
      for (const hPt of det.detectedHandles) {
        const mapped = applyHomography(hom.toCanvas, { x: hPt.u, y: hPt.v });
        if (mapped) projectedHandles.push(mapped);
      }
      nextHardware.push({
        id: 'hw_tiradores_auto',
        categoria: 'tiradores',
        descripcion: `Tiradores / manillas detectados en frente (${det.detectedHandles.length} u.)`,
        cantidad: det.detectedHandles.length,
        notaCompra: `Detectados automáticamente. Adquirir ${det.detectedHandles.length} tiradores aparte (no son melamina).`,
        origen: 'detectado',
      });
    }
    setDetectedHandlesPts(projectedHandles);

    const modeText =
      det.furnitureMode === 'hybrid'
        ? 'Híbrido (Abierto + Cerrado)'
        : det.furnitureMode === 'closed_front'
          ? 'Mueble Cerrado'
          : det.furnitureMode === 'open'
            ? 'Estructura Abierta'
            : 'Baja Confianza';
    setDetectedModeLabel(modeText);

    const hasLegVoid = det.inferredZones.some((z) => z.kind === 'leg_void');

    onUpdateTopology({
      ...topology,
      aspectRatioXY: estRatio,
      quadCorners: targetQuad,
      homographyMatrix: hom.toUnit.map((r) => [...r]),
      shelfMode: 'custom',
      vDividers: det.vDividers,
      hShelves: det.hShelves,
      frontZones: det.inferredZones,
      hasBackPanel: hasLegVoid ? false : topology.hasBackPanel,
      hardwareItems: nextHardware,
      detectionSource: 'auto',
      detectionConfidence: det.confidence,
    });

    const prefix = opts.autoQuadNote ? `${opts.autoQuadNote} ` : '';
    const zoneSummary = `${det.inferredZones.length} zona(s)`;
    if (det.confidence < 0.5) {
      setStatusMsg(
        `${prefix}Confianza baja (${Math.round(det.confidence * 100)}%). Usa "Encuadrar (1 arrastre)" sobre el frente del mueble o toca cada zona en la foto para definir Puerta / Cajones / Abierto.`,
      );
    } else {
      const matLabel =
        det.detectedMaterial === 'roble'
          ? 'Roble'
          : det.detectedMaterial === 'grafito'
            ? 'Grafito'
            : 'Blanco';
      setStatusMsg(
        `${prefix}[${modeText} · ${matLabel}] ${det.vDividers.length} div., ${det.hShelves.length} rep. y ${zoneSummary} (${Math.round(det.confidence * 100)}% conf.). Toca cualquier zona en la foto para cambiar su tipo (Abierto/Puerta/Cajones/Hueco).`,
      );
    }
  };

  const loadFrontalFromUrl = (url: string, isSample = false) => {
    lastExternalUrlRef.current = null;
    const img = new Image();
    img.onload = () => {
      const bmp = prepareWorkingBitmap(img);
      setImgUrl(url);
      setFrontBitmap(bmp);
      setImgSize({ w: bmp.w, h: bmp.h });
      setShowProtocol(false);
      setViewTab('frontal');
      setFrameMode('box');
      setCalibPts([]);
      setTool('corners');

      let initialQuad: [Point2D, Point2D, Point2D, Point2D];
      let bgRgb: [number, number, number] | undefined;
      let autoNote = '';

      if (isSample) {
        initialQuad = makeAxisAlignedQuad(165, 120, 735, 540);
        bgRgb = [232, 238, 244];
        autoNote = 'Escritorio de muestra analizado.';
      } else {
        const autoQ = autoDetectFurnitureQuad(bmp.rgba, bmp.w, bmp.h);
        initialQuad = autoQ.quadCorners;
        bgRgb = autoQ.exteriorBgRgb;
        autoNote = autoQ.usedFallback
          ? 'Fondo complejo (arrastra "Encuadrar" sobre la cara frontal).'
          : `Frente aislado (${Math.round(autoQ.backgroundCoverage * 100)}% fondo).`;
      }

      setExteriorBgRgb(bgRgb);
      setQuad(initialQuad);
      executeAnalysisPipeline(bmp, initialQuad, {
        bgRgb,
        applyProportionalDims: true,
        recordUndo: false,
        autoQuadNote: autoNote,
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

  const handleFullReanalyze = () => {
    if (!frontBitmap || frontBitmap.w === 0) return;
    executeAnalysisPipeline(frontBitmap, quad, {
      applyProportionalDims: false,
      recordUndo: true,
    });
  };

  const handleAutoQuad = () => {
    if (!frontBitmap || frontBitmap.w === 0) return;
    const autoQ = autoDetectFurnitureQuad(frontBitmap.rgba, frontBitmap.w, frontBitmap.h);
    setExteriorBgRgb(autoQ.exteriorBgRgb);
    setQuad(autoQ.quadCorners);
    setFrameMode('box');
    setTool('corners');
    executeAnalysisPipeline(frontBitmap, autoQ.quadCorners, {
      bgRgb: autoQ.exteriorBgRgb,
      applyProportionalDims: true,
      recordUndo: true,
      autoQuadNote: autoQ.usedFallback
        ? 'Marco base restablecido.'
        : `Auto-encuadre recalculado (fondo ${Math.round(autoQ.backgroundCoverage * 100)}%).`,
    });
  };

  const handleToggleFrameMode = (nextMode: FrameMode) => {
    setFrameMode(nextMode);
    if (nextMode === 'box') {
      setQuad((prev) => quadToBoundingBox(prev));
      setStatusMsg(
        'Modo Recuadro Frontal (rectángulo recto): arrastra cualquier esquina o usa "Encuadrar (1 arrastre)" sin deformar el trapecio.',
      );
    } else {
      setStatusMsg(
        'Modo Perspectiva 4 pts (Homografía H 3×3): ajusta las 4 esquinas TL/TR/BR/BL libremente para corregir inclinaciones.',
      );
    }
  };

  // Render de miniatura rectificada
  useEffect(() => {
    const previewCanvas = rectPreviewRef.current;
    if (!previewCanvas || !frontBitmap || frontBitmap.w === 0 || !homography) return;

    const previewW = dragTarget?.kind === 'corner' || dragTarget?.kind === 'drawBox' ? 180 : 300;
    const previewH = Math.max(
      100,
      Math.min(320, Math.round(previewW / Math.max(0.25, estimatedAspectXY))),
    );
    previewCanvas.width = previewW;
    previewCanvas.height = previewH;

    const rectRgba = rectifyImageRGBA(
      frontBitmap.rgba,
      frontBitmap.w,
      frontBitmap.h,
      homography.toCanvas,
      previewW,
      previewH,
    );
    const ctx = previewCanvas.getContext('2d');
    if (ctx) {
      const imgData = new ImageData(new Uint8ClampedArray(rectRgba), previewW, previewH);
      ctx.putImageData(imgData, 0, 0);
    }
  }, [frontBitmap, quad, homography, estimatedAspectXY, dragTarget]);

  // Dibujo del lienzo principal
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

    // Sombra suave fuera del recuadro para resaltar el frente seleccionado
    if (viewTab === 'frontal' && visualLayer !== 'edges') {
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
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

    // Contorno del marco frontal
    ctx.strokeStyle = frameMode === 'box' ? '#38bdf8' : '#00e5ff';
    ctx.lineWidth = Math.max(2.2, cw / 340);
    ctx.beginPath();
    activeQuad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    if (viewTab === 'frontal' && homography) {
      const { toCanvas } = homography;
      const e = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      // Capa de Zonas Funcionales interactivas (clic para ciclar Abierto / Puerta / Cajones / Hueco)
      const zones = topology.frontZones ?? [];
      if (visualLayer === 'zones' && zones.length > 0) {
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
            ctx.lineWidth = Math.max(1.5, cw / 480);
            ctx.stroke();

            const center = applyHomography(toCanvas, { x: (u0 + u1) / 2, y: (v0 + v1) / 2 });
            if (center) {
              const tagText =
                z.kind === 'drawers'
                  ? `${z.drawerCount ?? 2} Caj.`
                  : ZONE_LABELS[z.kind];
              const fontPx = Math.max(11, Math.min(18, Math.round(cw / 62)));
              ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
              const tw = ctx.measureText(tagText).width;
              ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
              ctx.fillRect(center.x - tw / 2 - 5, center.y - fontPx * 0.7, tw + 10, fontPx * 1.4);
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, center.x, center.y);
            }
          }
        }
      } else if (visualLayer === 'zones' && detectedCavities.length > 0) {
        detectedCavities.forEach((cav, idx) => {
          const u0 = interiorToExterior(cav.u0, e, xf);
          const u1 = interiorToExterior(cav.u1, e, xf);
          const v0 = interiorToExterior(cav.v0, e, yf);
          const v1 = interiorToExterior(cav.v1, e, yf);
          const pTL = applyHomography(toCanvas, { x: u0, y: v1 });
          const pTR = applyHomography(toCanvas, { x: u1, y: v1 });
          const pBR = applyHomography(toCanvas, { x: u1, y: v0 });
          const pBL = applyHomography(toCanvas, { x: u0, y: v0 });
          if (pTL && pTR && pBR && pBL) {
            ctx.beginPath();
            ctx.moveTo(pTL.x, pTL.y);
            ctx.lineTo(pTR.x, pTR.y);
            ctx.lineTo(pBR.x, pBR.y);
            ctx.lineTo(pBL.x, pBL.y);
            ctx.closePath();
            ctx.fillStyle =
              cav.kind === 'knee_space'
                ? 'rgba(168, 85, 247, 0.24)'
                : 'rgba(14, 165, 233, 0.20)';
            ctx.fill();
            ctx.strokeStyle = cav.kind === 'knee_space' ? '#c084fc' : '#38bdf8';
            ctx.lineWidth = Math.max(1.5, cw / 500);
            ctx.stroke();

            const center = applyHomography(toCanvas, { x: (u0 + u1) / 2, y: (v0 + v1) / 2 });
            if (center) {
              ctx.fillStyle = '#ffffff';
              ctx.font = `bold ${Math.max(11, Math.round(cw / 65))}px system-ui, sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(
                cav.kind === 'knee_space' ? 'Hueco' : `Z${idx + 1}`,
                center.x,
                center.y,
              );
            }
          }
        });
      }

      // Divisores verticales
      for (const div of topology.vDividers) {
        const isActive = dragTarget?.kind === 'vDivider' && dragTarget.id === div.id;
        ctx.strokeStyle = isActive ? '#38bdf8' : '#22c55e';
        ctx.lineWidth = Math.max(isActive ? 5 : 3, cw / (isActive ? 210 : 280));
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

      // Repisas horizontales
      for (const sh of topology.hShelves) {
        const isActive = dragTarget?.kind === 'hShelf' && dragTarget.id === sh.id;
        ctx.strokeStyle = isActive ? '#38bdf8' : '#f59e0b';
        ctx.lineWidth = Math.max(isActive ? 5 : 3, cw / (isActive ? 210 : 280));
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

      // Segmento de calibración A4
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

      // Vista previa al arrastrar nueva repisa
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

      // Marcadores de tiradores auto-detectados
      const hwR = Math.max(6, cw / 120);
      for (const hm of detectedHandlesPts) {
        ctx.fillStyle = '#a855f7';
        ctx.beginPath();
        ctx.arc(hm.x, hm.y, hwR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Manijas del marco: cuadradas limpias en modo 'box', circulares TL/TR/BR/BL en modo 'quad'
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
    detectedCavities,
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

    // Herramienta 1-Drag para dibujar el recuadro frontal completo en un solo gesto
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

          // Clic directo en una zona frontal (capa "Zonas"): ciclar tipo en 1 clic sin calcar líneas
          const zones = topology.frontZones ?? [];
          if (visualLayer === 'zones' && zones.length > 0) {
            const hitZone = zones.find(
              (z) =>
                uClick >= z.uStart &&
                uClick <= z.uEnd &&
                vClick >= z.vStart &&
                vClick <= z.vEnd,
            );
            if (hitZone) {
              pushUndo();
              const curIdx = ZONE_CYCLE.indexOf(hitZone.kind);
              const nextKind = ZONE_CYCLE[(curIdx + 1) % ZONE_CYCLE.length];
              const nextZones = zones.map((z) =>
                z.id === hitZone.id
                  ? {
                      ...z,
                      kind: nextKind,
                      drawerCount: nextKind === 'drawers' ? (z.drawerCount ?? 2) : undefined,
                      label: ZONE_LABELS[nextKind],
                    }
                  : z,
              );
              onUpdateFrontZones(nextZones);
              setStatusMsg(
                `Zona cambiada a "${ZONE_LABELS[nextKind]}" y sincronizada en 3D (clic nuevamente para alternar).`,
              );
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
      executeAnalysisPipeline(frontBitmap, quad, {
        seedPoint: {
          u: Math.max(0, Math.min(1, unitPt.x)),
          v: Math.max(0, Math.min(1, unitPt.y)),
        },
        applyProportionalDims: false,
        recordUndo: true,
        autoQuadNote: 'Color de melamina muestreado por gotero.',
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
        setStatusMsg(`Divisor vertical agregado en u = ${(uInt * 100).toFixed(1)}%.`);
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
        setStatusMsg('Divisor vertical eliminado (Ctrl+Z para deshacer).');
      } else if (targetKind === 'shelf') {
        pushUndo();
        onUpdateTopology({
          ...topology,
          hShelves: topology.hShelves.filter((s) => s.id !== targetId),
        });
        setStatusMsg('Repisa horizontal eliminada (Ctrl+Z para deshacer).');
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toCanvasCoords(e);

    if (!dragTarget) {
      if (draftLineStart !== null) {
        setCursorImgPt(pt);
      }
      return;
    }

    setCursorImgPt(pt);

    if (dragTarget.kind === 'drawBox') {
      const cw = frontBitmap?.w ?? 900;
      const ch = frontBitmap?.h ?? 680;
      const cx = Math.max(2, Math.min(cw - 2, pt.x));
      const cy = Math.max(2, Math.min(ch - 2, pt.y));
      setQuad(makeAxisAlignedQuad(dragTarget.start.x, dragTarget.start.y, cx, cy));
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
          executeAnalysisPipeline(frontBitmap, nextQuad, {
            applyProportionalDims: true,
            recordUndo: true,
            autoQuadNote: 'Frente encuadrado:',
          });
        } else {
          setStatusMsg('Arrastra de esquina a esquina sobre la cara frontal del mueble (mín. 30 px).');
        }
        return;
      }

      if (finished.kind === 'corner') {
        if (viewTab === 'frontal' && frontBitmap && homography) {
          executeAnalysisPipeline(frontBitmap, quad, {
            applyProportionalDims: false,
            recordUndo: false,
            autoQuadNote: frameMode === 'box' ? 'Recuadro ajustado:' : 'Perspectiva afinada:',
          });
        } else if (viewTab === 'lateral' && sideBitmap) {
          const ratioZY = estimateAspectRatioFixedFocal(sideQuad, sideBitmap.w, sideBitmap.h, focal35mm);
          const estDepth = Math.max(200, Math.min(800, Math.round(params.targetDimensions.y * ratioZY)));
          onUpdateTopology({ ...topology, viewsMode: 2, aspectRatioZY: ratioZY });
          onSelectDepthMm(estDepth);
          setStatusMsg(`Profundidad Z actualizada desde Vista Lateral ZY: ${estDepth} mm.`);
        }
      } else {
        setStatusMsg('Posición ajustada y sincronizada en 3D (Ctrl+Z para deshacer).');
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
        setStatusMsg(
          `Repisa agregada en v = ${(vMid * 100).toFixed(1)}% sobre vano [${(uStart * 100).toFixed(0)}%, ${(uEnd * 100).toFixed(0)}%].`,
        );
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
    setStatusMsg(
      `Escala calibrada (${knownAxis === 'x' ? 'Ancho' : 'Alto'} = ${knownMeasureMm} mm): Cuerpo V₀ = V_f = (${ext.x} × ${ext.y} × ${ext.z}) mm.`,
    );
  };

  const handleApplyCalibA4 = () => {
    if (calibPts.length !== 2) return;
    const [p1, p2] = calibPts;
    let yCal: number;
    let xCal: number;

    if (homography) {
      const u1 = applyHomography(homography.toUnit, p1);
      const u2 = applyHomography(homography.toUnit, p2);
      if (u1 && u2) {
        const dRect = Math.hypot((u2.x - u1.x) * estimatedAspectXY, u2.y - u1.y);
        if (dRect > 1e-4) {
          yCal = calibRefMm / dRect;
          xCal = yCal * estimatedAspectXY;
          const dims = { x: Math.round(xCal), y: Math.round(yCal), z: params.targetDimensions.z };
          onApplyCalibratedDims(dims);
          setStatusMsg(`Calibración A4 aplicada: ${dims.x} × ${dims.y} × ${dims.z} mm.`);
          return;
        }
      }
    }
    const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const bodyH = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
    if (pxDist > 1) {
      yCal = (bodyH / pxDist) * calibRefMm;
      xCal = yCal * estimatedAspectXY;
      const dims = { x: Math.round(xCal), y: Math.round(yCal), z: params.targetDimensions.z };
      onApplyCalibratedDims(dims);
      setStatusMsg(`Calibración aplicada: ${dims.x} × ${dims.y} × ${dims.z} mm.`);
    }
  };

  const conf = topology.detectionConfidence;
  const confClass =
    conf === undefined ? '' : conf >= 0.7 ? 'conf-high' : conf >= 0.5 ? 'conf-mid' : 'conf-low';
  const activeBmp = viewTab === 'frontal' ? frontBitmap : sideBitmap;
  const hasPhoto = Boolean(frontBitmap);
  const zonesCount = (topology.frontZones ?? []).length;
  const canvasCursor =
    dragTarget !== null
      ? 'grabbing'
      : tool === 'drawBox'
        ? 'crosshair'
        : tool === 'corners' || viewTab === 'lateral'
          ? visualLayer === 'zones'
            ? 'pointer'
            : 'grab'
          : tool === 'erase'
            ? 'pointer'
            : 'crosshair';

  return (
    <div className="vector-card">
      <div className="card-header-row">
        <h3>Visión Híbrida v4.0 — Foto Frontal → Zonas → 3D</h3>
        <div className="chip-row">
          {hasPhoto && viewTab === 'frontal' && (
            <button
              type="button"
              className={frameMode === 'quad' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => handleToggleFrameMode(frameMode === 'box' ? 'quad' : 'box')}
              title="Alterna entre Recuadro Frontal recto (fácil para la mayoría de fotos) y Homografía 4 esquinas libres (fotos inclinadas)"
            >
              {frameMode === 'quad' ? 'Perspectiva 4 pts (H 3×3)' : 'Recuadro Frontal'}
            </button>
          )}
          <button
            type="button"
            className={showPrecisionTools ? 'chip-btn active' : 'chip-btn'}
            onClick={() => setShowPrecisionTools((v) => !v)}
            title="Mostrar u ocultar herramientas de calibración A4, gotero, trazos manuales y vista lateral ZY"
          >
            <SlidersHorizontal size={12} /> Ajuste preciso
          </button>
          <button
            type="button"
            className={showProtocol ? 'chip-btn active' : 'chip-btn'}
            onClick={() => setShowProtocol((s) => !s)}
          >
            Protocolo
          </button>
        </div>
      </div>

      {showProtocol && (
        <div className="protocol-box">
          <strong>Foto Frontal Ideal (100 % Offline):</strong> Encuadra solo la{' '}
          <strong>cara frontal</strong> del mueble (sin incluir el costado en fotos 3/4) con{' '}
          <strong>"Encuadrar (1 arrastre)"</strong>. Si la foto tiene perspectiva inclinada, activa{' '}
          <strong>Perspectiva 4 pts (H 3×3)</strong>. Luego haz clic sobre cualquier zona coloreada
          para cambiar entre <em>Abierto, Puerta, 2 Puertas, Cajones (5 pzas), Vidrio o Hueco Piernas</em>.
        </div>
      )}

      {/* Barra primaria simplificada */}
      <div className="canvas-toolbar">
        <button
          type="button"
          className="btn-primary"
          onClick={() => fileFrontalInputRef.current?.click()}
        >
          <Camera size={14} /> {hasPhoto ? 'Subir otra foto' : 'Subir foto'}
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
                setStatusMsg(
                  'Arrastra un rectángulo sobre la cara frontal del mueble (en fotos 3/4 excluye el costado y TV/pared).',
                );
              }}
              title="Dibuja el recuadro del frente del mueble en 1 solo arrastre (reemplaza acomodar 4 puntos uno por uno)"
            >
              <Crop size={14} /> Encuadrar (1 arrastre)
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleFullReanalyze}
              disabled={!homography}
              title="Re-analizar estructura, puertas, cajones y color dentro del recuadro actual"
            >
              <ScanSearch size={14} /> Re-analizar
            </button>
            <span className="toolbar-sep" />
            <button
              type="button"
              className={visualLayer === 'zones' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setVisualLayer('zones')}
              title="Ver zonas detectadas (clic sobre una zona para alternar Abierto / Puerta / Cajones / Hueco)"
            >
              <LayoutGrid size={13} /> Zonas ({zonesCount})
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
              title="Ver bordes Sobel 3×3 y fondo aislado por Flood-Fill"
            >
              <Contrast size={13} /> Bordes + Fondo
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

      {/* Cajón colapsable de Ajuste Preciso */}
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
                  title="Toca un borde de melamina para muestrear su color y re-analizar"
                >
                  <Pipette size={13} /> Gotero
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
                  <Ruler size={13} /> A4
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={handleAutoQuad}
                  disabled={!hasPhoto}
                  title="Recalcular el encuadre automático por Flood-Fill + Sobel"
                >
                  <Scan size={13} /> Auto-encuadre
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
          <span>Posibles patas externas detectadas debajo del cuerpo.</span>
          <button
            type="button"
            className="btn-small"
            onClick={() => onToggleExternalLegs(true, 150, 4)}
          >
            Activar patas externas (4 × 150 mm)
          </button>
        </div>
      )}

      {!homography && viewTab === 'frontal' && hasPhoto && (
        <div className="alert-box critical">
          Marco inválido o cruzado. Pulsa "Encuadrar (1 arrastre)" o cambia a "Recuadro Frontal".
        </div>
      )}

      {/* Lienzo principal + vista rectificada */}
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
              <Upload size={32} />
              <strong>
                {viewTab === 'frontal'
                  ? 'Sube 1 foto de tu mueble o elige uno del Catálogo QA (14 fotos reales)'
                  : 'Arrastra una foto lateral (ZY) opcional'}
              </strong>
              <p className="small-note muted">
                Encuadre rápido en 1 arrastre (sin pelear con 4 puntos) + detección automática de
                puertas, cajones (5 pzas), huecos de escritorio y bicolor.
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
            <strong>Frente Rectificado</strong>
            <select
              className="select-mini"
              value={focal35mm}
              onChange={(e) => setFocal35mm(Number(e.target.value) as 26 | 52)}
              aria-label="Lente de cámara"
            >
              <option value={26}>1× (26mm)</option>
              <option value={52}>2× (52mm)</option>
            </select>
          </div>
          <canvas ref={rectPreviewRef} className="rect-preview-canvas" />
          <div className="mono small-note">
            W/H est.: <strong>{estimatedAspectXY.toFixed(3)}</strong>
          </div>
          {cameraPose && (
            <div className={`pose-badge pose-${cameraPose.distanceQuality}`}>
              <div>
                Dist. cámara: <strong>~{cameraPose.distanceMeters.toFixed(1)} m</strong>
                {cameraPose.distanceQuality === 'very_close'
                  ? ' (muy cerca)'
                  : cameraPose.distanceQuality === 'close'
                    ? ' (aléjate ≥2.5m)'
                    : ''}
              </div>
              <div className="mono" style={{ fontSize: 10.5, opacity: 0.9 }}>
                Pitch {cameraPose.pitchDeg > 0 ? '+' : ''}
                {cameraPose.pitchDeg.toFixed(1)}° · Horiz. v={cameraPose.estimatedHorizonV.toFixed(2)}
              </div>
            </div>
          )}
          {conf !== undefined && (
            <div className={`conf-badge ${confClass}`}>
              {detectedModeLabel ? `${detectedModeLabel} · ` : ''}
              {Math.round(conf * 100)}%
            </div>
          )}
          <div className="small-note muted">
            Div.: {topology.vDividers.length} · Rep.: {topology.hShelves.length} · Zonas: {zonesCount}
          </div>
        </div>
      </div>

      <p className="status-line">{statusMsg}</p>

      {viewTab === 'frontal' && hasPhoto && (
        <div className="calib-box">
          <strong>Medida exacta (opcional):</strong>
          <select
            value={knownAxis}
            onChange={(e) => setKnownAxis(e.target.value as 'x' | 'y')}
          >
            <option value="x">Ancho real (mm)</option>
            <option value="y">Alto real sin patas (mm)</option>
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
            Aplicar escala V<sub>f</sub>
          </button>

          {tool === 'calibA4' && (
            <>
              <span className="toolbar-sep" />
              <span>Segmento (mm):</span>
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
