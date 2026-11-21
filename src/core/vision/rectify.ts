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
  /** Fracción de la imagen clasificada como fondo exterior (0..1). */
  backgroundCoverage: number;
  /** Color RGB mediano estimado del fondo exterior (para distinguir huecos pasantes / leg_void). */
  exteriorBgRgb: [number, number, number];
}

function medianNum(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface BackgroundSegGrid {
  gw: number;
  gh: number;
  bgMask: Uint8Array;
  fgMain: Uint8Array;
  sobelMag: Float32Array;
  backgroundCoverage: number;
  exteriorBgRgb: [number, number, number];
}

/**
 * Segmentación pixel a pixel en 3 etapas robusta a fotos reales (100% offline):
 *   1. Pre-suavizado 3×3 + gradiente Sobel (atenúa juntas de ladrillo / textura de pared).
 *   2. Flood-Fill iterativo BFS desde techo y costados (NUNCA desde el piso central,
 *      evitando invadir el hueco de piernas de escritorios).
 *   3. Selección de componente conexa aterrizada (prioriza muebles en mitad inferior sobre
 *      TVs o cuadros colgados arriba) + unión de patas/laterales inferiores alineados.
 */
function segmentForegroundGrid(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  maxSide = 144,
): BackgroundSegGrid {
  const scale = Math.min(1, maxSide / Math.max(imgW, imgH));
  const gw = Math.max(24, Math.round(imgW * scale));
  const gh = Math.max(24, Math.round(imgH * scale));
  const n = gw * gh;

  const gR = new Float32Array(n);
  const gG = new Float32Array(n);
  const gB = new Float32Array(n);
  const gLum = new Float32Array(n);

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

  // Suavizado 3×3 para amortiguar textura fina de paredes (ladrillo/estuco) antes de Sobel
  const smoothLum = new Float32Array(n);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (y === 0 || y === gh - 1 || x === 0 || x === gw - 1) {
        smoothLum[y * gw + x] = gLum[y * gw + x];
      } else {
        const up = (y - 1) * gw;
        const mid = y * gw;
        const dn = (y + 1) * gw;
        smoothLum[mid + x] =
          (gLum[up + x - 1] +
            gLum[up + x] +
            gLum[up + x + 1] +
            gLum[mid + x - 1] +
            gLum[mid + x] +
            gLum[mid + x + 1] +
            gLum[dn + x - 1] +
            gLum[dn + x] +
            gLum[dn + x + 1]) /
          9;
      }
    }
  }

  // Etapa 1: Barreras de bordes Sobel 3×3 sobre luminancia suavizada
  const sobelMag = new Float32Array(n);
  for (let y = 1; y < gh - 1; y++) {
    const up = (y - 1) * gw;
    const mid = y * gw;
    const dn = (y + 1) * gw;
    for (let x = 1; x < gw - 1; x++) {
      const gx =
        -smoothLum[up + x - 1] +
        smoothLum[up + x + 1] -
        2 * smoothLum[mid + x - 1] +
        2 * smoothLum[mid + x + 1] -
        smoothLum[dn + x - 1] +
        smoothLum[dn + x + 1];
      const gy =
        -smoothLum[up + x - 1] -
        2 * smoothLum[up + x] -
        smoothLum[up + x + 1] +
        smoothLum[dn + x - 1] +
        2 * smoothLum[dn + x] +
        smoothLum[dn + x + 1];
      sobelMag[mid + x] = Math.hypot(gx, gy);
    }
  }

  // Color mediano perimetral (solo borde superior y laterales altos, evitando piso/hueco de escritorio)
  const bgRs: number[] = [];
  const bgGs: number[] = [];
  const bgBs: number[] = [];
  for (let x = 0; x < gw; x++) {
    bgRs.push(gR[x]);
    bgGs.push(gG[x]);
    bgBs.push(gB[x]);
  }
  const sideEndY = Math.round(gh * 0.72);
  for (let y = 1; y < sideEndY; y++) {
    const l = y * gw;
    const r = y * gw + (gw - 1);
    bgRs.push(gR[l], gR[r]);
    bgGs.push(gG[l], gG[r]);
    bgBs.push(gB[l], gB[r]);
  }
  const medR = medianNum(bgRs);
  const medG = medianNum(bgGs);
  const medB = medianNum(bgBs);

  // Etapa 2: Flood-Fill BFS iterativo desde techo y laterales (NO piso central)
  const bgMask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qHead = 0;
  let qTail = 0;

  const trySeed = (x: number, y: number) => {
    const idx = y * gw + x;
    if (bgMask[idx] === 1) return;
    if (sobelMag[idx] > 88) return;
    bgMask[idx] = 1;
    queue[qTail++] = idx;
  };

  for (let x = 0; x < gw; x++) {
    trySeed(x, 0);
  }
  for (let y = 1; y < Math.round(gh * 0.85); y++) {
    trySeed(0, y);
    trySeed(gw - 1, y);
  }

  const edgeBarrier = 60;
  const localStepTol = 18;
  const globalBgTol = 34;

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % gw;
    const cy = (cur - cx) / gw;
    const cr = gR[cur];
    const cg = gG[cur];
    const cb = gB[cur];

    const checkNeighbor = (nx: number, ny: number) => {
      const ni = ny * gw + nx;
      if (bgMask[ni] === 1) return;
      if (sobelMag[ni] >= edgeBarrier) return;
      const dLocal = Math.hypot(gR[ni] - cr, gG[ni] - cg, gB[ni] - cb);
      const dGlobal = Math.hypot(gR[ni] - medR, gG[ni] - medG, gB[ni] - medB);
      if (dLocal <= localStepTol || dGlobal <= globalBgTol) {
        bgMask[ni] = 1;
        queue[qTail++] = ni;
      }
    };

    if (cx > 0) checkNeighbor(cx - 1, cy);
    if (cx < gw - 1) checkNeighbor(cx + 1, cy);
    if (cy > 0) checkNeighbor(cx, cy - 1);
    if (cy < gh - 1) checkNeighbor(cx, cy + 1);
  }

  const backgroundCoverage = qTail / n;

  // Etapa 3: Componentes conexas de primer plano priorizando el mueble aterrizado (ignora TVs/cuadros en muro alto)
  interface FgComp {
    pixels: Int32Array;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    cx: number;
    cy: number;
    score: number;
  }

  const visited = new Uint8Array(n);
  const compPixels = new Int32Array(n);
  const comps: FgComp[] = [];
  const centerX = gw / 2;

  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const startIdx = y * gw + x;
      if (bgMask[startIdx] === 1 || visited[startIdx] === 1) continue;

      let h = 0;
      let t = 0;
      visited[startIdx] = 1;
      compPixels[t++] = startIdx;
      let minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;

      while (h < t) {
        const cur = compPixels[h++];
        const cx = cur % gw;
        const cy = (cur - cx) / gw;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const pushFg = (nx: number, ny: number) => {
          const ni = ny * gw + nx;
          if (bgMask[ni] === 0 && visited[ni] === 0) {
            visited[ni] = 1;
            compPixels[t++] = ni;
          }
        };

        if (cx > 1) pushFg(cx - 1, cy);
        if (cx < gw - 2) pushFg(cx + 1, cy);
        if (cy > 1) pushFg(cx, cy - 1);
        if (cy < gh - 2) pushFg(cx, cy + 1);
      }

      if (t < 18) continue;
      const avgX = sumX / t;
      const avgY = sumY / t;
      const horizCenterBias = Math.max(0.45, 1.1 - Math.abs(avgX - centerX) / gw);
      // Los muebles reales apoyan en el suelo o zona media-baja; TVs/cuadros flotan arriba (avgY < 0.35*gh)
      const normY = avgY / gh;
      const groundBias = normY < 0.36 ? 0.55 : normY > 0.88 ? 0.72 : 1.15;
      comps.push({
        pixels: compPixels.slice(0, t),
        minX,
        maxX,
        minY,
        maxY,
        cx: avgX,
        cy: avgY,
        score: t * horizCenterBias * groundBias,
      });
    }
  }

  comps.sort((a, b) => b.score - a.score);
  const fgMain = new Uint8Array(n);
  if (comps.length > 0) {
    const primary = comps[0];
    for (let i = 0; i < primary.pixels.length; i++) {
      fgMain[primary.pixels[i]] = 1;
    }
    // Incluir patas/laterales inferiores de escritorio que estén alineados bajo la cubierta principal
    for (let k = 1; k < comps.length; k++) {
      const c = comps[k];
      if (
        c.pixels.length >= primary.pixels.length * 0.04 &&
        c.minX >= primary.minX - 6 &&
        c.maxX <= primary.maxX + 6 &&
        c.minY >= primary.minY &&
        c.minY <= primary.maxY + Math.round(gh * 0.12)
      ) {
        for (let i = 0; i < c.pixels.length; i++) {
          fgMain[c.pixels[i]] = 1;
        }
      }
    }
  }

  return {
    gw,
    gh,
    bgMask,
    fgMain,
    sobelMag,
    backgroundCoverage,
    exteriorBgRgb: [Math.round(medR), Math.round(medG), Math.round(medB)],
  };
}

/**
 * Auto-propone las 4 esquinas iniciales [TL, TR, BR, BL] del mueble en la fotografía
 * usando segmentación en 3 etapas: Sobel suavizado + Flood-Fill BFS (techo/laterales)
 * + componente aterrizada (descarta cuadros/TVs altos y respeta huecos de escritorio).
 */
export function autoDetectFurnitureQuad(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
): AutoQuadResult {
  const fallbackQuad: [Point2D, Point2D, Point2D, Point2D] = [
    { x: Math.round(imgW * 0.14), y: Math.round(imgH * 0.14) },
    { x: Math.round(imgW * 0.86), y: Math.round(imgH * 0.14) },
    { x: Math.round(imgW * 0.86), y: Math.round(imgH * 0.86) },
    { x: Math.round(imgW * 0.14), y: Math.round(imgH * 0.86) },
  ];

  if (imgW < 24 || imgH < 24 || rgba.length < imgW * imgH * 4) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.25,
      usedFallback: true,
      aspectRatioEst: imgW > 0 && imgH > 0 ? imgW / imgH : 1,
      backgroundCoverage: 0,
      exteriorBgRgb: [240, 240, 240],
    };
  }

  const seg = segmentForegroundGrid(rgba, imgW, imgH, 144);
  const { gw, gh, fgMain, backgroundCoverage, exteriorBgRgb } = seg;

  const rowCounts = new Float32Array(gh);
  const colCounts = new Float32Array(gw);
  let fgTotal = 0;

  for (let y = 1; y < gh - 1; y++) {
    const rowOff = y * gw;
    for (let x = 1; x < gw - 1; x++) {
      if (fgMain[rowOff + x] === 1) {
        rowCounts[y] += 1;
        colCounts[x] += 1;
        fgTotal++;
      }
    }
  }

  const fgRatio = fgTotal / (gw * gh);
  if (fgRatio < 0.05 || fgRatio > 0.96) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.28,
      usedFallback: true,
      aspectRatioEst: imgW / imgH,
      backgroundCoverage: Number(backgroundCoverage.toFixed(2)),
      exteriorBgRgb,
    };
  }

  const innerW = Math.max(1, gw - 2);
  const innerH = Math.max(1, gh - 2);
  let maxRowD = 0;
  let maxColD = 0;
  for (let y = 1; y < gh - 1; y++) {
    rowCounts[y] /= innerW;
    if (rowCounts[y] > maxRowD) maxRowD = rowCounts[y];
  }
  for (let x = 1; x < gw - 1; x++) {
    colCounts[x] /= innerH;
    if (colCounts[x] > maxColD) maxColD = colCounts[x];
  }

  const rowThresh = Math.max(0.04, maxRowD * 0.16);
  const colThresh = Math.max(0.04, maxColD * 0.16);

  const findMainSpan = (
    arr: Float32Array,
    start: number,
    end: number,
    thresh: number,
  ): [number, number] => {
    let first = -1;
    let last = -1;
    for (let i = start; i < end; i++) {
      if (arr[i] >= thresh) {
        if (first < 0) first = i;
        last = i;
      }
    }
    return [first, last];
  };

  const [bx0, bx1] = findMainSpan(colCounts, 1, gw - 1, colThresh);
  const [by0, by1] = findMainSpan(rowCounts, 1, gh - 1, rowThresh);
  const bw = bx1 - bx0;
  const bh = by1 - by0;

  if (
    bx0 < 0 ||
    by0 < 0 ||
    bw < gw * 0.14 ||
    bh < gh * 0.14 ||
    (bw > gw * 0.96 && bh > gh * 0.96)
  ) {
    return {
      quadCorners: fallbackQuad,
      confidence: 0.3,
      usedFallback: true,
      aspectRatioEst: imgW / imgH,
      backgroundCoverage: Number(backgroundCoverage.toFixed(2)),
      exteriorBgRgb,
    };
  }

  const toImgX = (gx: number) => Math.max(4, Math.min(imgW - 4, Math.round(((gx + 0.5) / gw) * imgW)));
  const toImgY = (gy: number) => Math.max(4, Math.min(imgH - 4, Math.round(((gy + 0.5) / gh) * imgH)));

  // Por defecto entregar rectángulo limpio alineado al frente (evita deformar trapecios en escritorios con patas abiertas)
  const quadCorners: [Point2D, Point2D, Point2D, Point2D] = [
    { x: toImgX(bx0), y: toImgY(by0) },
    { x: toImgX(bx1), y: toImgY(by0) },
    { x: toImgX(bx1), y: toImgY(by1) },
    { x: toImgX(bx0), y: toImgY(by1) },
  ];

  let fgInside = 0;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      fgInside += fgMain[y * gw + x];
    }
  }
  const fillRatio = fgInside / Math.max(1, (bw + 1) * (bh + 1));
  const confidence = Number(Math.max(0.5, Math.min(0.96, 0.48 + fillRatio * 0.48)).toFixed(2));
  const estW = (bw / gw) * imgW;
  const estH = (bh / gh) * imgH;

  return {
    quadCorners,
    confidence,
    usedFallback: false,
    aspectRatioEst: estH > 1 ? estW / estH : imgW / imgH,
    backgroundCoverage: Number(backgroundCoverage.toFixed(2)),
    exteriorBgRgb,
  };
}

/**
 * Genera mapa visual combinado de Bordes Sobel 3×3 + Fondo Exterior Atenuado (100% offline)
 * para mostrar al usuario exactamente qué separó como fondo y qué bordes estructurales calcó.
 */
export function computeSobelEdgeOverlayRGBA(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
): Uint8ClampedArray {
  const nPx = W * H;
  const seg = segmentForegroundGrid(rgba, W, H, 144);
  const lum = new Float32Array(nPx);
  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }

  const out = new Uint8ClampedArray(nPx * 4);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(seg.gh - 1, Math.floor((y / H) * seg.gh));
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      const gx = Math.min(seg.gw - 1, Math.floor((x / W) * seg.gw));
      const isBg = seg.bgMask[gy * seg.gw + gx] === 1;
      const p = (rowOff + x) * 4;
      if (isBg) {
        // Fondo detectado fuertemente atenuado en azul oscuro
        out[p] = Math.round(rgba[p] * 0.16 + 8);
        out[p + 1] = Math.round(rgba[p + 1] * 0.18 + 12);
        out[p + 2] = Math.round(rgba[p + 2] * 0.24 + 24);
      } else {
        // Silueta del mueble preservada con contraste claro
        out[p] = Math.round(rgba[p] * 0.58);
        out[p + 1] = Math.round(rgba[p + 1] * 0.6);
        out[p + 2] = Math.round(rgba[p + 2] * 0.64);
      }
      out[p + 3] = 255;
    }
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
      if (mag > 44) {
        const intensity = Math.min(1, (mag - 44) / 200);
        const p = (rowMid + x) * 4;
        out[p] = Math.min(255, Math.round(out[p] + intensity * 60));
        out[p + 1] = Math.min(255, Math.round(out[p + 1] + intensity * 225));
        out[p + 2] = Math.min(255, Math.round(out[p + 2] + intensity * 255));
      }
    }
  }

  return out;
}
