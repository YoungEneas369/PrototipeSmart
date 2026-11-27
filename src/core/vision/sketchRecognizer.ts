/**
 * SMARTFURNITURE — RECONOCIMIENTO DE DIBUJOS Y BOCETOS A MANO ALZADA (v8.0)
 * 100% TypeScript puro, sin dependencias externas ni DOM.
 *
 * Detecta y vectoriza dibujos en papel blanco/cuadriculado o trazados sobre lienzo digital
 * para las 3 vistas ortogonales (`xy` Frente, `xz` Arriba, `zy` Lado):
 *  - Binarización adaptativa por imagen integral O(W·H) resistente a sombras en fotos reales.
 *  - Extracción de marco exterior, divisores verticales, repisas, diagonales y curvas libres
 *    mediante geometría diferencial (`fitDifferentialCurveFromStroke`).
 *  - Reconocimiento en Planta Superior (`xz`) de silueta Rectangular vs en L (derecha/izquierda)
 *    y detección de esquinas curvas donde no hay ángulo de 90°.
 */
import type {
  CurvePlane,
  CurvedCutSpec,
  DiagonalSegment,
  FrontZone,
  LShapeSide,
  NormalizedSegment,
  Point2D,
} from '../../types/contracts';
import { exteriorToInterior, fitDifferentialCurveFromStroke } from '../mathEngine';
import { clamp, rgbaLuminance } from './imageOps';
import { partitionCellsFromVectors } from './userVectorTrace';

export interface SketchDetectionBadge {
  isSketch: boolean;
  paperRatio: number;
  inkRatio: number;
  meanPaperLum: number;
}

export interface SketchLShapeInference {
  side: LShapeSide;
  returnLengthFrac: number;
  returnDepthFrac: number;
  curvedCorner: boolean;
  filletRadiusFrac: number;
}

export interface SketchRecognitionResult {
  plane: CurvePlane;
  isSketch: boolean;
  aspectRatio: number;
  quadCorners: [Point2D, Point2D, Point2D, Point2D];
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  diagonalDividers: DiagonalSegment[];
  curvedCuts: CurvedCutSpec[];
  frontZones: FrontZone[];
  lShapeInference?: SketchLShapeInference;
  confidence: number;
  inkPixelCount: number;
}

/**
 * Determina si una imagen corresponde principalmente a un dibujo/boceto (fondo claro de papel
 * o lienzo + trazos oscuros finos) frente a una fotografía de mueble con superficie de madera/color.
 */
export function isHandDrawnSketchImage(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): SketchDetectionBadge {
  if (w < 16 || h < 16 || rgba.length < w * h * 4) {
    return { isSketch: false, paperRatio: 0, inkRatio: 0, meanPaperLum: 0 };
  }

  const step = Math.max(1, Math.floor(Math.min(w, h) / 140));
  let total = 0;
  let paperCount = 0;
  let inkCount = 0;
  let paperLumSum = 0;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const lum = rgbaLuminance(r, g, b);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      total++;

      if (lum >= 182 && chroma <= 32) {
        paperCount++;
        paperLumSum += lum;
      } else if (lum <= 135) {
        inkCount++;
      }
    }
  }

  const paperRatio = total > 0 ? paperCount / total : 0;
  const inkRatio = total > 0 ? inkCount / total : 0;
  const meanPaperLum = paperCount > 0 ? paperLumSum / paperCount : 0;
  const isSketch = paperRatio >= 0.56 && inkRatio >= 0.004 && inkRatio <= 0.34;

  return {
    isSketch,
    paperRatio: Number(paperRatio.toFixed(3)),
    inkRatio: Number(inkRatio.toFixed(3)),
    meanPaperLum: Math.round(meanPaperLum),
  };
}

/**
 * Binariza trazos de tinta/lápiz mediante umbral adaptativo basado en imagen integral
 * (ignora cuadrículas claras de fondo y sombras suaves de cámara).
 */
export function binarizeSketchInk(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): { mask: Uint8Array; inkCount: number } {
  const n = w * h;
  const lum = new Float32Array(n);
  const sat = new Uint8Array(n);
  for (let idx = 0; idx < n; idx++) {
    const p = idx * 4;
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    lum[idx] = rgbaLuminance(r, g, b);
    sat[idx] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  // Imagen integral (w+1)×(h+1) para promedios locales rápidos
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    const srcRow = (y - 1) * w;
    const dstRow = y * iw;
    const prevRow = (y - 1) * iw;
    for (let x = 1; x <= w; x++) {
      rowSum += lum[srcRow + x - 1];
      integral[dstRow + x] = integral[prevRow + x] + rowSum;
    }
  }

  const radius = clamp(Math.round(Math.min(w, h) * 0.025), 5, 16);
  const mask = new Uint8Array(n);
  let inkCount = 0;

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      const localMean = sum / area;
      const curLum = lum[y * w + x];
      const curSat = sat[y * w + x];

      // Trazo oscuro real (lápiz/plumón/tinta digital) respecto al papel local
      if ((curLum < localMean - 17 && curLum < 185) || (curSat >= 45 && curLum < 165)) {
        mask[y * w + x] = 1;
        inkCount++;
      }
    }
  }

  return { mask, inkCount };
}

function clusterSortedPositions(items: Array<{ pos: number; start: number; end: number; score: number }>, tol: number) {
  const sorted = [...items].sort((a, b) => a.pos - b.pos);
  const merged: typeof sorted = [];
  for (const it of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(it.pos - last.pos) <= tol) {
      const wSum = last.score + it.score;
      last.pos = (last.pos * last.score + it.pos * it.score) / wSum;
      last.start = Math.min(last.start, it.start);
      last.end = Math.max(last.end, it.end);
      last.score = Math.max(last.score, it.score);
    } else {
      merged.push({ ...it });
    }
  }
  return merged;
}

/**
 * Extrae cadenas conexas interiores de tinta y las clasifica mediante cálculo diferencial
 * en segmentos diagonales rectos o curvas Bézier suaves (`free_bezier`).
 */
function extractInteriorFreeStrokes(
  mask: Uint8Array,
  w: number,
  _h: number,
  x0: number,
  y0: number,
  bw: number,
  bh: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  plane: CurvePlane,
  vDividers: readonly NormalizedSegment[],
  hShelves: readonly NormalizedSegment[],
): { diagonals: DiagonalSegment[]; curves: CurvedCutSpec[] } {
  const diagonals: DiagonalSegment[] = [];
  const curves: CurvedCutSpec[] = [];

  // Rejilla gruesa de muestreo sobre interior excluyendo bordes exteriores y líneas H/V detectadas
  const gw = clamp(Math.round(bw / 3), 24, 140);
  const gh = clamp(Math.round(bh / 3), 24, 140);
  const cell = new Uint8Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    const sy0 = y0 + Math.floor((gy * bh) / gh);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((gy + 1) * bh) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const sx0 = x0 + Math.floor((gx * bw) / gw);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((gx + 1) * bw) / gw));

      const uNorm = (gx + 0.5) / gw;
      const vNorm = 1 - (gy + 0.5) / gh;
      if (uNorm < 0.045 || uNorm > 0.955 || vNorm < 0.045 || vNorm > 0.955) continue;

      const uInt = exteriorToInterior(uNorm, boardThicknessMm, dimsMm.x);
      const vInt = exteriorToInterior(vNorm, boardThicknessMm, dimsMm.y);

      const onKnownV = vDividers.some(
        (d) =>
          Math.abs(d.position - uInt) <= 0.04 &&
          vInt >= Math.min(d.start, d.end) - 0.04 &&
          vInt <= Math.max(d.start, d.end) + 0.04,
      );
      const onKnownH = hShelves.some(
        (s) =>
          Math.abs(s.position - vInt) <= 0.04 &&
          uInt >= Math.min(s.start, s.end) - 0.04 &&
          uInt <= Math.max(s.start, s.end) + 0.04,
      );
      if (onKnownV || onKnownH) continue;

      let hasInk = false;
      for (let py = sy0; py < sy1 && !hasInk; py++) {
        const row = py * w;
        for (let px = sx0; px < sx1; px++) {
          if (mask[row + px] === 1) {
            hasInk = true;
            break;
          }
        }
      }
      if (hasInk) cell[gy * gw + gx] = 1;
    }
  }

  const visited = new Uint8Array(gw * gh);
  let idxCounter = 1;

  for (let startY = 0; startY < gh; startY++) {
    for (let startX = 0; startX < gw; startX++) {
      const startIdx = startY * gw + startX;
      if (cell[startIdx] === 0 || visited[startIdx]) continue;

      const queue: number[] = [startIdx];
      visited[startIdx] = 1;
      const compPts: Array<{ gx: number; gy: number }> = [];

      while (queue.length > 0) {
        const cur = queue.pop()!;
        const cx = cur % gw;
        const cy = Math.floor(cur / gw);
        compPts.push({ gx: cx, gy: cy });

        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
            const ni = ny * gw + nx;
            if (cell[ni] === 1 && !visited[ni]) {
              visited[ni] = 1;
              queue.push(ni);
            }
          }
        }
      }

      if (compPts.length < 8) continue;

      // Ordenar puntos por eje principal (PCA simple por dispersión X vs Y)
      let minGx = gw;
      let maxGx = 0;
      let minGy = gh;
      let maxGy = 0;
      for (const p of compPts) {
        minGx = Math.min(minGx, p.gx);
        maxGx = Math.max(maxGx, p.gx);
        minGy = Math.min(minGy, p.gy);
        maxGy = Math.max(maxGy, p.gy);
      }
      const spanX = maxGx - minGx;
      const spanY = maxGy - minGy;
      if (Math.hypot(spanX / gw, spanY / gh) < 0.16) continue;

      const sortByX = spanX >= spanY;
      const buckets = new Map<number, { sum: number; cnt: number }>();
      for (const p of compPts) {
        const key = sortByX ? p.gx : p.gy;
        const val = sortByX ? p.gy : p.gx;
        const cur = buckets.get(key) ?? { sum: 0, cnt: 0 };
        cur.sum += val;
        cur.cnt += 1;
        buckets.set(key, cur);
      }
      const orderedMm: Point2D[] = Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([k, v]) => {
          const avg = v.sum / v.cnt;
          const gx = sortByX ? k : avg;
          const gy = sortByX ? avg : k;
          const uExt = (gx + 0.5) / gw;
          const vExt = 1 - (gy + 0.5) / gh;
          const uInt = exteriorToInterior(uExt, boardThicknessMm, dimsMm.x);
          const vInt = exteriorToInterior(vExt, boardThicknessMm, dimsMm.y);
          return { x: uInt * dimsMm.x, y: vInt * dimsMm.y };
        });

      const fit = fitDifferentialCurveFromStroke(orderedMm);
      if (!fit) continue;

      if (fit.isCurved) {
        const toNorm = (pt: Point2D): Point2D => ({
          x: Number(clamp(pt.x / Math.max(1, dimsMm.x), 0, 1).toFixed(4)),
          y: Number(clamp(pt.y / Math.max(1, dimsMm.y), 0, 1).toFixed(4)),
        });
        curves.push({
          id: `sk_curve_${idxCounter++}`,
          plane,
          kind: 'free_bezier',
          controlPoints: [
            toNorm(fit.controlPoints[0]),
            toNorm(fit.controlPoints[1]),
            toNorm(fit.controlPoints[2]),
            toNorm(fit.controlPoints[3]),
          ],
          label: `Curva reconocida #${curves.length + 1}`,
          arcLengthMm: fit.arcLengthMm,
          minRadiusMm: fit.minRadiusMm,
          maxCurvature: fit.maxCurvature,
        });
      } else {
        const p0 = fit.controlPoints[0];
        const p3 = fit.controlPoints[3];
        const u1 = clamp(p0.x / Math.max(1, dimsMm.x), 0, 1);
        const v1 = clamp(p0.y / Math.max(1, dimsMm.y), 0, 1);
        const u2 = clamp(p3.x / Math.max(1, dimsMm.x), 0, 1);
        const v2 = clamp(p3.y / Math.max(1, dimsMm.y), 0, 1);
        const angleDeg = (Math.atan2(Math.abs(p3.y - p0.y), Math.abs(p3.x - p0.x)) * 180) / Math.PI;
        if (angleDeg >= 16 && angleDeg <= 74) {
          diagonals.push({
            id: `sk_diag_${idxCounter++}`,
            u1: Number(u1.toFixed(4)),
            v1: Number(v1.toFixed(4)),
            u2: Number(u2.toFixed(4)),
            v2: Number(v2.toFixed(4)),
          });
        }
      }
    }
  }

  return { diagonals, curves };
}

/**
 * Analiza un boceto dibujado a mano (en fotografía sobre papel o en lienzo digital)
 * para las vistas Frontal (`xy`), Superior/Arriba (`xz`) o Lateral (`zy`).
 */
export function recognizeHandDrawnSketch(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  plane: CurvePlane,
  boardThicknessMm = 18,
  dimsMm: { x: number; y: number } = { x: 1200, y: 1200 },
): SketchRecognitionResult {
  const badge = isHandDrawnSketchImage(rgba, w, h);
  const { mask, inkCount } = binarizeSketchInk(rgba, w, h);

  // Caja envolvente robusta usando cuantiles de tinta (ignora motas aisladas en esquinas)
  const colSums = new Float32Array(w);
  const rowSums = new Float32Array(h);
  for (let y = 2; y < h - 2; y++) {
    const row = y * w;
    for (let x = 2; x < w - 2; x++) {
      if (mask[row + x]) {
        colSums[x]++;
        rowSums[y]++;
      }
    }
  }

  const colThreshold = Math.max(2, h * 0.015);
  const rowThreshold = Math.max(2, w * 0.015);
  let xMin = Math.round(w * 0.1);
  let xMax = Math.round(w * 0.9);
  let yMin = Math.round(h * 0.1);
  let yMax = Math.round(h * 0.9);

  for (let x = 3; x < w - 3; x++) {
    if (colSums[x] >= colThreshold) {
      xMin = x;
      break;
    }
  }
  for (let x = w - 4; x > xMin + 20; x--) {
    if (colSums[x] >= colThreshold) {
      xMax = x;
      break;
    }
  }
  for (let y = 3; y < h - 3; y++) {
    if (rowSums[y] >= rowThreshold) {
      yMin = y;
      break;
    }
  }
  for (let y = h - 4; y > yMin + 20; y--) {
    if (rowSums[y] >= rowThreshold) {
      yMax = y;
      break;
    }
  }

  const bw = Math.max(24, xMax - xMin);
  const bh = Math.max(24, yMax - yMin);
  const aspectRatio = Number(clamp(bw / bh, 0.25, 4.0).toFixed(4));
  const quadCorners: [Point2D, Point2D, Point2D, Point2D] = [
    { x: xMin, y: yMin },
    { x: xMax, y: yMin },
    { x: xMax, y: yMax },
    { x: xMin, y: yMax },
  ];

  if (inkCount < 40) {
    return {
      plane,
      isSketch: badge.isSketch,
      aspectRatio,
      quadCorners,
      vDividers: [],
      hShelves: [],
      diagonalDividers: [],
      curvedCuts: [],
      frontZones: [{ id: 'sk_z1', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'open', label: 'Cuerpo' }],
      confidence: 0.2,
      inkPixelCount: inkCount,
    };
  }

  // En Planta Superior (XZ), detectar si el contorno dibujado es rectangular o en L (derecha/izquierda)
  let lShapeInference: SketchLShapeInference | undefined;
  const curvedCuts: CurvedCutSpec[] = [];

  if (plane === 'xz') {
    const qMidX = xMin + Math.floor(bw / 2);
    const qMidY = yMin + Math.floor(bh * 0.45);
    const measureQuadDensity = (qx0: number, qy0: number, qx1: number, qy1: number): number => {
      let hit = 0;
      let tot = 0;
      for (let y = qy0; y < qy1; y++) {
        const r = y * w;
        for (let x = qx0; x < qx1; x++) {
          tot++;
          if (mask[r + x]) hit++;
        }
      }
      return tot > 0 ? hit / tot : 0;
    };

    const marginX = Math.max(3, Math.round(bw * 0.08));
    const marginY = Math.max(3, Math.round(bh * 0.08));
    const botLeftBorder = measureQuadDensity(xMin, qMidY + marginY, xMin + marginX, yMax);
    const botRightBorder = measureQuadDensity(xMax - marginX, qMidY + marginY, xMax, yMax);
    const botLeftInterior = measureQuadDensity(xMin + marginX, qMidY + marginY, qMidX - marginX, yMax - marginY);
    const botRightInterior = measureQuadDensity(qMidX + marginX, qMidY + marginY, xMax - marginX, yMax - marginY);

    // En L Derecha: el borde inferior-izquierdo exterior está vacío (`botLeftBorder` bajo) mientras el derecho baja hasta yMax
    // En L Izquierda: el borde inferior-derecho exterior está vacío mientras el izquierdo baja hasta yMax
    const isRightL = botRightBorder > botLeftBorder * 2.1 && botLeftBorder < 0.035 && botLeftInterior < 0.012;
    const isLeftL = botLeftBorder > botRightBorder * 2.1 && botRightBorder < 0.035 && botRightInterior < 0.012;

    if (isRightL || isLeftL) {
      const side: LShapeSide = isRightL ? 'right' : 'left';
      // Estimar profundidad frontal del ala principal (y1 -> z1Frac) y ancho del retorno
      let z1Row = yMin + Math.round(bh * 0.45);
      for (let y = yMin + Math.round(bh * 0.18); y <= yMax - Math.round(bh * 0.18); y++) {
        let run = 0;
        const rStart = isRightL ? xMin + marginX : qMidX;
        const rEnd = isRightL ? qMidX : xMax - marginX;
        for (let x = rStart; x < rEnd; x++) {
          if (mask[y * w + x] || mask[(y - 1) * w + x] || mask[(y + 1) * w + x]) run++;
        }
        if (run >= Math.max(10, (rEnd - rStart) * 0.55)) {
          z1Row = y;
          break;
        }
      }

      let innerCol = isRightL ? xMin + Math.round(bw * 0.58) : xMin + Math.round(bw * 0.42);
      const cStart = isRightL ? xMin + Math.round(bw * 0.25) : xMin + Math.round(bw * 0.2);
      const cEnd = isRightL ? xMax - Math.round(bw * 0.18) : xMax - Math.round(bw * 0.25);
      for (let x = isRightL ? cEnd : cStart; isRightL ? x >= cStart : x <= cEnd; x += isRightL ? -1 : 1) {
        let colRun = 0;
        for (let y = z1Row + marginY; y < yMax - marginY; y++) {
          if (mask[y * w + x] || mask[y * w + x - 1] || mask[y * w + x + 1]) colRun++;
        }
        if (colRun >= Math.max(8, (yMax - z1Row) * 0.5)) {
          innerCol = x;
          break;
        }
      }

      const z1Frac = clamp((z1Row - yMin) / bh, 0.25, 0.72);
      const returnDepthFrac = isRightL
        ? clamp((xMax - innerCol) / bw, 0.22, 0.65)
        : clamp((innerCol - xMin) / bw, 0.22, 0.65);

      // Comprobar si hay trazo curvo en la esquina interior de la L (en lugar de ángulo recto 90°)
      const pocketX0 = isRightL ? Math.max(xMin, innerCol - Math.round(bw * 0.18)) : innerCol;
      const pocketX1 = isRightL ? innerCol : Math.min(xMax, innerCol + Math.round(bw * 0.18));
      const pocketY0 = z1Row;
      const pocketY1 = Math.min(yMax, z1Row + Math.round(bh * 0.18));
      let diagInkCount = 0;
      for (let py = pocketY0 + 3; py < pocketY1 - 3; py++) {
        for (let px = pocketX0 + 3; px < pocketX1 - 3; px++) {
          if (mask[py * w + px]) diagInkCount++;
        }
      }
      const pocketArea = Math.max(1, (pocketX1 - pocketX0) * (pocketY1 - pocketY0));
      const curvedCorner = diagInkCount / pocketArea >= 0.035;

      lShapeInference = {
        side,
        returnLengthFrac: 1,
        returnDepthFrac: Number(returnDepthFrac.toFixed(3)),
        curvedCorner,
        filletRadiusFrac: curvedCorner ? 0.18 : 0,
      };
      void z1Frac;

      if (curvedCorner) {
        const radiusMm = Math.round(Math.min(dimsMm.x, dimsMm.y) * 0.14);
        curvedCuts.push({
          id: 'sk_l_inner_curve',
          plane: 'xz',
          kind: 'corner_fillet',
          cornerTarget: 'l_inner',
          radiusMm: clamp(radiusMm, 60, 280),
          controlPoints: [
            { x: 0.35, y: 0.4 },
            { x: 0.48, y: 0.4 },
            { x: 0.56, y: 0.48 },
            { x: 0.56, y: 0.62 },
          ],
          label: `Curva interior L detectada en boceto (R=${clamp(radiusMm, 60, 280)} mm)`,
        });
      }
    }
  }

  // En vista Frontal (`xy`) o Libre: detectar líneas internas H, V, Diagonales y Curvas
  const rawV: Array<{ pos: number; start: number; end: number; score: number }> = [];
  const rawH: Array<{ pos: number; start: number; end: number; score: number }> = [];

  if (plane === 'xy') {
    const innerX0 = xMin + Math.round(bw * 0.045);
    const innerX1 = xMax - Math.round(bw * 0.045);
    const innerY0 = yMin + Math.round(bh * 0.045);
    const innerY1 = yMax - Math.round(bh * 0.045);

    // Barrido de columnas verticales internas
    for (let x = innerX0; x <= innerX1; x++) {
      let curStart = -1;
      let curHits = 0;
      for (let y = innerY0; y <= innerY1; y++) {
        const hit =
          mask[y * w + x] === 1 || mask[y * w + Math.max(0, x - 1)] === 1 || mask[y * w + Math.min(w - 1, x + 1)] === 1;
        if (hit) {
          if (curStart < 0) curStart = y;
          curHits++;
        } else if (curStart >= 0) {
          const span = (y - 1 - curStart) / bh;
          if (span >= 0.24 && curHits / Math.max(1, y - curStart) >= 0.62) {
            const uExt = (x - xMin) / bw;
            const vStartExt = 1 - (y - 1 - yMin) / bh;
            const vEndExt = 1 - (curStart - yMin) / bh;
            rawV.push({
              pos: clamp(exteriorToInterior(uExt, boardThicknessMm, dimsMm.x), 0.04, 0.96),
              start: clamp(exteriorToInterior(vStartExt, boardThicknessMm, dimsMm.y), 0, 1),
              end: clamp(exteriorToInterior(vEndExt, boardThicknessMm, dimsMm.y), 0, 1),
              score: curHits,
            });
          }
          curStart = -1;
          curHits = 0;
        }
      }
      if (curStart >= 0) {
        const span = (innerY1 - curStart) / bh;
        if (span >= 0.24 && curHits / Math.max(1, innerY1 - curStart) >= 0.62) {
          const uExt = (x - xMin) / bw;
          const vStartExt = 1 - (innerY1 - yMin) / bh;
          const vEndExt = 1 - (curStart - yMin) / bh;
          rawV.push({
            pos: clamp(exteriorToInterior(uExt, boardThicknessMm, dimsMm.x), 0.04, 0.96),
            start: clamp(exteriorToInterior(vStartExt, boardThicknessMm, dimsMm.y), 0, 1),
            end: clamp(exteriorToInterior(vEndExt, boardThicknessMm, dimsMm.y), 0, 1),
            score: curHits,
          });
        }
      }
    }

    // Barrido de filas horizontales internas
    for (let y = innerY0; y <= innerY1; y++) {
      let curStart = -1;
      let curHits = 0;
      for (let x = innerX0; x <= innerX1; x++) {
        const hit =
          mask[y * w + x] === 1 || mask[Math.max(0, y - 1) * w + x] === 1 || mask[Math.min(h - 1, y + 1) * w + x] === 1;
        if (hit) {
          if (curStart < 0) curStart = x;
          curHits++;
        } else if (curStart >= 0) {
          const span = (x - 1 - curStart) / bw;
          if (span >= 0.22 && curHits / Math.max(1, x - curStart) >= 0.62) {
            const vExt = 1 - (y - yMin) / bh;
            const uStartExt = (curStart - xMin) / bw;
            const uEndExt = (x - 1 - xMin) / bw;
            rawH.push({
              pos: clamp(exteriorToInterior(vExt, boardThicknessMm, dimsMm.y), 0.04, 0.96),
              start: clamp(exteriorToInterior(uStartExt, boardThicknessMm, dimsMm.x), 0, 1),
              end: clamp(exteriorToInterior(uEndExt, boardThicknessMm, dimsMm.x), 0, 1),
              score: curHits,
            });
          }
          curStart = -1;
          curHits = 0;
        }
      }
      if (curStart >= 0) {
        const span = (innerX1 - curStart) / bw;
        if (span >= 0.22 && curHits / Math.max(1, innerX1 - curStart) >= 0.62) {
          const vExt = 1 - (y - yMin) / bh;
          const uStartExt = (curStart - xMin) / bw;
          const uEndExt = (innerX1 - xMin) / bw;
          rawH.push({
            pos: clamp(exteriorToInterior(vExt, boardThicknessMm, dimsMm.y), 0.04, 0.96),
            start: clamp(exteriorToInterior(uStartExt, boardThicknessMm, dimsMm.x), 0, 1),
            end: clamp(exteriorToInterior(uEndExt, boardThicknessMm, dimsMm.x), 0, 1),
            score: curHits,
          });
        }
      }
    }
  }

  const vDividers: NormalizedSegment[] = clusterSortedPositions(rawV, 0.035).map((item, idx) => ({
    id: `sk_div_${idx + 1}`,
    position: Number(item.pos.toFixed(4)),
    start: item.start <= 0.06 ? 0 : Number(item.start.toFixed(4)),
    end: item.end >= 0.94 ? 1 : Number(item.end.toFixed(4)),
  }));

  const hShelves: NormalizedSegment[] = clusterSortedPositions(rawH, 0.035).map((item, idx) => ({
    id: `sk_rep_${idx + 1}`,
    position: Number(item.pos.toFixed(4)),
    start: item.start <= 0.06 ? 0 : Number(item.start.toFixed(4)),
    end: item.end >= 0.94 ? 1 : Number(item.end.toFixed(4)),
  }));

  const freeRes =
    plane === 'xy' || (plane === 'xz' && !lShapeInference)
      ? extractInteriorFreeStrokes(
          mask,
          w,
          h,
          xMin,
          yMin,
          bw,
          bh,
          dimsMm,
          boardThicknessMm,
          plane,
          vDividers,
          hShelves,
        )
      : { diagonals: [], curves: [] };

  const allCurves = [...curvedCuts, ...freeRes.curves];
  const cells = partitionCellsFromVectors(vDividers, hShelves);
  const frontZones: FrontZone[] = cells.map((c, idx) => ({
    id: c.id || `sk_z_${idx + 1}`,
    uStart: c.uStart,
    uEnd: c.uEnd,
    vStart: c.vStart,
    vEnd: c.vEnd,
    kind: 'open',
    label: cells.length === 1 ? 'Cuerpo' : `Parte ${idx + 1}`,
  }));

  const featureCount =
    vDividers.length +
    hShelves.length +
    freeRes.diagonals.length +
    allCurves.length +
    (lShapeInference ? 2 : 0);
  const confidence = badge.isSketch
    ? clamp(0.62 + Math.min(0.32, featureCount * 0.06), 0.55, 0.94)
    : clamp(0.45 + Math.min(0.25, featureCount * 0.05), 0.4, 0.78);

  return {
    plane,
    isSketch: badge.isSketch,
    aspectRatio,
    quadCorners,
    vDividers,
    hShelves,
    diagonalDividers: freeRes.diagonals,
    curvedCuts: allCurves,
    frontZones,
    lShapeInference,
    confidence: Number(confidence.toFixed(3)),
    inkPixelCount: inkCount,
  };
}
