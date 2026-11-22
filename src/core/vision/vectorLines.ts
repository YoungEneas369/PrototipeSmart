/**
 * SMARTFURNITURE — EXTRACTOR DE LÍNEAS VECTORIALES 2D + EVALUADOR MÁRGENES/3D vs FOTO (v8.0)
 * 100% offline, TypeScript puro (cero DOM, cero React, cero dependencias externas).
 *
 * 1. `extractStructuralVectorLines`: Convierte los bordes reales de la foto en segmentos
 *    vectoriales explícitos (`VectorLine2D`: H, V y diagonales reales 18°–72° vía `dEdge`).
 * 2. `evaluateMarginsAgainstPhoto`: Evalúa el cuadrilátero proyectivo real contra la foto usando
 *    test punto-en-polígono (`pointInQuad`) y normales perpendiculares reales a cada arista.
 * 3. `evaluate3DvsPhotoSimilarity`: Proyecta el modelo 3D real (`DespieceResult`), incluyendo
 *    piezas rotadas (`division_diagonal`, `rotacion3D[2] !== 0`) y rejillas de `baskets`.
 * 4. `reconstructStructureFromVectors` + `runIterativePhotoTo3D`: Reconstrucción integral
 *    coherente en espacio INTERIOR `[0,1]^2` sin duplicación de `hShelves` dentro de `drawers`.
 */
import type {
  DespieceResult,
  DiagonalSegment,
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
import { MATERIAL_BASE_RGB } from './colorClassifier';
import {
  clamp,
  edgeInwardUnitNormal,
  extractLuminanceBuffer,
  gaussianBlur3x3,
  interiorToExteriorPoint,
  interiorToExteriorRect,
  pointInQuad,
  quadArea,
  rgbaLuminance,
  sampleExteriorBgRgb,
  sampleLumSafe,
  sobel3x3At,
} from './imageOps';
import {
  autoDetectFurnitureQuad,
  computeRectifiedSize,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  rectifyImageRGBA,
  type AutoQuadResult,
  type CameraPoseEstimate,
} from './rectify';
import { runRecursiveXYCut, type XYCutCandidate } from './xyCut';
import {
  classifyZonesUnified,
  detectHandlesLocalContrast,
  suppressShelvesInsideDrawers,
} from './zoneClassifier';

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
  /** Segmentos diagonales reales (18°–72°) extraídos desde el mapa de gradiente oblicuo `dEdge`. */
  diagonalSegments: VectorLine2D[];
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
 * Calcula mapas de gradiente cromático + luminancia con suavizado Gaussiano 3×3 (`imageOps.ts`)
 * y supresión direccional de no-máximos (NMS) para extraer segmentos vectoriales H, V y
 * diagonales reales en rango `18°–72°` desde `dEdge`.
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
      diagonalSegments: [],
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

  // Suavizado Gaussiano 3×3 unificado por canal
  const sR = gaussianBlur3x3(chR, W, H);
  const sG = gaussianBlur3x3(chG, W, H);
  const sB = gaussianBlur3x3(chB, W, H);

  // Gradiente vectorial máximo entre canales R, G, B usando Sobel 3×3 unificado (`sobel3x3At`)
  const gxMap = new Float32Array(n);
  const gyMap = new Float32Array(n);
  const magMap = new Float32Array(n);
  const hEdge = new Float32Array(n);
  const vEdge = new Float32Array(n);
  const dEdgeSlash = new Float32Array(n); // bordes diagonales '/' (gx * gy > 0)
  const dEdgeBackslash = new Float32Array(n); // bordes diagonales '\' (gx * gy < 0)

  const gradMags: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    const m = y * W;
    for (let x = 1; x < W - 1; x++) {
      const [rx, ry] = sobel3x3At(sR, W, x, y);
      const [gx, gy] = sobel3x3At(sG, W, x, y);
      const [bx, by] = sobel3x3At(sB, W, x, y);
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
      magMap[idx] = bestM;
      if (bestM > 18) gradMags.push(bestM);
    }
  }

  // Umbral adaptativo por percentil (robusto a fotos oscuras o muy claras)
  gradMags.sort((a, b) => a - b);
  const p70 = gradMags.length > 30 ? gradMags[Math.floor(gradMags.length * 0.7)] : 48;
  const edgeThresh = clamp(p70 * 0.52, 26, 82);

  // Supresión direccional de no-máximos (NMS) separando H (< 18°), V (> 72°) y diagonales reales `dEdge` (18°–72°)
  for (let y = 2; y < H - 2; y++) {
    const m = y * W;
    for (let x = 2; x < W - 2; x++) {
      const idx = m + x;
      const mag = magMap[idx];
      if (mag < edgeThresh) continue;

      const gxVal = gxMap[idx];
      const gyVal = gyMap[idx];
      const agx = Math.abs(gxVal);
      const agy = Math.abs(gyVal);
      // Ángulo de la tangente del borde respecto a la horizontal: 0° = horiz, 90° = vert
      const edgeAngleDeg = (Math.atan2(agx, agy) * 180) / Math.PI;

      if (edgeAngleDeg < 18) {
        // Borde horizontal: máximo local a lo largo de Y
        const upM = Math.abs(gyMap[(y - 1) * W + x]);
        const dnM = Math.abs(gyMap[(y + 1) * W + x]);
        if (agy >= upM && agy >= dnM) {
          hEdge[idx] = mag;
        }
      } else if (edgeAngleDeg > 72) {
        // Borde vertical: máximo local a lo largo de X
        const ltM = Math.abs(gxMap[m + x - 1]);
        const rtM = Math.abs(gxMap[m + x + 1]);
        if (agx >= ltM && agx >= rtM) {
          vEdge[idx] = mag;
        }
      } else {
        // Borde oblicuo genuino (18°–72°): NMS en dirección normal al gradiente
        const rx = Math.round(gxVal / mag);
        const ry = Math.round(gyVal / mag);
        const mPlus = magMap[(y + ry) * W + (x + rx)];
        const mMinus = magMap[(y - ry) * W + (x - rx)];
        if (mag >= mPlus && mag >= mMinus) {
          if (gxVal * gyVal > 0) {
            dEdgeSlash[idx] = mag;
          } else {
            dEdgeBackslash[idx] = mag;
          }
        }
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

  // Trazado de vectores horizontales con tolerancia de ±1 px en Y
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
          orientation: slopeDeg >= 18 ? 'diagonal' : 'horizontal',
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
          orientation: tiltDeg >= 18 ? 'diagonal' : 'vertical',
        });
      }
    }
  }

  // Extracción de segmentos diagonales reales (18°–72°) desde `dEdgeSlash` ('/') y `dEdgeBackslash` ('\')
  const minDiagLen = Math.max(18, Math.round(Math.min(roiX1 - roiX0, roiY1 - roiY0) * 0.14));
  const extractDiagonalChains = (dMap: Float32Array, expectSlash: boolean): RawSeg[] => {
    const visited = new Uint8Array(n);
    const out: RawSeg[] = [];
    const qX: number[] = [];
    const qY: number[] = [];

    for (let y = roiY0; y <= roiY1; y++) {
      for (let x = roiX0; x <= roiX1; x++) {
        const idx0 = y * W + x;
        if (dMap[idx0] <= 0 || visited[idx0]) continue;

        visited[idx0] = 1;
        qX.length = 0;
        qY.length = 0;
        qX.push(x);
        qY.push(y);

        let head = 0;
        let sumW = 0;
        let sumX = 0;
        let sumY = 0;

        while (head < qX.length) {
          const cx = qX[head];
          const cy = qY[head];
          head++;
          const w = dMap[cy * W + cx];
          sumW += w;
          sumX += cx * w;
          sumY += cy * w;

          for (let dy = -2; dy <= 2; dy++) {
            const ny = cy + dy;
            if (ny < roiY0 || ny > roiY1) continue;
            const nRow = ny * W;
            for (let dx = -2; dx <= 2; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < roiX0 || nx > roiX1) continue;
              const nIdx = nRow + nx;
              if (dMap[nIdx] > 0 && !visited[nIdx]) {
                visited[nIdx] = 1;
                qX.push(nx);
                qY.push(ny);
              }
            }
          }
        }

        const count = head;
        if (count < Math.max(10, Math.round(minDiagLen * 0.6)) || sumW <= 1e-6) continue;

        const mx = sumX / sumW;
        const my = sumY / sumW;
        let sxx = 0;
        let syy = 0;
        let sxy = 0;
        for (let k = 0; k < count; k++) {
          const px = qX[k] - mx;
          const py = qY[k] - my;
          const w = dMap[qY[k] * W + qX[k]];
          sxx += px * px * w;
          syy += py * py * w;
          sxy += px * py * w;
        }
        sxx /= sumW;
        syy /= sumW;
        sxy /= sumW;

        const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        let ux = Math.cos(theta);
        let uy = Math.sin(theta);
        if (ux < 0 || (Math.abs(ux) < 1e-6 && uy < 0)) {
          ux = -ux;
          uy = -uy;
        }

        const lambdaMin = 0.5 * (sxx + syy - Math.hypot(sxx - syy, 2 * sxy));
        const rmsPerp = Math.sqrt(Math.max(0, lambdaMin));

        let tMin = Infinity;
        let tMax = -Infinity;
        for (let k = 0; k < count; k++) {
          const t = (qX[k] - mx) * ux + (qY[k] - my) * uy;
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }

        const len = tMax - tMin;
        if (len < minDiagLen) continue;
        if (rmsPerp > Math.max(2.8, len * 0.04)) continue;
        if (count / len < 0.42) continue;

        const x1 = mx + tMin * ux;
        const y1 = my + tMin * uy;
        const x2 = mx + tMax * ux;
        const y2 = my + tMax * uy;
        const ddx = (x2 - x1) * invScaleX;
        const ddy = (y2 - y1) * invScaleY;
        const rawDeg = Math.abs((Math.atan2(ddy, ddx) * 180) / Math.PI);
        const effDeg = rawDeg > 90 ? 180 - rawDeg : rawDeg;
        if (effDeg < 18 || effDeg > 72) continue;

        // Verificar coherencia de signo de pendiente: '/' -> ddx*ddy < 0, '\' -> ddx*ddy > 0
        if (expectSlash ? ddx * ddy >= 0 : ddx * ddy <= 0) continue;

        out.push({
          x1,
          y1,
          x2,
          y2,
          strength: clamp(sumW / count / 220, 0, 1),
          orientation: 'diagonal',
        });
      }
    }
    return out;
  };

  const rawDiag = [
    ...extractDiagonalChains(dEdgeSlash, true),
    ...extractDiagonalChains(dEdgeBackslash, false),
  ];

  // Fusión de segmentos H/V colineales cercanos
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

  // Fusión de flancos paralelos/colineales de un mismo tablero diagonal (centrado en eje físico)
  const mergeDiagonalSegs = (segs: RawSeg[]): RawSeg[] => {
    const sorted = [...segs].sort(
      (a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1),
    );
    const out: RawSeg[] = [];
    const perpTol = Math.max(10, Math.round(Math.min(W, H) * 0.045));
    const endGapTol = 14;

    for (const s of sorted) {
      const sLen = Math.max(1, Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
      const sUx = (s.x2 - s.x1) / sLen;
      const sUy = (s.y2 - s.y1) / sLen;
      const sMidX = 0.5 * (s.x1 + s.x2);
      const sMidY = 0.5 * (s.y1 + s.y2);
      const sAngle = (Math.atan2(sUy, sUx) * 180) / Math.PI;

      let merged = false;
      for (const m of out) {
        const mLen = Math.max(1, Math.hypot(m.x2 - m.x1, m.y2 - m.y1));
        const mUx = (m.x2 - m.x1) / mLen;
        const mUy = (m.y2 - m.y1) / mLen;
        const mAngle = (Math.atan2(mUy, mUx) * 180) / Math.PI;
        if (Math.abs(mAngle - sAngle) > 9) continue;

        const mMidX = 0.5 * (m.x1 + m.x2);
        const mMidY = 0.5 * (m.y1 + m.y2);
        const perpDist = Math.abs((sMidX - mMidX) * -mUy + (sMidY - mMidY) * mUx);
        if (perpDist > perpTol) continue;

        const tM1 = (m.x1 - mMidX) * mUx + (m.y1 - mMidY) * mUy;
        const tM2 = (m.x2 - mMidX) * mUx + (m.y2 - mMidY) * mUy;
        const tS1 = (s.x1 - mMidX) * mUx + (s.y1 - mMidY) * mUy;
        const tS2 = (s.x2 - mMidX) * mUx + (s.y2 - mMidY) * mUy;
        const mMin = Math.min(tM1, tM2);
        const mMax = Math.max(tM1, tM2);
        const sMin = Math.min(tS1, tS2);
        const sMax = Math.max(tS1, tS2);

        if (sMin <= mMax + endGapTol && sMax >= mMin - endGapTol) {
          const wM = mLen * (0.5 + m.strength);
          const wS = sLen * (0.5 + s.strength);
          const wTot = wM + wS;
          const cx = (mMidX * wM + sMidX * wS) / wTot;
          const cy = (mMidY * wM + sMidY * wS) / wTot;
          let ux = (mUx * wM + sUx * wS) / wTot;
          let uy = (mUy * wM + sUy * wS) / wTot;
          const uNorm = Math.max(1e-6, Math.hypot(ux, uy));
          ux /= uNorm;
          uy /= uNorm;
          if (ux < 0) {
            ux = -ux;
            uy = -uy;
          }

          const projs = [
            (m.x1 - cx) * ux + (m.y1 - cy) * uy,
            (m.x2 - cx) * ux + (m.y2 - cy) * uy,
            (s.x1 - cx) * ux + (s.y1 - cy) * uy,
            (s.x2 - cx) * ux + (s.y2 - cy) * uy,
          ];
          const pMin = Math.min(...projs);
          const pMax = Math.max(...projs);
          m.x1 = cx + pMin * ux;
          m.y1 = cy + pMin * uy;
          m.x2 = cx + pMax * ux;
          m.y2 = cy + pMax * uy;
          m.strength = Math.max(m.strength, s.strength);
          merged = true;
          break;
        }
      }
      if (!merged) out.push({ ...s });
    }
    return out;
  };

  const mergedH = mergeCollinear(rawHoriz, true);
  const mergedV = mergeCollinear(rawVert, false);
  const mergedD = mergeDiagonalSegs(rawDiag);

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

    // Diagonal estructural interior (18°–72°)
    if (
      midX >= frameBounds.x0 + borderTolX * 0.4 &&
      midX <= frameBounds.x1 - borderTolX * 0.4 &&
      midY >= frameBounds.y0 + borderTolY * 0.4 &&
      midY <= frameBounds.y1 - borderTolY * 0.4 &&
      Math.hypot(lenX, lenY) >= Math.min(fw, fh) * 0.16
    ) {
      return 'divider';
    }

    return 'detail';
  };

  // Mantener los vectores estructurales más significativos (top 64 H/V + hasta 12 diagonales)
  const topHV = [...mergedH, ...mergedV]
    .map((seg) => ({
      seg,
      score:
        Math.hypot((seg.x2 - seg.x1) * invScaleX, (seg.y2 - seg.y1) * invScaleY) *
        (0.4 + seg.strength),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 64);

  const topD = mergedD
    .map((seg) => ({
      seg,
      score:
        Math.hypot((seg.x2 - seg.x1) * invScaleX, (seg.y2 - seg.y1) * invScaleY) *
        (0.4 + seg.strength),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const allSelected = [...topHV, ...topD];

  const lines: VectorLine2D[] = allSelected.map(({ seg }, idx) =>
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

  // Refinar la caja exterior haciendo snap a vectores de contorno + recorte de costado 3/4
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
        const gyAbove = clamp(Math.round((ym * 0.5) / invScaleY), 0, H - 1);
        const gyBelow = clamp(Math.round(((ym + frameBounds.y1) * 0.5) / invScaleY), 0, H - 1);
        const gxMid = clamp(
          Math.round(((frameBounds.x0 + frameBounds.x1) * 0.5) / invScaleX),
          0,
          W - 1,
        );
        const iA = gyAbove * W + gxMid;
        const iB = gyBelow * W + gxMid;
        const warmthDiff = Math.abs(chR[iB] - chB[iB] - (chR[iA] - chB[iA]));
        const colDiff = Math.hypot(chR[iB] - chR[iA], chG[iB] - chG[iA], chB[iB] - chB[iA]);
        if (warmthDiff > 22 || colDiff > 48) {
          topCand = deepCand;
        }
      }
    }
    if (topCand) ry0 = (topCand.p1.y + topCand.p2.y) / 2;

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
          return xm > rx0 + curW * 0.065 && xm < rx0 + curW * 0.22 && l.lengthPx >= curH * 0.58;
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];

      if (leftCorner) {
        const cx = (leftCorner.p1.x + leftCorner.p2.x) / 2;
        const horizInStrip = interiorHoriz.some(
          (h) => Math.min(h.p1.x, h.p2.x) < cx - curW * 0.04,
        );
        const horizInMain = interiorHoriz.some(
          (h) => Math.min(h.p1.x, h.p2.x) >= cx - curW * 0.04,
        );
        if (!horizInStrip && horizInMain) {
          rx0 = cx;
        }
      }

      const rightCorner = vertLines
        .filter((l) => {
          const xm = (l.p1.x + l.p2.x) / 2;
          return xm < rx1 - curW * 0.065 && xm > rx1 - curW * 0.22 && l.lengthPx >= curH * 0.58;
        })
        .sort((a, b) => b.lengthPx * b.strength - a.lengthPx * a.strength)[0];

      if (rightCorner) {
        const cx = (rightCorner.p1.x + rightCorner.p2.x) / 2;
        const horizInStrip = interiorHoriz.some(
          (h) => Math.max(h.p1.x, h.p2.x) > cx + curW * 0.04,
        );
        const horizInMain = interiorHoriz.some(
          (h) => Math.max(h.p1.x, h.p2.x) <= cx + curW * 0.04,
        );
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
  const diagonalSegments = lines.filter((l) => l.orientation === 'diagonal');

  return {
    lines,
    horizontalCount: lines.filter((l) => l.orientation === 'horizontal').length,
    verticalCount: lines.filter((l) => l.orientation === 'vertical').length,
    diagonalCount: diagonalSegments.length,
    diagonalSegments,
    outerFrameLines,
    interiorLines,
    refinedBox,
  };
}

/**
 * Evalúa cuantitativamente qué tan bien coinciden los márgenes propuestos (quad proyectivo real)
 * y los segmentos vectoriales extraídos con la foto real subida, usando:
 *  - Normales perpendiculares reales a cada arista del quad (`edgeInwardUnitNormal`).
 *  - Test punto-en-polígono exacto (`pointInQuad`) en vez de AABB para `silhouetteIoU`.
 */
export function evaluateMarginsAgainstPhoto(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  quad: readonly [Point2D, Point2D, Point2D, Point2D],
  extracted: VectorLineExtractionResult,
  exteriorBgRgb?: [number, number, number],
): MarginEvaluationResult {
  const centroid: Point2D = {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) * 0.25,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) * 0.25,
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
    const stepShift = Math.max(1, Math.floor(band / 2));
    for (let k = 2; k <= steps - 2; k++) {
      const t = k / steps;
      const bx = p1.x + (p2.x - p1.x) * t;
      const by = p1.y + (p2.y - p1.y) * t;
      let maxDiff = 0;
      for (let shift = -band; shift <= band; shift += stepShift) {
        const lA = sampleLumSafe(rgba, imgW, imgH, bx + nx * (shift - 3), by + ny * (shift - 3));
        const lB = sampleLumSafe(rgba, imgW, imgH, bx + nx * (shift + 3), by + ny * (shift + 3));
        const diff = Math.abs(lB - lA);
        if (diff > maxDiff) maxDiff = diff;
      }
      if (maxDiff >= 16) hits++;
    }
    return hits / Math.max(1, steps - 3);
  };

  // Normales perpendiculares unitarias reales a cada arista del cuadrilátero en perspectiva
  const [topNx, topNy] = edgeInwardUnitNormal(quad[0], quad[1], centroid);
  const [rightNx, rightNy] = edgeInwardUnitNormal(quad[1], quad[2], centroid);
  const [botNx, botNy] = edgeInwardUnitNormal(quad[2], quad[3], centroid);
  const [leftNx, leftNy] = edgeInwardUnitNormal(quad[3], quad[0], centroid);

  const topSup = sampleEdgeSupport(quad[0], quad[1], topNx, topNy);
  const rightSup = sampleEdgeSupport(quad[1], quad[2], rightNx, rightNy);
  const bottomSup = sampleEdgeSupport(quad[2], quad[3], botNx, botNy);
  const leftSup = sampleEdgeSupport(quad[3], quad[0], leftNx, leftNy);
  const edgeAlignmentScore = (topSup + rightSup + bottomSup + leftSup) / 4;

  // 2. Silueta IoU exacta usando punto-en-polígono (`pointInQuad`) sobre el quad real
  const [bgR, bgG, bgB] = exteriorBgRgb ?? sampleExteriorBgRgb(rgba, imgW, imgH);

  let inter = 0;
  let union = 0;
  const stepX = Math.max(2, Math.floor(imgW / 90));
  const stepY = Math.max(2, Math.floor(imgH / 90));
  for (let y = 0; y < imgH; y += stepY) {
    for (let x = 0; x < imgW; x += stepX) {
      const p = (y * imgW + x) * 4;
      const dBg = Math.hypot(rgba[p] - bgR, rgba[p + 1] - bgG, rgba[p + 2] - bgB);
      const isFg = dBg > 24;
      const inQuad = pointInQuad(x, y, quad);
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
  const sidesWithVectors =
    (hasTop ? 1 : 0) + (hasBot ? 1 : 0) + (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
  const interiorSupport = Math.min(1, extracted.interiorLines.length / 6);
  const vectorCoverageScore = 0.65 * (sidesWithVectors / 4) + 0.35 * interiorSupport;

  // Ponderación compuesta 0..100 con área exacta del cuadrilátero (`quadArea`)
  const areaFrac = quadArea(quad) / Math.max(1, imgW * imgH);
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
  if (topSup < 0.45) {
    notes.push('Margen superior débil: verifica si incluye fondo/pared o TV encima.');
  }
  if (bottomSup < 0.4) {
    notes.push('Margen inferior abierto (posible escritorio sin base o patas).');
  }
  if (leftSup < 0.45) {
    notes.push('Margen izquierdo poco alineado al borde real del mueble.');
  }
  if (rightSup < 0.45) {
    notes.push('Margen derecho poco alineado (revisa si incluye costado en 3/4).');
  }
  if (silhouetteIoU < 0.52) {
    notes.push('Silueta con exceso de fondo o recorte parcial del cuerpo.');
  }
  if (notes.length === 0) {
    notes.push('Márgenes exteriores y vectores estructurales bien alineados con la foto.');
  }

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

/**
 * Proyecta el modelo 3D real (`DespieceResult`) sobre una rejilla frontal 2D (alzado XY),
 * rasterizando correctamente tableros rotados (`rotacion3D[2] !== 0`, ej. `division_diagonal`)
 * y rejillas metálicas de zonas `baskets`, y evalúa su similitud visual contra la foto rectificada.
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

  const gW = 96;
  const gH = Math.max(36, Math.min(128, Math.round((gW * rectH) / rectW)));
  const n = gW * gH;

  const synR = new Float32Array(n);
  const synG = new Float32Array(n);
  const synB = new Float32Array(n);
  const synOcc = new Uint8Array(n); // 0 = fondo ext, 1 = vano abierto sombreado, 2 = tablero/puerta/cajón/rejilla
  const synZ = new Float32Array(n).fill(-1e9);

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
  const eMm = params.boardThickness;
  const glassIds = new Set(
    (topology.frontZones ?? []).filter((z) => z.kind === 'door_glass').map((z) => `puerta_${z.id}`),
  );

  // Pintar zonas `leg_void`, `void_outside` y rejillas metálicas `baskets` usando mapeo exacto interior -> exterior
  for (const z of topology.frontZones ?? []) {
    if (z.kind === 'leg_void' || z.kind === 'void_outside') {
      const isOut = z.kind === 'void_outside';
      const rect = interiorToExteriorRect(z, { x: xf, y: yf }, eMm, gW, gH, 0);
      const x0 = isOut && z.uStart <= 0.02 ? 0 : rect.x0;
      const x1 = isOut && z.uEnd >= 0.98 ? gW - 1 : rect.x1;
      const y0 = isOut && z.vEnd >= 0.98 ? 0 : rect.y0;
      const y1 = isOut && z.vStart <= 0.02 ? gH - 1 : rect.y1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const idx = y * gW + x;
          synR[idx] = exteriorBgRgb[0];
          synG[idx] = exteriorBgRgb[1];
          synB[idx] = exteriorBgRgb[2];
          synOcc[idx] = 0;
        }
      }
    } else if (z.kind === 'baskets') {
      const rect = interiorToExteriorRect(z, { x: xf, y: yf }, eMm, gW, gH, 0.03);
      const bw = rect.x1 - rect.x0;
      const bh = rect.y1 - rect.y0;
      if (bw >= 4 && bh >= 6) {
        const nb = Math.max(1, Math.min(6, Math.round(z.basketCount ?? 3)));
        const slotH = bh / nb;
        const wireRgb: [number, number, number] = [188, 194, 202];
        const basketZ = params.targetDimensions.z * 0.9;
        for (let k = 0; k < nb; k++) {
          const by0 = clamp(Math.round(rect.y0 + k * slotH + slotH * 0.22), rect.y0, rect.y1);
          const by1 = clamp(Math.round(rect.y0 + (k + 1) * slotH - slotH * 0.1), by0, rect.y1);
          const byMid = Math.round((by0 + by1) * 0.5);
          const wireCols = Math.max(3, Math.min(8, Math.floor(bw / 3)));
          for (let x = rect.x0; x <= rect.x1; x++) {
            for (const wy of [by0, byMid, by1]) {
              const idx = wy * gW + x;
              if (basketZ >= synZ[idx]) {
                synZ[idx] = basketZ;
                synR[idx] = wireRgb[0];
                synG[idx] = wireRgb[1];
                synB[idx] = wireRgb[2];
                synOcc[idx] = 2;
              }
            }
          }
          for (let cIdx = 0; cIdx <= wireCols; cIdx++) {
            const wx = clamp(Math.round(rect.x0 + (bw * cIdx) / wireCols), rect.x0, rect.x1);
            for (let y = by0; y <= by1; y++) {
              const idx = y * gW + wx;
              if (basketZ >= synZ[idx]) {
                synZ[idx] = basketZ;
                synR[idx] = wireRgb[0];
                synG[idx] = wireRgb[1];
                synB[idx] = wireRgb[2];
                synOcc[idx] = 2;
              }
            }
          }
        }
      }
    }
  }

  // Z-buffer frontal de cada pieza física del 3D (`posicion3D`, `dimensiones3D`, `rotacion3D`)
  for (const p of despiece.matrizDespiece) {
    if (p.tipo === 'zocalo' || p.tipo === 'fondo' || p.tipo === 'fondo_cajon') continue;
    const [cx, cy, cz] = p.posicion3D;
    const [dx, dy, dz] = p.dimensiones3D;
    const rotZ = p.rotacion3D[2] ?? 0;
    const frontZ = cz + dz / 2;

    const isGlass = p.isGlassDoor === true || glassIds.has(p.id);
    const rgb = isGlass
      ? ([186, 224, 245] as [number, number, number])
      : MATERIAL_BASE_RGB[p.material] ?? baseCarcassRgb;
    const isFrontPanel = p.tipo === 'puerta' || p.tipo === 'frente_cajon';

    // Rasterización exacta de tableros rotados en Z (`division_diagonal`, etc.)
    if (Math.abs(rotZ) > 1e-4) {
      const cosT = Math.cos(rotZ);
      const sinT = Math.sin(rotZ);
      const hx = dx * 0.5;
      const minHalfThicknessMm = Math.max(xf / gW, yf / gH) * 0.65;
      const hy = Math.max(dy * 0.5, minHalfThicknessMm);
      const bbHalfX = Math.abs(hx * cosT) + Math.abs(hy * sinT);
      const bbHalfY = Math.abs(hx * sinT) + Math.abs(hy * cosT);

      const px0 = clamp(Math.floor(((cx - bbHalfX) / xf) * gW), 0, gW - 1);
      const px1 = clamp(Math.ceil(((cx + bbHalfX) / xf) * gW), 0, gW - 1);
      const py0 = clamp(Math.floor((1 - (cy + bbHalfY) / yf) * gH), 0, gH - 1);
      const py1 = clamp(Math.ceil((1 - (cy - bbHalfY) / yf) * gH), 0, gH - 1);

      for (let y = py0; y <= py1; y++) {
        const wy = (1 - (y + 0.5) / gH) * yf;
        const relY = wy - cy;
        for (let x = px0; x <= px1; x++) {
          const wx = ((x + 0.5) / gW) * xf;
          const relX = wx - cx;
          // Rotación inversa por -rotZ al marco local de la pieza
          const lx = relX * cosT + relY * sinT;
          const ly = -relX * sinT + relY * cosT;
          if (Math.abs(lx) <= hx && Math.abs(ly) <= hy) {
            const idx = y * gW + x;
            if (frontZ < synZ[idx]) continue;
            synZ[idx] = frontZ;
            synR[idx] = rgb[0];
            synG[idx] = rgb[1];
            synB[idx] = rgb[2];
            synOcc[idx] = 2;
          }
        }
      }
      continue;
    }

    const px0 = clamp(Math.floor(((cx - dx / 2) / xf) * gW), 0, gW - 1);
    const px1 = clamp(Math.ceil(((cx + dx / 2) / xf) * gW) - 1, 0, gW - 1);
    const py0 = clamp(Math.floor((1 - (cy + dy / 2) / yf) * gH), 0, gH - 1);
    const py1 = clamp(Math.ceil((1 - (cy - dy / 2) / yf) * gH) - 1, 0, gH - 1);

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
      phoLum[gi] = rgbaLuminance(phoR[gi], phoG[gi], phoB[gi]);
      synLum[gi] = rgbaLuminance(synR[gi], synG[gi], synB[gi]);

      const dCol =
        Math.hypot(phoR[gi] - synR[gi], phoG[gi] - synG[gi], phoB[gi] - synB[gi]) / 441.67;
      colorDistSum += dCol;

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

  // Correlación de mapas de bordes estructurales
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
    mismatches.push(
      'Diferencia de silueta/hueco inferior entre foto y 3D (revisa Hueco Piernas o encuadre).',
    );
  }
  if (edgeStructureMatch < 0.45) {
    mismatches.push(
      'Las divisiones internas del 3D no coinciden del todo con los bordes de la foto.',
    );
  }
  if (colorPaletteMatch < 0.62) {
    mismatches.push(
      'Acabado o contraste abierto/cerrado difiere de la foto (prueba alternar Zonas o color).',
    );
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
  /** Divisiones diagonales reales (18°–72°) convertidas a espacio interior `[0,1]^2`. */
  diagonalDividers: DiagonalSegment[];
  inferredZones: FrontZone[];
  detectedMaterial: MelamineMaterial;
  vectorLinesUsed: number;
  furnitureMode: 'open' | 'closed_front' | 'hybrid';
}

function snapCoordToAnchors(val: number, anchors: readonly number[], tol = 0.05): number {
  let best = val;
  let bestD = tol;
  for (const a of anchors) {
    const d = Math.abs(val - a);
    if (d <= bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/**
 * Reconstruye la topología del mueble DIRECTAMENTE a partir de los segmentos vectoriales 2D
 * (`VectorLine2D[]`) extraídos sobre la cara frontal rectificada:
 *  - Convierte TODA coordenada exterior `[0,1]^2` a espacio INTERIOR `[0,1]^2` antes de particionar.
 *  - Filtra molduras decorativas flotantes mediante regla de soporte en extremos (T-junction).
 *  - Particiona mediante `runRecursiveXYCut` (espacio interior puro) y clasifica vía `classifyZonesUnified`.
 *  - Suprime repisas fantasma interiores a zonas `drawers` y conserva diagonales reales (18°–72°).
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

  // Recolectar segmentos vectoriales ya convertidos estrictamente a espacio INTERIOR [0..1]^2
  interface NormVecSeg {
    pos: number;
    start: number;
    end: number;
    span: number;
    strength: number;
  }

  const toUInt = (uExt: number) => clamp(exteriorToInterior(uExt, boardThicknessMm, dimsMm.x), 0, 1);
  const toVInt = (vExt: number) => clamp(exteriorToInterior(vExt, boardThicknessMm, dimsMm.y), 0, 1);

  const rawV: NormVecSeg[] = [];
  const rawH: NormVecSeg[] = [];
  const rawDiags: Array<{ u1: number; v1: number; u2: number; v2: number; strength: number }> = [];

  for (const ln of ext.lines) {
    if (!ln.normStart || !ln.normEnd) continue;

    if (ln.orientation === 'diagonal') {
      const u1 = toUInt(ln.normStart.x);
      const v1 = toVInt(ln.normStart.y);
      const u2 = toUInt(ln.normEnd.x);
      const v2 = toVInt(ln.normEnd.y);
      const du = u2 - u1;
      const dv = v2 - v1;
      if (Math.hypot(du, dv) < 0.16) continue;
      // Verificar ángulo físico real 18°–72° en espacio del mueble
      const xInt = Math.max(1, dimsMm.x - 2 * boardThicknessMm);
      const yInt = Math.max(1, dimsMm.y - 2 * boardThicknessMm);
      const deg = (Math.atan2(Math.abs(dv * yInt), Math.abs(du * xInt)) * 180) / Math.PI;
      if (deg >= 18 && deg <= 72) {
        rawDiags.push({ u1, v1, u2, v2, strength: ln.strength });
      }
      continue;
    }

    const uA = toUInt(Math.min(ln.normStart.x, ln.normEnd.x));
    const uB = toUInt(Math.max(ln.normStart.x, ln.normEnd.x));
    const vA = toVInt(Math.min(ln.normStart.y, ln.normEnd.y));
    const vB = toVInt(Math.max(ln.normStart.y, ln.normEnd.y));

    if (ln.orientation === 'vertical' || Math.abs(Math.abs(ln.angleDeg) - 90) <= 10) {
      const uMid = (uA + uB) / 2;
      const span = vB - vA;
      if (uMid < 0.1 || uMid > 0.9 || span < 0.22) continue;
      rawV.push({ pos: uMid, start: vA, end: vB, span, strength: ln.strength });
    } else if (ln.orientation === 'horizontal' || Math.abs(ln.angleDeg) <= 10) {
      const vMid = (vA + vB) / 2;
      const span = uB - uA;
      const minV = dimsMm.y <= 700 ? 0.14 : 0.11;
      if (vMid < minV || vMid > 0.9 || span < 0.2) continue;
      rawH.push({ pos: vMid, start: uA, end: uB, span, strength: ln.strength });
    }
  }

  // Fusionar vectores paralelos colineales o muy cercanos (ya en espacio interior consistente)
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

  // Filtro T-Junction anti-molduras en espacio interior [0..1]
  const candV = candVAll.filter((v) => {
    const touchesTop = v.end >= 0.88;
    const touchesBot = v.start <= 0.12;
    const touchesH = candH.some(
      (h) =>
        v.pos >= h.start - 0.07 &&
        v.pos <= h.end + 0.07 &&
        (Math.abs(v.start - h.pos) <= 0.08 || Math.abs(v.end - h.pos) <= 0.08),
    );
    return (
      (touchesTop && touchesBot) ||
      ((touchesTop || touchesBot) && (touchesH || v.span >= 0.34)) ||
      (touchesH && v.span >= 0.28)
    );
  });

  // Partición jerárquica XY-Cut unificada en espacio interior normalizado puro (`vTopDownPx: false`)
  const xyRes = runRecursiveXYCut(
    { rx0: 0, rx1: 1, ry0: 0, ry1: 1, u0: 0, u1: 1, v0: 0, v1: 1 },
    {
      maxDepth: 3,
      minRegionW: 0.18,
      minRegionH: 0.16,
      minNormSpanU: 0.18,
      minNormSpanV: 0.16,
      minCutMarginNorm: 0.06,
      vTopDownPx: false,
      idPrefix: { v: 'vec_div', h: 'vec_rep' },
      findVerticalCuts: (reg): XYCutCandidate[] => {
        const spanU = reg.u1 - reg.u0;
        const spanV = reg.v1 - reg.v0;
        const vIn = candV
          .filter((v) => {
            if (
              v.pos <= reg.u0 + Math.max(0.11, spanU * 0.14) ||
              v.pos >= reg.u1 - Math.max(0.11, spanU * 0.14)
            ) {
              return false;
            }
            const ov = Math.min(v.end, reg.v1) - Math.max(v.start, reg.v0);
            return ov / Math.max(1e-4, spanV) >= 0.62;
          })
          .sort((a, b) => b.span * b.strength - a.span * a.strength)
          .slice(0, 4)
          .sort((a, b) => a.pos - b.pos);

        const selected: XYCutCandidate[] = [];
        for (const v of vIn) {
          if (selected.every((prev) => Math.abs(prev.posNorm - v.pos) >= 0.14)) {
            selected.push({
              posNorm: clamp(v.pos, 0.05, 0.95),
              posPx: clamp(v.pos, 0.05, 0.95),
              score: (v.span / Math.max(1e-4, spanV)) * v.strength,
            });
          }
        }
        return selected;
      },
      findHorizontalCuts: (reg): XYCutCandidate[] => {
        const spanU = reg.u1 - reg.u0;
        const spanV = reg.v1 - reg.v0;
        const hIn = candH
          .filter((h) => {
            if (
              h.pos <= reg.v0 + Math.max(0.11, spanV * 0.14) ||
              h.pos >= reg.v1 - Math.max(0.11, spanV * 0.14)
            ) {
              return false;
            }
            const ov = Math.min(h.end, reg.u1) - Math.max(h.start, reg.u0);
            return ov / Math.max(1e-4, spanU) >= 0.62;
          })
          .sort((a, b) => b.span * b.strength - a.span * a.strength)
          .slice(0, 4)
          .sort((a, b) => a.pos - b.pos);

        const selected: XYCutCandidate[] = [];
        for (const h of hIn) {
          if (selected.every((prev) => Math.abs(prev.posNorm - h.pos) >= 0.12)) {
            selected.push({
              posNorm: clamp(h.pos, 0.05, 0.95),
              posPx: clamp(h.pos, 0.05, 0.95),
              score: (h.span / Math.max(1e-4, spanU)) * h.strength,
            });
          }
        }
        return selected;
      },
      chooseAxis: (vCuts, hCuts) => {
        const scoreV = vCuts.reduce((acc, s) => Math.max(acc, s.score), 0);
        const scoreH = hCuts.reduce((acc, s) => Math.max(acc, s.score), 0);
        if (vCuts.length === 0 && hCuts.length === 0) return 'none';
        const preferHoriz = dimsMm.y > dimsMm.x * 1.12 && hCuts.length > 0 && scoreH >= scoreV * 0.82;
        if (hCuts.length > 0 && (preferHoriz || scoreH > scoreV)) return 'horizontal';
        return vCuts.length > 0 ? 'vertical' : 'horizontal';
      },
    },
  );

  const lum = extractLuminanceBuffer(rectRgba, W, H, true);
  const vSeamPxs = xyRes.vDividers.map(
    (d) => interiorToExteriorPoint(d.position, 0.5, dimsMm, boardThicknessMm).uExt * W,
  );
  const hSeamPxs = xyRes.hShelves.map((s) => ({
    y: (1 - interiorToExteriorPoint(0.5, s.position, dimsMm, boardThicknessMm).vExt) * H,
    uStart: s.start,
    uEnd: s.end,
  }));
  const detectedHandles =
    xyRes.vDividers.length + xyRes.hShelves.length > 0
      ? detectHandlesLocalContrast(lum, W, H, vSeamPxs, hSeamPxs, dimsMm, boardThicknessMm)
      : [];

  // Clasificación unificada CIE-Lab + interiorToExteriorRect + fusión verificada de cajones
  const inferredZones = classifyZonesUnified(
    xyRes.leaves.map((lf) => ({ uStart: lf.u0, uEnd: lf.u1, vStart: lf.v0, vEnd: lf.v1 })),
    {
      rectRgba,
      rectW: W,
      rectH: H,
      dimsMm,
      boardThicknessMm,
      carcassMaterial: detectedMaterial,
      refRgb: MATERIAL_BASE_RGB[detectedMaterial],
      exteriorBgRgb,
      lum,
      detectedHandles,
      mergeDrawers: true,
      modeHint: 'hybrid',
      idPrefix: 'vz',
    },
  );

  // Eliminar repisas interiores duplicadas dentro de zonas clasificadas como `drawers`
  const hShelves = suppressShelvesInsideDrawers(xyRes.hShelves, inferredZones);

  // Anclar extremos de diagonales reales detectadas a muros/divisores/repisas en espacio interior
  const uAnchors = [0, ...xyRes.vDividers.map((d) => d.position), 1];
  const vAnchors = [0, ...hShelves.map((s) => s.position), 1];
  const diagonalDividers: DiagonalSegment[] = rawDiags.map((d, idx) => ({
    id: `vec_diag_${idx + 1}`,
    u1: Number(snapCoordToAnchors(d.u1, uAnchors, 0.05).toFixed(4)),
    v1: Number(snapCoordToAnchors(d.v1, vAnchors, 0.05).toFixed(4)),
    u2: Number(snapCoordToAnchors(d.u2, uAnchors, 0.05).toFixed(4)),
    v2: Number(snapCoordToAnchors(d.v2, vAnchors, 0.05).toFixed(4)),
  }));

  const hasOpen = inferredZones.some(
    (z) => z.kind === 'open' || z.kind === 'leg_void' || z.kind === 'void_outside',
  );
  const hasClosed = inferredZones.some(
    (z) => z.kind !== 'open' && z.kind !== 'leg_void' && z.kind !== 'void_outside',
  );
  const furnitureMode: 'open' | 'closed_front' | 'hybrid' =
    hasOpen && hasClosed ? 'hybrid' : hasClosed ? 'closed_front' : 'open';

  return {
    vDividers: xyRes.vDividers,
    hShelves,
    diagonalDividers,
    inferredZones,
    detectedMaterial,
    vectorLinesUsed: candV.length + candH.length + diagonalDividers.length,
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
  /** Inyección opcional de `calculateDespiece` para desacoplamiento y pruebas unitarias. */
  calculateDespieceFn?: typeof calculateDespiece;
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
 * Orquestador v8.0 100% offline:
 *   1) Cuando `opts.overrideQuad` es provisto, omite `autoDetectFurnitureQuad` completo y solo
 *      muestrea el fondo exterior (`sampleExteriorBgRgb`) para minimizar latencia.
 *   2) Extrae líneas vectoriales 2D (H, V y diagonales reales 18°–72°) y evalúa márgenes reales.
 *   3) Rectifica la cara frontal y compara Candidato A (Band/Híbrido) vs Candidato B (Vector-First)
 *      evaluando el modelo 3D real contra la foto (`evaluate3DvsPhotoSimilarity`).
 */
export function runIterativePhotoTo3D(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  opts: IterativePhoto3DOptions = {},
): IterativePhoto3DResult | null {
  const focal = opts.focal35mm ?? 26;
  const e = opts.boardThicknessMm ?? 18;
  const depthZ = clamp(opts.currentDepthMm ?? 420, 250, 750);
  const despieceFn = opts.calculateDespieceFn ?? calculateDespiece;

  // Evitar re-ejecutar `autoDetectFurnitureQuad` completo cuando el usuario ya proveyó `overrideQuad`
  let autoQuad: AutoQuadResult;
  if (opts.overrideQuad) {
    const [tl, tr, br, bl] = opts.overrideQuad;
    const avgW =
      0.5 * (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y));
    const avgH =
      0.5 * (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y));
    autoQuad = {
      quadCorners: opts.overrideQuad,
      confidence: 1,
      usedFallback: false,
      aspectRatioEst: avgH > 1 ? avgW / avgH : imgW / Math.max(1, imgH),
      backgroundCoverage: 0,
      exteriorBgRgb: sampleExteriorBgRgb(rgba, imgW, imgH),
    };
  } else {
    autoQuad = autoDetectFurnitureQuad(rgba, imgW, imgH);
  }

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
  const round10 = (v: number) => clamp(Math.round(v / 10) * 10, 450, 2200);

  const effX =
    opts.preferredDimsMm?.x ?? (safeRatio >= 1.15 ? 1400 : round10(1800 * safeRatio));
  const effY =
    opts.preferredDimsMm?.y ?? (safeRatio >= 1.15 ? round10(1400 / safeRatio) : 1800);

  const cameraPose = estimateCameraPoseMeters(usedQuad, imgW, imgH, 'x', effX, focal);
  const { width: dstW, height: dstH } = computeRectifiedSize(effX, effY, e);
  const rectRgba = rectifyImageRGBA(rgba, imgW, imgH, hom.toCanvas, dstW, dstH);
  const legsHint = detectLowerGapHint(rgba, imgW, imgH, usedQuad, autoQuad.exteriorBgRgb);

  // Candidato A: Detector Dual/Híbrido unificado
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
      diagonalDividers: detObj.diagonalDividers,
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: hasLegVoid ? false : (opts.existingBackPanel ?? true),
      baseSupportType: hasLegVoid
        ? 'none'
        : (legsHint.supportType ?? (legsHint.possibleExternalLegs ? 'legs' : 'none')),
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
    const desp = despieceFn(topo, prm);
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

  // Candidato B: Reconstrucción Vector-First directa desde los segmentos VectorLine2D[] (incluyendo diagonales)
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
    if (vecRec.inferredZones.length > 0 || vecRec.diagonalDividers.length > 0) {
      const detB: BandDetectionResult = {
        ...detA,
        furnitureMode: vecRec.furnitureMode,
        vDividers: vecRec.vDividers,
        hShelves: vecRec.hShelves,
        diagonalDividers:
          vecRec.diagonalDividers.length > 0 ? vecRec.diagonalDividers : undefined,
        inferredZones: vecRec.inferredZones,
        confidence: Math.max(detA.confidence, 0.72),
      };
      const simB = scoreCandidate(detB, detB.detectedMaterial);
      if (simB.overallScore > bestSim.overallScore) {
        bestDet = detB;
        bestSim = simB;
        selectedStrategy = 'vector_first';
      } else if (vecRec.diagonalDividers.length > 0) {
        // Evaluar también añadir diagonales detectadas al Candidato A si mejora el parecido 3D
        const detAWithDiag: BandDetectionResult = {
          ...detA,
          diagonalDividers: vecRec.diagonalDividers,
        };
        const simADiag = scoreCandidate(detAWithDiag, detA.detectedMaterial);
        if (simADiag.overallScore >= bestSim.overallScore) {
          bestDet = detAWithDiag;
          bestSim = simADiag;
        }
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
