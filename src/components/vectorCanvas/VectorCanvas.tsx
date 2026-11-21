/**
 * SMARTFURNITURE — VECTORCANVAS UX v3.1 (FOTO -> HOMOGRAFÍA -> VISIÓN -> 3D)
 * - Dropzone drag-and-drop en estado vacío + protocolo auto-colapsable al cargar imagen.
 * - Reescalado único a máx. 1600 px + `touch-action: none` + Lupa 4×.
 * - Modo "Mover / Esquinas": arrastra tanto los 4 nodos [TL,TR,BR,BL] como divisores y repisas existentes.
 * - Deshacer (Ctrl+Z) y Limpiar líneas + Gotero 1 clic + Calibración 1 medida / A4 debajo del lienzo.
 * - Rendimiento protegido: `bandDetector` NUNCA corre en `onPointerMove`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Eraser,
  Move,
  Pipette,
  Ruler,
  ScanSearch,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Wrench,
} from 'lucide-react';
import type {
  FurnitureTopology,
  HardwareItem,
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
  computeRectifiedSize,
  detectLowerGapHint,
  estimateAspectRatioFixedFocal,
  extrapolateDimensionsFromSingleMeasure,
  rectifyImageRGBA,
} from '../../core/vision';
import { NumericInput } from '../NumericInput';

interface VectorCanvasProps {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  onUpdateTopology: (next: FurnitureTopology) => void;
  onApplyCalibratedDims: (dims: { x: number; y: number; z: number }) => void;
  onToggleExternalLegs: (checked: boolean, heightMm?: number, count?: number) => void;
  onAddHardwareItem: (item: HardwareItem) => void;
  onSelectDepthMm: (zMm: number) => void;
}

type ToolMode =
  | 'corners'
  | 'vDivider'
  | 'hShelf'
  | 'eyedropper'
  | 'calibA4'
  | 'hardware'
  | 'erase';

type DragTarget =
  | { kind: 'corner'; idx: number }
  | { kind: 'vDivider'; id: string }
  | { kind: 'hShelf'; id: string };

interface LineSnapshot {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
}

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;
const SNAP_TOL = 0.03;
const MAX_WORK_DIM = 1600;

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

function snapValue(val: number, anchors: readonly number[]): number {
  for (const a of anchors) {
    if (Math.abs(val - a) <= SNAP_TOL) {
      return a;
    }
  }
  return val;
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
  wallGrad.addColorStop(0, '#cbd5e1');
  wallGrad.addColorStop(1, '#e2e8f0');
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, w, 595);
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(0, 595, w, 85);

  const quad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: 185, y: 85 },
    { x: 675, y: 98 },
    { x: 700, y: 515 },
    { x: 165, y: 525 },
  ];

  ctx.fillStyle = '#1e293b';
  for (const lx of [195, 255, 625, 675]) {
    ctx.fillRect(lx, 515, 14, 82);
  }

  const hom = computeQuadToUnitHomography(quad);
  const fillPoly = (pts: Point2D[], fill: string) => {
    ctx.beginPath();
    pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  fillPoly(quad, '#334155');

  if (hom) {
    const mapRect = (u0: number, v0: number, u1: number, v1: number, color: string) => {
      const p0 = applyHomography(hom.toCanvas, { x: u0, y: v1 });
      const p1 = applyHomography(hom.toCanvas, { x: u1, y: v1 });
      const p2 = applyHomography(hom.toCanvas, { x: u1, y: v0 });
      const p3 = applyHomography(hom.toCanvas, { x: u0, y: v0 });
      if (p0 && p1 && p2 && p3) fillPoly([p0, p1, p2, p3], color);
    };

    const boardCol = '#cfa06e';
    const eU = 0.025;
    const eV = 0.03;

    mapRect(0, 1 - eV, 1, 1, boardCol);
    mapRect(0, 0, 1, eV, boardCol);
    mapRect(0, 0, eU, 1, boardCol);
    mapRect(1 - eU, 0, 1, 1, boardCol);
    mapRect(0.5 - eU / 2, eV, 0.5 + eU / 2, 1 - eV, boardCol);
    mapRect(eU, 0.34 - eV / 2, 0.5 - eU / 2, 0.34 + eV / 2, boardCol);
    mapRect(eU, 0.67 - eV / 2, 0.5 - eU / 2, 0.67 + eV / 2, boardCol);
    mapRect(0.5 + eU / 2, 0.52 - eV / 2, 1 - eU, 0.52 + eV / 2, boardCol);

    mapRect(0.68, 0.58, 0.85, 0.86, '#ffffff');
    const a4Label = applyHomography(hom.toCanvas, { x: 0.765, y: 0.72 });
    if (a4Label) {
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('A4', a4Label.x, a4Label.y - 4);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText('297mm', a4Label.x, a4Label.y + 10);
    }
  }

  return c.toDataURL('image/png');
}

export function VectorCanvas({
  topology,
  params,
  onUpdateTopology,
  onApplyCalibratedDims,
  onToggleExternalLegs,
  onAddHardwareItem,
  onSelectDepthMm,
}: VectorCanvasProps) {
  const [viewTab, setViewTab] = useState<'frontal' | 'lateral'>('frontal');
  const [showProtocol, setShowProtocol] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [frontBitmap, setFrontBitmap] = useState<WorkingBitmap | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 900, h: 680 });

  // Vista lateral opcional ZY
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
      { x: 185, y: 85 },
      { x: 675, y: 98 },
      { x: 700, y: 515 },
      { x: 165, y: 525 },
    ],
  );
  const [tool, setTool] = useState<ToolMode>('corners');
  const [focal35mm, setFocal35mm] = useState<26 | 52>(26);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const [cursorImgPt, setCursorImgPt] = useState<Point2D | null>(null);
  const [draftLineStart, setDraftLineStart] = useState<Point2D | null>(null);
  const [undoStack, setUndoStack] = useState<LineSnapshot[]>([]);

  // Calibración rápida con 1 sola medida (extrapolación)
  const [knownAxis, setKnownAxis] = useState<'x' | 'y'>('x');
  const [knownMeasureMm, setKnownMeasureMm] = useState<number>(params.targetDimensions.x);

  useEffect(() => {
    setKnownMeasureMm(knownAxis === 'x' ? params.targetDimensions.x : params.targetDimensions.y);
  }, [knownAxis, params.targetDimensions.x, params.targetDimensions.y]);

  // Calibración A4 por segmento [p1, p2]
  const [calibPts, setCalibPts] = useState<Point2D[]>([]);
  const [calibRefMm, setCalibRefMm] = useState<number>(297);

  // Feedback del detector
  const [statusMsg, setStatusMsg] = useState<string>(
    'Sube una foto frontal (o prueba el croquis local) para ajustar las 4 esquinas y detectar la estructura.',
  );
  const [legHintDetected, setLegHintDetected] = useState<boolean>(false);
  const [detectedModeLabel, setDetectedModeLabel] = useState<string>('');
  const [hardwareMarkers, setHardwareMarkers] = useState<Point2D[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rectPreviewRef = useRef<HTMLCanvasElement | null>(null);
  const fileFrontalInputRef = useRef<HTMLInputElement | null>(null);
  const fileSideInputRef = useRef<HTMLInputElement | null>(null);

  const pushUndo = () => {
    setUndoStack((prev) => [
      ...prev.slice(-19),
      {
        vDividers: topology.vDividers.map((d) => ({ ...d })),
        hShelves: topology.hShelves.map((s) => ({ ...s })),
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
      });
      setStatusMsg('Último cambio de trazos deshecho.');
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
      detectionSource: 'manual',
    });
    setStatusMsg('Líneas internas limpiadas. Puedes volver a detectar o trazar manualmente.');
  };

  // Atajo Ctrl+Z para deshacer trazos
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

  const homography = useMemo(() => computeQuadToUnitHomography(quad), [quad]);

  const estimatedAspectXY = useMemo(() => {
    return estimateAspectRatioFixedFocal(quad, imgSize.w, imgSize.h, focal35mm);
  }, [quad, imgSize.w, imgSize.h, focal35mm]);

  const loadFrontalFromUrl = (url: string, isSample = false) => {
    const img = new Image();
    img.onload = () => {
      const bmp = prepareWorkingBitmap(img);
      setImgUrl(url);
      setFrontBitmap(bmp);
      setImgSize({ w: bmp.w, h: bmp.h });
      setShowProtocol(false);

      const defaultQuad: [Point2D, Point2D, Point2D, Point2D] = isSample
        ? [
            { x: 185, y: 85 },
            { x: 675, y: 98 },
            { x: 700, y: 515 },
            { x: 165, y: 525 },
          ]
        : [
            { x: Math.round(bmp.w * 0.16), y: Math.round(bmp.h * 0.14) },
            { x: Math.round(bmp.w * 0.84), y: Math.round(bmp.h * 0.14) },
            { x: Math.round(bmp.w * 0.84), y: Math.round(bmp.h * 0.84) },
            { x: Math.round(bmp.w * 0.16), y: Math.round(bmp.h * 0.84) },
          ];
      setQuad(defaultQuad);
      setCalibPts([]);
      setHardwareMarkers([]);
      setLegHintDetected(false);
      setTool('corners');
      setStatusMsg(
        isSample
          ? 'Croquis cargado. Pulsa "Detectar estructura" o arrastra los nodos TL/TR/BR/BL.'
          : `Foto lista (${bmp.w}×${bmp.h} px). Alinea las 4 esquinas al cuerpo de melamina (sin patas) y pulsa "Detectar".`,
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
      setSideQuad([
        { x: Math.round(bmp.w * 0.25), y: Math.round(bmp.h * 0.14) },
        { x: Math.round(bmp.w * 0.75), y: Math.round(bmp.h * 0.14) },
        { x: Math.round(bmp.w * 0.75), y: Math.round(bmp.h * 0.86) },
        { x: Math.round(bmp.w * 0.25), y: Math.round(bmp.h * 0.86) },
      ]);
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

  // Render de miniatura rectificada (liviana 200px durante arrastre, detallada 320px al soltar)
  useEffect(() => {
    const previewCanvas = rectPreviewRef.current;
    if (!previewCanvas || !frontBitmap || frontBitmap.w === 0 || !homography) return;

    const previewW = dragTarget?.kind === 'corner' ? 200 : 320;
    const previewH = Math.max(110, Math.min(340, Math.round(previewW / Math.max(0.25, estimatedAspectXY))));
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

    ctx.drawImage(activeBmp.canvas, 0, 0, cw, ch);

    // Contorno del cuadrilátero
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = Math.max(2, cw / 360);
    ctx.beginPath();
    activeQuad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    if (viewTab === 'frontal' && homography) {
      const { toCanvas } = homography;
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.28)';
      ctx.lineWidth = 1;
      for (const k of [0.25, 0.5, 0.75]) {
        const a = applyHomography(toCanvas, { x: k, y: 0 });
        const b = applyHomography(toCanvas, { x: k, y: 1 });
        if (a && b) {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        const c = applyHomography(toCanvas, { x: 0, y: k });
        const d = applyHomography(toCanvas, { x: 1, y: k });
        if (c && d) {
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(d.x, d.y);
          ctx.stroke();
        }
      }

      const e = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

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

      // Vista previa en vivo al arrastrar nueva repisa
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

      // Marcadores de tiradores / herrajes
      const hwR = Math.max(8, cw / 100);
      for (const hm of hardwareMarkers) {
        ctx.fillStyle = '#a855f7';
        ctx.beginPath();
        ctx.arc(hm.x, hm.y, hwR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Nodos arrastrables [TL, TR, BR, BL]
    const nodeR = Math.max(10, cw / 85);
    activeQuad.forEach((p, idx) => {
      const isDraggingCorner = dragTarget?.kind === 'corner' && dragTarget.idx === idx;
      ctx.fillStyle = isDraggingCorner ? '#f59e0b' : '#0284c7';
      ctx.beginPath();
      ctx.arc(p.x, p.y, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(nodeR * 1.05)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(CORNER_LABELS[idx], p.x, p.y);
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
    frontBitmap,
    sideBitmap,
    quad,
    sideQuad,
    homography,
    topology.vDividers,
    topology.hShelves,
    params.boardThickness,
    params.targetDimensions.x,
    params.targetDimensions.y,
    dragTarget,
    cursorImgPt,
    draftLineStart,
    tool,
    calibPts,
    hardwareMarkers,
  ]);

  const toCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>): Point2D => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const runAutoDetection = (seedPoint?: { u: number; v: number }) => {
    if (!frontBitmap || frontBitmap.w === 0 || !homography) {
      setStatusMsg('Primero carga una imagen válida y ubica las 4 esquinas sin cruzarlas.');
      return;
    }

    pushUndo();

    const safeRatio = Math.max(0.25, Math.min(4, estimatedAspectXY));
    const currentRatio = params.targetDimensions.x / Math.max(1, params.targetDimensions.y);
    const ratioMismatch = Math.abs(currentRatio - safeRatio) / safeRatio > 0.15;
    const effX = ratioMismatch
      ? Math.min(1800, Math.max(800, params.targetDimensions.x))
      : params.targetDimensions.x;
    const effY = ratioMismatch
      ? Math.max(400, Math.min(2200, Math.round(effX / safeRatio)))
      : params.targetDimensions.y;

    const { width: dstW, height: dstH } = computeRectifiedSize(effX, effY, params.boardThickness);
    const rectRgba = rectifyImageRGBA(
      frontBitmap.rgba,
      frontBitmap.w,
      frontBitmap.h,
      homography.toCanvas,
      dstW,
      dstH,
    );

    const det = analyzeRectifiedFurniture(
      rectRgba,
      dstW,
      dstH,
      { x: effX, y: effY },
      params.boardThickness,
      { seedPoint, parallaxAware: true, horizonV: 0.5 },
    );

    const legsHint = detectLowerGapHint(frontBitmap.rgba, frontBitmap.w, frontBitmap.h, quad);
    setLegHintDetected(legsHint.possibleExternalLegs);

    const manualHardware = (topology.hardwareItems ?? []).filter((h) => h.origen !== 'detectado');
    const nextHardware = [...manualHardware];
    const projectedHandles: Point2D[] = [];

    if (det.detectedHandles.length > 0) {
      for (const hPt of det.detectedHandles) {
        const mapped = applyHomography(homography.toCanvas, { x: hPt.u, y: hPt.v });
        if (mapped) projectedHandles.push(mapped);
      }
      nextHardware.push({
        id: 'hw_tiradores_auto',
        categoria: 'tiradores',
        descripcion: `Tiradores / manillas detectados en frente (${det.detectedHandles.length} u.)`,
        cantidad: det.detectedHandles.length,
        notaCompra: `Detectados automáticamente sobre mueble cerrado. Adquirir ${det.detectedHandles.length} tiradores aparte (no son melamina).`,
        origen: 'detectado',
      });
    }
    setHardwareMarkers(projectedHandles);

    const modeText =
      det.furnitureMode === 'closed_front'
        ? 'Mueble Cerrado (Puertas/Cajones)'
        : det.furnitureMode === 'open'
          ? 'Mueble Abierto (Estantería/Vanos)'
          : 'Baja Confianza';
    setDetectedModeLabel(modeText);

    onUpdateTopology({
      ...topology,
      aspectRatioXY: estimatedAspectXY,
      quadCorners: quad,
      homographyMatrix: homography.toUnit.map((r) => [...r]),
      shelfMode: 'custom',
      vDividers: det.vDividers,
      hShelves: det.hShelves,
      hardwareItems: nextHardware,
      detectionSource: 'auto',
      detectionConfidence: det.confidence,
    });

    if (det.confidence < 0.5) {
      setStatusMsg(
        `Confianza baja (${Math.round(det.confidence * 100)}%). Ajusta las 4 esquinas al cuerpo exacto o usa "Gotero" / trazado manual.`,
      );
    } else {
      const handleMsg =
        det.detectedHandles.length > 0 ? ` + ${det.detectedHandles.length} tirador(es).` : '.';
      const legsMsg = legsHint.possibleExternalLegs ? ' Posibles patas externas detectadas.' : '';
      setStatusMsg(
        `[${modeText}] ${det.vDividers.length} divisor(es) y ${det.hShelves.length} repisa(s) (${Math.round(det.confidence * 100)}% conf.)${handleMsg}${legsMsg} Arrastra cualquier línea en "Mover" para afinar.`,
      );
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = toCanvasCoords(e);
    const activeQuad = viewTab === 'frontal' ? quad : sideQuad;
    const eMm = params.boardThickness;
    const xf = params.targetDimensions.x;
    const yf = params.targetDimensions.y;

    // Modo Mover / Esquinas (o pestaña lateral): primero intenta agarrar esquina, luego línea existente
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
            const dist = Math.abs(d.position - uClick);
            if (dist < bestDist) {
              bestDist = dist;
              found = { kind: 'vDivider', id: d.id };
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
          }
        }
      }
      return;
    }

    if (!homography) return;
    const unitPt = applyHomography(homography.toUnit, pt);
    if (!unitPt) return;

    if (tool === 'eyedropper') {
      runAutoDetection({
        u: Math.max(0, Math.min(1, unitPt.x)),
        v: Math.max(0, Math.min(1, unitPt.y)),
      });
      setTool('corners');
      return;
    }

    if (tool === 'calibA4') {
      setCalibPts((prev) => (prev.length >= 2 ? [pt] : [...prev, pt]));
      return;
    }

    if (tool === 'hardware') {
      setHardwareMarkers((prev) => [...prev, pt]);
      onAddHardwareItem({
        id: `hw_foto_${Date.now()}`,
        categoria: 'tiradores',
        descripcion: 'Tirador / accesorio marcado en foto',
        cantidad: 1,
        notaCompra: 'Elemento ajeno a la melamina — marcado sobre foto frontal.',
        origen: 'manual',
      });
      setStatusMsg('Tirador / herraje agregado a la pestaña Herrajes.');
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
        const dist = Math.abs(d.position - uClick);
        if (dist < bestDist) {
          bestDist = dist;
          targetKind = 'div';
          targetId = d.id;
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

    if (dragTarget.kind === 'corner') {
      if (viewTab === 'frontal') {
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
      const nextU = Math.max(0.04, Math.min(0.96, exteriorToInterior(unitPt.x, eMm, params.targetDimensions.x)));
      onUpdateTopology({
        ...topology,
        shelfMode: 'custom',
        detectionSource: 'manual',
        vDividers: topology.vDividers.map((d) =>
          d.id === dragTarget.id ? { ...d, position: Number(nextU.toFixed(4)) } : d,
        ),
      });
    } else if (dragTarget.kind === 'hShelf') {
      const nextV = Math.max(0.04, Math.min(0.96, exteriorToInterior(unitPt.y, eMm, params.targetDimensions.y)));
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
      const finishedKind = dragTarget.kind;
      setDragTarget(null);
      setCursorImgPt(null);
      if (finishedKind === 'corner') {
        if (viewTab === 'frontal' && homography) {
          onUpdateTopology({
            ...topology,
            aspectRatioXY: estimatedAspectXY,
            quadCorners: quad,
            homographyMatrix: homography.toUnit.map((r) => [...r]),
          });
        } else if (viewTab === 'lateral' && sideBitmap) {
          const ratioZY = estimateAspectRatioFixedFocal(sideQuad, sideBitmap.w, sideBitmap.h, focal35mm);
          const estDepth = Math.max(200, Math.min(800, Math.round(params.targetDimensions.y * ratioZY)));
          onUpdateTopology({ ...topology, viewsMode: 2, aspectRatioZY: ratioZY });
          onSelectDepthMm(estDepth);
          setStatusMsg(`Profundidad Z actualizada desde Vista Lateral ZY: ${estDepth} mm.`);
        }
      } else {
        setStatusMsg('Posición de línea ajustada y sincronizada en 3D (Ctrl+Z para deshacer).');
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
      `Extrapolado desde 1 medida (${knownAxis === 'x' ? 'Ancho' : 'Alto'} = ${knownMeasureMm} mm): Cuerpo V₀ = V_f = (${ext.x} × ${ext.y} × ${ext.z}) mm.`,
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
          setStatusMsg(`Calibración A4 aplicada (perspectiva corregida): ${dims.x} × ${dims.y} × ${dims.z} mm.`);
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
  const canvasCursor =
    dragTarget !== null
      ? 'grabbing'
      : tool === 'corners' || viewTab === 'lateral'
        ? 'grab'
        : tool === 'erase'
          ? 'pointer'
          : 'crosshair';

  return (
    <div className="vector-card">
      {/* Cabecera compacta */}
      <div className="card-header-row">
        <h3>Foto → Homografía 3×3 → Visión</h3>
        <div className="chip-row">
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
            Lateral ZY
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
          <strong>Protocolo de Foto (100 % Local):</strong> Cámara centrada a media altura, distancia ≥ 3 m, zoom{' '}
          <strong>1× o 2×</strong> (nunca 0.5×), sin recortar (WhatsApp como <em>Documento</em>). Enmarca{' '}
          <strong>solo el cuerpo de melamina</strong> (sin patas externas).
        </div>
      )}

      {/* Barra única compacta de carga + herramientas */}
      <div className="canvas-toolbar">
        {viewTab === 'frontal' ? (
          <>
            <button
              type="button"
              className="btn-secondary"
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
            <button
              type="button"
              className="btn-small"
              onClick={() => loadFrontalFromUrl(generateSampleFurnitureDataUrl(), true)}
            >
              <Sparkles size={14} /> Croquis local
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => runAutoDetection()}
              disabled={!hasPhoto || !homography}
            >
              <ScanSearch size={14} /> Detectar estructura
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              onClick={() => fileSideInputRef.current?.click()}
            >
              <Camera size={14} /> Subir foto lateral (ZY)
            </button>
            <input
              ref={fileSideInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSide}
              hidden
            />
          </>
        )}

        {viewTab === 'frontal' && (
          <>
            <span className="toolbar-sep" />
            <button
              type="button"
              className={tool === 'corners' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setTool('corners')}
              disabled={!hasPhoto}
              title="Arrastra esquinas TL/TR/BR/BL o mueve líneas existentes"
            >
              <Move size={13} /> Mover
            </button>
            <button
              type="button"
              className={tool === 'vDivider' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setTool('vDivider')}
              disabled={!hasPhoto}
              title="Clic en la foto para agregar divisor vertical"
            >
              + Divisor
            </button>
            <button
              type="button"
              className={tool === 'hShelf' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setTool('hShelf')}
              disabled={!hasPhoto}
              title="Arrastra o haz clic dentro de un vano para agregar repisa"
            >
              + Repisa
            </button>
            <button
              type="button"
              className={tool === 'eyedropper' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setTool('eyedropper')}
              disabled={!hasPhoto}
              title="Toca un canto de melamina para muestrear su color y re-detectar"
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
              title="Marca 2 puntos sobre una hoja A4 (297 mm) o medida conocida"
            >
              <Ruler size={13} /> A4
            </button>
            <button
              type="button"
              className={tool === 'hardware' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setTool('hardware')}
              disabled={!hasPhoto}
              title="Marcar tirador o herraje externo"
            >
              <Wrench size={13} /> Tirador
            </button>
            <button
              type="button"
              className={tool === 'erase' ? 'chip-btn active' : 'chip-btn'}
              onClick={() => setTool('erase')}
              disabled={!hasPhoto}
              title="Clic sobre una línea para borrarla"
            >
              <Eraser size={13} /> Borrar
            </button>
            <span className="toolbar-sep" />
            <button
              type="button"
              className="chip-btn"
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              title="Deshacer último cambio (Ctrl+Z)"
            >
              <Undo2 size={13} /> Deshacer
            </button>
            <button
              type="button"
              className="chip-btn"
              onClick={handleClearLines}
              disabled={!hasPhoto || (topology.vDividers.length === 0 && topology.hShelves.length === 0)}
              title="Quitar todas las líneas internas"
            >
              <Trash2 size={13} /> Limpiar
            </button>
          </>
        )}
      </div>

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
          Cuadrilátero degenerado o cruzado. Separa las 4 esquinas en orden horario (TL, TR, BR, BL).
        </div>
      )}

      {/* Lienzo principal (above the fold) + vista rectificada */}
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
                  ? 'Arrastra tu foto frontal aquí o selecciónala'
                  : 'Arrastra una foto lateral (ZY) opcional'}
              </strong>
              <p className="small-note muted">
                Procesamiento 100 % local en tu navegador · Compatible con fotos de celular
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
                  <Camera size={14} /> Elegir archivo
                </button>
                {viewTab === 'frontal' && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => loadFrontalFromUrl(generateSampleFurnitureDataUrl(), true)}
                  >
                    <Sparkles size={14} /> Probar con croquis local
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="rect-preview-panel">
          <div className="card-header-row">
            <strong>Vista Rectificada</strong>
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
          {conf !== undefined && topology.detectionSource === 'auto' && (
            <div className={`conf-badge ${confClass}`}>
              {detectedModeLabel ? `${detectedModeLabel} · ` : ''}
              {Math.round(conf * 100)}%
              {conf < 0.5 ? ' (Manual)' : conf < 0.7 ? ' (Revisar)' : ' (Alta)'}
            </div>
          )}
          <div className="small-note muted">
            Divisores: {topology.vDividers.length} · Repisas: {topology.hShelves.length}
          </div>
        </div>
      </div>

      {/* Estado + Calibración métrica debajo del lienzo */}
      <p className="status-line">{statusMsg}</p>

      {viewTab === 'frontal' && hasPhoto && (
        <div className="calib-box">
          <strong>Calibrar escala:</strong>
          <select
            value={knownAxis}
            onChange={(e) => setKnownAxis(e.target.value as 'x' | 'y')}
          >
            <option value="x">Ancho cuerpo (mm)</option>
            <option value="y">Alto cuerpo sin patas (mm)</option>
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
            Extrapolar V<sub>f</sub>
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
