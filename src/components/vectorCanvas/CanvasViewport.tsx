/**
 * SMARTFURNITURE v8.0 — VISOR INTERACTIVO DE LIENZO 2D (`CanvasViewport`)
 * - Zoom continuo 0.75×..4× (Ctrl+Rueda / botones / pinch táctil) sin bloquear scroll vertical en 1×.
 * - Pan fluido (Espacio + arrastrar, botón central, herramienta Mano o 2 dedos).
 * - Lupa 4× fija dentro del viewport visible (jamás se corta fuera del scroll), centrada en el
 *   punto ya imantado con líneas proyectadas, cruz de precisión y vista previa de color en Gotero.
 * - Renderizado a 60 fps usando estado borrador (`activeQuad`, `activeVDividers`, `activeHShelves`,
 *   `activeDiagonals`) sin recalcular 3D ni despiece durante `pointermove`.
 */
import { useEffect, useRef } from 'react';
import { Camera, Sparkles, Upload } from 'lucide-react';
import type {
  DiagonalSegment,
  FrontZone,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  applyHomography,
  interiorToExterior,
  type Matrix3x3,
} from '../../core/mathEngine';
import {
  vectorizeUserStroke,
  type UserStrokeMode,
  type VectorLine2D,
} from '../../core/vision';
import {
  CORNER_LABELS,
  MELAMINE_LABELS,
  VECTOR_ROLE_COLORS,
  ZONE_COLORS,
  ZONE_SHORT_LABELS,
  projectDiagonal,
  projectHShelf,
  projectVDivider,
  projectZoneQuad,
  type FrameMode,
  type LineRef,
  type SnapIndicator,
  type SubTool,
  type TraceStep,
  type VisualLayerMode,
  type WorkingBitmap,
} from './geometryHelpers';

export interface ActiveHoverTarget {
  kind:
    | 'none'
    | 'corner'
    | 'edge'
    | 'frameInterior'
    | 'lineBody'
    | 'lineEnd'
    | 'zone';
  idx?: number;
  edgeIdx?: 0 | 1 | 2 | 3;
  lineRef?: LineRef;
  linePart?: 'body' | 'start' | 'end';
  zoneId?: string;
}

export interface LiveStrokeDrawState {
  startImg: Point2D;
  currentImg: Point2D;
}

export interface EyedropperPreview {
  rgb: [number, number, number];
  material: MelamineMaterial;
}

export interface CanvasViewportProps {
  activeBmp: WorkingBitmap | null;
  sobelCanvas: HTMLCanvasElement | null;
  viewTab: 'frontal' | 'lateral';
  traceStep: TraceStep;
  frameMode: FrameMode;
  subTool: SubTool;
  visualLayer: VisualLayerMode;
  strokeMode: UserStrokeMode;
  activeQuad: [Point2D, Point2D, Point2D, Point2D];
  homography: { toUnit: Matrix3x3; toCanvas: Matrix3x3 } | null;
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  diagonalDividers: DiagonalSegment[];
  frontZones: FrontZone[];
  photoVectorLines: VectorLine2D[];
  params: ScaleAndBoardParams;
  selectedZoneId: string | null;
  hoveredZoneId: string | null;
  selectedLine: LineRef | null;
  hoverTarget: ActiveHoverTarget;
  pickingCorners: Point2D[] | null;
  calibPts: Point2D[];
  calibRefMm: number;
  liveStroke: LiveStrokeDrawState | null;
  snapIndicator: SnapIndicator | null;
  loupeFocusPt: Point2D | null;
  loupeSide: 'left' | 'right';
  eyedropperPreview: EyedropperPreview | null;
  zoom: number;
  pan: Point2D;
  isPanning: boolean;
  isSpacePan: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  canvasCursor: string;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  stageRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerLeave: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onTriggerUpload: () => void;
  onLoadSample: () => void;
}

const LOUPE_SIZE = 148;
const LOUPE_ZOOM = 4;

export function CanvasViewport({
  activeBmp,
  sobelCanvas,
  viewTab,
  traceStep,
  frameMode,
  subTool,
  visualLayer,
  strokeMode,
  activeQuad,
  homography,
  vDividers,
  hShelves,
  diagonalDividers,
  frontZones,
  photoVectorLines,
  params,
  selectedZoneId,
  hoveredZoneId,
  selectedLine,
  hoverTarget,
  pickingCorners,
  calibPts,
  calibRefMm,
  liveStroke,
  snapIndicator,
  loupeFocusPt,
  loupeSide,
  eyedropperPreview,
  zoom,
  pan,
  isPanning,
  isSpacePan,
  isDragging,
  isDragOver,
  canvasCursor,
  canvasRef,
  stageRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  onDragOver,
  onDragLeave,
  onDrop,
  onTriggerUpload,
  onLoadSample,
}: CanvasViewportProps) {
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Render principal del lienzo 2D
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeBmp) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = activeBmp.w;
    const ch = activeBmp.h;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    // 1. Imagen base o filtro Sobel
    if (viewTab === 'frontal' && visualLayer === 'edges' && sobelCanvas) {
      ctx.drawImage(sobelCanvas, 0, 0, cw, ch);
    } else {
      ctx.drawImage(activeBmp.canvas, 0, 0, cw, ch);
    }

    // 2. Atenuación suave fuera del contorno del mueble
    if (viewTab === 'frontal' && visualLayer === 'vectors_only') {
      ctx.fillStyle = 'rgba(10, 15, 28, 0.42)';
      ctx.fillRect(0, 0, cw, ch);
    } else if (viewTab === 'frontal' && visualLayer !== 'edges') {
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

    // 3. Guías de bordes vectoriales detectados (capa 'vectors_only')
    if (viewTab === 'frontal' && visualLayer === 'vectors_only' && photoVectorLines.length > 0) {
      for (const ln of photoVectorLines) {
        ctx.strokeStyle = VECTOR_ROLE_COLORS[ln.role];
        ctx.lineWidth = Math.max(1.6, cw / 400);
        ctx.beginPath();
        ctx.moveTo(ln.p1.x, ln.p1.y);
        ctx.lineTo(ln.p2.x, ln.p2.y);
        ctx.stroke();
      }
    }

    const e = params.boardThickness;
    const xf = params.targetDimensions.x;
    const yf = params.targetDimensions.y;
    const xInt = Math.max(1, xf - 2 * e);
    const yInt = Math.max(1, yf - 2 * e);

    // 4. Capas interiores proyectadas vía homografía
    if (viewTab === 'frontal' && homography) {
      const { toCanvas } = homography;

      // 4A. Zonas frontales (visibles en Paso 3 y sutiles en Paso 2 si capa = traced_zones)
      const showZones =
        visualLayer === 'traced_zones' &&
        frontZones.length > 0 &&
        (traceStep === 'zones' || traceStep === 'lines');

      if (showZones) {
        for (let zIdx = 0; zIdx < frontZones.length; zIdx++) {
          const z = frontZones[zIdx];
          const zQuad = projectZoneQuad(z, toCanvas, e, xf, yf);
          if (!zQuad) continue;
          const [pTL, pTR, pBR, pBL] = zQuad;
          const palette = ZONE_COLORS[z.kind];
          const isSelZone = selectedZoneId === z.id;
          const isHovZone = hoveredZoneId === z.id;

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(pTL.x, pTL.y);
          ctx.lineTo(pTR.x, pTR.y);
          ctx.lineTo(pBR.x, pBR.y);
          ctx.lineTo(pBL.x, pBL.y);
          ctx.closePath();

          if (traceStep === 'lines') {
            ctx.globalAlpha = isHovZone ? 0.65 : 0.36;
          }
          ctx.fillStyle = isHovZone || isSelZone ? palette.hoverFill : palette.fill;
          ctx.fill();

          if (z.kind === 'void_outside') {
            ctx.setLineDash([7, 5]);
            ctx.beginPath();
            ctx.moveTo(pTL.x, pTL.y);
            ctx.lineTo(pBR.x, pBR.y);
            ctx.moveTo(pTR.x, pTR.y);
            ctx.lineTo(pBL.x, pBL.y);
            ctx.strokeStyle = 'rgba(248, 113, 113, 0.72)';
            ctx.lineWidth = Math.max(1.5, cw / 480);
            ctx.stroke();
            ctx.setLineDash([]);
          }

          ctx.strokeStyle = isSelZone
            ? '#ffffff'
            : isHovZone
              ? '#38bdf8'
              : palette.stroke;
          ctx.lineWidth = Math.max(
            isSelZone ? 3.2 : isHovZone ? 2.4 : 1.3,
            cw / (isSelZone ? 260 : 520),
          );
          ctx.beginPath();
          ctx.moveTo(pTL.x, pTL.y);
          ctx.lineTo(pTR.x, pTR.y);
          ctx.lineTo(pBR.x, pBR.y);
          ctx.lineTo(pBL.x, pBL.y);
          ctx.closePath();
          ctx.stroke();
          ctx.restore();

          // Etiqueta legible y semitransparente que no tapa la foto
          if (traceStep === 'zones' || isHovZone) {
            const uMid = interiorToExterior((z.uStart + z.uEnd) / 2, e, xf);
            const vMid = interiorToExterior((z.vStart + z.vEnd) / 2, e, yf);
            const center = applyHomography(toCanvas, { x: uMid, y: vMid });
            if (center) {
              const tagText =
                z.kind === 'drawers'
                  ? `Z${zIdx + 1} · ${z.drawerCount ?? 3} Caj.`
                  : z.kind === 'baskets'
                    ? `Z${zIdx + 1} · ${z.basketCount ?? 3} Can.`
                    : z.kind === 'void_outside'
                      ? `Z${zIdx + 1} · Vacío`
                      : `Z${zIdx + 1} · ${ZONE_SHORT_LABELS[z.kind]}`;
              const fontPx = Math.max(11, Math.min(15, Math.round(cw / 68)));
              ctx.save();
              ctx.font = `700 ${fontPx}px system-ui, sans-serif`;
              const tw = ctx.measureText(tagText).width;
              const padX = 7;
              const boxH = fontPx * 1.48;
              ctx.fillStyle =
                z.kind === 'void_outside'
                  ? 'rgba(185, 28, 28, 0.80)'
                  : isSelZone
                    ? 'rgba(2, 132, 199, 0.90)'
                    : isHovZone
                      ? 'rgba(14, 116, 144, 0.86)'
                      : 'rgba(15, 23, 42, 0.72)';
              ctx.beginPath();
              ctx.roundRect(
                center.x - tw / 2 - padX,
                center.y - boxH / 2,
                tw + padX * 2,
                boxH,
                6,
              );
              ctx.fill();
              if (isSelZone) {
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
              }
              ctx.fillStyle = '#ffffff';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(tagText, center.x, center.y);
              ctx.restore();
            }
          }
        }
      }

      // 4B. Vectores estructurales (Divisores V, Repisas H y Diagonales)
      const endRBase = Math.max(4.5, cw / 185);
      const drawEndpointHandle = (
        pt: Point2D,
        isSelected: boolean,
        isHovered: boolean,
        accent: string,
      ) => {
        const r = isSelected ? endRBase * 1.45 : isHovered ? endRBase * 1.3 : endRBase;
        ctx.save();
        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r + 3.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#ffffff' : '#f8fafc';
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#0284c7' : accent;
        ctx.lineWidth = Math.max(2, cw / 420);
        ctx.stroke();
        ctx.restore();
      };

      const drawLineBadge = (
        mx: number,
        my: number,
        text: string,
        bg: string,
        isSelected: boolean,
      ) => {
        const fontPx = Math.max(10, Math.min(13, Math.round(cw / 78)));
        ctx.save();
        ctx.font = `700 ${fontPx}px Consolas, monospace`;
        const lw = ctx.measureText(text).width;
        const bh = fontPx + 6;
        ctx.fillStyle = isSelected ? 'rgba(2, 132, 199, 0.95)' : bg;
        ctx.beginPath();
        ctx.roundRect(mx - lw / 2 - 5, my - bh / 2, lw + 10, bh, 4);
        ctx.fill();
        if (isSelected) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, mx, my);
        ctx.restore();
      };

      // Divisores verticales
      for (const div of vDividers) {
        const proj = projectVDivider(div, toCanvas, e, xf, yf);
        if (!proj) continue;
        const isSel = selectedLine?.kind === 'vDivider' && selectedLine.id === div.id;
        const isHov =
          (hoverTarget.kind === 'lineBody' || hoverTarget.kind === 'lineEnd') &&
          hoverTarget.lineRef?.kind === 'vDivider' &&
          hoverTarget.lineRef.id === div.id;

        if (isSel || isHov) {
          ctx.strokeStyle = isSel ? 'rgba(56, 189, 248, 0.55)' : 'rgba(34, 197, 94, 0.40)';
          ctx.lineWidth = Math.max(8, cw / 120);
          ctx.beginPath();
          ctx.moveTo(proj.p0.x, proj.p0.y);
          ctx.lineTo(proj.p1.x, proj.p1.y);
          ctx.stroke();
        }

        ctx.strokeStyle = isSel ? '#38bdf8' : '#22c55e';
        ctx.lineWidth = Math.max(isSel ? 4.2 : 3, cw / (isSel ? 220 : 290));
        ctx.beginPath();
        ctx.moveTo(proj.p0.x, proj.p0.y);
        ctx.lineTo(proj.p1.x, proj.p1.y);
        ctx.stroke();

        if (traceStep === 'lines') {
          drawEndpointHandle(
            proj.p0,
            isSel,
            isHov && hoverTarget.linePart === 'start',
            '#16a34a',
          );
          drawEndpointHandle(
            proj.p1,
            isSel,
            isHov && hoverTarget.linePart === 'end',
            '#16a34a',
          );
          const xMm = Math.round(e + div.position * xInt);
          drawLineBadge(
            (proj.p0.x + proj.p1.x) / 2,
            (proj.p0.y + proj.p1.y) / 2,
            `${xMm}mm`,
            'rgba(21, 128, 61, 0.88)',
            isSel,
          );
        }
      }

      // Repisas horizontales
      for (const sh of hShelves) {
        const proj = projectHShelf(sh, toCanvas, e, xf, yf);
        if (!proj) continue;
        const isSel = selectedLine?.kind === 'hShelf' && selectedLine.id === sh.id;
        const isHov =
          (hoverTarget.kind === 'lineBody' || hoverTarget.kind === 'lineEnd') &&
          hoverTarget.lineRef?.kind === 'hShelf' &&
          hoverTarget.lineRef.id === sh.id;

        if (isSel || isHov) {
          ctx.strokeStyle = isSel ? 'rgba(56, 189, 248, 0.55)' : 'rgba(245, 158, 11, 0.40)';
          ctx.lineWidth = Math.max(8, cw / 120);
          ctx.beginPath();
          ctx.moveTo(proj.p0.x, proj.p0.y);
          ctx.lineTo(proj.p1.x, proj.p1.y);
          ctx.stroke();
        }

        ctx.strokeStyle = isSel ? '#38bdf8' : '#f59e0b';
        ctx.lineWidth = Math.max(isSel ? 4.2 : 3, cw / (isSel ? 220 : 290));
        ctx.beginPath();
        ctx.moveTo(proj.p0.x, proj.p0.y);
        ctx.lineTo(proj.p1.x, proj.p1.y);
        ctx.stroke();

        if (traceStep === 'lines') {
          drawEndpointHandle(
            proj.p0,
            isSel,
            isHov && hoverTarget.linePart === 'start',
            '#d97706',
          );
          drawEndpointHandle(
            proj.p1,
            isSel,
            isHov && hoverTarget.linePart === 'end',
            '#d97706',
          );
          const yMm = Math.round(e + sh.position * yInt);
          drawLineBadge(
            (proj.p0.x + proj.p1.x) / 2,
            (proj.p0.y + proj.p1.y) / 2,
            `${yMm}mm`,
            'rgba(180, 83, 9, 0.88)',
            isSel,
          );
        }
      }

      // Divisiones diagonales (seleccionables, arrastrables completas o por sus 2 extremos)
      for (const diag of diagonalDividers) {
        const proj = projectDiagonal(diag, toCanvas, e, xf, yf);
        if (!proj) continue;
        const isSel = selectedLine?.kind === 'diagonal' && selectedLine.id === diag.id;
        const isHov =
          (hoverTarget.kind === 'lineBody' || hoverTarget.kind === 'lineEnd') &&
          hoverTarget.lineRef?.kind === 'diagonal' &&
          hoverTarget.lineRef.id === diag.id;

        if (isSel || isHov) {
          ctx.strokeStyle = isSel ? 'rgba(56, 189, 248, 0.55)' : 'rgba(217, 70, 239, 0.40)';
          ctx.lineWidth = Math.max(8, cw / 120);
          ctx.beginPath();
          ctx.moveTo(proj.p0.x, proj.p0.y);
          ctx.lineTo(proj.p1.x, proj.p1.y);
          ctx.stroke();
        }

        ctx.strokeStyle = isSel ? '#38bdf8' : '#d946ef';
        ctx.lineWidth = Math.max(isSel ? 4.4 : 3.2, cw / (isSel ? 215 : 275));
        ctx.beginPath();
        ctx.moveTo(proj.p0.x, proj.p0.y);
        ctx.lineTo(proj.p1.x, proj.p1.y);
        ctx.stroke();

        if (traceStep === 'lines') {
          drawEndpointHandle(
            proj.p0,
            isSel,
            isHov && hoverTarget.linePart === 'start',
            '#a21caf',
          );
          drawEndpointHandle(
            proj.p1,
            isSel,
            isHov && hoverTarget.linePart === 'end',
            '#a21caf',
          );
          const dxD = (diag.u2 - diag.u1) * xInt;
          const dyD = (diag.v2 - diag.v1) * yInt;
          const lenMm = Math.round(Math.hypot(dxD, dyD));
          const deg = Math.round(Math.abs((Math.atan2(dyD, dxD) * 180) / Math.PI));
          drawLineBadge(
            (proj.p0.x + proj.p1.x) / 2,
            (proj.p0.y + proj.p1.y) / 2,
            `${deg}° · ${lenMm}mm`,
            'rgba(134, 25, 143, 0.90)',
            isSel,
          );
        }
      }

      // 4C. Vista previa EN VIVO del nuevo trazo (`liveStroke`)
      if (liveStroke) {
        const previewVec = vectorizeUserStroke(
          liveStroke.startImg,
          liveStroke.currentImg,
          homography.toUnit,
          vDividers,
          hShelves,
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
            lbl = `⟋ Diagonal ${Math.abs(previewVec.angleDeg)}° · ${previewVec.spanMm} mm`;
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
            lbl = `→ Repisa Y=${previewVec.positionMm} mm (luz ${previewVec.spanMm} mm)`;
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
            lbl = `↓ Divisor X=${previewVec.positionMm} mm (alto ${previewVec.spanMm} mm)`;
          }

          if (pA && pB) {
            ctx.strokeStyle = strokeCol;
            ctx.lineWidth = Math.max(4, cw / 220);
            ctx.setLineDash([10, 6]);
            ctx.beginPath();
            ctx.moveTo(pA.x, pA.y);
            ctx.lineTo(pB.x, pB.y);
            ctx.stroke();
            ctx.setLineDash([]);

            drawLineBadge(
              (pA.x + pB.x) / 2,
              (pA.y + pB.y) / 2,
              lbl,
              'rgba(15, 23, 42, 0.92)',
              true,
            );
          }
        } else {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(liveStroke.startImg.x, liveStroke.startImg.y);
          ctx.lineTo(liveStroke.currentImg.x, liveStroke.currentImg.y);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 4D. Calibración A4
      if (calibPts.length >= 1) {
        const markerR = Math.max(7, cw / 115);
        ctx.save();
        if (calibPts.length === 2) {
          ctx.strokeStyle = '#ec4899';
          ctx.lineWidth = Math.max(3, cw / 290);
          ctx.beginPath();
          ctx.moveTo(calibPts[0].x, calibPts[0].y);
          ctx.lineTo(calibPts[1].x, calibPts[1].y);
          ctx.stroke();
          drawLineBadge(
            (calibPts[0].x + calibPts[1].x) / 2,
            (calibPts[0].y + calibPts[1].y) / 2,
            `Ref: ${calibRefMm} mm`,
            'rgba(190, 24, 93, 0.92)',
            true,
          );
        }
        for (const cp of calibPts) {
          ctx.fillStyle = '#ec4899';
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, markerR, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 5. Contorno exterior (siempre nítido; manijas interactivas SOLO en Paso 1 o Vista Lateral)
    ctx.save();
    ctx.strokeStyle = traceStep === 'frame' || viewTab === 'lateral' ? '#38bdf8' : '#00e5ff';
    ctx.lineWidth = Math.max(traceStep === 'frame' ? 3.2 : 2.2, cw / 300);
    ctx.beginPath();
    activeQuad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    // Resaltar arista hovered en Paso 1 y mostrar manijas en los 4 bordes
    const showFrameHandles =
      (viewTab === 'frontal' && traceStep === 'frame' && subTool === 'none') ||
      viewTab === 'lateral';

    if (showFrameHandles && pickingCorners === null) {
      // Guías sutiles de perspectiva al arrastrar el marco en Paso 1
      if (isDragging && viewTab === 'frontal' && homography) {
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.50)';
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

      // Manijas en el punto medio de cada una de las 4 aristas (para arrastrar borde completo)
      for (let edgeIdx = 0; edgeIdx < 4; edgeIdx++) {
        const a = activeQuad[edgeIdx];
        const b = activeQuad[(edgeIdx + 1) % 4];
        const isEdgeHovered = hoverTarget.kind === 'edge' && hoverTarget.edgeIdx === edgeIdx;
        if (isEdgeHovered) {
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = Math.max(5.5, cw / 170);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const pillW = Math.max(20, cw / 42);
        const pillH = Math.max(7, cw / 130);
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(angle);
        ctx.fillStyle = isEdgeHovered ? '#facc15' : '#ffffff';
        ctx.strokeStyle = '#0284c7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(-pillW / 2, -pillH / 2, pillW, pillH, pillH / 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Manijas en las 4 esquinas con halo visual claro
      const nodeR = Math.max(13, cw / 68);
      activeQuad.forEach((p, idx) => {
        const isCornerHot = hoverTarget.kind === 'corner' && hoverTarget.idx === idx;
        ctx.save();
        if (isCornerHot) {
          ctx.fillStyle = 'rgba(250, 204, 21, 0.35)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, nodeR * 1.55, 0, Math.PI * 2);
          ctx.fill();
        }
        if (frameMode === 'box' && viewTab === 'frontal') {
          const hs = nodeR * 1.35;
          ctx.fillStyle = isCornerHot ? '#f59e0b' : '#0284c7';
          ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.4;
          ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
        } else {
          ctx.fillStyle = isCornerHot ? '#f59e0b' : '#0284c7';
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
        ctx.restore();
      });
    }
    ctx.restore();

    // 6. Modo guiado 4 toques secuenciales (1 → 2 → 3 → 4)
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

        if (loupeFocusPt) {
          const lastPt = pickingCorners[pickingCorners.length - 1];
          ctx.setLineDash([7, 5]);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = Math.max(2, cw / 360);
          ctx.beginPath();
          ctx.moveTo(lastPt.x, lastPt.y);
          ctx.lineTo(loupeFocusPt.x, loupeFocusPt.y);
          if (pickingCorners.length === 3) {
            ctx.lineTo(pickingCorners[0].x, pickingCorners[0].y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }

        if (pickingCorners.length === 3) {
          const proj4 = {
            x: pickingCorners[0].x + (pickingCorners[2].x - pickingCorners[1].x),
            y: pickingCorners[0].y + (pickingCorners[2].y - pickingCorners[1].y),
          };
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(proj4.x, proj4.y, pickR * 0.85, 0, Math.PI * 2);
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
          ctx.font = `bold ${Math.round(pickR * 1.05)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(idx + 1), pt.x, pt.y);
        });
      }
      ctx.restore();
    }

    // 7. Indicador visual luminoso del punto imantado (Sobel / Unión T / Borde)
    if (snapIndicator) {
      const sp = snapIndicator.pt;
      const color =
        snapIndicator.kind === 'tjunction'
          ? '#fbbf24'
          : snapIndicator.kind === 'wall'
            ? '#38bdf8'
            : '#22d3ee';
      const ringR = Math.max(9, cw / 95);
      ctx.save();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, ringR * 1.5, 0, Math.PI * 2);
      ctx.fillStyle =
        snapIndicator.kind === 'tjunction'
          ? 'rgba(251, 191, 36, 0.25)'
          : 'rgba(34, 211, 238, 0.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }
  }, [
    canvasRef,
    activeBmp,
    sobelCanvas,
    viewTab,
    traceStep,
    frameMode,
    subTool,
    visualLayer,
    strokeMode,
    activeQuad,
    homography,
    vDividers,
    hShelves,
    diagonalDividers,
    frontZones,
    photoVectorLines,
    params.boardThickness,
    params.targetDimensions,
    selectedZoneId,
    hoveredZoneId,
    selectedLine,
    hoverTarget,
    pickingCorners,
    calibPts,
    calibRefMm,
    liveStroke,
    snapIndicator,
    loupeFocusPt,
    isDragging,
  ]);

  // Render de la Lupa 4× fija en el viewport visible (centrada en `loupeFocusPt` ya imantado)
  useEffect(() => {
    const loupe = loupeCanvasRef.current;
    if (!loupe || !activeBmp || !loupeFocusPt) return;
    const ctx = loupe.getContext('2d');
    if (!ctx) return;

    loupe.width = LOUPE_SIZE;
    loupe.height = LOUPE_SIZE;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

    const half = LOUPE_SIZE / 2;
    const toLoupe = (pt: Point2D): Point2D => ({
      x: half + (pt.x - loupeFocusPt.x) * LOUPE_ZOOM,
      y: half + (pt.y - loupeFocusPt.y) * LOUPE_ZOOM,
    });

    // Foto ampliada 4× centrada exactamente en `loupeFocusPt`
    const srcSpan = LOUPE_SIZE / LOUPE_ZOOM;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      activeBmp.canvas,
      loupeFocusPt.x - srcSpan / 2,
      loupeFocusPt.y - srcSpan / 2,
      srcSpan,
      srcSpan,
      0,
      0,
      LOUPE_SIZE,
      LOUPE_SIZE,
    );

    // Proyectar contorno exterior y líneas trazadas dentro de la lupa
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    activeQuad.forEach((p, idx) => {
      const lp = toLoupe(p);
      if (idx === 0) ctx.moveTo(lp.x, lp.y);
      else ctx.lineTo(lp.x, lp.y);
    });
    ctx.closePath();
    ctx.stroke();

    if (viewTab === 'frontal' && homography) {
      const e = params.boardThickness;
      const xf = params.targetDimensions.x;
      const yf = params.targetDimensions.y;

      const drawSegInLoupe = (p0: Point2D, p1: Point2D, color: string, dashed = false) => {
        const a = toLoupe(p0);
        const b = toLoupe(p1);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.2;
        if (dashed) ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      };

      for (const div of vDividers) {
        const p = projectVDivider(div, homography.toCanvas, e, xf, yf);
        if (p) drawSegInLoupe(p.p0, p.p1, '#22c55e');
      }
      for (const sh of hShelves) {
        const p = projectHShelf(sh, homography.toCanvas, e, xf, yf);
        if (p) drawSegInLoupe(p.p0, p.p1, '#f59e0b');
      }
      for (const dg of diagonalDividers) {
        const p = projectDiagonal(dg, homography.toCanvas, e, xf, yf);
        if (p) drawSegInLoupe(p.p0, p.p1, '#d946ef');
      }
      if (liveStroke) {
        drawSegInLoupe(liveStroke.startImg, liveStroke.currentImg, '#38bdf8', true);
      }
    }

    // Cruz de precisión central
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(half - 16, half);
    ctx.lineTo(half - 4, half);
    ctx.moveTo(half + 4, half);
    ctx.lineTo(half + 16, half);
    ctx.moveTo(half, half - 16);
    ctx.lineTo(half, half - 4);
    ctx.moveTo(half, half + 4);
    ctx.lineTo(half, half + 16);
    ctx.stroke();

    ctx.strokeStyle = snapIndicator ? '#fbbf24' : '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(half - 15, half);
    ctx.lineTo(half - 4, half);
    ctx.moveTo(half + 4, half);
    ctx.lineTo(half + 15, half);
    ctx.moveTo(half, half - 15);
    ctx.lineTo(half, half - 4);
    ctx.moveTo(half, half + 4);
    ctx.lineTo(half, half + 15);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(half, half, snapIndicator ? 5.5 : 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }, [
    activeBmp,
    loupeFocusPt,
    activeQuad,
    viewTab,
    homography,
    vDividers,
    hShelves,
    diagonalDividers,
    liveStroke,
    params.boardThickness,
    params.targetDimensions,
    snapIndicator,
  ]);

  const effectiveTouchAction =
    traceStep === 'zones' && !isPanning && !isSpacePan && zoom <= 1.02 && subTool === 'none'
      ? 'pan-y'
      : 'none';

  return (
    <div
      ref={stageRef}
      className={`vc-viewport-stage${isDragOver ? ' drag-over' : ''}${
        zoom > 1.02 ? ' is-zoomed' : ''
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {activeBmp ? (
        <>
          <div
            className="vc-viewport-transform"
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            }}
          >
            <canvas
              ref={canvasRef}
              className="vc-photo-canvas"
              style={{ cursor: canvasCursor, touchAction: effectiveTouchAction }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onPointerLeave={onPointerLeave}
            />
          </div>

          {/* Lupa 4× fija dentro del viewport visible (nunca cortada fuera del scroll) */}
          {loupeFocusPt && (
            <div
              className={`vc-loupe-overlay vc-loupe-${loupeSide}`}
              aria-hidden="true"
            >
              <canvas ref={loupeCanvasRef} className="vc-loupe-canvas" />
              <div className="vc-loupe-footer">
                {subTool === 'eyedropper' && eyedropperPreview ? (
                  <span className="vc-loupe-color">
                    <i
                      className="vc-loupe-swatch"
                      style={{
                        backgroundColor: `rgb(${eyedropperPreview.rgb[0]}, ${eyedropperPreview.rgb[1]}, ${eyedropperPreview.rgb[2]})`,
                      }}
                    />
                    {MELAMINE_LABELS[eyedropperPreview.material]}
                  </span>
                ) : snapIndicator ? (
                  <span className="vc-loupe-snap">● {snapIndicator.label}</span>
                ) : (
                  <span>Lupa 4×</span>
                )}
                <span className="vc-loupe-coords">
                  {Math.round(loupeFocusPt.x)},{Math.round(loupeFocusPt.y)}
                </span>
              </div>
            </div>
          )}

          {/* Indicador sutil de zoom/pan activo */}
          {(zoom !== 1 || isSpacePan) && (
            <div className="vc-viewport-hud" aria-hidden="true">
              {Math.round(zoom * 100)}%{isSpacePan ? ' · Pan (Espacio)' : ''}
            </div>
          )}
        </>
      ) : (
        <div className="vc-dropzone">
          <Upload size={34} />
          <strong>
            {viewTab === 'frontal'
              ? 'Sube la foto de tu mueble y calca sus márgenes para generar el 3D exacto'
              : 'Sube una foto lateral (perfil) para estimar la profundidad Z'}
          </strong>
          <p className="vc-dropzone-desc">
            {viewTab === 'frontal'
              ? '1) Ajusta contorno exterior (4 esquinas o bordes) · 2) Traza o mueve líneas rectas y diagonales · 3) Define puertas, cajones, canastos o recortes.'
              : 'Ajusta las 4 esquinas sobre el costado del mueble y el sistema calculará la profundidad Z en milímetros.'}
          </p>
          <div className="vc-dropzone-actions">
            <button type="button" className="vc-btn vc-btn-primary" onClick={onTriggerUpload}>
              <Camera size={14} /> Elegir foto (o arrastra aquí)
            </button>
            {viewTab === 'frontal' && (
              <button type="button" className="vc-btn vc-btn-secondary" onClick={onLoadSample}>
                <Sparkles size={14} /> Probar con escritorio de muestra
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
