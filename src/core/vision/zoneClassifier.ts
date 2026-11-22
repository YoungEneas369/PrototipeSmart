/**
 * SMARTFURNITURE — CLASIFICADOR UNIFICADO DE ZONAS FRONTALES, MANILLAS Y APOYO INFERIOR (v8.0)
 * 100% offline, TypeScript puro + TypedArrays.
 *
 * Reemplaza los 4 clasificadores divergentes (`bandDetector` cerrado/híbrido/abierto, `vectorLines`
 * y `userVectorTrace`) garantizando:
 *  1. Mapeo SIEMPRE mediante `interiorToExteriorRect()` (elimina los 6 bugs de contaminación de espacio).
 *  2. Detección de manillas por contraste local (oscuras sobre blanco/roble Y claras/cromadas sobre grafito).
 *  3. Distinción real de `door_glass` vs puertas Shaker de madera (gradiente interno / reflejo / croma).
 *  4. Verificación estricta de adyacencia vertical (`|a.vEnd - b.vStart| < 0.03`) antes de fusionar cajones.
 *  5. Heurísticas offline v7.0/v8.0: `void_outside` (escalón superior), `baskets` (rejilla metálica)
 *     y apoyo inferior (`legs` | `wheels` | `toe_kick` | `none`).
 */
import type {
  BaseSupportType,
  FrontModuleKind,
  FrontZone,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
} from '../../types/contracts';
import { exteriorToInterior } from '../mathEngine';
import {
  MATERIAL_BASE_RGB,
  clusterCarcassVsFronts,
  deltaE76,
  inferMaterialOverrideLab,
  isWarmWoodLab,
  rgbDeltaE,
  rgbToLab,
  type LabColor,
} from './colorClassifier';
import {
  boxBlur2D,
  clamp,
  extractLuminanceBuffer,
  interiorToExteriorPoint,
  interiorToExteriorRect,
  median,
  rgbaLuminance,
  sampleLumSafe,
} from './imageOps';

export interface DetectedHandlePoint {
  u: number;
  v: number;
  /** Polaridad detectada respecto al panel local ('dark' = negro/oscuro, 'bright' = cromado/claro). */
  polarity?: 'dark' | 'bright';
}

export interface CellRect {
  id?: string;
  uStart: number;
  uEnd: number;
  vStart: number;
  vEnd: number;
}

export interface BasketPatternEstimate {
  wireGridScore: number;
  estimatedCount: number;
}

export interface CellPixelStats {
  meanR: number;
  meanG: number;
  meanB: number;
  meanLab: LabColor;
  meanL: number;
  stdL: number;
  bgRatio: number;
  transparentRatio: number;
  matchRatio: number;
  frameMeanL: number;
  frameStdL: number;
  frameLab: LabColor;
  centerMeanL: number;
  centerStdL: number;
  centerLab: LabColor;
  centerGradMean: number;
  centerSpecularRatio: number;
  wireGridScore: number;
  estimatedBasketCount: number;
  validPixels: number;
}

/**
 * Detecta patrones repetitivos de alta frecuencia tipo rejilla metálica (`baskets`)
 * buscando cruces periódicos de alambres delgados en AMBAS direcciones (horizontal y vertical).
 */
export function detectBasketPattern(
  lum: Float32Array,
  W: number,
  H: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): BasketPatternEstimate {
  if (W < 8 || H < 8 || lum.length < W * H) {
    return { wireGridScore: 0, estimatedCount: 3 };
  }
  const sx0 = clamp(Math.floor(x0), 0, W - 1);
  const sx1 = clamp(Math.ceil(x1), sx0, W - 1);
  const sy0 = clamp(Math.floor(y0), 0, H - 1);
  const sy1 = clamp(Math.ceil(y1), sy0, H - 1);
  const cw = sx1 - sx0;
  const ch = sy1 - sy0;
  if (cw < 20 || ch < 24) {
    return { wireGridScore: 0, estimatedCount: 3 };
  }

  const wireThresh = 17;
  const stepY = Math.max(1, Math.floor(ch / 64));
  const stepX = Math.max(1, Math.floor(cw / 64));

  // 1. Cruces de alambres verticales a lo largo de filas horizontales
  // Exigir pulso bilateral (pico o valle: dL * dR > 0) para rechazar 100% escalones de marcos de vidrio
  let rowsChecked = 0;
  let rowsWithGrid = 0;
  let totalVWires = 0;
  const rowWireEnergy: number[] = [];

  for (let y = sy0 + 2; y <= sy1 - 2; y += stepY) {
    const rowOff = y * W;
    let crossings = 0;
    let lastCross = -10;
    for (let x = sx0 + 3; x <= sx1 - 3; x++) {
      if (x - lastCross < 5) continue;
      const cur = lum[rowOff + x];
      const dL = cur - lum[rowOff + x - 3];
      const dR = cur - lum[rowOff + x + 3];
      if (dL * dR <= 0) continue;
      const pulse = Math.min(Math.abs(dL), Math.abs(dR));
      if (pulse >= wireThresh) {
        const dL2 = cur - lum[rowOff + x - 2];
        const dR2 = cur - lum[rowOff + x + 2];
        if (dL2 * dR2 > 0 || Math.max(Math.abs(dL2), Math.abs(dR2)) >= wireThresh * 0.65) {
          crossings++;
          lastCross = x;
        }
      }
    }
    rowsChecked++;
    totalVWires += crossings;
    if (crossings >= 3) rowsWithGrid++;
    rowWireEnergy.push(crossings);
  }

  // 2. Cruces de alambres horizontales a lo largo de columnas verticales
  let colsChecked = 0;
  let colsWithGrid = 0;
  let totalHWires = 0;

  for (let x = sx0 + 2; x <= sx1 - 2; x += stepX) {
    let crossings = 0;
    let lastCross = -10;
    for (let y = sy0 + 3; y <= sy1 - 3; y++) {
      if (y - lastCross < 5) continue;
      const cur = lum[y * W + x];
      const dU = cur - lum[(y - 3) * W + x];
      const dD = cur - lum[(y + 3) * W + x];
      if (dU * dD <= 0) continue;
      const pulse = Math.min(Math.abs(dU), Math.abs(dD));
      if (pulse >= wireThresh) {
        const dU2 = cur - lum[(y - 2) * W + x];
        const dD2 = cur - lum[(y + 2) * W + x];
        if (dU2 * dD2 > 0 || Math.max(Math.abs(dU2), Math.abs(dD2)) >= wireThresh * 0.65) {
          crossings++;
          lastCross = y;
        }
      }
    }
    colsChecked++;
    totalHWires += crossings;
    if (crossings >= 3) colsWithGrid++;
  }

  const rowGridFrac = rowsChecked > 0 ? rowsWithGrid / rowsChecked : 0;
  const colGridFrac = colsChecked > 0 ? colsWithGrid / colsChecked : 0;
  const avgV = rowsChecked > 0 ? totalVWires / rowsChecked : 0;
  const avgH = colsChecked > 0 ? totalHWires / colsChecked : 0;

  // Exigir rejilla bidireccional repetitiva (alambres verticales Y horizontales)
  if (rowGridFrac < 0.32 || colGridFrac < 0.32 || avgV < 2.5 || avgH < 2.5) {
    return { wireGridScore: 0, estimatedCount: 3 };
  }

  const wireGridScore = clamp(
    0.4 * Math.min(1, rowGridFrac / 0.7) +
      0.4 * Math.min(1, colGridFrac / 0.7) +
      0.2 * Math.min(1, Math.min(avgV, avgH) / 6),
    0,
    1,
  );

  // Estimar número de canastos apilados buscando bandas verticales de alta densidad de rejilla
  let bands = 0;
  let inBand = false;
  let lowGap = 0;
  const minGapRows = Math.max(2, Math.round(rowWireEnergy.length * 0.06));
  for (let i = 0; i < rowWireEnergy.length; i++) {
    if (rowWireEnergy[i] >= 3) {
      if (!inBand) {
        bands++;
        inBand = true;
      }
      lowGap = 0;
    } else if (inBand) {
      lowGap++;
      if (lowGap >= minGapRows) {
        inBand = false;
      }
    }
  }
  const estimatedCount = bands >= 2 && bands <= 5 ? bands : clamp(Math.round(ch / Math.max(24, cw * 0.6)), 2, 4);

  return { wireGridScore, estimatedCount };
}

/**
 * Muestrea estadísticas completas de una celda `[uStart, uEnd] × [vStart, vEnd]`
 * (SIEMPRE en espacio INTERIOR) mapeándola exactamente a píxeles de la imagen rectificada
 * mediante `interiorToExteriorRect()`.
 */
export function measureCellStats(
  cell: CellRect,
  rectRgba: Uint8ClampedArray,
  lum: Float32Array,
  rectW: number,
  rectH: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  exteriorBgRgb?: readonly [number, number, number],
  matchMap?: Float32Array,
  insetFrac = 0.08,
): CellPixelStats {
  const rect = interiorToExteriorRect(
    cell,
    dimsMm,
    boardThicknessMm,
    rectW,
    rectH,
    insetFrac,
  );
  const { x0, x1, y0, y1 } = rect;
  const cw = x1 - x0;
  const ch = y1 - y0;

  const fx0 = x0 + Math.round(cw * 0.2);
  const fx1 = x1 - Math.round(cw * 0.2);
  const fy0 = y0 + Math.round(ch * 0.18);
  const fy1 = y1 - Math.round(ch * 0.18);

  const bgLab = exteriorBgRgb
    ? rgbToLab(exteriorBgRgb[0], exteriorBgRgb[1], exteriorBgRgb[2])
    : null;

  let sumR = 0,
    sumG = 0,
    sumB = 0,
    sumL = 0,
    sumL2 = 0;
  let bgHits = 0,
    transHits = 0,
    matchHits = 0,
    cnt = 0;

  let fSumL = 0,
    fSumL2 = 0,
    fSumR = 0,
    fSumG = 0,
    fSumB = 0,
    fCnt = 0;
  let cSumL = 0,
    cSumL2 = 0,
    cSumR = 0,
    cSumG = 0,
    cSumB = 0,
    cCnt = 0;
  let cGradSum = 0,
    cGradCnt = 0;
  const centerLums: number[] = [];

  const step = cw > 140 || ch > 140 ? 2 : 1;

  for (let y = y0; y <= y1; y += step) {
    const rowOff = y * rectW;
    for (let x = x0; x <= x1; x += step) {
      const idx = rowOff + x;
      const p = idx * 4;
      if (rectRgba[p + 3] < 128) {
        bgHits++;
        transHits++;
        cnt++;
        continue;
      }
      const r = rectRgba[p];
      const g = rectRgba[p + 1];
      const b = rectRgba[p + 2];
      const l = lum[idx];
      sumR += r;
      sumG += g;
      sumB += b;
      sumL += l;
      sumL2 += l * l;

      if (matchMap && matchMap[idx] > 0.52) {
        matchHits++;
      }

      if (exteriorBgRgb && bgLab) {
        const dRgb = Math.hypot(
          r - exteriorBgRgb[0],
          g - exteriorBgRgb[1],
          b - exteriorBgRgb[2],
        );
        if (dRgb <= 36) {
          bgHits++;
        } else if (dRgb <= 54) {
          const dE = deltaE76(rgbToLab(r, g, b), bgLab);
          if (dE <= 16) bgHits++;
        }
      }

      const inCenter = x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1;
      if (inCenter) {
        cSumL += l;
        cSumL2 += l * l;
        cSumR += r;
        cSumG += g;
        cSumB += b;
        cCnt++;
        centerLums.push(l);
        if (x > 0 && x < rectW - 1 && y > 0 && y < rectH - 1) {
          const gx = lum[rowOff + x + 1] - lum[rowOff + x - 1];
          const gy = lum[(y + 1) * rectW + x] - lum[(y - 1) * rectW + x];
          cGradSum += Math.hypot(gx, gy);
          cGradCnt++;
        }
      } else {
        fSumL += l;
        fSumL2 += l * l;
        fSumR += r;
        fSumG += g;
        fSumB += b;
        fCnt++;
      }
      cnt++;
    }
  }

  const opaqueCnt = Math.max(1, cnt - transHits);
  const nSafe = Math.max(1, cnt);
  const meanR = sumR / opaqueCnt;
  const meanG = sumG / opaqueCnt;
  const meanB = sumB / opaqueCnt;
  const meanL = sumL / opaqueCnt;
  const stdL = Math.sqrt(Math.max(0, sumL2 / opaqueCnt - meanL * meanL));

  const frameMeanL = fCnt > 0 ? fSumL / fCnt : meanL;
  const frameStdL = fCnt > 0 ? Math.sqrt(Math.max(0, fSumL2 / fCnt - frameMeanL * frameMeanL)) : stdL;
  const frameLab =
    fCnt > 0 ? rgbToLab(fSumR / fCnt, fSumG / fCnt, fSumB / fCnt) : rgbToLab(meanR, meanG, meanB);

  const centerMeanL = cCnt > 0 ? cSumL / cCnt : meanL;
  const centerStdL =
    cCnt > 0 ? Math.sqrt(Math.max(0, cSumL2 / cCnt - centerMeanL * centerMeanL)) : stdL;
  const centerLab =
    cCnt > 0 ? rgbToLab(cSumR / cCnt, cSumG / cCnt, cSumB / cCnt) : rgbToLab(meanR, meanG, meanB);
  const centerGradMean = cGradCnt > 0 ? cGradSum / cGradCnt : 0;

  // Reflejos especulares dentro del cristal (píxeles notablemente más brillantes que la media del cristal)
  let specHits = 0;
  if (centerLums.length >= 12) {
    const specThresh = Math.min(248, centerMeanL + Math.max(24, centerStdL * 1.4));
    for (let i = 0; i < centerLums.length; i++) {
      if (centerLums[i] >= specThresh) specHits++;
    }
  }
  const centerSpecularRatio = centerLums.length > 0 ? specHits / centerLums.length : 0;

  const basket = detectBasketPattern(lum, rectW, rectH, x0, x1, y0, y1);

  return {
    meanR,
    meanG,
    meanB,
    meanLab: rgbToLab(meanR, meanG, meanB),
    meanL,
    stdL,
    bgRatio: bgHits / nSafe,
    transparentRatio: transHits / nSafe,
    matchRatio: matchHits / nSafe,
    frameMeanL,
    frameStdL,
    frameLab,
    centerMeanL,
    centerStdL,
    centerLab,
    centerGradMean,
    centerSpecularRatio,
    wireGridScore: basket.wireGridScore,
    estimatedBasketCount: basket.estimatedCount,
    validPixels: cnt,
  };
}

/**
 * Determina si una celda corresponde a una PUERTA VIDRIADA (`door_glass`) sin confundirla
 * con una puerta Shaker de madera con tablero rehundido:
 *  - Exige altura mínima (`>= 360 mm`) y marco relativamente uniforme más claro que el centro.
 *  - Descarta puertas Shaker de madera (marco y centro del mismo tono cálido sin gradiente/reflejo).
 *  - Valida señal genuina de vidrio: gradiente/estructura interna, reflejo especular o cambio cromático/oscurecimiento fuerte.
 */
export function isGlassDoorFromStats(
  stats: CellPixelStats,
  cellWmm: number,
  cellHmm: number,
): boolean {
  if (cellHmm < 360) return false;
  if (cellHmm / Math.max(1, cellWmm) < 1.05) return false;
  if (stats.frameStdL >= 42) return false;

  const frameDrop = stats.frameMeanL - stats.centerMeanL;
  if (frameDrop < 11) return false;
  if (stats.stdL >= 52) return false;

  const frameIsWood = isWarmWoodLab(stats.frameLab);
  const centerIsWood = isWarmWoodLab(stats.centerLab);
  const sameWoodHue =
    frameIsWood &&
    centerIsWood &&
    Math.abs(stats.centerLab[1] - stats.frameLab[1]) < 6 &&
    Math.abs(stats.centerLab[2] - stats.frameLab[2]) < 7;

  const hasInternalStructure = stats.centerGradMean >= 7.5 || stats.centerStdL >= 11;
  const hasSpecularReflection = stats.centerSpecularRatio >= 0.02;
  const hasCoolerGlassTint = stats.centerLab[2] < stats.frameLab[2] - 5 || !centerIsWood;

  // Guardia anti-Shaker: si marco y centro son madera del mismo tono sin estructura ni reflejo
  if (sameWoodHue && !hasInternalStructure && !hasSpecularReflection && frameDrop < 26) {
    return false;
  }

  return (
    hasInternalStructure ||
    hasSpecularReflection ||
    (hasCoolerGlassTint && frameDrop >= 13) ||
    frameDrop >= 24
  );
}

/**
 * Detector unificado de tiradores/manillas por CONTRASTE LOCAL bidireccional:
 *  - Detecta manillas oscuras sobre melamina blanca o roble (`lum < localBg - thresh`).
 *  - Detecta manillas claras/cromadas sobre melamina grafito o nogal oscuro (`lum > localBg + thresh`).
 *  - Emite coordenadas normalizadas en espacio INTERIOR `[0, 1]^2` consistentes con `FrontZone`.
 */
export function detectHandlesLocalContrast(
  lum: Float32Array,
  W: number,
  H: number,
  vSeamPxs: readonly number[],
  hSeams: ReadonlyArray<{ y: number; uStart: number; uEnd: number }>,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
): DetectedHandlePoint[] {
  if (W < 36 || H < 36) return [];

  const nPx = W * H;
  const bgRadius = clamp(Math.round(Math.min(W, H) * 0.05), 9, 26);
  const localBg = boxBlur2D(lum, W, H, bgRadius);

  const darkMask = new Uint8Array(nPx);
  const brightMask = new Uint8Array(nPx);
  const borderX = Math.max(10, Math.round(W * 0.025));
  const borderY = Math.max(10, Math.round(H * 0.055));

  // Umbral relativo adaptativo: separa herrajes metálicos reales de molduras decorativas de madera
  for (let y = borderY; y < H - borderY; y++) {
    const rowOff = y * W;
    for (let x = borderX; x < W - borderX; x++) {
      const idx = rowOff + x;
      const bg = localBg[idx];
      const diff = lum[idx] - bg;
      const darkThresh = Math.max(62, bg * 0.56);
      const brightThresh = Math.max(58, (255 - bg) * 0.34);
      if (diff <= -darkThresh) {
        darkMask[idx] = 1;
      } else if (diff >= brightThresh) {
        brightMask[idx] = 1;
      }
    }
  }

  // Enmascarar ±7 px alrededor de juntas verticales y horizontales (usando interior -> exterior exacto)
  const seamClear = 7;
  const clearSeam = (mask: Uint8Array) => {
    for (const vx of vSeamPxs) {
      const x0 = Math.max(0, Math.round(vx) - seamClear);
      const x1 = Math.min(W - 1, Math.round(vx) + seamClear);
      for (let y = 0; y < H; y++) {
        const rowOff = y * W;
        for (let x = x0; x <= x1; x++) mask[rowOff + x] = 0;
      }
    }
    for (const hr of hSeams) {
      const y0 = Math.max(0, Math.round(hr.y) - seamClear);
      const y1 = Math.min(H - 1, Math.round(hr.y) + seamClear);
      const p0 = interiorToExteriorPoint(hr.uStart, 0.5, dimsMm, boardThicknessMm);
      const p1 = interiorToExteriorPoint(hr.uEnd, 0.5, dimsMm, boardThicknessMm);
      const x0 = clamp(Math.floor(p0.uExt * W), 0, W - 1);
      const x1 = clamp(Math.ceil(p1.uExt * W), x0, W - 1);
      for (let y = y0; y <= y1; y++) {
        const rowOff = y * W;
        for (let x = x0; x <= x1; x++) mask[rowOff + x] = 0;
      }
    }
  };
  clearSeam(darkMask);
  clearSeam(brightMask);

  const extractBlobs = (
    mask: Uint8Array,
    polarity: 'dark' | 'bright',
  ): DetectedHandlePoint[] => {
    const visited = new Uint8Array(nPx);
    const rawBlobs: Array<{ cx: number; cy: number; area: number }> = [];
    const queueX: number[] = [];
    const queueY: number[] = [];

    for (let y = borderY; y < H - borderY; y++) {
      for (let x = borderX; x < W - borderX; x++) {
        const idx0 = y * W + x;
        if (mask[idx0] === 0 || visited[idx0] === 1) continue;

        visited[idx0] = 1;
        queueX.length = 0;
        queueY.length = 0;
        queueX.push(x);
        queueY.push(y);

        let head = 0;
        let minX = x,
          maxX = x,
          minY = y,
          maxY = y;
        let sumX = 0,
          sumY = 0;
        let deepCoreCount = 0;

        while (head < queueX.length) {
          const cx = queueX[head];
          const cy = queueY[head];
          head++;
          sumX += cx;
          sumY += cy;
          const idx = cy * W + cx;
          const bgVal = localBg[idx];
          const signedDiff = polarity === 'dark' ? bgVal - lum[idx] : lum[idx] - bgVal;
          const coreThresh =
            polarity === 'dark'
              ? Math.max(72, bgVal * 0.62)
              : Math.max(70, (255 - bgVal) * 0.42);
          if (signedDiff >= coreThresh) deepCoreCount++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          for (let dy = -4; dy <= 4; dy++) {
            const ny = cy + dy;
            if (ny < borderY || ny >= H - borderY) continue;
            const nRow = ny * W;
            for (let dx = -4; dx <= 4; dx++) {
              const nx = cx + dx;
              if (nx < borderX || nx >= W - borderX) continue;
              const nIdx = nRow + nx;
              if (mask[nIdx] === 1 && visited[nIdx] === 0) {
                visited[nIdx] = 1;
                queueX.push(nx);
                queueY.push(ny);
              }
            }
          }
        }

        const area = head;
        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const fillRatio = area / Math.max(1, bw * bh);
        // Descartar molduras huecas grandes (baja compacidad) y nudos débiles; conservar herrajes metálicos
        if (
          area >= 24 &&
          deepCoreCount >= 10 &&
          area <= nPx * 0.018 &&
          bw <= W * 0.16 &&
          bh <= H * 0.35 &&
          fillRatio >= 0.22
        ) {
          rawBlobs.push({ cx: sumX / area, cy: sumY / area, area });
        }
      }
    }

    const mergeDistX = Math.max(12, W * 0.022);
    const mergeDistY = Math.max(24, H * 0.15);
    const used = new Array<boolean>(rawBlobs.length).fill(false);
    const out: DetectedHandlePoint[] = [];

    for (let i = 0; i < rawBlobs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      let sx = rawBlobs[i].cx * rawBlobs[i].area;
      let sy = rawBlobs[i].cy * rawBlobs[i].area;
      let totalA = rawBlobs[i].area;

      for (let j = i + 1; j < rawBlobs.length; j++) {
        if (used[j]) continue;
        const dx = Math.abs(rawBlobs[j].cx - sx / totalA);
        const dy = Math.abs(rawBlobs[j].cy - sy / totalA);
        if (dx <= mergeDistX && dy <= mergeDistY) {
          used[j] = true;
          sx += rawBlobs[j].cx * rawBlobs[j].area;
          sy += rawBlobs[j].cy * rawBlobs[j].area;
          totalA += rawBlobs[j].area;
        }
      }

      if (totalA >= 36) {
        const uExt = sx / totalA / W;
        const vExt = 1 - sy / totalA / H;
        out.push({
          u: Number(exteriorToInterior(uExt, boardThicknessMm, dimsMm.x).toFixed(4)),
          v: Number(exteriorToInterior(vExt, boardThicknessMm, dimsMm.y).toFixed(4)),
          polarity,
        });
      }
    }

    return out;
  };

  const darkHandles = extractBlobs(darkMask, 'dark');
  const brightHandles = extractBlobs(brightMask, 'bright');

  // Fusionar deduplicando si un tirador metálico bicolor genera halo claro + núcleo oscuro en el mismo punto
  const merged: DetectedHandlePoint[] = [...darkHandles];
  for (const bh of brightHandles) {
    const dup = merged.some(
      (dh) => Math.abs(dh.u - bh.u) < 0.035 && Math.abs(dh.v - bh.v) < 0.06,
    );
    if (!dup) merged.push(bh);
  }
  return merged;
}

export interface ZoneClassificationContext {
  rectRgba: Uint8ClampedArray | null;
  rectW: number;
  rectH: number;
  dimsMm: { x: number; y: number };
  boardThicknessMm: number;
  carcassMaterial: MelamineMaterial;
  refRgb?: readonly [number, number, number];
  exteriorBgRgb?: readonly [number, number, number];
  lum?: Float32Array;
  matchMap?: Float32Array;
  detectedHandles?: readonly DetectedHandlePoint[];
  previousZones?: readonly FrontZone[];
  /** Fusionar cajones verticalmente adyacentes (`|a.vEnd - b.vStart| < 0.03`) en la misma columna. */
  mergeDrawers?: boolean;
  modeHint?: 'open' | 'closed' | 'hybrid' | 'traced';
  idPrefix?: string;
}

function defaultLabelForKind(kind: FrontModuleKind, idx: number, count?: number): string {
  switch (kind) {
    case 'void_outside':
      return 'Sin mueble (Escalón)';
    case 'leg_void':
      return 'Hueco Piernas';
    case 'baskets':
      return `${count ?? 3} Canastos`;
    case 'door_glass':
      return 'Vitrina';
    case 'open':
      return `Vano ${idx + 1}`;
    case 'drawers':
      return count && count > 1 ? `${count} Cajones` : 'Cajón';
    case 'door_double':
      return '2 Puertas';
    default:
      return 'Puerta';
  }
}

/**
 * Clasificador unificado de celdas `FrontZone` (única fuente de verdad para `bandDetector`,
 * `vectorLines` y `userVectorTrace`).
 */
export function classifyZonesUnified(
  cells: readonly CellRect[],
  ctx: ZoneClassificationContext,
): FrontZone[] {
  const {
    rectRgba,
    rectW,
    rectH,
    dimsMm,
    boardThicknessMm,
    carcassMaterial,
    exteriorBgRgb,
    matchMap,
    detectedHandles = [],
    previousZones = [],
    mergeDrawers = false,
    modeHint = 'hybrid',
    idPrefix = 'zone',
  } = ctx;

  if (cells.length === 0) return [];

  const refRgb = ctx.refRgb ?? MATERIAL_BASE_RGB[carcassMaterial];
  const refLum = rgbaLuminance(refRgb[0], refRgb[1], refRgb[2]);
  const refLab = rgbToLab(refRgb[0], refRgb[1], refRgb[2]);
  const bgDistFromCarcass = exteriorBgRgb ? rgbDeltaE(refRgb, exteriorBgRgb) : 999;

  if (!rectRgba || rectW < 20 || rectH < 20) {
    return cells.map((cell, idx) => ({
      id: cell.id ?? `${idPrefix}_${idx + 1}`,
      uStart: Number(cell.uStart.toFixed(4)),
      uEnd: Number(cell.uEnd.toFixed(4)),
      vStart: Number(cell.vStart.toFixed(4)),
      vEnd: Number(cell.vEnd.toFixed(4)),
      kind: 'open',
      label: `Zona ${idx + 1}`,
    }));
  }

  const lum = ctx.lum ?? extractLuminanceBuffer(rectRgba, rectW, rectH, true);

  interface ClassifiedCell {
    cell: CellRect;
    stats: CellPixelStats;
    kind: FrontModuleKind;
    drawerCount?: number;
    basketCount?: number;
    matOverride?: MelamineMaterial;
    preserved?: FrontZone;
  }

  // 1. Medir estadísticas exactas en espacio exterior rectificado para cada celda
  const measured = cells.map((cell) => {
    const prevMatch = previousZones.find(
      (pz) =>
        Math.abs(pz.uStart - cell.uStart) <= 0.04 &&
        Math.abs(pz.uEnd - cell.uEnd) <= 0.04 &&
        Math.abs(pz.vStart - cell.vStart) <= 0.04 &&
        Math.abs(pz.vEnd - cell.vEnd) <= 0.04,
    );
    const stats = measureCellStats(
      cell,
      rectRgba,
      lum,
      rectW,
      rectH,
      dimsMm,
      boardThicknessMm,
      exteriorBgRgb,
      matchMap,
      0.09,
    );
    return { cell, stats, prevMatch };
  });

  // 2. Clustering ligero bicolor en CIE-Lab sobre celdas candidatas a frente sólido
  const candidateIdxMap: number[] = [];
  const candidateRgbs: [number, number, number][] = [];
  measured.forEach((m, idx) => {
    if (m.stats.bgRatio < 0.45 && m.stats.stdL <= 36) {
      candidateIdxMap.push(idx);
      candidateRgbs.push([m.stats.meanR, m.stats.meanG, m.stats.meanB]);
    }
  });
  const bicolorCluster = clusterCarcassVsFronts(
    refRgb,
    carcassMaterial,
    candidateRgbs,
    exteriorBgRgb,
  );
  const clusterOverrideByIdx = new Map<number, MelamineMaterial>();
  if (bicolorCluster.isBicolor && bicolorCluster.secondaryMaterial) {
    for (let k = 0; k < candidateIdxMap.length; k++) {
      if (bicolorCluster.assignments[k] === 'secondary') {
        clusterOverrideByIdx.set(candidateIdxMap[k], bicolorCluster.secondaryMaterial);
      }
    }
  }

  // 3. Clasificar cada celda con criterios unificados
  const items: ClassifiedCell[] = measured.map(({ cell, stats, prevMatch }, idx) => {
    if (prevMatch) {
      return {
        cell,
        stats,
        kind: prevMatch.kind,
        drawerCount: prevMatch.drawerCount,
        basketCount: prevMatch.basketCount,
        matOverride: prevMatch.materialOverride,
        preserved: prevMatch,
      };
    }

    const spanU = cell.uEnd - cell.uStart;
    const spanV = cell.vEnd - cell.vStart;
    const cellWmm = spanU * dimsMm.x;
    const cellHmm = spanV * dimsMm.y;
    const isWarmWood = isWarmWoodLab(stats.meanLab, stats.stdL);
    const dCarcassLab = deltaE76(stats.meanLab, refLab);
    const dCarcassRgb = Math.hypot(
      stats.meanR - refRgb[0],
      stats.meanG - refRgb[1],
      stats.meanB - refRgb[2],
    );
    const dToBgLab = exteriorBgRgb
      ? deltaE76(stats.meanLab, rgbToLab(exteriorBgRgb[0], exteriorBgRgb[1], exteriorBgRgb[2]))
      : 999;

    const singleOverride = inferMaterialOverrideLab(
      [stats.meanR, stats.meanG, stats.meanB],
      refRgb,
      carcassMaterial,
      stats.stdL,
      exteriorBgRgb,
    );
    const matOverride = singleOverride ?? clusterOverrideByIdx.get(idx);

    const bgClearlyExterior =
      stats.transparentRatio >= 0.45 ||
      (exteriorBgRgb !== undefined &&
        (bgDistFromCarcass >= 14 || dToBgLab < dCarcassLab * 0.55));

    // 3a. Hueco inferior de piernas (`leg_void` — escritorio): exige que el fondo difiera de la carcasa
    // (evita convertir puertas blancas inferiores sobre pared blanca en falsos huecos de piernas)
    const isLegVoid =
      cell.vStart <= 0.05 &&
      stats.bgRatio >= 0.48 &&
      bgClearlyExterior &&
      (!matchMap || stats.matchRatio < 0.45) &&
      (spanU < 0.94 || spanV < 0.92);

    // 3b. Recorte escalonado superior (`void_outside` v7.0/v8.0)
    const atTopCorner =
      cell.vEnd >= 0.96 &&
      cell.vStart > 0.08 &&
      (cell.uStart <= 0.04 || cell.uEnd >= 0.96) &&
      spanU < 0.92 &&
      spanV < 0.92;
    const isVoidOutside =
      !isLegVoid &&
      atTopCorner &&
      stats.bgRatio >= 0.62 &&
      bgClearlyExterior &&
      stats.stdL < 22 &&
      (!matchMap || stats.matchRatio < 0.28);

    // 3c. Canastos metálicos (`baskets` v7.0/v8.0 — rejilla repetitiva de alta frecuencia)
    const isBaskets =
      !isLegVoid &&
      !isVoidOutside &&
      stats.wireGridScore >= 0.48 &&
      stats.stdL >= 14 &&
      !isWarmWood;

    let kind: FrontModuleKind;
    let basketCount: number | undefined;
    let drawerCount: number | undefined;

    if (isLegVoid) {
      kind = 'leg_void';
    } else if (isVoidOutside) {
      kind = 'void_outside';
    } else if (isBaskets) {
      kind = 'baskets';
      basketCount = stats.estimatedBasketCount;
    } else if (modeHint === 'open') {
      // En modo abierto, solo promover a puerta bicolor cerrada cuando hay claro panel liso de madera contrastante
      const isContrastingWoodDoor =
        cells.length >= 2 &&
        stats.stdL < 38 &&
        isWarmWood &&
        carcassMaterial !== 'roble' &&
        dCarcassLab >= 18;
      if (isContrastingWoodDoor) {
        kind = cellWmm > 620 ? 'door_double' : cell.uStart < 0.48 ? 'door_left' : 'door_right';
      } else {
        kind = 'open';
      }
    } else {
      const isOpenPassThrough =
        cell.vStart > 0.05 &&
        stats.bgRatio >= 0.65 &&
        (carcassMaterial !== 'blanco' || dToBgLab < dCarcassLab * 0.55);
      const isGlass =
        !isOpenPassThrough &&
        stats.centerMeanL >= 52 &&
        (deltaE76(stats.frameLab, refLab) <= 26 || stats.frameMeanL >= refLum - 35) &&
        isGlassDoorFromStats(stats, cellWmm, cellHmm);

      const isDarkOpen =
        !isGlass &&
        ((stats.centerMeanL < 56 && !isWarmWood && carcassMaterial !== 'grafito') ||
          (refLum >= 195 && stats.meanL < refLum - 62 && stats.stdL > 20) ||
          (stats.meanL < refLum - 26 &&
            dCarcassRgb > 32 &&
            !isWarmWood &&
            (!matchMap || stats.matchRatio < 0.44)) ||
          (stats.stdL > 35 && stats.bgRatio < 0.45));

      if (isOpenPassThrough || isDarkOpen) {
        kind = 'open';
      } else if (isGlass) {
        kind = 'door_glass';
      } else if (cellHmm <= 310 && cellWmm > cellHmm * 1.15) {
        kind = 'drawers';
        drawerCount = 1;
      } else if (mergeDrawers && cellHmm <= 360 && cellWmm > cellHmm * 0.85 && stats.stdL <= 34) {
        // Candidato a cajón apilado (se confirmará al fusionar corrida adyacente o degradará a puerta)
        kind = 'drawers';
        drawerCount = 1;
      } else if (cellWmm >= 540 && cellWmm / Math.max(1, cellHmm) >= 0.85) {
        kind = 'door_double';
      } else {
        const uMid = (cell.uStart + cell.uEnd) * 0.5;
        const handle = detectedHandles.find(
          (h) =>
            h.u >= cell.uStart - 0.03 &&
            h.u <= cell.uEnd + 0.03 &&
            h.v >= cell.vStart - 0.03 &&
            h.v <= cell.vEnd + 0.03,
        );
        if (handle) {
          kind = handle.u >= uMid ? 'door_left' : 'door_right';
        } else {
          kind = cell.uStart < 0.48 ? 'door_left' : 'door_right';
        }
      }
    }

    const noOverride = kind === 'open' || kind === 'leg_void' || kind === 'void_outside' || kind === 'baskets';
    return {
      cell,
      stats,
      kind,
      drawerCount,
      basketCount,
      matOverride: noOverride ? undefined : matOverride,
    };
  });

  // 4. Sin fusión de cajones (modo `userVectorTrace` donde cada celda trazada es 1:1)
  if (!mergeDrawers) {
    return items.map((it, idx) => {
      if (it.preserved) {
        return {
          ...it.preserved,
          id: it.cell.id ?? `${idPrefix}_${idx + 1}`,
          uStart: Number(it.cell.uStart.toFixed(4)),
          uEnd: Number(it.cell.uEnd.toFixed(4)),
          vStart: Number(it.cell.vStart.toFixed(4)),
          vEnd: Number(it.cell.vEnd.toFixed(4)),
        };
      }
      return {
        id: it.cell.id ?? `${idPrefix}_${idx + 1}`,
        uStart: Number(it.cell.uStart.toFixed(4)),
        uEnd: Number(it.cell.uEnd.toFixed(4)),
        vStart: Number(it.cell.vStart.toFixed(4)),
        vEnd: Number(it.cell.vEnd.toFixed(4)),
        kind: it.kind,
        drawerCount: it.kind === 'drawers' ? (it.drawerCount ?? 1) : undefined,
        basketCount: it.kind === 'baskets' ? (it.basketCount ?? 3) : undefined,
        label: defaultLabelForKind(it.kind, idx, it.drawerCount ?? it.basketCount),
        materialOverride: it.matOverride,
      };
    });
  }

  // 5. Fusión de cajones apilados por columna VERIFICANDO ADYACENCIA VERTICAL REAL (`|a.vEnd - b.vStart| < 0.03`)
  const colGroups = new Map<string, ClassifiedCell[]>();
  for (const it of items) {
    const key = `${it.cell.uStart.toFixed(2)}_${it.cell.uEnd.toFixed(2)}`;
    const list = colGroups.get(key) ?? [];
    list.push(it);
    colGroups.set(key, list);
  }

  const out: FrontZone[] = [];
  for (const group of colGroups.values()) {
    const sorted = [...group].sort((a, b) => a.cell.vStart - b.cell.vStart);
    let i = 0;
    while (i < sorted.length) {
      if (sorted[i].kind === 'drawers') {
        let j = i;
        while (
          j + 1 < sorted.length &&
          sorted[j + 1].kind === 'drawers' &&
          // Adyacencia vertical real obligatoria: no fusionar cajones separados por otra zona o hueco
          Math.abs(sorted[j].cell.vEnd - sorted[j + 1].cell.vStart) < 0.03 &&
          sorted[j].matOverride === sorted[j + 1].matOverride
        ) {
          j++;
        }
        const count = j - i + 1;
        const u0 = sorted[i].cell.uStart;
        const u1 = sorted[i].cell.uEnd;
        const v0 = sorted[i].cell.vStart;
        const v1 = sorted[j].cell.vEnd;

        // Si era un bloque solitario relativamente alto (> 310 mm o poco apaisado), reevaluar como puerta
        const wMm = (u1 - u0) * dimsMm.x;
        const hMm = (v1 - v0) * dimsMm.y;
        if (count === 1 && (hMm > 310 || wMm <= hMm * 1.15)) {
          const uMid = (u0 + u1) * 0.5;
          const handle = detectedHandles.find(
            (h) => h.u >= u0 - 0.03 && h.u <= u1 + 0.03 && h.v >= v0 - 0.03 && h.v <= v1 + 0.03,
          );
          const doorKind: FrontModuleKind =
            wMm >= 540 && wMm / Math.max(1, hMm) >= 0.85
              ? 'door_double'
              : handle
                ? handle.u >= uMid
                  ? 'door_left'
                  : 'door_right'
                : u0 < 0.48
                  ? 'door_left'
                  : 'door_right';
          out.push({
            id: `${idPrefix}_${doorKind}_${out.length + 1}`,
            uStart: Number(u0.toFixed(4)),
            uEnd: Number(u1.toFixed(4)),
            vStart: Number(v0.toFixed(4)),
            vEnd: Number(v1.toFixed(4)),
            kind: doorKind,
            label: defaultLabelForKind(doorKind, out.length),
            materialOverride: sorted[i].matOverride,
          });
        } else {
          out.push({
            id: `${idPrefix}_drw_${out.length + 1}`,
            uStart: Number(u0.toFixed(4)),
            uEnd: Number(u1.toFixed(4)),
            vStart: Number(v0.toFixed(4)),
            vEnd: Number(v1.toFixed(4)),
            kind: 'drawers',
            drawerCount: count,
            label: defaultLabelForKind('drawers', out.length, count),
            materialOverride: sorted[i].matOverride,
          });
        }
        i = j + 1;
      } else {
        const it = sorted[i];
        out.push({
          id: it.cell.id ?? `${idPrefix}_${it.kind}_${out.length + 1}`,
          uStart: Number(it.cell.uStart.toFixed(4)),
          uEnd: Number(it.cell.uEnd.toFixed(4)),
          vStart: Number(it.cell.vStart.toFixed(4)),
          vEnd: Number(it.cell.vEnd.toFixed(4)),
          kind: it.kind,
          basketCount: it.kind === 'baskets' ? (it.basketCount ?? 3) : undefined,
          label: defaultLabelForKind(it.kind, out.length, it.basketCount),
          materialOverride: it.matOverride,
        });
        i++;
      }
    }
  }

  return out;
}

export interface BaseSupportHintResult {
  possibleExternalLegs: boolean;
  estimatedLegRatio?: number;
  supportType: BaseSupportType;
  estimatedHeightRatio?: number;
}

/**
 * Analiza la franja inferior bajo el segmento `[BL -> BR]` del mueble en la foto original
 * para clasificar el apoyo inferior: `'legs'` (patas), `'wheels'` (ruedas), `'toe_kick'` (zócalo) o `'none'`.
 */
export function detectBaseSupportHint(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  quadCorners: readonly [Point2D, Point2D, Point2D, Point2D],
  exteriorBgRgb?: readonly [number, number, number],
): BaseSupportHintResult {
  const [tl, tr, br, bl] = quadCorners;
  const bodyH =
    0.5 * (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y));
  const dropOffset = Math.round(bodyH * 0.14);

  if (bodyH < 40 || dropOffset < 10) {
    return { possibleExternalLegs: false, supportType: 'none' };
  }

  const samples = 60;
  const sampleBand = (
    offsetPx: number,
  ): { edgeLums: number[]; midLums: number[]; allLums: number[] } => {
    const edgeLums: number[] = [];
    const midLums: number[] = [];
    const allLums: number[] = [];
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      const px = bl.x + (br.x - bl.x) * t;
      const py = bl.y + (br.y - bl.y) * t + offsetPx;
      if (py < 1 || py >= srcH - 2) continue;
      const l = sampleLumSafe(srcRgba, srcW, srcH, px, py);
      allLums.push(l);
      if (t <= 0.14 || t >= 0.86) edgeLums.push(l);
      else if (t >= 0.22 && t <= 0.78) midLums.push(l);
    }
    return { edgeLums, midLums, allLums };
  };

  const nearBand = sampleBand(Math.max(4, Math.round(bodyH * 0.05)));
  const midBand = sampleBand(Math.max(7, Math.round(bodyH * 0.095)));
  const farBand = sampleBand(dropOffset);
  const bodyRefBand = sampleBand(-Math.max(5, Math.round(bodyH * 0.06)));

  const evalEdgeContrast = (band: { edgeLums: number[]; midLums: number[] }) => {
    if (band.edgeLums.length < 4 || band.midLums.length < 10) return 0;
    const mMed = median(band.midLums);
    return band.edgeLums.filter((l) => Math.abs(l - mMed) > 20).length / band.edgeLums.length;
  };

  const nearContrast = evalEdgeContrast(nearBand);
  const midContrast = evalEdgeContrast(midBand);
  const farContrast = evalEdgeContrast(farBand);

  // 1. Patas externas o ruedas giratorias (soportes discretos en extremos + hueco libre al medio)
  if (farContrast >= 0.16) {
    return {
      possibleExternalLegs: true,
      estimatedLegRatio: Number(((dropOffset * 1.4) / bodyH).toFixed(3)),
      supportType: 'legs',
      estimatedHeightRatio: Number(((dropOffset * 1.4) / bodyH).toFixed(3)),
    };
  }

  // Ruedas compactas: contraste fuerte justo bajo las esquinas (5..9% alto) pero ausente a 14% (rueda baja)
  if (nearContrast >= 0.2 && midContrast < 0.28 && farContrast < 0.12) {
    const ratio = Number(((Math.max(4, Math.round(bodyH * 0.075))) / bodyH).toFixed(3));
    return {
      possibleExternalLegs: true,
      estimatedLegRatio: ratio,
      supportType: 'wheels',
      estimatedHeightRatio: ratio,
    };
  }

  // 2. Zócalo continuo (`toe_kick`): franja horizontal continua más oscura/retranqueada bajo la base
  if (nearBand.midLums.length >= 10 && bodyRefBand.midLums.length >= 10) {
    const bodyMed = median(bodyRefBand.midLums);
    const nearMed = median(nearBand.midLums);
    const farMed = farBand.midLums.length >= 10 ? median(farBand.midLums) : bodyMed;
    const bgLum = exteriorBgRgb
      ? rgbaLuminance(exteriorBgRgb[0], exteriorBgRgb[1], exteriorBgRgb[2])
      : farMed;

    const meanNear =
      nearBand.midLums.reduce((a, b) => a + b, 0) / Math.max(1, nearBand.midLums.length);
    const varNear =
      nearBand.midLums.reduce((a, b) => a + (b - meanNear) * (b - meanNear), 0) /
      Math.max(1, nearBand.midLums.length);
    const stdNear = Math.sqrt(varNear);

    const darkerThanBody = bodyMed - nearMed >= 18;
    const distinctFromFloor = Math.abs(farMed - nearMed) >= 14 || bgLum - nearMed >= 18;
    const uniformContinuousBand = stdNear <= 22 && nearContrast < 0.16;

    if (darkerThanBody && distinctFromFloor && uniformContinuousBand) {
      const toeRatio = Number((0.08).toFixed(3));
      return {
        possibleExternalLegs: false,
        supportType: 'toe_kick',
        estimatedHeightRatio: toeRatio,
      };
    }
  }

  return { possibleExternalLegs: false, supportType: 'none' };
}

/**
 * Elimina o recorta segmentos horizontales (`hShelves`) que caen ESTRICTAMENTE DENTRO
 * de una zona clasificada como `kind: 'drawers'` (evita emitir repisas fantasma a partir
 * de las juntas entre frentes de cajón). Conserva siempre repisas en la frontera (`vStart`/`vEnd`)
 * que sostienen cajoneras suspendidas o separan niveles distintos.
 */
export function suppressShelvesInsideDrawers(
  hShelves: readonly NormalizedSegment[],
  frontZones: readonly FrontZone[],
): NormalizedSegment[] {
  const drawerZones = frontZones.filter((z) => z.kind === 'drawers');
  if (drawerZones.length === 0 || hShelves.length === 0) {
    return hShelves.map((s) => ({ ...s }));
  }

  const out: NormalizedSegment[] = [];
  const vTol = 0.025;
  const uPad = 0.015;
  const minSpan = 0.05;

  for (const sh of hShelves) {
    let intervals: Array<[number, number]> = [
      [Math.min(sh.start, sh.end), Math.max(sh.start, sh.end)],
    ];
    for (const z of drawerZones) {
      const zv0 = Math.min(z.vStart, z.vEnd);
      const zv1 = Math.max(z.vStart, z.vEnd);
      if (sh.position <= zv0 + vTol || sh.position >= zv1 - vTol) continue;

      const zu0 = Math.min(z.uStart, z.uEnd) - uPad;
      const zu1 = Math.max(z.uStart, z.uEnd) + uPad;
      const next: Array<[number, number]> = [];
      for (const [a, b] of intervals) {
        if (zu1 <= a || zu0 >= b) {
          next.push([a, b]);
        } else {
          if (zu0 > a + minSpan) next.push([a, Math.min(b, zu0)]);
          if (zu1 < b - minSpan) next.push([Math.max(a, zu1), b]);
        }
      }
      intervals = next;
      if (intervals.length === 0) break;
    }

    intervals.forEach(([a, b], idx) => {
      if (b - a >= minSpan) {
        out.push({
          id: intervals.length === 1 ? sh.id : `${sh.id}_s${idx + 1}`,
          position: sh.position,
          start: Number(clamp(a, 0, 1).toFixed(4)),
          end: Number(clamp(b, 0, 1).toFixed(4)),
        });
      }
    });
  }

  return out;
}
