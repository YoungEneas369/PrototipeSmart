/**
 * SMARTFURNITURE — EXTRACTOR DE LÍNEAS VECTORIALES 2D + EVALUADOR MÁRGENES/3D vs FOTO (v5.0)
 * 100% offline, TypeScript puro (cero DOM, cero React, cero dependencias externas).
 *
 * 1. `extractStructuralVectorLines`: Convierte los bordes reales de la foto en segmentos
 *    vectoriales explícitos (`VectorLine2D`: p1, p2, Δx, Δy, ||v||, vector unitario û, rol).
 * 2. `evaluateMarginsAgainstPhoto`: Evalúa qué tan bien calzan los márgenes y líneas vectoriales
 *    propuestos contra los bordes y la silueta real de la foto subida.
 * 3. `evaluate3DvsPhotoSimilarity`: Proyecta el modelo 3D real (`DespieceResult`) sobre el frente
 *    de la foto rectificada y mide similitud estructural, de silueta y de color zona por zona.
 */
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
  calculateDespiece,
  computeQuadToUnitHomography,
  exteriorToInterior,
} from '../mathEngine';
import {
  analyzeRectifiedFurniture,
  detectLowerGapHint,
  type BandDetectionResult,
  type LowerGapHintResult,
} from './bandDetector';
import {
  autoDetectFurnitureQuad,
  computeRectifiedSize,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  rectifyImageRGBA,
  type AutoQuadResult,
  type CameraPoseEstimate,
} from './rectify';

export type VectorLineOrientation = 'horizontal' | 'vertical' | 'diagonal';
export type VectorLineRole =
  | 'outer_top'
  | 'outer_bottom'
  | 'outer_left'
  | 'outer_right'
  | 'divider'
  | 'shelf'
  | 'seam'
  | 'detail';

export interface VectorLine2D {
  id: string;
  p1: Point2D;
  p2: Point2D;
  dx: number;
  dy: number;
  lengthPx: number;
  unitVec: [number, number];
  angleDeg: number;
  orientation: VectorLineOrientation;
  role: VectorLineRole;
  strength: number;
  /** Coordenadas normalizadas dentro del marco exterior [0..1] (x: izq->der, y: abajo->arriba). */
  normStart?: Point2D;
  normEnd?: Point2D;
}

export interface VectorLineExtractionResult {
  lines: VectorLine2D[];
  horizontalCount: number;
  verticalCount: number;
  diagonalCount: number;
  outerFrameLines: VectorLine2D[];
  interiorLines: VectorLine2D[];
  /** Caja ajustada usando vectores de contorno reales si fueron consistentes. */
  refinedBox?: [Point2D, Point2D, Point2D, Point2D];
}

export interface MarginEvaluationResult {
  silhouetteIoU: number;
  edgeAlignmentScore: number;
  vectorCoverageScore: number;
  overallScore: number; // 0..100
  perEdgeSupport: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  verdict: 'excelente' | 'aceptable' | 'revisar';
  notes: string[];
}

export interface Visual3DSimilarityResult {
  silhouetteMatch: number;
  edgeStructureMatch: number;
  colorPaletteMatch: number;
  overallScore: number; // 0..100
  verdict: 'alto_parecido' | 'parecido_medio' | 'bajo_parecido';
  mismatches: string[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function makeVectorLine(
  id: string,
  p1: Point2D,
  p2: Point2D,
  orientation: VectorLineOrientation,
  role: VectorLineRole,
  strength: number,
  frameBounds?: { x0: number; y0: number; x1: number; y1: number },
): VectorLine2D {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthPx = Math.hypot(dx, dy);
  const ux = lengthPx > 1e-6 ? dx / lengthPx : 1;
  const uy = lengthPx > 1e-6 ? dy / lengthPx : 0;
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  let normStart: Point2D | undefined;
  let normEnd: Point2D | undefined;
  if (frameBounds && frameBounds.x1 > frameBounds.x0 && frameBounds.y1 > frameBounds.y0) {
    const fw = frameBounds.x1 - frameBounds.x0;
    const fh = frameBounds.y1 - frameBounds.y0;
    normStart = {
      x: Number(clamp((p1.x - frameBounds.x0) / fw, 0, 1).toFixed(4)),
      y: Number(clamp(1 - (p1.y - frameBounds.y0) / fh, 0, 1).toFixed(4)),
    };
    normEnd = {
      x: Number(clamp((p2.x - frameBounds.x0) / fw, 0, 1).toFixed(4)),
      y: Number(clamp(1 - (p2.y - frameBounds.y0) / fh, 0, 1).toFixed(4)),
    };
  }

  return {
    id,
    p1: { x: Number(p1.x.toFixed(1)), y: Number(p1.y.toFixed(1)) },
    p2: { x: Number(p2.x.toFixed(1)), y: Number(p2.y.toFixed(1)) },
    dx: Number(dx.toFixed(1)),
    dy: Number(dy.toFixed(1)),
    lengthPx: Number(lengthPx.toFixed(1)),
    unitVec: [Number(ux.toFixed(4)), Number(uy.toFixed(4))],
    angleDeg: Number(angleDeg.toFixed(1)),
    orientation,
    role,
    strength: Number(clamp(strength, 0, 1).toFixed(3)),
    normStart,
    normEnd,
  };
}

/**
 * Calcula mapas de gradiente cromático + luminancia con suavizado Gaussiano 3×3
 * y supresión direccional de no-máximos (NMS) para extraer segmentos vectoriales limpios.
 */
export function extractStructuralVectorLines(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  frameQuad?: readonly [Point2D, Point2D, Point2D, Point2D],
): VectorLineExtractionResult {
  if (imgW < 24 || imgH < 24 || rgba.length < imgW * imgH * 4) {
    return {
      lines: [],
      horizontalCount: 0,
      verticalCount: 0,
      diagonalCount: 0,
      outerFrameLines: [],
      interiorLines: [],
    };
  }

  // Trabajar sobre malla nítida (máx 420 px) para velocidad < 25 ms con alta precisión de líneas
  const maxWork = 420;
  const scale = Math.min(1, maxWork / Math.max(imgW, imgH));
  const W = Math.max(32, Math.round(imgW * scale));
  const H = Math.max(32, Math.round(imgH * scale));
  const invScaleX = imgW / W;
  const invScaleY = imgH / H;
  const n = W * H;

  const chR = new Float32Array(n);
  const chG = new Float32Array(n);
  const chB = new Float32Array(n);

  for (let y = 0; y < H; y++) {
    const sy = Math.min(imgH - 1, Math.floor(((y + 0.5) / H) * imgH));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(imgW - 1, Math.floor(((x + 0.5) / W) * imgW));
      const si = (sy * imgW + sx) * 4;
      const gi = y * W + x;
      if (rgba[si + 3] < 128) {
        chR[gi] = 255;
        chG[gi] = 255;
        chB[gi] = 255;
      } else {
        chR[gi] = rgba[si];
        chG[gi] = rgba[si + 1];
        chB[gi] = rgba[si + 2];
      }
    }
  }

  // Suavizado Gaussiano 3×3 por canal (preserva bordes rectos de melamina, atenúa grano y ruido JPEG/WebP)
  const smoothChannel = (src: Float32Array): Float32Array => {
    const dst = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (y === 0 || y === H - 1 || x === 0 || x === W - 1) {
          dst[y * W + x] = src[y * W + x];
        } else {
          const u = (y - 1) * W;
          const m = y * W;
          const d = (y + 1) * W;
          dst[m + x] =
            (src[u + x - 1] +
              2 * src[u + x] +
              src[u + x + 1] +
              2 * src[m + x - 1] +
              4 * src[m + x] +
              2 * src[m + x + 1] +
              src[d + x - 1] +
              2 * src[d + x] +
              src[d + x + 1]) /
            16;
        }
      }
    }
    return dst;
  };

  const sR = smoothChannel(chR);
  const sG = smoothChannel(chG);
  const sB = smoothChannel(chB);

  // Gradiente vectorial máximo entre canales R, G, B (detecta cambios de color incluso a igual luminancia)
  const gxMap = new Float32Array(n);
  const gyMap = new Float32Array(n);
  const hEdge = new Float32Array(n);
  const vEdge = new Float32Array(n);
  const dEdge = new Float32Array(n);

  const sobelAt = (arr: Float32Array, u: number, m: number, d: number, x: number): [number, number] => {
    const gx =
      -arr[u + x - 1] +
      arr[u + x + 1] -
      2 * arr[m + x - 1] +
      2 * arr[m + x + 1] -
      arr[d + x - 1] +
      arr[d + x + 1];
    const gy =
      -arr[u + x - 1] -
      2 * arr[u + x] -
      arr[u + x + 1] +
      arr[d + x - 1] +
      2 * arr[d + x] +
      arr[d + x + 1];
    return [gx, gy];
  };

  const gradMags: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    const u = (y - 1) * W;
    const m = y * W;
    const d = (y + 1) * W;
    for (let x = 1; x < W - 1; x++) {
      const [rx, ry] = sobelAt(sR, u, m, d, x);
      const [gx, gy] = sobelAt(sG, u, m, d, x);
      const [bx, by] = sobelAt(sB, u, m, d, x);
      const rm = Math.hypot(rx, ry);
      const gm = Math.hypot(gx, gy);
      const bm = Math.hypot(bx, by);
      let bestGx = rx;
      let bestGy = ry;
      let bestM = rm;
      if (gm > bestM) {
        bestGx = gx;
        bestGy = gy;
        bestM = gm;
      }
      if (bm > bestM) {
        bestGx = bx;
        bestGy = by;
        bestM = bm;
      }
      const idx = m + x;
      gxMap[idx] = bestGx;
      gyMap[idx] = bestGy;
      if (bestM > 18) gradMags.push(bestM);
    }
  }

  // Umbral adaptativo por percentil (robusto a fotos oscuras o muy claras)
  gradMags.sort((a, b) => a - b);
  const p70 = gradMags.length > 30 ? gradMags[Math.floor(gradMags.length * 0.7)] : 48;
  const edgeThresh = clamp(p70 * 0.52, 26, 82);

  // Supresión direccional de no-máximos (NMS) separando bordes horizontales, verticales y diagonales
  for (let y = 2; y < H - 2; y++) {
    const m = y * W;
    for (let x = 2; x < W - 2; x++) {
      const idx = m + x;
      const agx = Math.abs(gxMap[idx]);
      const agy = Math.abs(gyMap[idx]);
      const mag = Math.hypot(agx, agy);
      if (mag < edgeThresh) continue;

      if (agy >= agx * 1.45) {
        // Borde horizontal: máximo local a lo largo de Y
        const upM = Math.abs(gyMap[(y - 1) * W + x]);
        const dnM = Math.abs(gyMap[(y + 1) * W + x]);
        if (agy >= upM && agy >= dnM) {
          hEdge[idx] = mag;
        }
      } else if (agx >= agy * 1.45) {
        // Borde vertical: máximo local a lo largo de X
        const ltM = Math.abs(gxMap[m + x - 1]);
        const rtM = Math.abs(gxMap[m + x + 1]);
        if (agx >= ltM && agx >= rtM) {
          vEdge[idx] = mag;
        }
      } else {
        dEdge[idx] = mag;
      }
    }
  }

  // Límites del marco exterior (si se entregó) en espacio imagen
  let frameBounds: { x0: number; y0: number; x1: number; y1: number } | undefined;
  let roiX0 = 2;
  let roiX1 = W - 3;
  let roiY0 = 2;
  let roiY1 = H - 3;

  if (frameQuad) {
    const xs = frameQuad.map((p) => p.x);
    const ys = frameQuad.map((p) => p.y);
    frameBounds = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };
    // Buscar líneas dentro del marco + un margen de 8% alrededor para evaluar márgenes exteriores
    const padX = Math.max(8, Math.round(((frameBounds.x1 - frameBounds.x0) * 0.08) / invScaleX));
    const padY = Math.max(8, Math.round(((frameBounds.y1 - frameBounds.y0) * 0.08) / invScaleY));
    roiX0 = Math.max(2, Math.floor(frameBounds.x0 / invScaleX) - padX);
    roiX1 = Math.min(W - 3, Math.ceil(frameBounds.x1 / invScaleX) + padX);
    roiY0 = Math.max(2, Math.floor(frameBounds.y0 / invScaleY) - padY);
    roiY1 = Math.min(H - 3, Math.ceil(frameBounds.y1 / invScaleY) + padY);
  }

  interface RawSeg {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    strength: number;
    orientation: VectorLineOrientation;
  }

  const rawHoriz: RawSeg[] = [];
  const rawVert: RawSeg[] = [];
  const minHorizLen = Math.max(14, Math.round((roiX1 - roiX0) * 0.11));
  const minVertLen = Math.max(14, Math.round((roiY1 - roiY0) * 0.11));
  const gapTol = 4;

  // Trazado de vectores horizontales con tolerancia de ±1 px en Y (captura líneas rectas con leve inclinación)
  const visitedH = new Uint8Array(n);
  for (let y = roiY0; y <= roiY1; y++) {
    for (let x = roiX0; x <= roiX1; x++) {
      const startIdx = y * W + x;
      if (hEdge[startIdx] <= 0 || visitedH[startIdx]) continue;

      let cx = x;
      let cy = y;
      let gaps = 0;
      let endX = x;
      let endY = y;
      let sumS = hEdge[startIdx];
      let hits = 1;
      visitedH[startIdx] = 1;

      while (cx + 1 <= roiX1) {
        cx++;
        let bestY = -1;
        let bestVal = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < roiY0 || ny > roiY1) continue;
          const v = hEdge[ny * W + cx];
          if (v > bestVal && !visitedH[ny * W + cx]) {
            bestVal = v;
            bestY = ny;
          }
        }
        if (bestY >= 0) {
          cy = bestY;
          visitedH[cy * W + cx] = 1;
          endX = cx;
          endY = cy;
          sumS += bestVal;
          hits++;
          gaps = 0;
        } else {
          gaps++;
          if (gaps > gapTol) break;
        }
      }

      const len = Math.hypot(endX - x, endY - y);
      if (len >= minHorizLen && hits / Math.max(1, endX - x + 1) >= 0.58) {
        const slopeDeg = Math.abs((Math.atan2(endY - y, endX - x) * 180) / Math.PI);
        rawHoriz.push({
          x1: x,
          y1: y,
          x2: endX,
          y2: endY,
          strength: Math.min(1, sumS / hits / 220),
          orientation: slopeDeg > 7 ? 'diagonal' : 'horizontal',
        });
      }
    }
  }

  // Trazado de vectores verticales con tolerancia de ±1 px en X
  const visitedV = new Uint8Array(n);
  for (let x = roiX0; x <= roiX1; x++) {
    for (let y = roiY0; y <= roiY1; y++) {
      const startIdx = y * W + x;
      if (vEdge[startIdx] <= 0 || visitedV[startIdx]) continue;

      let cx = x;
      let cy = y;
      let gaps = 0;
      let endX = x;
      let endY = y;
      let sumS = vEdge[startIdx];
      let hits = 1;
      visitedV[startIdx] = 1;

      while (cy + 1 <= roiY1) {
        cy++;
        let bestX = -1;
        let bestVal = 0;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < roiX0 || nx > roiX1) continue;
          const v = vEdge[cy * W + nx];
          if (v > bestVal && !visitedV[cy * W + nx]) {
            bestVal = v;
            bestX = nx;
          }
        }
        if (bestX >= 0) {
          cx = bestX;
          visitedV[cy * W + cx] = 1;
          endX = cx;
          endY = cy;
          sumS += bestVal;
          hits++;
          gaps = 0;
        } else {
          gaps++;
          if (gaps > gapTol) break;
        }
      }

      const len = Math.hypot(endX - x, endY - y);
      if (len >= minVertLen && hits / Math.max(1, endY - y + 1) >= 0.58) {
        const tiltDeg = Math.abs((Math.atan2(endX - x, endY - y) * 180) / Math.PI);
        rawVert.push({
          x1: x,
          y1: y,
          x2: endX,
          y2: endY,
          strength: Math.min(1, sumS / hits / 220),
          orientation: tiltDeg > 7 ? 'diagonal' : 'vertical',
        });
      }
    }
  }

  // Fusión de segmentos colineales cercanos (elimina fragmentos partidos por tiradores o brillo)
  const mergeCollinear = (segs: RawSeg[], isHoriz: boolean): RawSeg[] => {
    const sorted = [...segs].sort((a, b) =>
      isHoriz
        ? (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2 || a.x1 - b.x1
        : (a.x1 + a.x2) / 2 - (b.x1 + b.x2) / 2 || a.y1 - b.y1,
    );
    const out: RawSeg[] = [];
    const perpTol = 3.5;
    const endGapTol = 12;

    for (const s of sorted) {
      let merged = false;
      for (const m of out) {
        if (m.orientation !== s.orientation) continue;
        if (isHoriz) {
          const ym = (m.y1 + m.y2) / 2;
          const ys = (s.y1 + s.y2) / 2;
          if (
            Math.abs(ym - ys) <= perpTol &&
            s.x1 <= m.x2 + endGapTol &&
            s.x2 >= m.x1 - endGapTol
          ) {
            const lenM = Math.max(1, m.x2 - m.x1);
            const lenS = Math.max(1, s.x2 - s.x1);
            const newY = (ym * lenM + ys * lenS) / (lenM + lenS);
            m.x1 = Math.min(m.x1, s.x1);
            m.x2 = Math.max(m.x2, s.x2);
            if (m.orientation === 'horizontal') {
              m.y1 = newY;
              m.y2 = newY;
            }
            m.strength = Math.max(m.strength, s.strength);
            merged = true;
            break;
          }
        } else {
          const xm = (m.x1 + m.x2) / 2;
          const xs = (s.x1 + s.x2) / 2;
          if (
            Math.abs(xm - xs) <= perpTol &&
            s.y1 <= m.y2 + endGapTol &&
            s.y2 >= m.y1 - endGapTol
          ) {
            const lenM = Math.max(1, m.y2 - m.y1);
            const lenS = Math.max(1, s.y2 - s.y1);
            const newX = (xm * lenM + xs * lenS) / (lenM + lenS);
            m.y1 = Math.min(m.y1, s.y1);
            m.y2 = Math.max(m.y2, s.y2);
            if (m.orientation === 'vertical') {
              m.x1 = newX;
              m.x2 = newX;
            }
            m.strength = Math.max(m.strength, s.strength);
            merged = true;
            break;
          }
        }
      }
      if (!merged) out.push({ ...s });
    }
    return out;
  };

  const mergedH = mergeCollinear(rawHoriz, true);
  const mergedV = mergeCollinear(rawVert, false);

  // Clasificar cada vector según su posición respecto a los márgenes del mueble
  const classifyRole = (seg: RawSeg): VectorLineRole => {
    const ix1 = seg.x1 * invScaleX;
    const iy1 = seg.y1 * invScaleY;
    const ix2 = seg.x2 * invScaleX;
    const iy2 = seg.y2 * invScaleY;
    if (!frameBounds) return seg.orientation === 'horizontal' ? 'shelf' : 'divider';

    const fw = Math.max(1, frameBounds.x1 - frameBounds.x0);
    const fh = Math.max(1, frameBounds.y1 - frameBounds.y0);
    const midX = (ix1 + ix2) / 2;
    const midY = (iy1 + iy2) / 2;
    const lenX = Math.abs(ix2 - ix1);
    const lenY = Math.abs(iy2 - iy1);
    const borderTolX = Math.max(8, fw * 0.055);
    const borderTolY = Math.max(8, fh * 0.055);

    if (seg.orientation === 'horizontal') {
      if (Math.abs(midY - frameBounds.y0) <= borderTolY && lenX >= fw * 0.25) return 'outer_top';
      if (Math.abs(midY - frameBounds.y1) <= borderTolY && lenX >= fw * 0.22) return 'outer_bottom';
      if (
        midX >= frameBounds.x0 - borderTolX &&
        midX <= frameBounds.x1 + borderTolX &&
        midY > frameBounds.y0 + borderTolY &&
        midY < frameBounds.y1 - borderTolY
      ) {
        return lenX >= fw * 0.2 ? 'shelf' : 'seam';
      }
      return 'detail';
    }

    if (seg.orientation === 'vertical') {
      if (Math.abs(midX - frameBounds.x0) <= borderTolX && lenY >= fh * 0.25) return 'outer_left';
      if (Math.abs(midX - frameBounds.x1) <= borderTolX && lenY >= fh * 0.25) return 'outer_right';
      if (
        midY >= frameBounds.y0 - borderTolY &&
        midY <= frameBounds.y1 + borderTolY &&
        midX > frameBounds.x0 + borderTolX &&
        midX < frameBounds.x1 - borderTolX
      ) {
        return lenY >= fh * 0.24 ? 'divider' : 'seam';
      }
      return 'detail';
    }

    return 'detail';
  };

  // Mantener los vectores estructurales más significativos (top 60 por longitud × fuerza)
  const allMerged = [...mergedH, ...mergedV]
    .map((seg) => ({
      seg,
      score: Math.hypot((seg.x2 - seg.x1) * invScaleX, (seg.y2 - seg.y1) * invScaleY) * (0.4 + seg.strength),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 64);

  const lines: VectorLine2D[] = allMerged.map(({ seg }, idx) =>
    makeVectorLine(
      `vec_${idx + 1}`,
      { x: seg.x1 * invScaleX, y: seg.y1 * invScaleY },
      { x: seg.x2 * invScaleX, y: seg.y2 * invScaleY },
      seg.orientation,
      classifyRole(seg),
      seg.strength,
      frameBounds,
    ),
  );

  // Refinar la caja exterior haciendo snap a vectores de contorno + recorte de costado 3/4 y objetos decorativos
  let refinedBox: [Point2D, Point2D, Point2D, Point2D] | undefined;
  if (frameBounds) {
    const fw = Math.max(1, frameBounds.x1 - frameBounds.x0);
    const fh = Math.max(1, frameBounds.y1 - frameBounds.y0);
    let rx0 = frameBounds.x0;
    let rx1 = frameBounds.x1;
    let ry0 = frameBounds.y0;
    let ry1 = frameBounds.y1;

    const horizLines = lines.filter((l) => l.orientation === 'horizontal');
    const vertLines = lines.filter((l) => l.orientation === 'vertical');

    // 1) Snap TOP: buscar vector horizontal largo cerca del borde superior;
    // si tocó el borde superior de la foto (ej. ladrillo + cuadro en #01), solo bajar hasta 42%
    // cuando la franja superior difiera claramente en color del cuerpo inferior (evita cortar vitrinas ajustadas como #09)
    const touchedTop = frameBounds.y0 <= imgH * 0.03;
    let topCand = horizLines
      .filter((l) => {
        const ym = (l.p1.y + l.p2.y) / 2;
        return (
          ym >= frameBounds.y0 - fh * 0.06 &&
          ym <= frameBounds.y0 + fh * 0.24 &&
          l.lengthPx >= fw * 0.42
        );
      })
      .sort((a, b) => (a.p1.y + a.p2.y) / 2 - (b.p1.y + b.p2.y) / 2)[0];

    if (!topCand && touchedTop) {
      const deepCand = horizLines
        .filter((l) => {
          const ym = (l.p1.y + l.p2.y) / 2;
          return (
            ym > frameBounds.y0 + fh * 0.24 &&
            ym <= frameBounds.y0 + fh * 0.42 &&
            l.lengthPx >= fw * 0.52
          );
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];
      if (deepCand) {
        const ym = (deepCand.p1.y + deepCand.p2.y) / 2;
        const gyAbove = Math.max(0, Math.min(H - 1, Math.round((ym * 0.5) / invScaleY)));
        const gyBelow = Math.max(0, Math.min(H - 1, Math.round(((ym + frameBounds.y1) * 0.5) / invScaleY)));
        const gxMid = Math.max(0, Math.min(W - 1, Math.round(((frameBounds.x0 + frameBounds.x1) * 0.5) / invScaleX)));
        const iA = gyAbove * W + gxMid;
        const iB = gyBelow * W + gxMid;
        const warmthDiff = Math.abs((chR[iB] - chB[iB]) - (chR[iA] - chB[iA]));
        const colDiff = Math.hypot(chR[iB] - chR[iA], chG[iB] - chG[iA], chB[iB] - chB[iA]);
        if (warmthDiff > 22 || colDiff > 48) {
          topCand = deepCand;
        }
      }
    }
    if (topCand) ry0 = (topCand.p1.y + topCand.p2.y) / 2;

    // 2) Snap BOTTOM: vector horizontal largo más cercano a la base (hasta 24% arriba para saltar alfombra/piso)
    const botCand = horizLines
      .filter((l) => {
        const ym = (l.p1.y + l.p2.y) / 2;
        return (
          ym <= frameBounds.y1 + fh * 0.06 &&
          ym >= frameBounds.y1 - fh * 0.24 &&
          l.lengthPx >= fw * 0.42
        );
      })
      .sort((a, b) => (b.p1.y + b.p2.y) / 2 - (a.p1.y + a.p2.y) / 2)[0];
    if (botCand) ry1 = (botCand.p1.y + botCand.p2.y) / 2;

    // 3) Snap LEFT / RIGHT a vectores verticales exteriores dominantes
    const leftCand = vertLines
      .filter((l) => {
        const xm = (l.p1.x + l.p2.x) / 2;
        return (
          xm >= frameBounds.x0 - fw * 0.05 &&
          xm <= frameBounds.x0 + fw * 0.14 &&
          l.lengthPx >= fh * 0.34
        );
      })
      .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];
    if (leftCand) rx0 = (leftCand.p1.x + leftCand.p2.x) / 2;

    const rightCand = vertLines
      .filter((l) => {
        const xm = (l.p1.x + l.p2.x) / 2;
        return (
          xm <= frameBounds.x1 + fw * 0.05 &&
          xm >= frameBounds.x1 - fw * 0.14 &&
          l.lengthPx >= fh * 0.34
        );
      })
      .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];
    if (rightCand) rx1 = (rightCand.p1.x + rightCand.p2.x) / 2;

    // 4) Recorte de costado 3/4 (fotos en ángulo): si existe un vector vertical de altura completa
    // a 6%..22% del borde izquierdo o derecho y la franja externa NO tiene repisas/ranuras horizontales
    // mientras la cara principal sí las tiene, recortar al plano frontal real.
    const curW = rx1 - rx0;
    const curH = ry1 - ry0;
    const interiorHoriz = horizLines.filter((l) => {
      const ym = (l.p1.y + l.p2.y) / 2;
      return ym > ry0 + curH * 0.12 && ym < ry1 - curH * 0.12 && l.lengthPx >= curW * 0.16;
    });

    if (interiorHoriz.length >= 1) {
      const leftCorner = vertLines
        .filter((l) => {
          const xm = (l.p1.x + l.p2.x) / 2;
          return (
            xm > rx0 + curW * 0.065 &&
            xm < rx0 + curW * 0.22 &&
            l.lengthPx >= curH * 0.58
          );
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];

      if (leftCorner) {
        const cx = (leftCorner.p1.x + leftCorner.p2.x) / 2;
        const horizInStrip = interiorHoriz.some((h) => Math.min(h.p1.x, h.p2.x) < cx - curW * 0.04);
        const horizInMain = interiorHoriz.some((h) => Math.min(h.p1.x, h.p2.x) >= cx - curW * 0.04);
        if (!horizInStrip && horizInMain) {
          rx0 = cx;
        }
      }

      const rightCorner = vertLines
        .filter((l) => {
          const xm = (l.p1.x + l.p2.x) / 2;
          return (
            xm < rx1 - curW * 0.065 &&
            xm > rx1 - curW * 0.22 &&
            l.lengthPx >= curH * 0.58
          );
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];

      if (rightCorner) {
        const cx = (rightCorner.p1.x + rightCorner.p2.x) / 2;
        const horizInStrip = interiorHoriz.some((h) => Math.max(h.p1.x, h.p2.x) > cx + curW * 0.04);
        const horizInMain = interiorHoriz.some((h) => Math.max(h.p1.x, h.p2.x) <= cx + curW * 0.04);
        if (!horizInStrip && horizInMain) {
          rx1 = cx;
        }
      }
    }

    if (rx1 - rx0 >= fw * 0.5 && ry1 - ry0 >= fh * 0.45) {
      refinedBox = [
        { x: Math.round(rx0), y: Math.round(ry0) },
        { x: Math.round(rx1), y: Math.round(ry0) },
        { x: Math.round(rx1), y: Math.round(ry1) },
        { x: Math.round(rx0), y: Math.round(ry1) },
      ];
    }
  }

  const outerRoles = new Set<VectorLineRole>([
    'outer_top',
    'outer_bottom',
    'outer_left',
    'outer_right',
  ]);
  const outerFrameLines = lines.filter((l) => outerRoles.has(l.role));
  const interiorLines = lines.filter((l) => !outerRoles.has(l.role));

  return {
    lines,
    horizontalCount: lines.filter((l) => l.orientation === 'horizontal').length,
    verticalCount: lines.filter((l) => l.orientation === 'vertical').length,
    diagonalCount: lines.filter((l) => l.orientation === 'diagonal').length,
    outerFrameLines,
    interiorLines,
    refinedBox,
  };
}

/**
 * Evalúa cuantitativamente qué tan bien coinciden los márgenes propuestos (quad)
 * y los segmentos vectoriales extraídos con la foto real subida.
 */
export function evaluateMarginsAgainstPhoto(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  quad: readonly [Point2D, Point2D, Point2D, Point2D],
  extracted: VectorLineExtractionResult,
  exteriorBgRgb?: [number, number, number],
): MarginEvaluationResult {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const qx0 = clamp(Math.min(...xs), 0, imgW - 1);
  const qx1 = clamp(Math.max(...xs), 1, imgW - 1);
  const qy0 = clamp(Math.min(...ys), 0, imgH - 1);
  const qy1 = clamp(Math.max(...ys), 1, imgH - 1);
  const qw = Math.max(1, qx1 - qx0);
  const qh = Math.max(1, qy1 - qy0);

  // 1. Medir soporte de gradiente real directamente sobre los 4 bordes del marco
  const sampleLum = (x: number, y: number): number => {
    const ix = clamp(Math.round(x), 0, imgW - 1);
    const iy = clamp(Math.round(y), 0, imgH - 1);
    const p = (iy * imgW + ix) * 4;
    return 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  };

  const sampleEdgeSupport = (
    p1: Point2D,
    p2: Point2D,
    nx: number,
    ny: number,
    steps = 44,
  ): number => {
    let hits = 0;
    const band = Math.max(3, Math.round(Math.min(imgW, imgH) * 0.01));
    for (let k = 2; k <= steps - 2; k++) {
      const t = k / steps;
      const bx = p1.x + (p2.x - p1.x) * t;
      const by = p1.y + (p2.y - p1.y) * t;
      let maxDiff = 0;
      for (let shift = -band; shift <= band; shift += Math.max(1, Math.floor(band / 2))) {
        const lA = sampleLum(bx + nx * (shift - 3), by + ny * (shift - 3));
        const lB = sampleLum(bx + nx * (shift + 3), by + ny * (shift + 3));
        const diff = Math.abs(lB - lA);
        if (diff > maxDiff) maxDiff = diff;
      }
      if (maxDiff >= 16) hits++;
    }
    return hits / Math.max(1, steps - 3);
  };

  const topSup = sampleEdgeSupport(quad[0], quad[1], 0, 1);
  const rightSup = sampleEdgeSupport(quad[1], quad[2], -1, 0);
  const bottomSup = sampleEdgeSupport(quad[3], quad[2], 0, -1);
  const leftSup = sampleEdgeSupport(quad[0], quad[3], 1, 0);
  const edgeAlignmentScore = (topSup + rightSup + bottomSup + leftSup) / 4;

  // 2. Silueta IoU aproximada comparando píxeles distintos al fondo exterior
  let bgR = exteriorBgRgb?.[0] ?? 240;
  let bgG = exteriorBgRgb?.[1] ?? 240;
  let bgB = exteriorBgRgb?.[2] ?? 240;
  if (!exteriorBgRgb) {
    const p0 = 0;
    bgR = rgba[p0];
    bgG = rgba[p0 + 1];
    bgB = rgba[p0 + 2];
  }

  let inter = 0;
  let union = 0;
  const stepX = Math.max(2, Math.floor(imgW / 90));
  const stepY = Math.max(2, Math.floor(imgH / 90));
  for (let y = 0; y < imgH; y += stepY) {
    for (let x = 0; x < imgW; x += stepX) {
      const p = (y * imgW + x) * 4;
      const dBg = Math.hypot(rgba[p] - bgR, rgba[p + 1] - bgG, rgba[p + 2] - bgB);
      const isFg = dBg > 24;
      const inQuad = x >= qx0 && x <= qx1 && y >= qy0 && y <= qy1;
      if (isFg && inQuad) inter++;
      if (isFg || inQuad) union++;
    }
  }
  const silhouetteIoU = union > 0 ? inter / union : 0;

  // 3. Cobertura de vectores de contorno reales hallados en los 4 lados
  const hasTop = extracted.outerFrameLines.some((l) => l.role === 'outer_top');
  const hasBot = extracted.outerFrameLines.some((l) => l.role === 'outer_bottom');
  const hasLeft = extracted.outerFrameLines.some((l) => l.role === 'outer_left');
  const hasRight = extracted.outerFrameLines.some((l) => l.role === 'outer_right');
  const sidesWithVectors = (hasTop ? 1 : 0) + (hasBot ? 1 : 0) + (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
  const interiorSupport = Math.min(1, extracted.interiorLines.length / 6);
  const vectorCoverageScore = 0.65 * (sidesWithVectors / 4) + 0.35 * interiorSupport;

  // Ponderación compuesta 0..100
  const areaFrac = (qw * qh) / Math.max(1, imgW * imgH);
  const areaPenalty = areaFrac < 0.08 || areaFrac > 0.94 ? 0.72 : 1;
  const overallScore = Math.round(
    clamp(
      (edgeAlignmentScore * 0.44 + silhouetteIoU * 0.34 + vectorCoverageScore * 0.22) *
        100 *
        areaPenalty,
      0,
      100,
    ),
  );

  const notes: string[] = [];
  if (topSup < 0.45) notes.push('Margen superior débil: verifica si incluye fondo/pared o TV encima.');
  if (bottomSup < 0.4) notes.push('Margen inferior abierto (posible escritorio sin base o patas).');
  if (leftSup < 0.45) notes.push('Margen izquierdo poco alineado al borde real del mueble.');
  if (rightSup < 0.45) notes.push('Margen derecho poco alineado (revisa si incluye costado en 3/4).');
  if (silhouetteIoU < 0.52) notes.push('Silueta con exceso de fondo o recorte parcial del cuerpo.');
  if (notes.length === 0) notes.push('Márgenes exteriores y vectores estructurales bien alineados con la foto.');

  const verdict: MarginEvaluationResult['verdict'] =
    overallScore >= 72 ? 'excelente' : overallScore >= 52 ? 'aceptable' : 'revisar';

  return {
    silhouetteIoU: Number(silhouetteIoU.toFixed(3)),
    edgeAlignmentScore: Number(edgeAlignmentScore.toFixed(3)),
    vectorCoverageScore: Number(vectorCoverageScore.toFixed(3)),
    overallScore,
    perEdgeSupport: {
      top: Number(topSup.toFixed(2)),
      bottom: Number(bottomSup.toFixed(2)),
      left: Number(leftSup.toFixed(2)),
      right: Number(rightSup.toFixed(2)),
    },
    verdict,
    notes,
  };
}

const MATERIAL_BASE_RGB: Record<MelamineMaterial | 'durolac_3mm', [number, number, number]> = {
  blanco: [238, 240, 244],
  roble: [198, 154, 106],
  grafito: [62, 74, 92],
  durolac_3mm: [148, 114, 82],
};

/**
 * Proyecta el modelo 3D real (`DespieceResult`) sobre una rejilla frontal 2D (alzado XY)
 * y evalúa su similitud visual pixel-a-pixel contra la foto rectificada del mueble.
 */
export function evaluate3DvsPhotoSimilarity(
  rectRgba: Uint8ClampedArray,
  rectW: number,
  rectH: number,
  despiece: DespieceResult,
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  exteriorBgRgb: [number, number, number] = [242, 244, 248],
): Visual3DSimilarityResult {
  if (rectW < 24 || rectH < 24 || despiece.matrizDespiece.length === 0) {
    return {
      silhouetteMatch: 0,
      edgeStructureMatch: 0,
      colorPaletteMatch: 0,
      overallScore: 0,
      verdict: 'bajo_parecido',
      mismatches: ['Sin imagen rectificada o despiece vacío para comparar.'],
    };
  }

  // Rejilla de comparación rápida (96×96 proporcional)
  const gW = 96;
  const gH = Math.max(36, Math.min(128, Math.round((gW * rectH) / rectW)));
  const n = gW * gH;

  const synR = new Float32Array(n);
  const synG = new Float32Array(n);
  const synB = new Float32Array(n);
  const synOcc = new Uint8Array(n); // 0 = hueco pasante / fondo ext, 1 = vano abierto sombreado, 2 = tablero/puerta/cajón
  const synZ = new Float32Array(n).fill(-1e9);

  // Fondo base: si tiene hueco de piernas abajo, rellenar esa zona con fondo exterior; si es vano interior, sombra interior
  const hasBack = topology.hasBackPanel;
  const cavityShade = hasBack ? 0.55 : 0.85;
  const baseCarcassRgb = MATERIAL_BASE_RGB[params.material];
  for (let i = 0; i < n; i++) {
    synR[i] = hasBack ? baseCarcassRgb[0] * cavityShade : exteriorBgRgb[0];
    synG[i] = hasBack ? baseCarcassRgb[1] * cavityShade : exteriorBgRgb[1];
    synB[i] = hasBack ? baseCarcassRgb[2] * cavityShade : exteriorBgRgb[2];
    synOcc[i] = hasBack ? 1 : 0;
  }

  const xf = Math.max(1, params.targetDimensions.x);
  const yf = Math.max(1, params.targetDimensions.y);
  const glassIds = new Set(
    (topology.frontZones ?? [])
      .filter((z) => z.kind === 'door_glass')
      .map((z) => `puerta_${z.id}`),
  );

  // Pintar las zonas explícitas `leg_void` y `void_outside` (recorte escalonado) como fondo exterior (sin tablero)
  for (const z of topology.frontZones ?? []) {
    if (z.kind !== 'leg_void' && z.kind !== 'void_outside') continue;
    const isOut = z.kind === 'void_outside';
    const x0 = isOut && z.uStart <= 0.02 ? 0 : clamp(Math.floor(z.uStart * gW), 0, gW - 1);
    const x1 = isOut && z.uEnd >= 0.98 ? gW - 1 : clamp(Math.ceil(z.uEnd * gW), 0, gW - 1);
    const y0 = isOut && z.vEnd >= 0.98 ? 0 : clamp(Math.floor((1 - z.vEnd) * gH), 0, gH - 1);
    const y1 = isOut && z.vStart <= 0.02 ? gH - 1 : clamp(Math.ceil((1 - z.vStart) * gH), 0, gH - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const idx = y * gW + x;
        synR[idx] = exteriorBgRgb[0];
        synG[idx] = exteriorBgRgb[1];
        synB[idx] = exteriorBgRgb[2];
        synOcc[idx] = 0;
      }
    }
  }

  // Z-buffer frontal de cada pieza física del 3D (`posicion3D` + `dimensiones3D`)
  for (const p of despiece.matrizDespiece) {
    if (p.tipo === 'zocalo' || p.tipo === 'fondo' || p.tipo === 'fondo_cajon') continue;
    const [cx, cy, cz] = p.posicion3D;
    const [dx, dy, dz] = p.dimensiones3D;
    const frontZ = cz + dz / 2;

    const px0 = clamp(Math.floor(((cx - dx / 2) / xf) * gW), 0, gW - 1);
    const px1 = clamp(Math.ceil(((cx + dx / 2) / xf) * gW) - 1, 0, gW - 1);
    const py0 = clamp(Math.floor((1 - (cy + dy / 2) / yf) * gH), 0, gH - 1);
    const py1 = clamp(Math.ceil((1 - (cy - dy / 2) / yf) * gH) - 1, 0, gH - 1);

    const isGlass = glassIds.has(p.id);
    const rgb = isGlass
      ? ([186, 224, 245] as [number, number, number])
      : MATERIAL_BASE_RGB[p.material] ?? baseCarcassRgb;

    // Oscurecer levemente juntas de puertas/cajones en su borde de 1 px
    const isFrontPanel = p.tipo === 'puerta' || p.tipo === 'frente_cajon';

    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const idx = y * gW + x;
        if (frontZ < synZ[idx]) continue;
        synZ[idx] = frontZ;
        const onSeam = isFrontPanel && (x === px0 || x === px1 || y === py0 || y === py1);
        const shade = onSeam ? 0.58 : isGlass ? 0.86 : 1.0;
        synR[idx] = rgb[0] * shade;
        synG[idx] = rgb[1] * shade;
        synB[idx] = rgb[2] * shade;
        synOcc[idx] = 2;
      }
    }
  }

  // Muestrear la foto rectificada en la misma rejilla gW×gH
  const phoR = new Float32Array(n);
  const phoG = new Float32Array(n);
  const phoB = new Float32Array(n);
  const phoLum = new Float32Array(n);
  const synLum = new Float32Array(n);

  let colorDistSum = 0;
  let silHits = 0;

  for (let y = 0; y < gH; y++) {
    const sy = clamp(Math.floor(((y + 0.5) / gH) * rectH), 0, rectH - 1);
    for (let x = 0; x < gW; x++) {
      const sx = clamp(Math.floor(((x + 0.5) / gW) * rectW), 0, rectW - 1);
      const pi = (sy * rectW + sx) * 4;
      const gi = y * gW + x;
      phoR[gi] = rectRgba[pi];
      phoG[gi] = rectRgba[pi + 1];
      phoB[gi] = rectRgba[pi + 2];
      phoLum[gi] = 0.299 * phoR[gi] + 0.587 * phoG[gi] + 0.114 * phoB[gi];
      synLum[gi] = 0.299 * synR[gi] + 0.587 * synG[gi] + 0.114 * synB[gi];

      // Comparación de color normalizada (0..1)
      const dCol = Math.hypot(phoR[gi] - synR[gi], phoG[gi] - synG[gi], phoB[gi] - synB[gi]) / 441.67;
      colorDistSum += dCol;

      // Ocupación: comparar si el píxel de la foto es fondo exterior vs cuerpo/tablero
      const dExt = Math.hypot(
        phoR[gi] - exteriorBgRgb[0],
        phoG[gi] - exteriorBgRgb[1],
        phoB[gi] - exteriorBgRgb[2],
      );
      const photoIsVoid = dExt < 26;
      const synIsVoid = synOcc[gi] === 0;
      if (photoIsVoid === synIsVoid) silHits++;
    }
  }

  const colorPaletteMatch = clamp(1 - colorDistSum / n / 0.55, 0, 1);
  const silhouetteMatch = silHits / n;

  // Correlación de mapas de bordes estructurales (Sobel suave en gW×gH)
  const edgeMap = (lum: Float32Array): Float32Array => {
    const out = new Float32Array(n);
    for (let y = 1; y < gH - 1; y++) {
      const u = (y - 1) * gW;
      const m = y * gW;
      const d = (y + 1) * gW;
      for (let x = 1; x < gW - 1; x++) {
        const gx = -lum[m + x - 1] + lum[m + x + 1];
        const gy = -lum[u + x] + lum[d + x];
        out[m + x] = Math.hypot(gx, gy) > 16 ? 1 : 0;
      }
    }
    return out;
  };

  const phoE = edgeMap(phoLum);
  const synE = edgeMap(synLum);
  // Tolerancia de ±2 celdas en la rejilla gW×gH para comparar alineación de aristas
  let synMatched = 0;
  let synTotal = 0;
  let phoMatched = 0;
  let phoTotal = 0;

  for (let y = 2; y < gH - 2; y++) {
    for (let x = 2; x < gW - 2; x++) {
      const idx = y * gW + x;
      if (synE[idx] > 0) {
        synTotal++;
        let hit = false;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (phoE[(y + dy) * gW + (x + dx)] > 0) {
              hit = true;
              break;
            }
          }
        }
        if (hit) synMatched++;
      }
      if (phoE[idx] > 0) {
        phoTotal++;
        let hit = false;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (synE[(y + dy) * gW + (x + dx)] > 0) {
              hit = true;
              break;
            }
          }
        }
        if (hit) phoMatched++;
      }
    }
  }

  const prec = synTotal > 0 ? synMatched / synTotal : 0.5;
  const rec = phoTotal > 0 ? phoMatched / phoTotal : 0.5;
  const edgeStructureMatch = prec + rec > 1e-6 ? (2 * prec * rec) / (prec + rec) : 0;

  const overallScore = Math.round(
    clamp(
      (silhouetteMatch * 0.36 + edgeStructureMatch * 0.34 + colorPaletteMatch * 0.3) * 100,
      0,
      100,
    ),
  );

  const mismatches: string[] = [];
  if (silhouetteMatch < 0.72) {
    mismatches.push('Diferencia de silueta/hueco inferior entre foto y 3D (revisa Hueco Piernas o encuadre).');
  }
  if (edgeStructureMatch < 0.45) {
    mismatches.push('Las divisiones internas del 3D no coinciden del todo con los bordes de la foto.');
  }
  if (colorPaletteMatch < 0.62) {
    mismatches.push('Acabado o contraste abierto/cerrado difiere de la foto (prueba alternar Zonas o color).');
  }
  if (mismatches.length === 0) {
    mismatches.push('Buen parecido global entre la foto subida y la geometría 3D reconstruida.');
  }

  const verdict: Visual3DSimilarityResult['verdict'] =
    overallScore >= 72 ? 'alto_parecido' : overallScore >= 52 ? 'parecido_medio' : 'bajo_parecido';

  return {
    silhouetteMatch: Number(silhouetteMatch.toFixed(3)),
    edgeStructureMatch: Number(edgeStructureMatch.toFixed(3)),
    colorPaletteMatch: Number(colorPaletteMatch.toFixed(3)),
    overallScore,
    verdict,
    mismatches,
  };
}

export interface VectorStructureReconstruction {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  inferredZones: FrontZone[];
  detectedMaterial: MelamineMaterial;
  vectorLinesUsed: number;
  furnitureMode: 'open' | 'closed_front' | 'hybrid';
}

function inferMaterialRgb(r: number, g: number, b: number): MelamineMaterial {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const warmth = r - b;
  if (lum >= 175 && Math.abs(r - b) < 28) return 'blanco';
  if (lum <= 96) return 'grafito';
  if (warmth > 20 && r > g - 6) return 'roble';
  if (lum >= 165) return 'blanco';
  return warmth > 12 ? 'roble' : 'grafito';
}

/**
 * Reconstruye la topología del mueble DIRECTAMENTE a partir de los segmentos vectoriales 2D
 * (`VectorLine2D[]`) extraídos sobre la cara frontal rectificada:
 *  - Filtra molduras decorativas flotantes mediante regla de soporte en extremos (T-junction).
 *  - Particiona el frente [0..1]^2 jerárquicamente (cortes totales y luego parciales por zona).
 *  - Clasifica cada celda resultante (hueco piernas, vidrio, abierto, cajones, puerta, bicolor).
 */
export function reconstructStructureFromVectors(
  rectRgba: Uint8ClampedArray,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  detectedMaterial: MelamineMaterial,
  exteriorBgRgb: [number, number, number] = [245, 245, 245],
): VectorStructureReconstruction {
  const fullQuad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ];
  const ext = extractStructuralVectorLines(rectRgba, W, H, fullQuad);

  // Recolectar segmentos vectoriales interiores normalizados [0..1] (u: izq->der, v: abajo->arriba)
  interface NormVecSeg {
    pos: number;
    start: number;
    end: number;
    span: number;
    strength: number;
  }

  const rawV: NormVecSeg[] = [];
  const rawH: NormVecSeg[] = [];

  for (const ln of ext.lines) {
    if (!ln.normStart || !ln.normEnd) continue;
    const uA = Math.min(ln.normStart.x, ln.normEnd.x);
    const uB = Math.max(ln.normStart.x, ln.normEnd.x);
    const vA = Math.min(ln.normStart.y, ln.normEnd.y);
    const vB = Math.max(ln.normStart.y, ln.normEnd.y);

    if (ln.orientation === 'vertical' || Math.abs(Math.abs(ln.angleDeg) - 90) <= 10) {
      const uMid = (uA + uB) / 2;
      const span = vB - vA;
      // Descartar contornos exteriores / ecos laterales (< 12% o > 88%)
      if (uMid < 0.12 || uMid > 0.88 || span < 0.22) continue;
      rawV.push({ pos: uMid, start: vA, end: vB, span, strength: ln.strength });
    } else if (ln.orientation === 'horizontal' || Math.abs(ln.angleDeg) <= 10) {
      const vMid = (vA + vB) / 2;
      const span = uB - uA;
      // Descartar cubierta, base y zócalo inferior (< 16% en muebles bajos como racks TV, < 13% en altos)
      const minV = dimsMm.y <= 700 ? 0.16 : 0.13;
      if (vMid < minV || vMid > 0.89 || span < 0.2) continue;
      rawH.push({ pos: vMid, start: uA, end: uB, span, strength: ln.strength });
    }
  }

  // Fusionar vectores paralelos colineales o muy cercanos
  const clusterSegs = (segs: NormVecSeg[], posTol: number): NormVecSeg[] => {
    const sorted = [...segs].sort((a, b) => a.pos - b.pos);
    const merged: NormVecSeg[] = [];
    for (const s of sorted) {
      const hit = merged.find(
        (m) =>
          Math.abs(m.pos - s.pos) <= posTol &&
          s.start <= m.end + 0.08 &&
          s.end >= m.start - 0.08,
      );
      if (hit) {
        const wM = hit.span * hit.strength;
        const wS = s.span * s.strength;
        hit.pos = (hit.pos * wM + s.pos * wS) / Math.max(1e-6, wM + wS);
        hit.start = Math.min(hit.start, s.start);
        hit.end = Math.max(hit.end, s.end);
        hit.span = hit.end - hit.start;
        hit.strength = Math.max(hit.strength, s.strength);
      } else {
        merged.push({ ...s });
      }
    }
    return merged;
  };

  const candH = clusterSegs(rawH, 0.045);
  const candVAll = clusterSegs(rawV, 0.055);

  // Filtro T-Junction anti-molduras: todo vector vertical estructural debe apoyar al menos 1 extremo
  // en la cubierta (>= 0.88), base (<= 0.12) o un vector horizontal detectado (±0.07)
  const candV = candVAll.filter((v) => {
    const touchesTop = v.end >= 0.88;
    const touchesBot = v.start <= 0.12;
    const touchesH = candH.some(
      (h) =>
        v.pos >= h.start - 0.07 &&
        v.pos <= h.end + 0.07 &&
        (Math.abs(v.start - h.pos) <= 0.08 || Math.abs(v.end - h.pos) <= 0.08),
    );
    return (touchesTop && touchesBot) || ((touchesTop || touchesBot) && (touchesH || v.span >= 0.34)) || (touchesH && v.span >= 0.28);
  });

  // Partición jerárquica XY guiada por los vectores reales
  const vDividers: NormalizedSegment[] = [];
  const hShelves: NormalizedSegment[] = [];
  const leafCells: Array<{ u0: number; u1: number; v0: number; v1: number }> = [];

  const splitRegion = (u0: number, u1: number, v0: number, v1: number, depth: number) => {
    const spanU = u1 - u0;
    const spanV = v1 - v0;
    if (depth >= 3 || spanU < 0.18 || spanV < 0.16) {
      leafCells.push({ u0, u1, v0, v1 });
      return;
    }

    // Buscar cortes verticales que atraviesen al menos 65% de la altura actual (o anclados en el nivel raíz)
    const vIn = candV
      .filter((v) => {
        if (v.pos <= u0 + Math.max(0.11, spanU * 0.14) || v.pos >= u1 - Math.max(0.11, spanU * 0.14)) {
          return false;
        }
        const ov = Math.min(v.end, v1) - Math.max(v.start, v0);
        return ov / Math.max(1e-4, spanV) >= 0.62;
      })
      .sort((a, b) => b.span * b.strength - a.span * a.strength)
      .slice(0, 4)
      .sort((a, b) => a.pos - b.pos);

    // Filtrar separación mínima entre cortes verticales
    const vSel: NormVecSeg[] = [];
    for (const v of vIn) {
      if (vSel.every((prev) => Math.abs(prev.pos - v.pos) >= 0.14)) {
        vSel.push(v);
      }
    }

    const hIn = candH
      .filter((h) => {
        if (h.pos <= v0 + Math.max(0.11, spanV * 0.14) || h.pos >= v1 - Math.max(0.11, spanV * 0.14)) {
          return false;
        }
        const ov = Math.min(h.end, u1) - Math.max(h.start, u0);
        return ov / Math.max(1e-4, spanU) >= 0.62;
      })
      .sort((a, b) => b.span * b.strength - a.span * a.strength)
      .slice(0, 4)
      .sort((a, b) => a.pos - b.pos);

    const hSel: NormVecSeg[] = [];
    for (const h of hIn) {
      if (hSel.every((prev) => Math.abs(prev.pos - h.pos) >= 0.12)) {
        hSel.push(h);
      }
    }

    const scoreV = vSel.reduce((acc, s) => Math.max(acc, (s.span / spanV) * s.strength), 0);
    const scoreH = hSel.reduce((acc, s) => Math.max(acc, (s.span / spanU) * s.strength), 0);

    // En muebles más altos que anchos (cocinas, vitrinas, armarios 2 niveles), priorizar divisiones horizontales completas
    const preferHoriz = dimsMm.y > dimsMm.x * 1.12 && hSel.length > 0 && scoreH >= scoreV * 0.82;

    if (hSel.length > 0 && (preferHoriz || scoreH > scoreV)) {
      const vStops = [v0];
      for (const hs of hSel) {
        const vInt = clamp(exteriorToInterior(hs.pos, boardThicknessMm, dimsMm.y), 0.05, 0.95);
        if (vInt <= v0 + 0.06 || vInt >= v1 - 0.06) continue;
        hShelves.push({
          id: `vec_rep_${hShelves.length + 1}`,
          position: Number(vInt.toFixed(4)),
          start: Number(u0.toFixed(4)),
          end: Number(u1.toFixed(4)),
        });
        vStops.push(vInt);
      }
      vStops.push(v1);
      if (vStops.length > 2) {
        for (let k = 0; k < vStops.length - 1; k++) {
          splitRegion(u0, u1, vStops[k], vStops[k + 1], depth + 1);
        }
        return;
      }
    }

    if (vSel.length > 0) {
      const uStops = [u0];
      for (const vs of vSel) {
        const uInt = clamp(exteriorToInterior(vs.pos, boardThicknessMm, dimsMm.x), 0.05, 0.95);
        if (uInt <= u0 + 0.06 || uInt >= u1 - 0.06) continue;
        vDividers.push({
          id: `vec_div_${vDividers.length + 1}`,
          position: Number(uInt.toFixed(4)),
          start: Number(v0.toFixed(4)),
          end: Number(v1.toFixed(4)),
        });
        uStops.push(uInt);
      }
      uStops.push(u1);
      if (uStops.length > 2) {
        for (let k = 0; k < uStops.length - 1; k++) {
          splitRegion(uStops[k], uStops[k + 1], v0, v1, depth + 1);
        }
        return;
      }
    }

    leafCells.push({ u0, u1, v0, v1 });
  };

  splitRegion(0, 1, 0, 1, 0);

  // Calcular luminancia y color de referencia del cuerpo (filtrando fondo exterior)
  const nPx = W * H;
  const lum = new Float32Array(nPx);
  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    lum[i] = 0.299 * rectRgba[p] + 0.587 * rectRgba[p + 1] + 0.114 * rectRgba[p + 2];
  }
  const refRgb = MATERIAL_BASE_RGB[detectedMaterial];
  const refLum = 0.299 * refRgb[0] + 0.587 * refRgb[1] + 0.114 * refRgb[2];

  // Clasificar cada celda hoja usando estadísticas de color, contraste marco/centro (vidrio) y fondo exterior
  interface CellStat {
    c: { u0: number; u1: number; v0: number; v1: number };
    kind: FrontModuleKind;
    matOverride?: MelamineMaterial;
  }

  const colMap = new Map<string, CellStat[]>();
  for (const c of leafCells) {
    const x0 = clamp(Math.round((c.u0 + (c.u1 - c.u0) * 0.12) * W), 0, W - 1);
    const x1 = clamp(Math.round((c.u1 - (c.u1 - c.u0) * 0.12) * W), 0, W - 1);
    const y0 = clamp(Math.round((1 - c.v1 + (c.v1 - c.v0) * 0.12) * H), 0, H - 1);
    const y1 = clamp(Math.round((1 - c.v0 - (c.v1 - c.v0) * 0.12) * H), 0, H - 1);

    let sumR = 0, sumG = 0, sumB = 0, sumL = 0, sumL2 = 0, bgHits = 0, cnt = 0;
    let fSum = 0, fCnt = 0, cSum = 0, cCnt = 0;
    const fx0 = x0 + Math.round((x1 - x0) * 0.16);
    const fx1 = x1 - Math.round((x1 - x0) * 0.16);
    const fy0 = y0 + Math.round((y1 - y0) * 0.16);
    const fy1 = y1 - Math.round((y1 - y0) * 0.16);

    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const idx = y * W + x;
        const p = idx * 4;
        if (rectRgba[p + 3] < 128) {
          bgHits++;
          cnt++;
          continue;
        }
        const r = rectRgba[p], g = rectRgba[p + 1], b = rectRgba[p + 2];
        const l = lum[idx];
        sumR += r;
        sumG += g;
        sumB += b;
        sumL += l;
        sumL2 += l * l;
        if (Math.hypot(r - exteriorBgRgb[0], g - exteriorBgRgb[1], b - exteriorBgRgb[2]) <= 36) {
          bgHits++;
        }
        if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) {
          cSum += l;
          cCnt++;
        } else {
          fSum += l;
          fCnt++;
        }
        cnt++;
      }
    }

    const nSafe = Math.max(1, cnt);
    const meanR = sumR / nSafe;
    const meanG = sumG / nSafe;
    const meanB = sumB / nSafe;
    const meanL = sumL / nSafe;
    const stdL = Math.sqrt(Math.max(0, sumL2 / nSafe - meanL * meanL));
    const bgRatio = bgHits / nSafe;
    const cellWmm = (c.u1 - c.u0) * dimsMm.x;
    const cellHmm = (c.v1 - c.v0) * dimsMm.y;
    const fMean = fCnt > 0 ? fSum / fCnt : meanL;
    const cMean = cCnt > 0 ? cSum / cCnt : meanL;

    const warmth = meanR - meanB;
    const isDarkWalnut = warmth >= 15 && meanR > meanG + 4 && meanL >= 48;
    const cellMat: MelamineMaterial = isDarkWalnut
      ? 'roble'
      : inferMaterialRgb(meanR, meanG, meanB);
    const distCarcass = Math.hypot(meanR - refRgb[0], meanG - refRgb[1], meanB - refRgb[2]);
    const matOverride =
      (distCarcass > 38 || (isDarkWalnut && detectedMaterial !== 'roble')) &&
      cellMat !== detectedMaterial
        ? cellMat
        : undefined;

    let kind: FrontModuleKind;
    if (c.v0 <= 0.05 && bgRatio >= 0.48 && (c.u1 - c.u0 < 0.94 || c.v1 - c.v0 < 0.92)) {
      kind = 'leg_void';
    } else if (
      (cMean < 56 && !isDarkWalnut) ||
      (meanL < refLum - 26 && distCarcass > 32 && !isDarkWalnut) ||
      (stdL > 34 && bgRatio < 0.45) ||
      (bgRatio >= 0.55 && c.v0 > 0.08 && detectedMaterial !== 'blanco')
    ) {
      kind = 'open';
    } else if (
      cellHmm >= 360 &&
      cellHmm / Math.max(1, cellWmm) >= 1.15 &&
      fMean - cMean >= 14 &&
      stdL < 46
    ) {
      kind = 'door_glass';
    } else if (cellHmm <= 310 && cellWmm > cellHmm * 1.15) {
      kind = 'drawers';
    } else if (cellWmm >= 540 && cellWmm / Math.max(1, cellHmm) >= 0.85) {
      kind = 'door_double';
    } else {
      kind = c.u0 < 0.48 ? 'door_left' : 'door_right';
    }

    const key = `${c.u0.toFixed(2)}_${c.u1.toFixed(2)}`;
    const list = colMap.get(key) ?? [];
    list.push({ c, kind, matOverride: kind === 'open' || kind === 'leg_void' ? undefined : matOverride });
    colMap.set(key, list);
  }

  // Consolidar pilas verticales contiguas de cajones en la misma columna
  const inferredZones: FrontZone[] = [];
  for (const list of colMap.values()) {
    const sorted = [...list].sort((a, b) => a.c.v0 - b.c.v0);
    let i = 0;
    while (i < sorted.length) {
      if (sorted[i].kind === 'drawers') {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1].kind === 'drawers') j++;
        const count = j - i + 1;
        const u0 = sorted[i].c.u0;
        const u1 = sorted[i].c.u1;
        const v0 = sorted[i].c.v0;
        const v1 = sorted[j].c.v1;
        inferredZones.push({
          id: `vz_drw_${inferredZones.length + 1}`,
          uStart: Number(u0.toFixed(4)),
          uEnd: Number(u1.toFixed(4)),
          vStart: Number(v0.toFixed(4)),
          vEnd: Number(v1.toFixed(4)),
          kind: 'drawers',
          drawerCount: count,
          label: count > 1 ? `${count} Cajones` : 'Cajón',
          materialOverride: sorted[i].matOverride,
        });
        i = j + 1;
      } else {
        const it = sorted[i];
        inferredZones.push({
          id: `vz_${it.kind}_${inferredZones.length + 1}`,
          uStart: Number(it.c.u0.toFixed(4)),
          uEnd: Number(it.c.u1.toFixed(4)),
          vStart: Number(it.c.v0.toFixed(4)),
          vEnd: Number(it.c.v1.toFixed(4)),
          kind: it.kind,
          label:
            it.kind === 'leg_void'
              ? 'Hueco Piernas'
              : it.kind === 'door_glass'
                ? 'Vitrina'
                : it.kind === 'open'
                  ? 'Nicho'
                  : it.kind === 'door_double'
                    ? 'Puerta Doble'
                    : 'Puerta',
          materialOverride: it.matOverride,
        });
        i++;
      }
    }
  }

  const hasOpen = inferredZones.some((z) => z.kind === 'open' || z.kind === 'leg_void');
  const hasClosed = inferredZones.some((z) => z.kind !== 'open' && z.kind !== 'leg_void');
  const furnitureMode: 'open' | 'closed_front' | 'hybrid' =
    hasOpen && hasClosed ? 'hybrid' : hasClosed ? 'closed_front' : 'open';

  return {
    vDividers,
    hShelves,
    inferredZones,
    detectedMaterial,
    vectorLinesUsed: candV.length + candH.length,
    furnitureMode,
  };
}

export interface IterativePhoto3DOptions {
  overrideQuad?: [Point2D, Point2D, Point2D, Point2D];
  seedPoint?: { u: number; v: number };
  focal35mm?: 26 | 52;
  boardThicknessMm?: number;
  currentDepthMm?: number;
  preferredDimsMm?: { x: number; y: number };
  existingBackPanel?: boolean;
}

export interface IterativePhoto3DResult {
  autoQuad: AutoQuadResult;
  rawQuad: [Point2D, Point2D, Point2D, Point2D];
  usedQuad: [Point2D, Point2D, Point2D, Point2D];
  vectorExtraction: VectorLineExtractionResult;
  marginEval: MarginEvaluationResult;
  cameraPose: CameraPoseEstimate | null;
  estimatedAspectXY: number;
  estimatedDimsMm: { x: number; y: number; z: number };
  detection: BandDetectionResult;
  legsHint: LowerGapHintResult;
  similarity3D: Visual3DSimilarityResult;
  selectedStrategy: 'band_hybrid' | 'vector_first';
  iterationsRun: number;
}

/**
 * Orquestador v5.0 100% offline:
 *   1) Extrae líneas vectoriales 2D (`VectorLine2D[]`) de la foto.
 *   2) Evalúa márgenes (`rawQuad` vs `refinedBox`) contra la foto y selecciona el mejor encuadre.
 *   3) Rectifica la cara frontal y compara Candidato A (Band/Híbrido) vs Candidato B (Vector-First 2D)
 *      + iteración de acabado evaluando el modelo 3D real contra la foto (`evaluate3DvsPhotoSimilarity`).
 */
export function runIterativePhotoTo3D(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  opts: IterativePhoto3DOptions = {},
): IterativePhoto3DResult | null {
  const focal = opts.focal35mm ?? 26;
  const e = opts.boardThicknessMm ?? 18;
  const depthZ = Math.max(250, Math.min(750, opts.currentDepthMm ?? 420));

  const autoQuad = autoDetectFurnitureQuad(rgba, imgW, imgH);
  const rawQuad = opts.overrideQuad ?? autoQuad.quadCorners;
  const extractedRaw = extractStructuralVectorLines(rgba, imgW, imgH, rawQuad);
  const evalRaw = evaluateMarginsAgainstPhoto(
    rgba,
    imgW,
    imgH,
    rawQuad,
    extractedRaw,
    autoQuad.exteriorBgRgb,
  );

  let usedQuad = rawQuad;
  let vectorExtraction = extractedRaw;
  let marginEval = evalRaw;
  let iterationsRun = 1;

  // Solo auto-refinar márgenes cuando el usuario no forzó un encuadre manual exacto
  if (!opts.overrideQuad && extractedRaw.refinedBox) {
    iterationsRun++;
    const extRef = extractStructuralVectorLines(rgba, imgW, imgH, extractedRaw.refinedBox);
    const evalRef = evaluateMarginsAgainstPhoto(
      rgba,
      imgW,
      imgH,
      extractedRaw.refinedBox,
      extRef,
      autoQuad.exteriorBgRgb,
    );
    if (evalRef.overallScore >= evalRaw.overallScore - 2) {
      usedQuad = extractedRaw.refinedBox;
      vectorExtraction = extRef;
      marginEval = evalRef;
    }
  }

  const hom = computeQuadToUnitHomography(usedQuad);
  if (!hom) return null;

  const estRatio = estimateAspectRatioFixedFocal(usedQuad, imgW, imgH, focal);
  const safeRatio = clamp(Number.isFinite(estRatio) ? estRatio : 1, 0.3, 3.2);
  const round10 = (v: number) => Math.max(450, Math.min(2200, Math.round(v / 10) * 10));

  const effX =
    opts.preferredDimsMm?.x ??
    (safeRatio >= 1.15 ? 1400 : round10(1800 * safeRatio));
  const effY =
    opts.preferredDimsMm?.y ??
    (safeRatio >= 1.15 ? round10(1400 / safeRatio) : 1800);

  const cameraPose = estimateCameraPoseMeters(usedQuad, imgW, imgH, 'x', effX, focal);
  const { width: dstW, height: dstH } = computeRectifiedSize(effX, effY, e);
  const rectRgba = rectifyImageRGBA(rgba, imgW, imgH, hom.toCanvas, dstW, dstH);
  const legsHint = detectLowerGapHint(rgba, imgW, imgH, usedQuad);

  // Candidato A: Detector Dual/Híbrido clásico
  const detA = analyzeRectifiedFurniture(rectRgba, dstW, dstH, { x: effX, y: effY }, e, {
    seedPoint: opts.seedPoint,
    parallaxAware: true,
    horizonV: cameraPose?.estimatedHorizonV ?? 0.5,
    exteriorBgRgb: autoQuad.exteriorBgRgb,
  });

  const scoreCandidate = (
    detObj: BandDetectionResult,
    mat: MelamineMaterial,
  ): Visual3DSimilarityResult => {
    const hasLegVoid = detObj.inferredZones.some((z) => z.kind === 'leg_void');
    const topo: FurnitureTopology = {
      viewsMode: 1,
      aspectRatioXY: safeRatio,
      quadCorners: usedQuad,
      homographyMatrix: hom.toUnit.map((r) => [...r]),
      vDividers: detObj.vDividers,
      hShelves: detObj.hShelves,
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: hasLegVoid ? false : (opts.existingBackPanel ?? true),
      hasExternalLegs: !hasLegVoid && legsHint.possibleExternalLegs,
      externalLegHeightMm: 140,
      externalLegCount: 4,
      frontZones: detObj.inferredZones,
      hardwareItems: [],
      detectionSource: 'auto',
      detectionConfidence: detObj.confidence,
    };
    const prm: ScaleAndBoardParams = {
      targetDimensions: { x: effX, y: effY, z: depthZ },
      referenceDimensions: { x: effX, y: effY, z: depthZ },
      boardThickness: e,
      backPanelThickness: 3,
      sheetDimensions: { width: 2440, height: 1220 },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: mat,
    };
    const desp = calculateDespiece(topo, prm);
    return evaluate3DvsPhotoSimilarity(
      rectRgba,
      dstW,
      dstH,
      desp,
      topo,
      prm,
      autoQuad.exteriorBgRgb,
    );
  };

  let bestDet = detA;
  let bestSim = scoreCandidate(detA, detA.detectedMaterial);
  let selectedStrategy: 'band_hybrid' | 'vector_first' = 'band_hybrid';

  // Candidato B: Reconstrucción Vector-First directa desde los segmentos VectorLine2D[]
  if (!opts.seedPoint) {
    iterationsRun++;
    const vecRec = reconstructStructureFromVectors(
      rectRgba,
      dstW,
      dstH,
      { x: effX, y: effY },
      e,
      detA.detectedMaterial,
      autoQuad.exteriorBgRgb,
    );
    if (vecRec.inferredZones.length > 0) {
      const detB: BandDetectionResult = {
        ...detA,
        furnitureMode: vecRec.furnitureMode,
        vDividers: vecRec.vDividers,
        hShelves: vecRec.hShelves,
        inferredZones: vecRec.inferredZones,
        confidence: Math.max(detA.confidence, 0.72),
      };
      const simB = scoreCandidate(detB, detB.detectedMaterial);
      if (simB.overallScore > bestSim.overallScore) {
        bestDet = detB;
        bestSim = simB;
        selectedStrategy = 'vector_first';
      }
    }

    // Iteración de afinamiento de acabado 3D si colorPaletteMatch < 0.74
    if (bestSim.colorPaletteMatch < 0.74) {
      const mats: MelamineMaterial[] = ['blanco', 'roble', 'grafito'];
      for (const altMat of mats) {
        if (altMat === bestDet.detectedMaterial) continue;
        iterationsRun++;
        const altDet: BandDetectionResult = { ...bestDet, detectedMaterial: altMat };
        const altSim = scoreCandidate(altDet, altMat);
        if (altSim.overallScore > bestSim.overallScore + 3) {
          bestDet = altDet;
          bestSim = altSim;
        }
      }
    }
  }

  return {
    autoQuad,
    rawQuad,
    usedQuad,
    vectorExtraction,
    marginEval,
    cameraPose,
    estimatedAspectXY: safeRatio,
    estimatedDimsMm: { x: effX, y: effY, z: depthZ },
    detection: bestDet,
    legsHint,
    similarity3D: bestSim,
    selectedStrategy,
    iterationsRun,
  };
}


