/**
 * SMARTFURNITURE — RECTIFICACIÓN DE PERSPECTIVA Y ESTIMACIÓN DE RELACIÓN W/H (v3.0)
 * 100% offline, álgebra pura, cero dependencias externas, sin parser EXIF.
 */
import type { Point2D } from '../../types/contracts';
import {
  applyHomography,
  computeQuadToUnitHomography,
  type Matrix3x3,
} from '../mathEngine/homography';

/**
 * Estima la relación de aspecto real W/H del mueble usando la fórmula vectorial de Zhang
 * con distancia focal fija típica de cámara de celular (26 mm eq. en 1×, 52 mm eq. en 2×).
 * Evita la degeneración de f² < 0 observada en ~43% de fotos de clóset al estimar f.
 */
export function estimateAspectRatioFixedFocal(
  quadCorners: readonly [Point2D, Point2D, Point2D, Point2D],
  imgW: number,
  imgH: number,
  focal35mm = 26,
): number {
  const [tl, tr, br, bl] = quadCorners;
  const topLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const botLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftLen = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightLen = Math.hypot(br.x - tr.x, br.y - tr.y);
  const avgW = (topLen + botLen) / 2;
  const avgH = (leftLen + rightLen) / 2;
  const euclidFallback = avgH > 1e-6 ? avgW / avgH : 1;

  const hom = computeQuadToUnitHomography(quadCorners);
  if (!hom || imgW <= 0 || imgH <= 0 || focal35mm <= 0) {
    return euclidFallback;
  }

  // toCanvas mapea el cuadrado unitario (u: ancho, v: alto) -> píxeles de la foto
  const H = hom.toCanvas;
  const cx = imgW / 2;
  const cy = imgH / 2;
  const f = (focal35mm / 43.27) * Math.hypot(imgW, imgH);
  if (!Number.isFinite(f) || f <= 1) {
    return euclidFallback;
  }

  // r1 = K^-1 · h1, r2 = K^-1 · h2
  const h10 = H[0][0], h11 = H[1][0], h12 = H[2][0];
  const h20 = H[0][1], h21 = H[1][1], h22 = H[2][1];

  const r1x = (h10 - cx * h12) / f;
  const r1y = (h11 - cy * h12) / f;
  const r1z = h12;

  const r2x = (h20 - cx * h22) / f;
  const r2y = (h21 - cy * h22) / f;
  const r2z = h22;

  const norm1 = Math.hypot(r1x, r1y, r1z);
  const norm2 = Math.hypot(r2x, r2y, r2z);
  if (!Number.isFinite(norm1) || !Number.isFinite(norm2) || norm2 < 1e-10) {
    return euclidFallback;
  }

  const ratio = norm1 / norm2;
  if (!Number.isFinite(ratio) || ratio <= 0.05 || ratio > 20) {
    return euclidFallback;
  }
  return ratio;
}

/**
 * Extrapola las dimensiones del cuerpo de melamina { x, y, z } en mm a partir de
 * UNA sola medida real confirmada por el usuario (ancho total o alto del cuerpo sin patas).
 */
export function extrapolateDimensionsFromSingleMeasure(
  aspectRatioXY: number,
  knownAxis: 'x' | 'y',
  knownValueMm: number,
  defaultDepthMm = 400,
): { x: number; y: number; z: number } {
  const safeRatio = Number.isFinite(aspectRatioXY) && aspectRatioXY > 0.05 ? aspectRatioXY : 1;
  const safeVal = Math.max(100, knownValueMm);
  const z = Math.round(Math.max(150, defaultDepthMm));

  if (knownAxis === 'x') {
    return {
      x: Math.round(safeVal),
      y: Math.round(safeVal / safeRatio),
      z,
    };
  }
  return {
    x: Math.round(safeVal * safeRatio),
    y: Math.round(safeVal),
    z,
  };
}

/**
 * Calcula las dimensiones óptimas en píxeles para la rectificación del mueble,
 * garantizando >= 6 px por canto de melamina (18 mm) y acotando uso de RAM local.
 */
export function computeRectifiedSize(
  xMm: number,
  yMm: number,
  eMm: number,
): { width: number; height: number } {
  const safeX = Math.max(200, xMm);
  const safeY = Math.max(200, yMm);
  const safeE = Math.max(6, eMm);
  const width = Math.max(360, Math.min(960, Math.ceil((6 * safeX) / safeE)));
  const height = Math.max(200, Math.min(1200, Math.round((width * safeY) / safeX)));
  return { width, height };
}

/**
 * Rectifica una imagen RGBA usando muestreo bilineal puro vía `toCanvas` (unitario -> foto).
 * Convención de salida: fila 0 = cubierta (v = 1), fila dstH - 1 = base (v = 0).
 */
export function rectifyImageRGBA(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  toCanvas: Matrix3x3,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let row = 0; row < dstH; row++) {
    const v = 1 - (row + 0.5) / dstH;
    for (let col = 0; col < dstW; col++) {
      const u = (col + 0.5) / dstW;
      const pt = applyHomography(toCanvas, { x: u, y: v });
      const dstIdx = (row * dstW + col) * 4;

      if (!pt) {
        out[dstIdx + 3] = 255;
        continue;
      }

      const sx = Math.max(0, Math.min(maxX, pt.x));
      const sy = Math.max(0, Math.min(maxY, pt.y));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(maxX, x0 + 1);
      const y1 = Math.min(maxY, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      out[dstIdx] = Math.round(
        srcRgba[i00] * w00 + srcRgba[i10] * w10 + srcRgba[i01] * w01 + srcRgba[i11] * w11,
      );
      out[dstIdx + 1] = Math.round(
        srcRgba[i00 + 1] * w00 + srcRgba[i10 + 1] * w10 + srcRgba[i01 + 1] * w01 + srcRgba[i11 + 1] * w11,
      );
      out[dstIdx + 2] = Math.round(
        srcRgba[i00 + 2] * w00 + srcRgba[i10 + 2] * w10 + srcRgba[i01 + 2] * w01 + srcRgba[i11 + 2] * w11,
      );
      out[dstIdx + 3] = 255;
    }
  }

  return out;
}

export interface CameraPoseEstimate {
  /** Distancia estimada en metros desde la cámara al centro del mueble. */
  distanceMeters: number;
  /** Profundidad proyectiva Z sobre el eje óptico en metros. */
  depthZMeters: number;
  /** Inclinación vertical (pitch) en grados (+ = cámara inclinada hacia arriba). */
  pitchDeg: number;
  /** Horizonte de paralaje cero normalizado v ∈ [0, 1] (0 = base, 1 = cubierta). */
  estimatedHorizonV: number;
  /** Diagnóstico rápido de encuadre según protocolo de distancia. */
  distanceQuality: 'very_close' | 'close' | 'optimal' | 'far';
}

/**
 * Descompone la homografía `toCanvas` con matriz intrínseca K de focal fija (26/52 mm eq.)
 * y UNA dimensión física conocida (ancho o alto en mm) para estimar:
 *   1. Distancia real cámara-mueble en metros (Z = t_z / λ).
 *   2. Ángulo de inclinación (pitch) en grados.
 *   3. Horizonte dinámico `estimatedHorizonV` para anclaje de paralaje en `bandDetector`.
 */
export function estimateCameraPoseMeters(
  quadCorners: readonly [Point2D, Point2D, Point2D, Point2D],
  imgW: number,
  imgH: number,
  knownAxis: 'x' | 'y',
  knownSizeMm: number,
  focal35mm = 26,
): CameraPoseEstimate | null {
  if (imgW <= 0 || imgH <= 0 || knownSizeMm <= 0 || focal35mm <= 0) {
    return null;
  }
  const hom = computeQuadToUnitHomography(quadCorners);
  if (!hom) return null;

  const H = hom.toCanvas;
  const cx = imgW / 2;
  const cy = imgH / 2;
  const f = (focal35mm / 43.27) * Math.hypot(imgW, imgH);
  if (!Number.isFinite(f) || f <= 1) return null;

  const kInvCol = (c: 0 | 1 | 2): [number, number, number] => {
    const a = H[0][c];
    const b = H[1][c];
    const w = H[2][c];
    return [(a - cx * w) / f, (b - cy * w) / f, w];
  };

  const h1 = kInvCol(0);
  const h2 = kInvCol(1);
  const h3 = kInvCol(2);

  const norm1 = Math.hypot(h1[0], h1[1], h1[2]);
  const norm2 = Math.hypot(h2[0], h2[1], h2[2]);
  if (!Number.isFinite(norm1) || !Number.isFinite(norm2) || norm1 < 1e-10 || norm2 < 1e-10) {
    return null;
  }

  // Vector sin escalar al centro del mueble (u = 0.5, v = 0.5)
  const centerRaw: [number, number, number] = [
    h3[0] + 0.5 * h1[0] + 0.5 * h2[0],
    h3[1] + 0.5 * h1[1] + 0.5 * h2[1],
    h3[2] + 0.5 * h1[2] + 0.5 * h2[2],
  ];

  // Elegir signo para que el centro quede delante de la cámara (Z > 0)
  const sign = centerRaw[2] >= 0 ? 1 : -1;
  const knownSizeM = knownSizeMm / 1000;
  const absLambda = knownAxis === 'x' ? norm1 / knownSizeM : norm2 / knownSizeM;
  if (!Number.isFinite(absLambda) || absLambda < 1e-10) {
    return null;
  }

  const lambdaSigned = sign * absLambda;
  const tx = centerRaw[0] / lambdaSigned;
  const ty = centerRaw[1] / lambdaSigned;
  const tz = centerRaw[2] / lambdaSigned;
  const distanceMeters = Math.hypot(tx, ty, tz);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0.1 || distanceMeters > 40) {
    return null;
  }

  // Vector unitario vertical del mueble en coordenadas de cámara (y hacia abajo)
  const r2y = (sign * h2[1]) / norm2;
  const r2z = (sign * h2[2]) / norm2;
  const pitchDeg = (Math.atan2(r2z, -r2y) * 180) / Math.PI;

  // Horizonte de paralaje cero: P(0.5, v) · r2 = 0 => v = 0.5 - (centerRaw · h2) / ||h2||²
  const dotCenterH2 = centerRaw[0] * h2[0] + centerRaw[1] * h2[1] + centerRaw[2] * h2[2];
  const rawHorizonV = 0.5 - dotCenterH2 / (norm2 * norm2);
  const estimatedHorizonV = Math.max(0.05, Math.min(0.95, rawHorizonV));

  let distanceQuality: CameraPoseEstimate['distanceQuality'] = 'optimal';
  if (distanceMeters < 1.8) {
    distanceQuality = 'very_close';
  } else if (distanceMeters < 2.4) {
    distanceQuality = 'close';
  } else if (distanceMeters > 6.5) {
    distanceQuality = 'far';
  }

  return {
    distanceMeters: Number(distanceMeters.toFixed(2)),
    depthZMeters: Number(tz.toFixed(2)),
    pitchDeg: Number(pitchDeg.toFixed(1)),
    estimatedHorizonV: Number(estimatedHorizonV.toFixed(3)),
    distanceQuality,
  };
}

export interface AutoQuadResult {
  quadCorners: [Point2D, Point2D, Point2D, Point2D];
  confidence: number;
  usedFallback: boolean;
  aspectRatioEst: number;
}

function medianNum(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Auto-propone las 4 esquinas iniciales [TL, TR, BR, BL] del mueble en la fotografía
 * combinando contraste perimetral mediano contra el fondo + gradiente Sobel 3×3
 * y proyecciones recortadas inmunes a píxeles ruidosos aislados (heredado y reforzado
 * desde SmartFurniture v35, 100% offline sobre RGBA puro).
 */
export function autoDetectFurnitureQuad(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
): AutoQuadResult {
  const fallbackQuad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: Math.round(imgW * 0.16), y: Math.round(imgH * 0.14) },
    { x: Math.round(imgW * 0.84), y: Math.round(imgH * 0.14) },
    { x: Math.round(imgW * 0.84), y: Math.round(imgH * 0.84) },
    { x: Math.round(imgW * 0.16), y: Math.round(imgH * 0.84) },
  ];

  if (imgW < 24 || imgH < 24 || rgba.length < imgW * imgH * 4) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.25,
      usedFallback: true,
      aspectRatioEst: imgW > 0 && imgH > 0 ? imgW / imgH : 1,
    };
  }

  // Downsample rápido preservando proporción (máx 128 px por lado)
  const scale = Math.min(1, 128 / Math.max(imgW, imgH));
  const gw = Math.max(24, Math.round(imgW * scale));
  const gh = Math.max(24, Math.round(imgH * scale));
  const gR = new Float32Array(gw * gh);
  const gG = new Float32Array(gw * gh);
  const gB = new Float32Array(gw * gh);
  const gLum = new Float32Array(gw * gh);

  for (let y = 0; y < gh; y++) {
    const sy = Math.min(imgH - 1, Math.floor(((y + 0.5) / gh) * imgH));
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(imgW - 1, Math.floor(((x + 0.5) / gw) * imgW));
      const si = (sy * imgW + sx) * 4;
      const gi = y * gw + x;
      const r = rgba[si];
      const g = rgba[si + 1];
      const b = rgba[si + 2];
      gR[gi] = r;
      gG[gi] = g;
      gB[gi] = b;
      gLum[gi] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  // Color mediano del fondo muestreado en borde superior, izquierdo y derecho (evita piso inferior)
  const bgRs: number[] = [];
  const bgGs: number[] = [];
  const bgBs: number[] = [];
  const pushBg = (x: number, y: number) => {
    const i = y * gw + x;
    bgRs.push(gR[i]);
    bgGs.push(gG[i]);
    bgBs.push(gB[i]);
  };
  for (let x = 0; x < gw; x++) {
    pushBg(x, 0);
    pushBg(x, 1);
  }
  const sideEndY = Math.round(gh * 0.78);
  for (let y = 2; y < sideEndY; y++) {
    pushBg(0, y);
    pushBg(1, y);
    pushBg(gw - 1, y);
    pushBg(gw - 2, y);
  }

  const bgR = medianNum(bgRs);
  const bgG = medianNum(bgGs);
  const bgB = medianNum(bgBs);

  // Máscara de primer plano: diferencia de color contra fondo OR magnitud Sobel 3×3
  const fg = new Uint8Array(gw * gh);
  const rowCounts = new Float32Array(gh);
  const colCounts = new Float32Array(gw);

  for (let y = 2; y < gh - 2; y++) {
    for (let x = 2; x < gw - 2; x++) {
      const i = y * gw + x;
      const distBg = Math.hypot(gR[i] - bgR, gG[i] - bgG, gB[i] - bgB);
      const gx =
        -gLum[(y - 1) * gw + (x - 1)] +
        gLum[(y - 1) * gw + (x + 1)] -
        2 * gLum[y * gw + (x - 1)] +
        2 * gLum[y * gw + (x + 1)] -
        gLum[(y + 1) * gw + (x - 1)] +
        gLum[(y + 1) * gw + (x + 1)];
      const gy =
        -gLum[(y - 1) * gw + (x - 1)] -
        2 * gLum[(y - 1) * gw + x] -
        gLum[(y - 1) * gw + (x + 1)] +
        gLum[(y + 1) * gw + (x - 1)] +
        2 * gLum[(y + 1) * gw + x] +
        gLum[(y + 1) * gw + (x + 1)];
      const mag = Math.hypot(gx, gy);

      if (distBg > 34 || mag > 90) {
        fg[i] = 1;
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
    }
  }

  // Normalizar densidades y localizar intervalo principal robusto (ignora ruido puntual)
  const innerW = Math.max(1, gw - 4);
  const innerH = Math.max(1, gh - 4);
  let maxRowD = 0;
  let maxColD = 0;
  for (let y = 2; y < gh - 2; y++) {
    rowCounts[y] /= innerW;
    if (rowCounts[y] > maxRowD) maxRowD = rowCounts[y];
  }
  for (let x = 2; x < gw - 2; x++) {
    colCounts[x] /= innerH;
    if (colCounts[x] > maxColD) maxColD = colCounts[x];
  }

  if (maxRowD < 0.12 || maxColD < 0.12) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.25,
      usedFallback: true,
      aspectRatioEst: imgW / imgH,
    };
  }

  const rowThresh = Math.max(0.08, maxRowD * 0.28);
  const colThresh = Math.max(0.08, maxColD * 0.28);

  const findMainSpan = (arr: Float32Array, start: number, end: number, thresh: number): [number, number] => {
    let bestA = -1;
    let bestB = -1;
    let curA = -1;
    let gap = 0;
    const maxGap = Math.max(2, Math.round((end - start) * 0.04));

    for (let i = start; i < end; i++) {
      if (arr[i] >= thresh) {
        if (curA < 0) curA = i;
        gap = 0;
        if (i - curA > bestB - bestA) {
          bestA = curA;
          bestB = i;
        }
      } else if (curA >= 0) {
        gap++;
        if (gap > maxGap) {
          curA = -1;
          gap = 0;
        }
      }
    }
    return [bestA, bestB];
  };

  const [bx0, bx1] = findMainSpan(colCounts, 2, gw - 2, colThresh);
  const [by0, by1] = findMainSpan(rowCounts, 2, gh - 2, rowThresh);
  const bw = bx1 - bx0;
  const bh = by1 - by0;

  // Rechazar cajas degeneradas (< 14% o > 95% del encuadre)
  if (
    bx0 < 0 ||
    by0 < 0 ||
    bw < gw * 0.14 ||
    bh < gh * 0.14 ||
    (bw > gw * 0.94 && bh > gh * 0.94)
  ) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.3,
      usedFallback: true,
      aspectRatioEst: imgW / imgH,
    };
  }

  // Refinar inclinación trapecial superior e inferior (para fotos con perspectiva moderada)
  const bandH = Math.max(3, Math.round(bh * 0.12));
  const findBandX = (yA: number, yB: number): [number, number] => {
    const bandCols = new Float32Array(gw);
    const rows = Math.max(1, yB - yA + 1);
    let maxD = 0;
    for (let x = bx0; x <= bx1; x++) {
      let c = 0;
      for (let y = yA; y <= yB; y++) c += fg[y * gw + x];
      bandCols[x] = c / rows;
      if (bandCols[x] > maxD) maxD = bandCols[x];
    }
    if (maxD < 0.25) return [bx0, bx1];
    const [sx0, sx1] = findMainSpan(bandCols, bx0, bx1 + 1, Math.max(0.2, maxD * 0.4));
    if (sx0 >= 0 && sx1 - sx0 >= bw * 0.55) {
      return [sx0, sx1];
    }
    return [bx0, bx1];
  };

  const [topX0, topX1] = findBandX(by0, Math.min(by1, by0 + bandH));
  const [botX0, botX1] = findBandX(Math.max(by0, by1 - bandH), by1);

  const toImgX = (gx: number) => Math.max(4, Math.min(imgW - 4, Math.round(((gx + 0.5) / gw) * imgW)));
  const toImgY = (gy: number) => Math.max(4, Math.min(imgH - 4, Math.round(((gy + 0.5) / gh) * imgH)));

  const quadCorners: [Point2D, Point2D, Point2D, Point2D] = [
    { x: toImgX(topX0), y: toImgY(by0) },
    { x: toImgX(topX1), y: toImgY(by0) },
    { x: toImgX(botX1), y: toImgY(by1) },
    { x: toImgX(botX0), y: toImgY(by1) },
  ];

  // Medir relleno de primer plano dentro de la caja para estimar confianza
  let fgInside = 0;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      fgInside += fg[y * gw + x];
    }
  }
  const fillRatio = fgInside / Math.max(1, (bw + 1) * (bh + 1));
  const confidence = Number(Math.max(0.45, Math.min(0.95, 0.4 + fillRatio * 0.65)).toFixed(2));
  const estW = ((topX1 - topX0 + (botX1 - botX0)) / 2 / gw) * imgW;
  const estH = (bh / gh) * imgH;

  return {
    quadCorners,
    confidence,
    usedFallback: false,
    aspectRatioEst: estH > 1 ? estW / estH : imgW / imgH,
  };
}

/**
 * Genera mapa visual de bordes Sobel 3×3 (100% offline) para asistir la alineación
 * manual de las 4 esquinas en fotografías con baja iluminación o sombras.
 */
export function computeSobelEdgeOverlayRGBA(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
): Uint8ClampedArray {
  const nPx = W * H;
  const lum = new Float32Array(nPx);
  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }

  const out = new Uint8ClampedArray(nPx * 4);
  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    // Fondo atenuado del original para conservar contexto visual
    out[p] = Math.round(rgba[p] * 0.32);
    out[p + 1] = Math.round(rgba[p + 1] * 0.34);
    out[p + 2] = Math.round(rgba[p + 2] * 0.4);
    out[p + 3] = 255;
  }

  for (let y = 1; y < H - 1; y++) {
    const rowUp = (y - 1) * W;
    const rowMid = y * W;
    const rowDn = (y + 1) * W;
    for (let x = 1; x < W - 1; x++) {
      const gx =
        -lum[rowUp + x - 1] +
        lum[rowUp + x + 1] -
        2 * lum[rowMid + x - 1] +
        2 * lum[rowMid + x + 1] -
        lum[rowDn + x - 1] +
        lum[rowDn + x + 1];
      const gy =
        -lum[rowUp + x - 1] -
        2 * lum[rowUp + x] -
        lum[rowUp + x + 1] +
        lum[rowDn + x - 1] +
        2 * lum[rowDn + x] +
        lum[rowDn + x + 1];
      const mag = Math.hypot(gx, gy);
      if (mag > 48) {
        const intensity = Math.min(1, (mag - 48) / 210);
        const p = (rowMid + x) * 4;
        out[p] = Math.min(255, Math.round(out[p] + intensity * 70));
        out[p + 1] = Math.min(255, Math.round(out[p + 1] + intensity * 220));
        out[p + 2] = Math.min(255, Math.round(out[p + 2] + intensity * 255));
      }
    }
  }

  return out;
}
