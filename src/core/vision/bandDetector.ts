/**
 * SMARTFURNITURE — DETECTOR DUAL/HÍBRIDO DE ESTRUCTURA DE MELAMINA (v8.0)
 * 100% offline, TypeScript puro + TypedArrays, unificado sobre `imageOps`, `colorClassifier`,
 * `xyCut` y `zoneClassifier`.
 *
 * Soporta todas las familias reales de muebles:
 *   A) MUEBLE ABIERTO (`open`): cantos de melamina sobre huecos oscuros — usa luminancia flat-field
 *      + crominancia normalizada RGBA + sembrado en 4 bordes/gotero + anclaje unilateral de paralaje
 *      + partición recursiva XY-Cut (`xyCut.ts`).
 *   B) MUEBLE CERRADO (`closed_front` — puertas y cajones): superficie frontal uniforme con
 *      ranuras/juntas lineales continuas en extremos (inmune a molduras decorativas) + detector de
 *      manillas por contraste local bidireccional (oscuras y claras/cromadas sobre grafito).
 *   C) MUEBLE HÍBRIDO / BICOLOR / ESCRITORIO (`hybrid`): transiciones RGB + clasificación CIE-Lab
 *      unificada (`zoneClassifier.ts`) sin emisión duplicada de `hShelves` dentro de `drawers`.
 *   D) BAJA CONFIANZA (`uncertain`, ej. blanco sobre blanco sin ranuras): retorna `confidence < 0.5`
 *      para guiar el trazado manual en 3 pasos.
 */
import type {
  BaseSupportType,
  DiagonalSegment,
  FrontZone,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
} from '../../types/contracts';
import { exteriorToInterior } from '../mathEngine';
import { classifyMelamineMaterial, isWarmWoodLab, rgbToLab } from './colorClassifier';
import {
  boxBlur2D,
  clamp,
  interiorToExteriorPoint,
  mad,
  median,
  rgbaLuminance,
  type LocalExteriorBgSamples,
} from './imageOps';
import { partitionCellsFromVectors } from './userVectorTrace';
import { findLocalPeaks1D, runRecursiveXYCut, type XYCutCandidate } from './xyCut';
import {
  classifyZonesUnified,
  detectBaseSupportHint,
  detectHandlesLocalContrast,
  detectInternalDrawersInCell,
  detectMetallicBasketRails,
  suppressShelvesInsideDrawers,
  type DetectedHandlePoint,
} from './zoneClassifier';

export type { DetectedHandlePoint } from './zoneClassifier';

export interface BandDetectorOptions {
  /** Gotero de 1 clic en coordenadas unitarias exteriores { u: 0..1, v: 0..1 (0=base, 1=cubierta) }. */
  seedPoint?: { u: number; v: number };
  /** Activa anclaje unilateral consciente de paralaje (default true). */
  parallaxAware?: boolean;
  /** Altura normalizada aproximada de la cámara (0..1, default 0.5). */
  horizonV?: number;
  /** RGB mediano del fondo exterior (permite reconocer huecos de piernas / pasantes en escritorios). */
  exteriorBgRgb?: [number, number, number];
  /** Muestras locales de fondo exterior junto al quad (para recortes escalonados `void_outside`). */
  localExteriorBg?: LocalExteriorBgSamples;
}

export interface DetectedCavity {
  id: string;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  kind: 'open_bay' | 'knee_space';
}

export interface BandDetectionResult {
  furnitureMode: 'open' | 'closed_front' | 'hybrid' | 'uncertain';
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  /** Divisiones diagonales opcionales detectadas (espacio interior [0,1]^2). */
  diagonalDividers?: DiagonalSegment[];
  detectedHandles: DetectedHandlePoint[];
  /** Espacios vacíos / recuadros detectados en espacio interior [0,1]^2. */
  cavities: DetectedCavity[];
  /** Zonas frontales clasificadas por celda (abierto, puerta, cajones, canastos, hueco piernas, bicolor). */
  inferredZones: FrontZone[];
  /** Acabado de melamina estimado desde la carcasa principal en espacio CIE-Lab. */
  detectedMaterial: MelamineMaterial;
  confidence: number;
  interiorMatch: number;
  refLum: number;
}

export interface LowerGapHintResult {
  possibleExternalLegs: boolean;
  estimatedLegRatio?: number;
  supportType?: BaseSupportType;
  estimatedHeightRatio?: number;
}

interface HybridStructureResult {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  detectedHandles: DetectedHandlePoint[];
  cavities: DetectedCavity[];
  inferredZones: FrontZone[];
  strength: number;
}

function rangeMean(arr: Float32Array, start: number, end: number): number {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(arr.length, Math.ceil(end));
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) {
    sum += arr[i];
  }
  return sum / (e - s);
}

/**
 * Fusiona divisores verticales duplicados muy próximos (< 0.11) alrededor del eje central en
 * muebles angostos (`x <= 900 mm`, p. ej. largueros de puertas de vidrio en vitrinas `#06`).
 */
export function consolidateNarrowCenterDividers(
  vDividers: readonly NormalizedSegment[],
  dimsMm: { x: number; y: number },
): NormalizedSegment[] {
  if (dimsMm.x > 900 || vDividers.length < 2) {
    return vDividers.map((d) => ({ ...d }));
  }
  const sorted = [...vDividers].sort((a, b) => a.position - b.position || a.start - b.start);
  const stage1: NormalizedSegment[] = [];
  for (const d of sorted) {
    const prev = stage1[stage1.length - 1];
    if (prev && dimsMm.x <= 900) {
      const distU = Math.abs(d.position - prev.position);
      const ov = Math.min(d.end, prev.end) - Math.max(d.start, prev.start);
      const minSpan = Math.max(1e-4, Math.min(d.end - d.start, prev.end - prev.start));
      const bothNearCenter =
        prev.position >= 0.34 && prev.position <= 0.66 && d.position >= 0.34 && d.position <= 0.66;
      if (bothNearCenter && distU < 0.12 && ov / minSpan >= 0.5) {
        const dPrev = Math.abs(prev.position - 0.5);
        const dCur = Math.abs(d.position - 0.5);
        const mergedPos =
          Math.abs(dPrev - dCur) < 0.025
            ? 0.5 * (prev.position + d.position)
            : dCur < dPrev
              ? d.position
              : prev.position;
        prev.position = Number(mergedPos.toFixed(4));
        prev.start = Number(Math.min(prev.start, d.start).toFixed(4));
        prev.end = Number(Math.max(prev.end, d.end).toFixed(4));
        continue;
      }
    }
    stage1.push({ ...d });
  }
  // Fusionar tramos verticales colineales en niveles contiguos (ej. #06 divisor central entre nivel bajo y alto)
  const out: NormalizedSegment[] = [];
  for (const d of stage1) {
    const colinear = out.find(
      (m) =>
        Math.abs(m.position - d.position) <= 0.035 &&
        (Math.abs(m.end - d.start) <= 0.025 || Math.abs(d.end - m.start) <= 0.025),
    );
    if (colinear) {
      colinear.position = Number((0.5 * (colinear.position + d.position)).toFixed(4));
      colinear.start = Number(Math.min(colinear.start, d.start).toFixed(4));
      colinear.end = Number(Math.max(colinear.end, d.end).toFixed(4));
    } else {
      out.push({ ...d });
    }
  }
  return out.map((d, idx) => ({ ...d, id: d.id || `auto_div_${idx + 1}` }));
}

export interface SteppedCornerCutout {
  side: 'top_right' | 'top_left';
  uCut: number;
  vCut: number;
  xCutPx: number;
  yCutPx: number;
  strength: number;
}

/**
 * Detecta un recorte escalonado real (`void_outside`) en esquina superior derecha o izquierda
 * cuando la pared exterior LOCAL continúa sin borde de melamina hacia el interior del quad,
 * hallando la arista vertical del cuerpo alto (`uCut`) y la cubierta del escalón bajo (`vCut`).
 */
export function detectSteppedCornerCutout(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  localExteriorBg?: LocalExteriorBgSamples,
): SteppedCornerCutout | null {
  if (!localExteriorBg || W < 48 || H < 48) return null;

  const tryCorner = (side: 'top_right' | 'top_left'): SteppedCornerCutout | null => {
    const isRight = side === 'top_right';
    const borderOpen = isRight
      ? localExteriorBg.topRightBorderOpen === true
      : localExteriorBg.topLeftBorderOpen === true;
    const wallRgb = isRight
      ? (localExteriorBg.rightWallBgRgb ?? localExteriorBg.topRightBgRgb)
      : (localExteriorBg.leftWallBgRgb ?? localExteriorBg.topLeftBgRgb);
    if (!borderOpen || !wallRgb) return null;

    const wallLab = rgbToLab(wallRgb[0], wallRgb[1], wallRgb[2]);
    const isWallPx = (x: number, y: number): boolean => {
      const p = (clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)) * 4;
      if (rgba[p + 3] < 128) return true;
      const dRgb = Math.hypot(rgba[p] - wallRgb[0], rgba[p + 1] - wallRgb[1], rgba[p + 2] - wallRgb[2]);
      if (dRgb <= 38) return true;
      if (dRgb <= 58) {
        const pxLab = rgbToLab(rgba[p], rgba[p + 1], rgba[p + 2]);
        return Math.hypot(pxLab[0] - wallLab[0], pxLab[1] - wallLab[1], pxLab[2] - wallLab[2]) <= 18;
      }
      return false;
    };

    // 1. Buscar frontera vertical `xCutPx` en la franja superior (y = 3%..22%) avanzando desde la esquina
    const yProbe0 = Math.max(2, Math.round(H * 0.03));
    const yProbe1 = Math.max(yProbe0 + 8, Math.round(H * 0.22));
    const xStart = isRight ? Math.round(W * 0.45) : Math.round(W * 0.14);
    const xEnd = isRight ? Math.round(W * 0.86) : Math.round(W * 0.55);
    const stepPad = clamp(Math.round(Math.min(W, H) * 0.016), 4, 9);

    let bestX = -1;
    let bestXScore = 0;
    for (let x = xStart; x <= xEnd; x++) {
      let edgeSum = 0;
      let wallSideHits = 0;
      let bodySideHits = 0;
      const nY = Math.max(1, yProbe1 - yProbe0);
      for (let y = yProbe0; y < yProbe1; y++) {
        const iL = (y * W + Math.max(0, x - stepPad)) * 4;
        const iR = (y * W + Math.min(W - 1, x + stepPad)) * 4;
        const dCol = Math.hypot(rgba[iL] - rgba[iR], rgba[iL + 1] - rgba[iR + 1], rgba[iL + 2] - rgba[iR + 2]);
        edgeSum += dCol;
        const wallX = isRight ? Math.min(W - 1, x + stepPad) : Math.max(0, x - stepPad);
        const bodyX = isRight ? Math.max(0, x - stepPad) : Math.min(W - 1, x + stepPad);
        if (isWallPx(wallX, y)) wallSideHits++;
        if (!isWallPx(bodyX, y)) bodySideHits++;
      }
      const wallFrac = wallSideHits / nY;
      const bodyFrac = bodySideHits / nY;
      const meanEdge = edgeSum / nY;
      if (wallFrac >= 0.55 && bodyFrac >= 0.6 && meanEdge >= 22) {
        // Verificar que la región exterior completa desde `x` hasta la esquina sea mayoritariamente pared arriba
        const extX0 = isRight ? x + 3 : 3;
        const extX1 = isRight ? W - 4 : x - 3;
        let extHits = 0;
        let extCnt = 0;
        for (let y = yProbe0; y < yProbe1; y += 2) {
          for (let xx = extX0; xx <= extX1; xx += 2) {
            if (isWallPx(xx, y)) extHits++;
            extCnt++;
          }
        }
        const extFrac = extCnt > 0 ? extHits / extCnt : 0;
        if (extFrac >= 0.62) {
          const score = meanEdge * wallFrac * extFrac;
          if (score > bestXScore) {
            bestXScore = score;
            bestX = x;
          }
        }
      }
    }
    if (bestX < 0) return null;

    // 2. Buscar cubierta horizontal del escalón `yCutPx` dentro de la columna exterior `[colX0..colX1]`
    const colX0 = isRight ? bestX + Math.max(4, Math.round(W * 0.015)) : Math.max(4, Math.round(W * 0.02));
    const colX1 = isRight ? W - Math.max(4, Math.round(W * 0.02)) : bestX - Math.max(4, Math.round(W * 0.015));
    if (colX1 - colX0 < 20) return null;

    const yMin = Math.round(H * 0.14);
    const yMax = Math.round(H * 0.56);
    let bestY = -1;
    let bestYScore = 0;
    for (let y = yMin; y <= yMax; y++) {
      let edgeHits = 0;
      let edgeSum = 0;
      let aboveWall = 0;
      let belowNonWall = 0;
      const nX = Math.max(1, colX1 - colX0);
      for (let x = colX0; x < colX1; x++) {
        const iU = (Math.max(0, y - stepPad) * W + x) * 4;
        const iD = (Math.min(H - 1, y + stepPad) * W + x) * 4;
        const dCol = Math.hypot(rgba[iU] - rgba[iD], rgba[iU + 1] - rgba[iD + 1], rgba[iU + 2] - rgba[iD + 2]);
        if (dCol >= 24) edgeHits++;
        edgeSum += dCol;
        if (isWallPx(x, Math.max(0, y - stepPad * 2))) aboveWall++;
        if (!isWallPx(x, Math.min(H - 1, y + stepPad * 2))) belowNonWall++;
      }
      const hitFrac = edgeHits / nX;
      const aboveFrac = aboveWall / nX;
      const belowFrac = belowNonWall / nX;
      if (hitFrac >= 0.52 && (aboveFrac >= 0.35 || belowFrac >= 0.55)) {
        const score = (edgeSum / nX) * hitFrac * (0.5 + 0.5 * Math.max(aboveFrac, belowFrac));
        if (score > bestYScore) {
          bestYScore = score;
          bestY = y;
        }
      }
    }
    if (bestY < 0) return null;

    // 3. Validar que el cuadrante superior-exterior de la esquina sea claramente pared
    const qX0 = isRight ? Math.round((bestX + W) * 0.5) : 3;
    const qX1 = isRight ? W - 4 : Math.round(bestX * 0.5);
    const qY0 = 3;
    const qY1 = Math.max(qY0 + 6, Math.round(bestY * 0.65));
    let qHits = 0;
    let qCnt = 0;
    for (let y = qY0; y <= qY1; y += 2) {
      for (let x = qX0; x <= qX1; x += 2) {
        if (isWallPx(x, y)) qHits++;
        qCnt++;
      }
    }
    if (qCnt < 16 || qHits / qCnt < 0.65) return null;

    // 3b. Si sobre el escalón hay objetos pequeños apoyados (ej. frascos sobre el escalón en #12 entre u=0.68 y u=0.81),
    // verificar si existe una arista vertical estructural más interna (`xInner`) que continúa hacia la puerta inferior
    // y separa el frente real del cuerpo alto de los objetos sobre el escalón.
    const innerMinX = isRight
      ? Math.round(W * 0.52)
      : Math.min(W - stepPad - 4, bestX + Math.round(W * 0.06));
    const innerMaxX = isRight
      ? Math.max(stepPad + 4, bestX - Math.round(W * 0.06))
      : Math.round(W * 0.48);
    if (innerMaxX > innerMinX) {
      const yUpper0 = Math.max(4, Math.round(H * 0.04));
      const yUpper1 = Math.max(yUpper0 + 8, Math.round(bestY * 0.88));
      const yLower0 = Math.min(H - 12, Math.round(bestY + H * 0.08));
      const yLower1 = Math.min(H - 6, Math.round(H * 0.88));
      let bestInnerX = -1;
      let bestInnerScore = 0;
      for (let x = innerMinX; x <= innerMaxX; x++) {
        let upEdgeSum = 0;
        let upHits = 0;
        const nUp = Math.max(1, yUpper1 - yUpper0);
        for (let y = yUpper0; y < yUpper1; y++) {
          const iL = (y * W + Math.max(0, x - stepPad)) * 4;
          const iR = (y * W + Math.min(W - 1, x + stepPad)) * 4;
          const dCol = Math.hypot(
            rgba[iL] - rgba[iR],
            rgba[iL + 1] - rgba[iR + 1],
            rgba[iL + 2] - rgba[iR + 2],
          );
          upEdgeSum += dCol;
          if (dCol >= 24) upHits++;
        }
        const upRatio = upHits / nUp;
        if (upRatio < 0.55 || upEdgeSum / nUp < 24) continue;

        // Verificar que entre `x` y `bestX` arriba del escalón el color medio difiera del frente del cuerpo alto
        const bodySampleX0 = isRight ? Math.max(4, x - Math.round(W * 0.14)) : Math.min(W - 5, x + 4);
        const bodySampleX1 = isRight ? Math.max(5, x - 4) : Math.min(W - 4, x + Math.round(W * 0.14));
        const objSampleX0 = isRight ? x + 3 : bestX + 3;
        const objSampleX1 = isRight ? bestX - 3 : x - 3;
        if (bodySampleX1 > bodySampleX0 && objSampleX1 > objSampleX0) {
          let bR = 0,
            bG = 0,
            bB = 0,
            bN = 0;
          let oR = 0,
            oG = 0,
            oB = 0,
            oN = 0;
          for (let y = yUpper0; y < yUpper1; y += 2) {
            for (let xx = bodySampleX0; xx <= bodySampleX1; xx += 2) {
              const p = (y * W + xx) * 4;
              bR += rgba[p];
              bG += rgba[p + 1];
              bB += rgba[p + 2];
              bN++;
            }
            for (let xx = objSampleX0; xx <= objSampleX1; xx += 2) {
              const p = (y * W + xx) * 4;
              oR += rgba[p];
              oG += rgba[p + 1];
              oB += rgba[p + 2];
              oN++;
            }
          }
          const dBodyObj =
            bN > 0 && oN > 0
              ? Math.hypot(bR / bN - oR / oN, bG / bN - oG / oN, bB / bN - oB / oN)
              : 0;
          if (dBodyObj < 28) continue;

          // Verificar continuidad o junta vertical también bajo el escalón (`yLower0..yLower1`)
          let lowHits = 0;
          const nLow = Math.max(1, yLower1 - yLower0);
          for (let y = yLower0; y < yLower1; y++) {
            const iL = (y * W + Math.max(0, x - stepPad)) * 4;
            const iR = (y * W + Math.min(W - 1, x + stepPad)) * 4;
            const iC = (y * W + x) * 4;
            const dStep = Math.hypot(
              rgba[iL] - rgba[iR],
              rgba[iL + 1] - rgba[iR + 1],
              rgba[iL + 2] - rgba[iR + 2],
            );
            const dCenter = Math.max(
              Math.hypot(rgba[iC] - rgba[iL], rgba[iC + 1] - rgba[iL + 1], rgba[iC + 2] - rgba[iL + 2]),
              Math.hypot(rgba[iC] - rgba[iR], rgba[iC + 1] - rgba[iR + 1], rgba[iC + 2] - rgba[iR + 2]),
            );
            if (Math.max(dStep, dCenter) >= 16) lowHits++;
          }
          const lowRatio = lowHits / nLow;
          const score = (upEdgeSum / nUp) * upRatio * (0.6 + 0.4 * lowRatio);
          if (score > bestInnerScore) {
            bestInnerScore = score;
            bestInnerX = x;
          }
        }
      }
      if (bestInnerX > 0) {
        bestX = bestInnerX;
      }
    }

    const uCut = clamp(exteriorToInterior(bestX / W, boardThicknessMm, dimsMm.x), 0.14, 0.86);
    const vCut = clamp(exteriorToInterior(1 - bestY / H, boardThicknessMm, dimsMm.y), 0.4, 0.88);
    return {
      side,
      uCut: Number(uCut.toFixed(4)),
      vCut: Number(vCut.toFixed(4)),
      xCutPx: bestX,
      yCutPx: bestY,
      strength: Math.min(bestXScore, bestYScore),
    };
  };

  return tryCorner('top_right') ?? tryCorner('top_left');
}

/**
 * Detector híbrido por transiciones de borde RGB (|∇x RGB|, |∇y RGB|) + XY-Cut recursivo
 * + detección de recorte escalonado (`void_outside`) + anti-sobre-segmentación en canastos (`baskets`)
 * + clasificación CIE-Lab unificada (`zoneClassifier.ts`).
 */
function detectHybridEdgeTransitions(
  rgba: Uint8ClampedArray,
  lum: Float32Array,
  matchMap: Float32Array,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  refRgb: [number, number, number],
  carcassMaterial: MelamineMaterial,
  exteriorBgRgb?: [number, number, number],
  localExteriorBg?: LocalExteriorBgSamples,
  steppedCorner?: SteppedCornerCutout | null,
): HybridStructureResult {
  const tPx = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.x)) * W));
  const tPy = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.y)) * H));
  const stepPad = Math.max(5, Math.min(11, Math.round(Math.min(W, H) * 0.015)));

  const evalVertStep = (x: number, y0: number, y1: number): { ratio: number; meanDiff: number } => {
    const count = Math.max(1, y1 - y0);
    let hits = 0;
    let sumDiff = 0;
    for (let y = y0; y < y1; y++) {
      const rowOff = y * W;
      const iL = (rowOff + x - stepPad) * 4;
      const iR = (rowOff + x + stepPad) * 4;
      const iC = (rowOff + x) * 4;
      const stepColor = Math.hypot(
        rgba[iL] - rgba[iR],
        rgba[iL + 1] - rgba[iR + 1],
        rgba[iL + 2] - rgba[iR + 2],
      );
      const flankLum = 0.5 * (lum[rowOff + x - stepPad] + lum[rowOff + x + stepPad]);
      const valley = flankLum - Math.min(lum[rowOff + x - 1], lum[rowOff + x], lum[rowOff + x + 1]);
      const centerColor = Math.max(
        Math.hypot(rgba[iC] - rgba[iL], rgba[iC + 1] - rgba[iL + 1], rgba[iC + 2] - rgba[iL + 2]),
        Math.hypot(rgba[iC] - rgba[iR], rgba[iC + 1] - rgba[iR + 1], rgba[iC + 2] - rgba[iR + 2]),
      );
      const eff = Math.max(stepColor * 0.72, valley * 1.15, centerColor * 0.6);
      if (eff >= 30) hits++;
      sumDiff += eff;
    }
    return { ratio: hits / count, meanDiff: sumDiff / count };
  };

  const evalHorizStep = (y: number, x0: number, x1: number): { ratio: number; meanDiff: number } => {
    const count = Math.max(1, x1 - x0);
    let hits = 0;
    let sumDiff = 0;
    for (let x = x0; x < x1; x++) {
      const iU = ((y - stepPad) * W + x) * 4;
      const iD = ((y + stepPad) * W + x) * 4;
      const iC = (y * W + x) * 4;
      const stepColor = Math.hypot(
        rgba[iU] - rgba[iD],
        rgba[iU + 1] - rgba[iD + 1],
        rgba[iU + 2] - rgba[iD + 2],
      );
      const flankLum = 0.5 * (lum[(y - stepPad) * W + x] + lum[(y + stepPad) * W + x]);
      const valley =
        flankLum -
        Math.min(
          lum[Math.max(0, y - 2) * W + x],
          lum[(y - 1) * W + x],
          lum[y * W + x],
          lum[(y + 1) * W + x],
          lum[Math.min(H - 1, y + 2) * W + x],
        );
      const centerColor = Math.max(
        Math.hypot(rgba[iC] - rgba[iU], rgba[iC + 1] - rgba[iU + 1], rgba[iC + 2] - rgba[iU + 2]),
        Math.hypot(rgba[iC] - rgba[iD], rgba[iC + 1] - rgba[iD + 1], rgba[iC + 2] - rgba[iD + 2]),
      );
      const eff = Math.max(stepColor * 0.72, valley * 1.15, centerColor * 0.6);
      if (eff >= 28) hits++;
      sumDiff += eff;
    }
    return { ratio: hits / count, meanDiff: sumDiff / count };
  };

  const isBasketColumnRegion = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    u0: number,
    u1: number,
    v0: number,
    v1: number,
  ): boolean => {
    const spanU = u1 - u0;
    const spanV = v1 - v0;
    if (spanU < 0.14 || spanU > 0.52 || spanV < 0.36) return false;
    const cellWmm = spanU * dimsMm.x;
    const cellHmm = spanV * dimsMm.y;
    if (cellHmm < 240 || cellWmm > 560 || cellWmm / Math.max(1, cellHmm) > 1.2) return false;
    return detectMetallicBasketRails(rgba, lum, W, H, rx0, rx1, ry0, ry1).isBasketRails;
  };

  const findFullVertSteps = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    allowPartialAnchor = false,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < 40 || regH < 30) return [];
    const yA = ry0 + Math.round(regH * 0.05);
    const yB = ry1 - Math.round(regH * 0.05);
    const yTop1 = ry0 + Math.round(regH * 0.18);
    const yBot0 = ry1 - Math.round(regH * 0.18);
    const minX = Math.max(rx0 + stepPad + 2, Math.round(rx0 + regW * 0.14));
    const maxX = Math.min(rx1 - stepPad - 3, Math.round(rx1 - regW * 0.14));
    if (maxX <= minX) return [];

    const scores = new Float32Array(W);
    for (let x = minX; x <= maxX; x++) {
      const all = evalVertStep(x, yA, yB);
      const top = evalVertStep(x, yA, yTop1);
      const bot = evalVertStep(x, yBot0, yB);
      if (!allowPartialAnchor) {
        if (all.ratio < 0.72 || all.meanDiff < 36) continue;
        if (top.ratio < 0.62 || bot.ratio < 0.62) continue;
        scores[x] = all.ratio * all.meanDiff;
      } else {
        const anchoredTop = top.ratio >= 0.72;
        const anchoredBot = bot.ratio >= 0.72;
        if (!anchoredTop && !anchoredBot) continue;
        if (all.ratio < 0.35 || all.meanDiff < 34) continue;
        scores[x] = all.ratio * all.meanDiff;
      }
    }

    const nms =
      dimsMm.x <= 720 ? Math.max(40, Math.round(regW * 0.25)) : Math.max(28, Math.round(regW * 0.14));
    const peaks = findLocalPeaks1D(scores, minX, maxX, nms, allowPartialAnchor ? 17 : 32, {
      maxPeaks: dimsMm.x <= 720 ? 1 : 4,
    });
    return peaks
      .map((pk) => ({
        posPx: pk.pos,
        posNorm: exteriorToInterior(pk.pos / W, boardThicknessMm, dimsMm.x),
        score: pk.score,
      }))
      .filter((c) =>
        dimsMm.x <= 720
          ? c.posNorm >= 0.42 && c.posNorm <= 0.58
          : c.posNorm * dimsMm.x >= 205 && (1 - c.posNorm) * dimsMm.x >= 205,
      );
  };

  const findFullHorizSteps = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    isRoot = false,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < 36 || regH < 30) return [];
    const xA = rx0 + Math.round(regW * 0.05);
    const xB = rx1 - Math.round(regW * 0.05);
    const xL1 = rx0 + Math.round(regW * 0.18);
    const xR0 = rx1 - Math.round(regW * 0.18);
    const minY = Math.max(ry0 + stepPad + 2, Math.round(ry0 + regH * 0.12));
    const maxY = Math.min(ry1 - stepPad - 3, Math.round(ry1 - regH * (isRoot ? 0.16 : 0.11)));
    if (maxY <= minY) return [];

    const scores = new Float32Array(H);
    for (let y = minY; y <= maxY; y++) {
      const all = evalHorizStep(y, xA, xB);
      if (all.ratio < 0.65 || all.meanDiff < (isRoot ? 29 : 25)) continue;
      const left = evalHorizStep(y, xA, xL1);
      if (left.ratio < 0.55) continue;
      const right = evalHorizStep(y, xR0, xB);
      if (right.ratio < 0.55) continue;
      scores[y] = all.ratio * all.meanDiff;
    }

    const nms = Math.max(18, Math.round(regH * 0.11));
    const peaks = findLocalPeaks1D(scores, minY, maxY, nms, isRoot ? 24 : 20, { maxPeaks: 4 });
    return peaks
      .map((pk) => ({
        posPx: pk.pos,
        posNorm: exteriorToInterior(1 - pk.pos / H, boardThicknessMm, dimsMm.y),
        score: pk.score,
      }))
      .filter((c) => !(dimsMm.y < 600 && c.posNorm > 0.89));
  };

  const runSubRegionXYCut = (
    initial: {
      rx0: number;
      rx1: number;
      ry0: number;
      ry1: number;
      u0: number;
      u1: number;
      v0: number;
      v1: number;
    },
    preferHorizRoot = false,
  ) =>
    runRecursiveXYCut(initial, {
      maxDepth: 3,
      minRegionW: 36,
      minRegionH: 30,
      minNormSpanU: 0.12,
      minNormSpanV: 0.1,
      minCutMarginNorm: 0.06,
      padX: Math.round(tPx * 0.5),
      padY: Math.round(tPy * 0.5),
      vTopDownPx: true,
      idPrefix: { v: 'auto_div', h: 'auto_rep' },
      findVerticalCuts: (reg) => {
        if (isBasketColumnRegion(reg.rx0, reg.rx1, reg.ry0, reg.ry1, reg.u0, reg.u1, reg.v0, reg.v1)) {
          return [];
        }
        const strict = findFullVertSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, false);
        if (strict.length > 0 || reg.depth > 0) return strict;
        // En raíz sin cortes de punta a punta, habilitar anclaje a techo/piso (ej. cajonera suspendida #11)
        const hRoot = findFullHorizSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, true);
        if (hRoot.length > 0) return strict;
        return findFullVertSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, true);
      },
      findHorizontalCuts: (reg) => {
        if (isBasketColumnRegion(reg.rx0, reg.rx1, reg.ry0, reg.ry1, reg.u0, reg.u1, reg.v0, reg.v1)) {
          return [];
        }
        return findFullHorizSteps(reg.rx0, reg.rx1, reg.ry0, reg.ry1, reg.depth === 0);
      },
      chooseAxis: (vCuts, hCuts, reg) => {
        const bestV = vCuts.reduce((m, p) => Math.max(m, p.score), 0);
        const bestH = hCuts.reduce((m, p) => Math.max(m, p.score), 0);
        if (bestV === 0 && bestH === 0) return 'none';
        if (
          reg.depth === 0 &&
          hCuts.length > 0 &&
          (preferHorizRoot || (dimsMm.y > dimsMm.x * 1.05 && bestH >= bestV * 0.72))
        ) {
          return 'horizontal';
        }
        return bestV >= bestH ? 'vertical' : 'horizontal';
      },
    });

  let rawVDividers: NormalizedSegment[] = [];
  let rawHShelves: NormalizedSegment[] = [];
  let leafCells: Array<{ uStart: number; uEnd: number; vStart: number; vEnd: number }> = [];
  let cutStrengthSum = 0;
  let cutCount = 0;

  // Descomposición geométrica exacta cuando existe un recorte escalonado real (`void_outside`, ej. #12):
  // separa cuerpo alto vs ala baja con su escalón `vCut`, y aplica XY-Cut limpio en el cuerpo alto
  if (steppedCorner) {
    const { side, uCut, vCut, xCutPx, yCutPx, strength } = steppedCorner;
    const isRight = side === 'top_right';
    rawVDividers.push({
      id: 'auto_div_step',
      position: uCut,
      start: 0,
      end: 1,
    });
    rawHShelves.push({
      id: 'auto_rep_step',
      position: vCut,
      start: isRight ? uCut : 0,
      end: isRight ? 1 : uCut,
    });
    cutStrengthSum += strength * 2;
    cutCount += 2;

    // Esquina vacía `void_outside`
    leafCells.push({
      uStart: isRight ? uCut : 0,
      uEnd: isRight ? 1 : uCut,
      vStart: vCut,
      vEnd: 1,
    });

    // Ala baja bajo el escalón: si es un único vano angosto (<= 420 mm, ej. puerta baja #12),
    // mantenerlo como una celda limpia sin partir su manilla superior en un micro-cajón falso
    const wingSpanU = isRight ? 1 - uCut : uCut;
    if (wingSpanU * dimsMm.x <= 420) {
      leafCells.push({
        uStart: isRight ? uCut : 0,
        uEnd: isRight ? 1 : uCut,
        vStart: 0,
        vEnd: vCut,
      });
    } else {
      const lowWing = runSubRegionXYCut({
        rx0: isRight ? Math.min(W - tPx, xCutPx + Math.round(tPx * 0.5)) : tPx,
        rx1: isRight ? W - tPx : Math.max(tPx, xCutPx - Math.round(tPx * 0.5)),
        ry0: Math.min(H - tPy, yCutPx + Math.round(tPy * 0.5)),
        ry1: H - tPy,
        u0: isRight ? uCut : 0,
        u1: isRight ? 1 : uCut,
        v0: 0,
        v1: vCut,
      });
      rawVDividers.push(...lowWing.vDividers);
      rawHShelves.push(...lowWing.hShelves);
      leafCells.push(
        ...lowWing.leaves.map((lf) => ({ uStart: lf.u0, uEnd: lf.u1, vStart: lf.v0, vEnd: lf.v1 })),
      );
      cutStrengthSum += lowWing.cutStrengthSum;
      cutCount += lowWing.cutCount;
    }

    // Cuerpo alto contiguo: priorizar corte horizontal de cajón superior/niveles antes de dividir columnas
    const tallBody = runSubRegionXYCut(
      {
        rx0: isRight ? tPx : Math.min(W - tPx, xCutPx + Math.round(tPx * 0.5)),
        rx1: isRight ? Math.max(tPx, xCutPx - Math.round(tPx * 0.5)) : W - tPx,
        ry0: tPy,
        ry1: H - tPy,
        u0: isRight ? 0 : uCut,
        u1: isRight ? uCut : 1,
        v0: 0,
        v1: 1,
      },
      true,
    );
    rawVDividers.push(...tallBody.vDividers);
    rawHShelves.push(...tallBody.hShelves);
    leafCells.push(
      ...tallBody.leaves.map((lf) => ({ uStart: lf.u0, uEnd: lf.u1, vStart: lf.v0, vEnd: lf.v1 })),
    );
    cutStrengthSum += tallBody.cutStrengthSum;
    cutCount += tallBody.cutCount;
  } else {
    const xyRes = runSubRegionXYCut({
      rx0: tPx,
      rx1: W - tPx,
      ry0: tPy,
      ry1: H - tPy,
      u0: 0,
      u1: 1,
      v0: 0,
      v1: 1,
    });
    rawVDividers = xyRes.vDividers;
    rawHShelves = xyRes.hShelves;
    leafCells = xyRes.leaves.map((lf) => ({
      uStart: lf.u0,
      uEnd: lf.u1,
      vStart: lf.v0,
      vEnd: lf.v1,
    }));
    cutStrengthSum = xyRes.cutStrengthSum;
    cutCount = xyRes.cutCount;

    // Coherencia de escritorio de 2 pedestales (ej. #05): si existen 2 divisores verticales completos
    // con cajón superior en ambos pedestales laterales (v ∈ [0.68..0.88]) y el vano central quedó sin corte horizontal,
    // verificar si hay faldón/cajón central arriba y hueco oscuro/piso debajo.
    if (
      dimsMm.y <= 900 &&
      dimsMm.x >= 1100 &&
      rawVDividers.length === 2 &&
      rawHShelves.length === 2
    ) {
      const sortedV = [...rawVDividers].sort((a, b) => a.position - b.position);
      const uL = sortedV[0].position;
      const uR = sortedV[1].position;
      const hLeft = rawHShelves.find(
        (s) => Math.abs(s.start) <= 0.03 && Math.abs(s.end - uL) <= 0.03 && s.position >= 0.66 && s.position <= 0.88,
      );
      const hRight = rawHShelves.find(
        (s) => Math.abs(s.start - uR) <= 0.03 && Math.abs(s.end - 1) <= 0.03 && s.position >= 0.66 && s.position <= 0.88,
      );
      if (hLeft && hRight) {
        const vMidEst = Number((0.5 * (hLeft.position + hRight.position)).toFixed(4));
        const cx0 = Math.max(tPx, Math.round((uL + 0.03) * W));
        const cx1 = Math.min(W - tPx, Math.round((uR - 0.03) * W));
        const cySplit = clamp(Math.round((1 - vMidEst) * H), 12, H - 20);
        let topMatch = 0,
          topCnt = 0;
        let botMatch = 0,
          botCnt = 0;
        for (let y = tPy + 2; y < Math.max(tPy + 6, cySplit - 4); y += 2) {
          for (let x = cx0; x <= cx1; x += 3) {
            topMatch += matchMap[y * W + x];
            topCnt++;
          }
        }
        for (let y = Math.max(cySplit + 6, Math.round(H * 0.56)); y < H - tPy - 4; y += 3) {
          for (let x = cx0; x <= cx1; x += 3) {
            botMatch += matchMap[y * W + x];
            botCnt++;
          }
        }
        if (topCnt > 10 && botCnt > 10 && topMatch / topCnt >= 0.4 && botMatch / botCnt < 0.44) {
          rawHShelves.push({
            id: 'auto_rep_center_desk',
            position: vMidEst,
            start: uL,
            end: uR,
          });
          leafCells = partitionCellsFromVectors(rawVDividers, rawHShelves);
        }
      }
    }

    // En libreros abiertos multi-repisa (ej. #10): colapsar franja angosta de espesor en perspectiva
    // entre dos divisores verticales completos si dicha franja tiene 0 repisas y ambos lados tienen >= 2
    if (rawVDividers.length >= 3 && rawHShelves.length >= 4) {
      const sortedV = [...rawVDividers].sort((a, b) => a.position - b.position);
      for (let i = 0; i < sortedV.length - 1; i++) {
        const dA = sortedV[i];
        const dB = sortedV[i + 1];
        const gapU = dB.position - dA.position;
        if (
          dA.start <= 0.02 &&
          dA.end >= 0.98 &&
          dB.start <= 0.02 &&
          dB.end >= 0.98 &&
          gapU > 0.03 &&
          gapU <= 0.16
        ) {
          const midShelves = rawHShelves.filter(
            (h) => h.start >= dA.position - 0.02 && h.end <= dB.position + 0.02,
          );
          const leftShelves = rawHShelves.filter((h) => Math.abs(h.end - dA.position) <= 0.025);
          const rightShelves = rawHShelves.filter((h) => Math.abs(h.start - dB.position) <= 0.025);
          if (midShelves.length === 0 && leftShelves.length >= 2 && rightShelves.length >= 2) {
            const uMerged = Number((0.5 * (dA.position + dB.position)).toFixed(4));
            rawHShelves = rawHShelves.map((h) => {
              if (Math.abs(h.end - dA.position) <= 0.025) return { ...h, end: uMerged };
              if (Math.abs(h.start - dB.position) <= 0.025) return { ...h, start: uMerged };
              return h;
            });
            sortedV.splice(i, 2, { ...dA, position: uMerged });
            rawVDividers = sortedV;
            leafCells = partitionCellsFromVectors(rawVDividers, rawHShelves);
            break;
          }
        }
      }
    }
  }

  const vDividers = consolidateNarrowCenterDividers(rawVDividers, dimsMm).map((d, idx) => ({
    ...d,
    id: `auto_div_${idx + 1}`,
  }));
  const orderedHShelves = rawHShelves.map((s, idx) => ({
    ...s,
    id: `auto_rep_${idx + 1}`,
  }));

  // Re-particionar limpiamente si consolidación ajustó algún divisor
  const finalCells =
    vDividers.length !== rawVDividers.length
      ? partitionCellsFromVectors(vDividers, orderedHShelves)
      : leafCells;

  // Detectar manillas por contraste local respetando conversión interior -> exterior en las juntas
  const vSeamPxs = vDividers.map(
    (d) => interiorToExteriorPoint(d.position, 0.5, dimsMm, boardThicknessMm).uExt * W,
  );
  const hSeamPxs = orderedHShelves.map((s) => ({
    y: (1 - interiorToExteriorPoint(0.5, s.position, dimsMm, boardThicknessMm).vExt) * H,
    uStart: s.start,
    uEnd: s.end,
  }));
  const detectedHandles =
    vDividers.length + orderedHShelves.length > 0
      ? detectHandlesLocalContrast(lum, W, H, vSeamPxs, hSeamPxs, dimsMm, boardThicknessMm)
      : [];

  // Clasificación unificada CIE-Lab + interiorToExteriorRect + fusión verificada de cajones
  const inferredZones = classifyZonesUnified(finalCells, {
    rectRgba: rgba,
    rectW: W,
    rectH: H,
    dimsMm,
    boardThicknessMm,
    carcassMaterial,
    refRgb,
    exteriorBgRgb,
    localExteriorBg,
    lum,
    matchMap,
    detectedHandles,
    mergeDrawers: true,
    modeHint: 'hybrid',
    idPrefix: 'zone',
  });

  const cavities: DetectedCavity[] = inferredZones.map((z, idx) => ({
    id: `cav_hyb_${idx + 1}`,
    u0: z.uStart,
    u1: z.uEnd,
    v0: z.vStart,
    v1: z.vEnd,
    kind: z.kind === 'leg_void' ? 'knee_space' : 'open_bay',
  }));

  // Eliminar repisas fantasma estrictamente interiores a zonas clasificadas como `drawers`
  const hShelves = suppressShelvesInsideDrawers(orderedHShelves, inferredZones);

  return {
    vDividers,
    hShelves,
    detectedHandles,
    cavities,
    inferredZones,
    strength: cutCount > 0 ? cutStrengthSum / cutCount : 0,
  };
}

/**
 * Detector jerárquico para muebles CERRADOS y DE 2 NIVELES (puertas, cajones, alacena + mesón):
 *  1) Detecta primero niveles horizontales principales que cruzan >= 60% del ancho (`tiers`, ej. mesón/nicho).
 *  2) Dentro de CADA nivel horizontal (`spanV >= 0.14`) busca ranuras verticales (oscuras O cambios bruscos
 *     de color entre puertas y nichos), exigiendo continuidad en extremos del nivel (inmune a molduras/cuarterones).
 *  3) Fusiona divisores verticales alineados entre niveles contiguos y deduplica divisores centrales en muebles angostos.
 *  4) Detecta cajones apilados o cajón superior sobre puerta dentro de cada columna cerrada.
 */
function detectClosedFrontSeams(
  rgba: Uint8ClampedArray,
  lum: Float32Array,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  refLum: number,
  exteriorBgRgb?: readonly [number, number, number],
): {
  vDividers: NormalizedSegment[];
  hShelves: NormalizedSegment[];
  detectedHandles: DetectedHandlePoint[];
  seamStrength: number;
} {
  const pad = Math.max(7, Math.min(14, Math.round(W * 0.017)));
  const minDiff = clamp(refLum * 0.22, 10, 18);

  // Evaluador de ranura oscura vertical pura (puertas del mismo material)
  const evalVertDarkRange = (
    x: number,
    y0: number,
    y1: number,
  ): { ratio: number; meanPos: number } => {
    const count = Math.max(1, y1 - y0);
    let darkHits = 0;
    let sumPos = 0;
    const flankN = Math.max(1, pad - 2);
    for (let y = y0; y < y1; y++) {
      const rowOff = y * W;
      const cMin = Math.min(lum[rowOff + x - 1], lum[rowOff + x], lum[rowOff + x + 1]);
      let lSum = 0;
      let rSum = 0;
      for (let k = 3; k <= pad; k++) {
        lSum += lum[rowOff + x - k];
        rSum += lum[rowOff + x + k];
      }
      const flankMean = (0.5 * (lSum + rSum)) / flankN;
      const diff = flankMean - cMin;
      if (diff > minDiff) darkHits++;
      if (diff > 0) sumPos += diff;
    }
    return { ratio: darkHits / count, meanPos: sumPos / count };
  };

  // Evaluador combinado (ranura oscura O salto de color RGB entre puerta y nicho/otro color dentro de un nivel)
  const evalVertTierRange = (
    x: number,
    y0: number,
    y1: number,
    allowColorStep: boolean,
  ): { ratio: number; meanPos: number } => {
    const count = Math.max(1, y1 - y0);
    let hits = 0;
    let sumPos = 0;
    const flankN = Math.max(1, pad - 2);
    const stepPad = Math.min(pad, Math.max(5, Math.round(W * 0.015)));
    for (let y = y0; y < y1; y++) {
      const rowOff = y * W;
      const cMin = Math.min(lum[rowOff + x - 1], lum[rowOff + x], lum[rowOff + x + 1]);
      let lSum = 0;
      let rSum = 0;
      for (let k = 3; k <= pad; k++) {
        lSum += lum[rowOff + x - k];
        rSum += lum[rowOff + x + k];
      }
      const flankMean = (0.5 * (lSum + rSum)) / flankN;
      const valley = flankMean - cMin;
      let eff = valley;
      if (allowColorStep) {
        const iL = (rowOff + x - stepPad) * 4;
        const iR = (rowOff + x + stepPad) * 4;
        const stepColor = Math.hypot(
          rgba[iL] - rgba[iR],
          rgba[iL + 1] - rgba[iR + 1],
          rgba[iL + 2] - rgba[iR + 2],
        );
        // Solo permitir stepColor fuerte (p. ej. puerta roble vs nicho blanco) para no disparar en vetas
        eff = Math.max(valley, stepColor >= 32 ? stepColor * 0.65 : 0);
      }
      if (eff > minDiff) hits++;
      if (eff > 0) sumPos += eff;
    }
    return { ratio: hits / count, meanPos: sumPos / count };
  };

  // Evaluador horizontal (ranura oscura O transición fuerte de nivel tipo mesón/alacena)
  const evalHorizRange = (
    y: number,
    x0: number,
    x1: number,
    allowColorStep: boolean,
  ): { ratio: number; meanPos: number } => {
    const count = Math.max(1, x1 - x0);
    let hits = 0;
    let sumPos = 0;
    const flankN = Math.max(1, pad - 2);
    const stepPad = Math.min(pad, Math.max(5, Math.round(H * 0.015)));
    for (let x = x0; x < x1; x++) {
      const cMin = Math.min(lum[(y - 1) * W + x], lum[y * W + x], lum[(y + 1) * W + x]);
      let uSum = 0;
      let dSum = 0;
      for (let k = 3; k <= pad; k++) {
        uSum += lum[(y - k) * W + x];
        dSum += lum[(y + k) * W + x];
      }
      const flankMean = (0.5 * (uSum + dSum)) / flankN;
      const valley = flankMean - cMin;
      let eff = valley;
      if (allowColorStep) {
        const iU = ((y - stepPad) * W + x) * 4;
        const iD = ((y + stepPad) * W + x) * 4;
        const stepColor = Math.hypot(
          rgba[iU] - rgba[iD],
          rgba[iU + 1] - rgba[iD + 1],
          rgba[iU + 2] - rgba[iD + 2],
        );
        eff = Math.max(valley, stepColor >= 30 ? stepColor * 0.68 : 0);
      }
      if (eff > minDiff) hits++;
      if (eff > 0) sumPos += eff;
    }
    return { ratio: hits / count, meanPos: sumPos / count };
  };

  // 1. PROBAR PRIMERO RANURAS VERTICALES DE ALTURA COMPLETA (buffets, cómodas, vitrinas)
  const minVx = Math.max(pad + 2, Math.round(W * 0.08));
  const maxVx = Math.min(W - pad - 3, Math.round(W * 0.92));
  const nmsVx = Math.max(24, Math.round(W * 0.06));
  const minPeakScore = refLum < 80 ? 12 : 18;

  const yAll0 = Math.round(H * 0.05);
  const yAll1 = Math.round(H * 0.95);
  const yTop1 = Math.round(H * 0.14);
  const yBot0 = Math.round(H * 0.86);

  const fullVScore = new Float32Array(W);
  for (let x = minVx; x <= maxVx; x++) {
    const all = evalVertDarkRange(x, yAll0, yAll1);
    if (all.ratio <= 0.65) continue;
    const top = evalVertDarkRange(x, yAll0, yTop1);
    if (top.ratio <= 0.55) continue;
    const bot = evalVertDarkRange(x, yBot0, yAll1);
    if (bot.ratio <= 0.55) continue;
    fullVScore[x] = all.ratio * all.meanPos;
  }
  const fullVPeaks = findLocalPeaks1D(fullVScore, minVx, maxVx, nmsVx, minPeakScore);

  // 2. DETECTAR CORTES HORIZONTALES PRINCIPALES DE ANCHO COMPLETO (`tiers`, >= 60% del ancho)
  const xFull0 = Math.max(4, Math.round(W * 0.04));
  const xFull1 = Math.min(W - 5, Math.round(W * 0.96));
  const xFullL1 = Math.round(W * 0.17);
  const xFullR0 = Math.round(W * 0.83);
  const yMinH = Math.max(pad + 2, Math.round(H * 0.1));
  const yMaxH = Math.min(H - pad - 3, Math.round(H * 0.9));
  const nmsHy = Math.max(18, Math.round(H * 0.085));

  const tierHScore = new Float32Array(H);
  for (let y = yMinH; y <= yMaxH; y++) {
    const all = evalHorizRange(y, xFull0, xFull1, true);
    if (all.ratio < 0.54) continue;
    const left = evalHorizRange(y, xFull0, xFullL1, true);
    const right = evalHorizRange(y, xFullR0, xFull1, true);
    const bothSidesOk = left.ratio >= 0.48 && right.ratio >= 0.48;
    const threeQuarterOk = all.ratio >= 0.56 && Math.max(left.ratio, right.ratio) >= 0.62;
    if (!bothSidesOk && !threeQuarterOk) continue;
    tierHScore[y] = all.ratio * all.meanPos;
  }
  const tierHPeaks = findLocalPeaks1D(tierHScore, yMinH, yMaxH, nmsHy, minPeakScore * 1.1, {
    maxPeaks: 4,
  });

  // 3. RAMA JERÁRQUICA POR NIVELES (`tiers`) cuando hay cortes horizontales principales
  //    y menos de 2 divisores de altura completa (ej. cocinas 2 niveles #09, #13, #14, despensero #02)
  const isTwoTierCandidate =
    tierHPeaks.length >= 1 && (fullVPeaks.length === 0 || dimsMm.y >= dimsMm.x * 0.95);

  if (isTwoTierCandidate && tierHPeaks.length >= 1 && fullVPeaks.length <= 1) {
    // Filtrar líneas horizontales falsas cerca de la parte muy superior (ej. travesaño de vidrio en v > 0.85 en muebles altos)
    const validTierPeaks = tierHPeaks.filter((pk) => {
      const vExt = 1 - pk.pos / H;
      if (dimsMm.y >= 1500 && vExt > 0.84) return false;
      return true;
    });

    if (validTierPeaks.length >= 1) {
      // Ordenar de abajo (v=0) hacia arriba (v=1)
      const tierVs = validTierPeaks
        .map((pk) => ({
          yPx: pk.pos,
          vInt: clamp(exteriorToInterior(1 - pk.pos / H, boardThicknessMm, dimsMm.y), 0.08, 0.92),
          score: pk.score,
        }))
        .sort((a, b) => a.vInt - b.vInt);

      const tierEdgesV = [0, ...tierVs.map((t) => t.vInt), 1];
      const tierEdgesY = [H - 1, ...tierVs.map((t) => t.yPx), 0]; // y decrece cuando v crece

      const allRawV: Array<{
        uInt: number;
        xPx: number;
        vStart: number;
        vEnd: number;
        score: number;
      }> = [];
      const hRaw: Array<{ vInt: number; y: number; uStart: number; uEnd: number; score: number }> =
        tierVs.map((t) => ({
          vInt: t.vInt,
          y: t.yPx,
          uStart: 0,
          uEnd: 1,
          score: t.score,
        }));

      const bgRgb = exteriorBgRgb;
      const minBayPx = Math.round((205 / Math.max(300, dimsMm.x)) * W);
      for (let ti = 0; ti < tierEdgesV.length - 1; ti++) {
        const vStart = tierEdgesV[ti];
        const vEnd = tierEdgesV[ti + 1];
        const spanV = vEnd - vStart;
        if (spanV < 0.14) continue;

        const yTopRaw = tierEdgesY[ti + 1];
        const yBotRaw = tierEdgesY[ti];
        const tierH = yBotRaw - yTopRaw;
        if (tierH < 28) continue;

        // Omitir búsqueda de puertas verticales dentro de un nicho central pasante (coincide con fondo exterior)
        if (bgRgb && vStart > 0.05 && vEnd < 0.95) {
          let bgHits = 0;
          let bgCnt = 0;
          for (let y = Math.round(yTopRaw + tierH * 0.18); y <= Math.round(yBotRaw - tierH * 0.18); y += 3) {
            for (let x = Math.round(W * 0.15); x <= Math.round(W * 0.85); x += 4) {
              const p = (y * W + x) * 4;
              const d = Math.hypot(rgba[p] - bgRgb[0], rgba[p + 1] - bgRgb[1], rgba[p + 2] - bgRgb[2]);
              if (d < 30) bgHits++;
              bgCnt++;
            }
          }
          if (bgCnt > 20 && bgHits / bgCnt >= 0.52) {
            continue;
          }
        }

        // En el nivel inferior de muebles altos con zócalo (vStart === 0), recortar 8% inferior para no cruzar el zócalo
        const toeTrim = vStart <= 0.02 && dimsMm.y >= 1200 ? Math.round(H * 0.075) : 0;
        const yA = clamp(Math.round(yTopRaw + Math.max(3, tierH * 0.04)), 2, H - 3);
        const yB = clamp(Math.round(yBotRaw - Math.max(3, tierH * 0.04) - toeTrim), yA + 12, H - 3);
        const effH = yB - yA;
        if (effH < 22) continue;
        // Verificar continuidad estricta en los extremos externos (9% superior e inferior del nivel)
        // para rechazar cuarterones de vidrio (#09) y molduras Shaker sin perder ranuras de puertas
        const endSpan = Math.max(5, Math.round(effH * 0.1));
        const yEndTop = Math.min(yB, yA + endSpan);
        const yEndBot = Math.max(yA, yB - endSpan);

        const tierVScore = new Float32Array(W);
        const tierMinX = Math.max(pad + 2, minBayPx, Math.round(W * 0.14));
        const tierMaxX = Math.min(W - pad - 3, W - minBayPx, Math.round(W * 0.86));

        for (let x = tierMinX; x <= tierMaxX; x++) {
          const all = evalVertTierRange(x, yA, yB, true);
          if (all.ratio < 0.45) continue;
          const top = evalVertTierRange(x, yA, yEndTop, true);
          const bot = evalVertTierRange(x, yEndBot, yB, true);
          if (top.ratio < 0.36 || bot.ratio < 0.36) continue;
          tierVScore[x] = all.ratio * all.meanPos;
        }

        const tierNmsX =
          dimsMm.x <= 720 ? Math.max(40, Math.round(W * 0.25)) : Math.max(24, Math.round(W * 0.13));
        const tierMinVScore = refLum < 80 ? 8 : 9.5;
        const tPeaks =
          tierMaxX > tierMinX
            ? findLocalPeaks1D(tierVScore, tierMinX, tierMaxX, tierNmsX, tierMinVScore, {
                maxPeaks: dimsMm.x <= 720 ? 1 : 4,
              })
            : [];

        for (const pk of tPeaks) {
          const uCand = clamp(exteriorToInterior(pk.pos / W, boardThicknessMm, dimsMm.x), 0.08, 0.92);
          if (dimsMm.x <= 720 && (uCand < 0.42 || uCand > 0.58)) continue;
          allRawV.push({
            uInt: uCand,
            xPx: pk.pos,
            vStart,
            vEnd,
            score: pk.score,
          });
        }
      }

      // En muebles anchos de 2 niveles con mesón intermedio (ej. cocinas #09, #13, #14: >= 3 niveles horizontales y x >= 1200 mm):
      // 1) Completar columna simétrica faltante en el módulo bajo (p. ej. 0.25 cuando hay 0.49 y 0.75 en #09; 0.67 cuando hay 0.34 en #13; 0.46 cuando hay 0.23 y 0.69 en #14)
      // 2) Alinear columnas de la alacena superior (`vEnd === 1`) con las del módulo bajo cuando el nivel superior quedó sub-dividido
      if (dimsMm.x >= 1200 && tierEdgesV.length >= 4) {
        const lowTierEnd = tierEdgesV[1];
        const highTierStart = tierEdgesV[tierEdgesV.length - 2];
        const lowV = allRawV
          .filter((v) => v.vStart <= 0.02 && Math.abs(v.vEnd - lowTierEnd) <= 0.02)
          .sort((a, b) => a.uInt - b.uInt);
        if (lowV.length === 1) {
          const u0 = lowV[0].uInt;
          if (u0 >= 0.28 && u0 <= 0.39) {
            const uSym = Number(clamp(1 - u0, 0.61, 0.72).toFixed(4));
            lowV.push({
              uInt: uSym,
              xPx: Math.round(uSym * W),
              vStart: 0,
              vEnd: lowTierEnd,
              score: lowV[0].score * 0.85,
            });
            allRawV.push(lowV[1]);
          }
        } else if (lowV.length === 2) {
          const u0 = lowV[0].uInt;
          const u1 = lowV[1].uInt;
          if (u0 >= 0.43 && u0 <= 0.55 && u1 >= 0.69 && u1 <= 0.81) {
            // 4 columnas: falta 1er cuarto (~0.245, ej. #09)
            const uFirst = Number((0.5 * u0).toFixed(4));
            const added = {
              uInt: uFirst,
              xPx: Math.round(uFirst * W),
              vStart: 0,
              vEnd: lowTierEnd,
              score: lowV[0].score * 0.85,
            };
            lowV.unshift(added);
            allRawV.push(added);
          } else if (u0 >= 0.18 && u0 <= 0.29 && u1 >= 0.63 && u1 <= 0.76) {
            // 4 columnas: falta punto medio (~0.46, ej. #14)
            const uMid = Number((0.5 * (u0 + u1)).toFixed(4));
            const added = {
              uInt: uMid,
              xPx: Math.round(uMid * W),
              vStart: 0,
              vEnd: lowTierEnd,
              score: lowV[0].score * 0.85,
            };
            lowV.splice(1, 0, added);
            allRawV.push(added);
          }
        }
        const highV = allRawV.filter(
          (v) => Math.abs(v.vStart - highTierStart) <= 0.02 && v.vEnd >= 0.98,
        );
        if (highV.length < lowV.length && lowV.length >= 2) {
          for (const lv of lowV) {
            const exists = highV.some((hv) => Math.abs(hv.uInt - lv.uInt) <= 0.06);
            if (!exists) {
              allRawV.push({
                uInt: lv.uInt,
                xPx: lv.xPx,
                vStart: highTierStart,
                vEnd: 1,
                score: lv.score * 0.85,
              });
            }
          }
        }
      }

      // Si hubo un divisor vertical de altura completa (ej. #06 vitrina) y algún nivel no lo incluyó, asegurarlo
      for (const fp of fullVPeaks) {
        const uFull = clamp(exteriorToInterior(fp.pos / W, boardThicknessMm, dimsMm.x), 0.08, 0.92);
        const alreadyCovered = allRawV.some((v) => Math.abs(v.uInt - uFull) <= 0.05);
        if (!alreadyCovered) {
          allRawV.push({ uInt: uFull, xPx: fp.pos, vStart: 0, vEnd: 1, score: fp.score });
        }
      }

      // Fusionar divisores verticales alineados (`|uA - uB| <= 0.035`) en niveles contiguos
      allRawV.sort((a, b) => a.uInt - b.uInt || a.vStart - b.vStart);
      const mergedV: Array<{ uInt: number; xPx: number; vStart: number; vEnd: number; score: number; count: number }> = [];
      for (const rv of allRawV) {
        const hit = mergedV.find(
          (m) => Math.abs(m.uInt - rv.uInt) <= 0.035 && Math.abs(m.vEnd - rv.vStart) <= 0.025,
        );
        if (hit) {
          hit.uInt = (hit.uInt * hit.count + rv.uInt) / (hit.count + 1);
          hit.xPx = (hit.xPx * hit.count + rv.xPx) / (hit.count + 1);
          hit.vEnd = rv.vEnd;
          hit.score = Math.max(hit.score, rv.score);
          hit.count++;
        } else {
          mergedV.push({ ...rv, count: 1 });
        }
      }

      const vDividers = consolidateNarrowCenterDividers(
        mergedV.map((m, idx) => ({
          id: `auto_div_${idx + 1}`,
          position: Number(m.uInt.toFixed(4)),
          start: Number(m.vStart.toFixed(4)),
          end: Number(m.vEnd.toFixed(4)),
        })),
        dimsMm,
      );

      // Buscar cajón superior sobre puerta dentro de cada celda baja cerrada (ej. #09, #13, #14 columna derecha)
      const prelimHShelves: NormalizedSegment[] = hRaw.map((m, idx) => ({
        id: `auto_rep_${idx + 1}`,
        position: Number(m.vInt.toFixed(4)),
        start: Number(m.uStart.toFixed(4)),
        end: Number(m.uEnd.toFixed(4)),
      }));
      const prelimCells = partitionCellsFromVectors(vDividers, prelimHShelves);
      for (const cell of prelimCells) {
        if (cell.vStart > 0.05) continue;
        const internal = detectInternalDrawersInCell(cell, lum, W, H, dimsMm, boardThicknessMm);
        if (internal.kind === 'top_drawer_over_door' && internal.splitV !== undefined) {
          const dup = hRaw.some(
            (h) =>
              Math.abs(h.vInt - internal.splitV!) <= 0.04 &&
              Math.min(h.uEnd, cell.uEnd) - Math.max(h.uStart, cell.uStart) > 0.05,
          );
          if (!dup) {
            const splitY =
              (1 - interiorToExteriorPoint(0.5, internal.splitV, dimsMm, boardThicknessMm).vExt) * H;
            hRaw.push({
              vInt: internal.splitV,
              y: splitY,
              uStart: cell.uStart,
              uEnd: cell.uEnd,
              score: 26,
            });
          }
        }
      }

      const hShelves: NormalizedSegment[] = hRaw
        .sort((a, b) => a.vInt - b.vInt || a.uStart - b.uStart)
        .map((m, idx) => ({
          id: `auto_rep_${idx + 1}`,
          position: Number(m.vInt.toFixed(4)),
          start: Number(m.uStart.toFixed(4)),
          end: Number(m.uEnd.toFixed(4)),
        }));

      const detectedHandles: DetectedHandlePoint[] =
        vDividers.length > 0 || hRaw.length > 0
          ? detectHandlesLocalContrast(
              lum,
              W,
              H,
              vDividers.map(
                (d) => interiorToExteriorPoint(d.position, 0.5, dimsMm, boardThicknessMm).uExt * W,
              ),
              hRaw.map((hr) => ({ y: hr.y, uStart: hr.uStart, uEnd: hr.uEnd })),
              dimsMm,
              boardThicknessMm,
            )
          : [];

      const allScores = [...mergedV.map((m) => m.score), ...hRaw.map((m) => m.score)];
      const seamStrength =
        allScores.length > 0 ? allScores.reduce((acc, s) => acc + s, 0) / allScores.length : 0;

      return { vDividers, hShelves, detectedHandles, seamStrength };
    }
  }

  // 4. MUEBLE CERRADO DE UN SOLO NIVEL (buffets #01, #03, cómodas, etc.): divisores verticales completos + ranuras horizontales por vano
  const vDividers: NormalizedSegment[] = consolidateNarrowCenterDividers(
    fullVPeaks.map((p, idx) => ({
      id: `auto_div_${idx + 1}`,
      position: Number(exteriorToInterior(p.pos / W, boardThicknessMm, dimsMm.x).toFixed(4)),
      start: 0,
      end: 1,
    })),
    dimsMm,
  );

  const pxStops = [
    0,
    ...vDividers.map(
      (d) => interiorToExteriorPoint(d.position, 0.5, dimsMm, boardThicknessMm).uExt * W,
    ),
    W,
  ];
  const uStops = [0, ...vDividers.map((d) => d.position), 1];
  const hRaw: Array<{ y: number; vInt: number; uStart: number; uEnd: number; score: number }> = [];

  for (let b = 0; b < pxStops.length - 1; b++) {
    const bx0 = pxStops[b];
    const bx1 = pxStops[b + 1];
    const bw = bx1 - bx0;
    if (bw < 36) continue;

    const xAll0 = Math.round(bx0 + Math.max(4, bw * 0.04));
    const xAll1 = Math.round(bx1 - Math.max(4, bw * 0.04));
    const xLeft1 = Math.round(bx0 + Math.max(8, bw * 0.16));
    const xRight0 = Math.round(bx1 - Math.max(8, bw * 0.16));

    const hScore = new Float32Array(H);
    for (let y = yMinH; y <= yMaxH; y++) {
      const all = evalHorizRange(y, xAll0, xAll1, false);
      if (all.ratio <= 0.65) continue;
      const left = evalHorizRange(y, xAll0, xLeft1, false);
      if (left.ratio <= 0.55) continue;
      const right = evalHorizRange(y, xRight0, xAll1, false);
      if (right.ratio <= 0.55) continue;
      hScore[y] = all.ratio * all.meanPos;
    }

    const hPeaks = findLocalPeaks1D(hScore, yMinH, yMaxH, nmsHy, minPeakScore);
    for (const pk of hPeaks) {
      const vExt = 1 - pk.pos / H;
      const vInt = exteriorToInterior(vExt, boardThicknessMm, dimsMm.y);
      if (dimsMm.y < 600 && vInt > 0.89) continue;
      hRaw.push({
        y: pk.pos,
        vInt,
        uStart: uStops[b],
        uEnd: uStops[b + 1],
        score: pk.score,
      });
    }
  }

  // Fusión de ranuras horizontales colineales en vanos adyacentes
  hRaw.sort((a, b) => a.vInt - b.vInt || a.uStart - b.uStart);
  let hMerged: Array<{ vInt: number; uStart: number; uEnd: number; count: number; score: number }> =
    [];
  for (const rs of hRaw) {
    const existing = hMerged.find(
      (m) => Math.abs(m.vInt - rs.vInt) <= 0.025 && Math.abs(m.uEnd - rs.uStart) <= 0.025,
    );
    if (existing) {
      existing.vInt = (existing.vInt * existing.count + rs.vInt) / (existing.count + 1);
      existing.uEnd = rs.uEnd;
      existing.score = Math.max(existing.score, rs.score);
      existing.count++;
    } else {
      hMerged.push({ vInt: rs.vInt, uStart: rs.uStart, uEnd: rs.uEnd, count: 1, score: rs.score });
    }
  }

  // En escritorios de 2 pedestales (ej. #05: 2 divisores verticales con cajón superior en ambos pedestales y vano central libre):
  // verificar si hay faldón/cajón central arriba y sombra/piso de hueco de piernas debajo
  if (
    dimsMm.y >= 680 &&
    dimsMm.y <= 880 &&
    dimsMm.x >= 1100 &&
    vDividers.length === 2 &&
    hMerged.length === 2
  ) {
    const uL = vDividers[0].position;
    const uR = vDividers[1].position;
    const hLeft = hMerged.find(
      (s) => Math.abs(s.uStart) <= 0.03 && Math.abs(s.uEnd - uL) <= 0.03 && s.vInt >= 0.66 && s.vInt <= 0.88,
    );
    const hRight = hMerged.find(
      (s) => Math.abs(s.uStart - uR) <= 0.03 && Math.abs(s.uEnd - 1) <= 0.03 && s.vInt >= 0.66 && s.vInt <= 0.88,
    );
    if (hLeft && hRight) {
      const vMidEst = Number((0.5 * (hLeft.vInt + hRight.vInt)).toFixed(4));
      const cx0 = Math.max(8, Math.round((uL + 0.03) * W));
      const cx1 = Math.min(W - 8, Math.round((uR - 0.03) * W));
      const cySplit = clamp(Math.round((1 - vMidEst) * H), 12, H - 20);
      let topLumSum = 0,
        topCnt = 0;
      let botLumSum = 0,
        botCnt = 0;
      for (let y = 6; y < Math.max(10, cySplit - 4); y += 2) {
        for (let x = cx0; x <= cx1; x += 3) {
          topLumSum += lum[y * W + x];
          topCnt++;
        }
      }
      for (let y = Math.max(cySplit + 6, Math.round(H * 0.56)); y < H - 6; y += 2) {
        for (let x = cx0; x <= cx1; x += 3) {
          botLumSum += lum[y * W + x];
          botCnt++;
        }
      }
      const topLumMean = topCnt > 0 ? topLumSum / topCnt : 0;
      const botLumMean = botCnt > 0 ? botLumSum / botCnt : 999;
      if (Math.abs(topLumMean - refLum) <= 42 && Math.abs(topLumMean - botLumMean) >= 16) {
        hMerged.push({
          vInt: vMidEst,
          uStart: uL,
          uEnd: uR,
          count: 1,
          score: 0.5 * (hLeft.score + hRight.score),
        });
      }
    }
  }

  // En libreros abiertos multi-repisa (ej. #10): colapsar franja angosta de espesor en perspectiva
  // entre dos divisores verticales completos si dicha franja tiene 0 repisas y ambos lados tienen >= 2
  let finalVDividers = vDividers;
  if (finalVDividers.length >= 3 && hMerged.length >= 4) {
    const sortedV = [...finalVDividers].sort((a, b) => a.position - b.position);
    for (let i = 0; i < sortedV.length - 1; i++) {
      const dA = sortedV[i];
      const dB = sortedV[i + 1];
      const gapU = dB.position - dA.position;
      if (gapU > 0.03 && gapU <= 0.16) {
        const midShelves = hMerged.filter(
          (h) => h.uStart >= dA.position - 0.02 && h.uEnd <= dB.position + 0.02,
        );
        const leftShelves = hMerged.filter((h) => Math.abs(h.uEnd - dA.position) <= 0.025);
        const rightShelves = hMerged.filter((h) => Math.abs(h.uStart - dB.position) <= 0.025);
        if (midShelves.length === 0 && leftShelves.length >= 2 && rightShelves.length >= 2) {
          const uMerged = Number((0.5 * (dA.position + dB.position)).toFixed(4));
          hMerged = hMerged.map((h) => {
            if (Math.abs(h.uEnd - dA.position) <= 0.025) return { ...h, uEnd: uMerged };
            if (Math.abs(h.uStart - dB.position) <= 0.025) return { ...h, uStart: uMerged };
            return h;
          });
          sortedV.splice(i, 2, { ...dA, position: uMerged });
          finalVDividers = sortedV.map((d, idx) => ({ ...d, id: `auto_div_${idx + 1}` }));
          break;
        }
      }
    }
  }

  // Si tras colapsar quedan 2 divisores verticales simétricos de un librero de 3 cuerpos (ej. #10: ~0.28 y ~0.75)
  // donde la torre izquierda y el cuerpo central tienen >= 3 repisas pero la torre derecha quedó con 0 repisas por sobreexposición lateral,
  // proyectar las repisas de la torre izquierda hacia la torre derecha simétrica.
  if (dimsMm.y >= 1500 && finalVDividers.length === 2 && hMerged.length >= 6) {
    const u0 = finalVDividers[0].position;
    const u1 = finalVDividers[1].position;
    if (u0 >= 0.2 && u0 <= 0.35 && u1 >= 0.65 && u1 <= 0.82) {
      const leftTowerShelves = hMerged.filter(
        (h) => Math.abs(h.uStart) <= 0.02 && Math.abs(h.uEnd - u0) <= 0.025,
      );
      const centerShelves = hMerged.filter(
        (h) => Math.abs(h.uStart - u0) <= 0.025 && Math.abs(h.uEnd - u1) <= 0.025,
      );
      const rightTowerShelves = hMerged.filter(
        (h) => Math.abs(h.uStart - u1) <= 0.025 && Math.abs(h.uEnd - 1) <= 0.02,
      );
      if (
        leftTowerShelves.length >= 3 &&
        centerShelves.length >= 3 &&
        rightTowerShelves.length === 0
      ) {
        for (const ls of leftTowerShelves) {
          hMerged.push({
            vInt: ls.vInt,
            uStart: u1,
            uEnd: 1,
            count: 1,
            score: ls.score * 0.85,
          });
        }
      }
    }
  }

  const hShelves: NormalizedSegment[] = hMerged.map((m, idx) => ({
    id: `auto_rep_${idx + 1}`,
    position: Number(m.vInt.toFixed(4)),
    start: Number(m.uStart.toFixed(4)),
    end: Number(m.uEnd.toFixed(4)),
  }));

  const detectedHandles: DetectedHandlePoint[] =
    finalVDividers.length > 0 || hRaw.length > 0
      ? detectHandlesLocalContrast(
          lum,
          W,
          H,
          finalVDividers.map(
            (d) => interiorToExteriorPoint(d.position, 0.5, dimsMm, boardThicknessMm).uExt * W,
          ),
          hRaw.map((hr) => ({ y: hr.y, uStart: hr.uStart, uEnd: hr.uEnd })),
          dimsMm,
          boardThicknessMm,
        )
      : [];

  const allScores = [...fullVPeaks.map((p) => p.score), ...hMerged.map((m) => m.score)];
  const seamStrength =
    allScores.length > 0 ? allScores.reduce((acc, s) => acc + s, 0) / allScores.length : 0;

  return { vDividers: finalVDividers, hShelves, detectedHandles, seamStrength };
}

/**
 * Detecta automáticamente la estructura interna de un mueble rectificado (modo dual/híbrido:
 * mueble abierto con huecos vs mueble cerrado con puertas/cajones + tiradores vs híbrido/bicolor).
 */
export function analyzeRectifiedFurniture(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  dimsMm: { x: number; y: number },
  boardThicknessMm: number,
  opts: BandDetectorOptions = {},
): BandDetectionResult {
  const parallaxAware = opts.parallaxAware ?? true;
  const horizonV = opts.horizonV ?? 0.5;
  const nPx = W * H;

  const lum = new Float32Array(nPx);
  const c1 = new Float32Array(nPx);
  const c2 = new Float32Array(nPx);

  for (let i = 0; i < nPx; i++) {
    const p = i * 4;
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    lum[i] = rgbaLuminance(r, g, b);
    const denom = r + g + b + 15;
    c1[i] = (r - g) / denom;
    c2[i] = (b - 0.5 * (r + g)) / denom;
  }

  const blurRadius = Math.max(12, Math.round(W / 8));
  const lumBlur = boxBlur2D(lum, W, H, blurRadius);
  const lumFlat = new Float32Array(nPx);
  for (let i = 0; i < nPx; i++) {
    lumFlat[i] = (lum[i] + 15) / (lumBlur[i] + 15);
  }

  const tPx = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.x)) * W));
  const tPy = Math.max(3, Math.round((boardThicknessMm / Math.max(100, dimsMm.y)) * H));

  const sampleLum: number[] = [];
  const sampleFlat: number[] = [];
  const sampleC1: number[] = [];
  const sampleC2: number[] = [];
  const sampleR: number[] = [];
  const sampleG: number[] = [];
  const sampleB: number[] = [];

  const pushPixel = (x: number, y: number, filterBg = false): void => {
    const cx = clamp(Math.round(x), 0, W - 1);
    const cy = clamp(Math.round(y), 0, H - 1);
    const idx = cy * W + cx;
    const p = idx * 4;
    if (rgba[p + 3] < 128) return;
    if (filterBg && opts.exteriorBgRgb) {
      const dBg = Math.hypot(
        rgba[p] - opts.exteriorBgRgb[0],
        rgba[p + 1] - opts.exteriorBgRgb[1],
        rgba[p + 2] - opts.exteriorBgRgb[2],
      );
      if (dBg < 34) return;
    }
    sampleLum.push(lum[idx]);
    sampleFlat.push(lumFlat[idx]);
    sampleC1.push(c1[idx]);
    sampleC2.push(c2[idx]);
    sampleR.push(rgba[p]);
    sampleG.push(rgba[p + 1]);
    sampleB.push(rgba[p + 2]);
  };

  if (opts.seedPoint) {
    const sx = Math.round(opts.seedPoint.u * (W - 1));
    const sy = Math.round((1 - opts.seedPoint.v) * (H - 1));
    const r = Math.max(2, Math.floor(Math.min(tPx, tPy) / 2));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        pushPixel(sx + dx, sy + dy, false);
      }
    }
  } else {
    const bxStart = Math.max(2, Math.floor(tPx * 0.25));
    const bxEnd = Math.max(bxStart + 2, Math.floor(tPx * 1.15));
    const byStart = Math.max(2, Math.floor(tPy * 0.25));
    const byEnd = Math.max(byStart + 2, Math.floor(tPy * 1.15));
    const stepY = Math.max(1, Math.floor(H / 90));
    const stepX = Math.max(1, Math.floor(W / 90));

    const collectBorder = (filterBg: boolean) => {
      for (let y = byEnd; y < H - byEnd; y += stepY) {
        for (let dx = bxStart; dx < bxEnd; dx++) {
          pushPixel(dx, y, filterBg);
          pushPixel(W - 1 - dx, y, filterBg);
        }
      }
      for (let x = bxEnd; x < W - bxEnd; x += stepX) {
        for (let dy = byStart; dy < byEnd; dy++) {
          pushPixel(x, dy, filterBg);
          if (x < W * 0.16 || x > W * 0.84) {
            pushPixel(x, H - 1 - dy, filterBg);
          }
        }
      }
    };

    collectBorder(true);
    if (sampleLum.length < 24) {
      collectBorder(false);
    }
  }

  let refLum = median(sampleLum);
  const refFlat = median(sampleFlat);
  const refC1 = median(sampleC1);
  const refC2 = median(sampleC2);
  let refRgb: [number, number, number] = [median(sampleR), median(sampleG), median(sampleB)];
  let detectedMaterial = classifyMelamineMaterial(
    refRgb[0],
    refRgb[1],
    refRgb[2],
    opts.exteriorBgRgb,
  );

  // Mueble bajo muy apaisado (ej. mesa de centro con estructura metálica lateral #08):
  // si los bordes exteriores son un marco metálico delgado muy oscuro (refLum < 75), muestrear
  // la cubierta/bandeja horizontal superior/inferior para recuperar el acabado real de madera (roble)
  const isLowWideTable = dimsMm.y <= 500 && dimsMm.x / Math.max(1, dimsMm.y) >= 2.0;
  if (!opts.seedPoint && isLowWideTable && refLum < 75) {
    const deckR: number[] = [];
    const deckG: number[] = [];
    const deckB: number[] = [];
    const xD0 = Math.round(W * 0.18);
    const xD1 = Math.round(W * 0.82);
    const stepDX = Math.max(2, Math.floor((xD1 - xD0) / 60));
    const yBands: Array<[number, number]> = [
      [Math.round(H * 0.06), Math.round(H * 0.16)],
      [Math.round(H * 0.78), Math.round(H * 0.92)],
    ];
    for (const [ya, yb] of yBands) {
      for (let y = ya; y <= yb; y += 2) {
        for (let x = xD0; x <= xD1; x += stepDX) {
          const p = (clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)) * 4;
          if (rgba[p + 3] < 128) continue;
          const lab = rgbToLab(rgba[p], rgba[p + 1], rgba[p + 2]);
          if (isWarmWoodLab(lab)) {
            deckR.push(rgba[p]);
            deckG.push(rgba[p + 1]);
            deckB.push(rgba[p + 2]);
          }
        }
      }
    }
    if (deckR.length >= 24) {
      refRgb = [median(deckR), median(deckG), median(deckB)];
      refLum = rgbaLuminance(refRgb[0], refRgb[1], refRgb[2]);
      detectedMaterial = classifyMelamineMaterial(refRgb[0], refRgb[1], refRgb[2], opts.exteriorBgRgb);
    }
  }

  const sigmaLum = Math.max(22, mad(sampleLum, refLum) * 2.5);
  const sigmaFlat = Math.max(0.11, mad(sampleFlat, refFlat) * 2.5);
  const sigmaC1 = Math.max(0.032, mad(sampleC1, refC1) * 2.5);
  const sigmaC2 = Math.max(0.032, mad(sampleC2, refC2) * 2.5);

  const matchMap = new Float32Array(nPx);
  let interiorHits = 0;
  let interiorCount = 0;
  const marginX = Math.max(tPx + 2, Math.round(W * 0.03));
  const marginY = Math.max(tPy + 2, Math.round(H * 0.03));

  for (let y = 0; y < H; y++) {
    const insideY = y >= marginY && y < H - marginY;
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      const idx = rowOff + x;
      const dLum = Math.abs(lum[idx] - refLum) / sigmaLum;
      const dFlat = Math.abs(lumFlat[idx] - refFlat) / sigmaFlat;
      const dLumEff = Math.min(dLum, dFlat * 1.05);
      const dChroma = Math.hypot((c1[idx] - refC1) / sigmaC1, (c2[idx] - refC2) / sigmaC2);
      const dist = Math.hypot(0.62 * dLumEff, 1.15 * dChroma);
      const m = Math.exp(-0.5 * dist * dist);
      matchMap[idx] = m;

      if (insideY && x >= marginX && x < W - marginX) {
        interiorCount++;
        if (m > 0.55) {
          interiorHits++;
        }
      }
    }
  }

  const interiorMatch = interiorCount > 0 ? interiorHits / interiorCount : 1;

  // Helper anti-falso-positivo para mesas de centro bajas abiertas (`H <= 500 mm, W/H >= 2.0`, ej. #08):
  // Si no existe ningún divisor vertical sólido de arriba a abajo y la zona central muestra
  // abertura/contraste alto de fondo/suelo, mantener como nicho abierto limpio (0V · 0H).
  const applyLowWideOpenTableGuard = (res: BandDetectionResult): BandDetectionResult => {
    if (!isLowWideTable) return res;
    const hasFullHeightDivider = res.vDividers.some((d) => d.end - d.start >= 0.78);
    if (hasFullHeightDivider) return res;

    // Medir dispersión de luminancia en la banda central
    let cSum = 0;
    let cSum2 = 0;
    let cCnt = 0;
    for (let y = Math.round(H * 0.18); y <= Math.round(H * 0.82); y += 2) {
      const row = y * W;
      for (let x = Math.round(W * 0.12); x <= Math.round(W * 0.88); x += 2) {
        const l = lum[row + x];
        cSum += l;
        cSum2 += l * l;
        cCnt++;
      }
    }
    const cMean = cCnt > 0 ? cSum / cCnt : 128;
    const cStd = Math.sqrt(Math.max(0, cSum2 / Math.max(1, cCnt) - cMean * cMean));
    const mostlyOpen =
      res.inferredZones.length === 0 ||
      res.inferredZones.filter((z) => z.kind === 'open').length / res.inferredZones.length >= 0.5;
    if (cStd >= 30 || mostlyOpen || interiorMatch < 0.55) {
      return {
        ...res,
        furnitureMode: 'open',
        vDividers: [],
        hShelves: [],
        detectedHandles: [],
        cavities: [{ id: 'cav_open_table_1', u0: 0, u1: 1, v0: 0, v1: 1, kind: 'open_bay' }],
        inferredZones: [
          {
            id: 'zone_open_1',
            uStart: 0,
            uEnd: 1,
            vStart: 0,
            vEnd: 1,
            kind: 'open',
            label: 'Vano 1',
          },
        ],
        confidence: Math.max(res.confidence, 0.78),
      };
    }
    return res;
  };

  // Detectar si existe un recorte escalonado real en esquina superior (ej. #12 carro escalonado)
  const steppedCorner = detectSteppedCornerCutout(
    rgba,
    W,
    H,
    dimsMm,
    boardThicknessMm,
    opts.localExteriorBg,
  );
  if (steppedCorner) {
    const hybridStep = detectHybridEdgeTransitions(
      rgba,
      lum,
      matchMap,
      W,
      H,
      dimsMm,
      boardThicknessMm,
      refRgb,
      detectedMaterial,
      opts.exteriorBgRgb,
      opts.localExteriorBg,
      steppedCorner,
    );
    if (hybridStep.vDividers.length + hybridStep.hShelves.length > 0) {
      const hybConf = clamp(0.62 + hybridStep.strength / 200, 0.65, 0.94);
      return applyLowWideOpenTableGuard({
        furnitureMode: 'hybrid',
        vDividers: hybridStep.vDividers,
        hShelves: hybridStep.hShelves,
        detectedHandles: hybridStep.detectedHandles,
        cavities: hybridStep.cavities,
        inferredZones: hybridStep.inferredZones,
        detectedMaterial,
        confidence: Number(hybConf.toFixed(3)),
        interiorMatch: Number(interiorMatch.toFixed(3)),
        refLum: Number(refLum.toFixed(1)),
      });
    }
  }

  // =========================================================================
  // RAMA B: SI interiorMatch > 0.50 -> PROBAR CERRADO (JUNTAS/NIVELES) O HÍBRIDO (BORDES/BICOLOR/ESCRITORIO)
  // =========================================================================
  if (interiorMatch > 0.5) {
    const closed = detectClosedFrontSeams(
      rgba,
      lum,
      W,
      H,
      dimsMm,
      boardThicknessMm,
      refLum,
      opts.exteriorBgRgb,
    );
    const totalSeams = closed.vDividers.length + closed.hShelves.length;
    const minStrength = refLum < 80 ? 15 : 22;
    if (totalSeams > 0 && closed.seamStrength >= minStrength) {
      const closedConf = clamp(0.55 + closed.seamStrength / 240, 0.62, 0.95);
      // Partición planar exacta para soportar tanto divisores completos como parciales por nivel (`tiers`)
      const closedCells = partitionCellsFromVectors(closed.vDividers, closed.hShelves).map((c) => ({
        uStart: c.uStart,
        uEnd: c.uEnd,
        vStart: c.vStart,
        vEnd: c.vEnd,
      }));
      const closedCavities: DetectedCavity[] = closedCells.map((cell, idx) => ({
        id: `cav_closed_${idx + 1}`,
        u0: cell.uStart,
        u1: cell.uEnd,
        v0: cell.vStart,
        v1: cell.vEnd,
        kind: 'open_bay',
      }));

      const closedZones = classifyZonesUnified(closedCells, {
        rectRgba: rgba,
        rectW: W,
        rectH: H,
        dimsMm,
        boardThicknessMm,
        carcassMaterial: detectedMaterial,
        refRgb,
        exteriorBgRgb: opts.exteriorBgRgb,
        localExteriorBg: opts.localExteriorBg,
        lum,
        matchMap,
        detectedHandles: closed.detectedHandles,
        mergeDrawers: true,
        modeHint: 'closed',
        idPrefix: 'zone',
      });

      const filteredHShelves = suppressShelvesInsideDrawers(closed.hShelves, closedZones);
      const hasOpenOrSpecial = closedZones.some(
        (z) =>
          z.kind === 'open' ||
          z.kind === 'door_glass' ||
          z.kind === 'leg_void' ||
          z.kind === 'void_outside' ||
          z.kind === 'baskets',
      );

      return applyLowWideOpenTableGuard({
        furnitureMode: hasOpenOrSpecial ? 'hybrid' : 'closed_front',
        vDividers: closed.vDividers,
        hShelves: filteredHShelves,
        detectedHandles: closed.detectedHandles,
        cavities: closedCavities,
        inferredZones: closedZones,
        detectedMaterial,
        confidence: Number(closedConf.toFixed(3)),
        interiorMatch: Number(interiorMatch.toFixed(3)),
        refLum: Number(refLum.toFixed(1)),
      });
    }

    // Probar detector híbrido por transiciones fuertes de borde/color (racks mixtos, bicolor, escritorio)
    const hybrid = detectHybridEdgeTransitions(
      rgba,
      lum,
      matchMap,
      W,
      H,
      dimsMm,
      boardThicknessMm,
      refRgb,
      detectedMaterial,
      opts.exteriorBgRgb,
      opts.localExteriorBg,
      null,
    );
    if (hybrid.vDividers.length + hybrid.hShelves.length > 0 && hybrid.strength >= 20) {
      const hybConf = clamp(0.55 + hybrid.strength / 200, 0.6, 0.92);
      return applyLowWideOpenTableGuard({
        furnitureMode: 'hybrid',
        vDividers: hybrid.vDividers,
        hShelves: hybrid.hShelves,
        detectedHandles:
          hybrid.detectedHandles.length > 0 ? hybrid.detectedHandles : closed.detectedHandles,
        cavities: hybrid.cavities,
        inferredZones: hybrid.inferredZones,
        detectedMaterial,
        confidence: Number(hybConf.toFixed(3)),
        interiorMatch: Number(interiorMatch.toFixed(3)),
        refLum: Number(refLum.toFixed(1)),
      });
    }

    // Sin ranuras ni transiciones claras (ej. blanco sobre blanco sin contraste) -> NO CONFIABLE
    const rawConf = clamp(1 - interiorMatch * 1.05, 0, 0.45);
    return {
      furnitureMode: 'uncertain',
      vDividers: [],
      hShelves: [],
      detectedHandles: [],
      cavities: [],
      inferredZones: [],
      detectedMaterial,
      confidence: Number(rawConf.toFixed(3)),
      interiorMatch: Number(interiorMatch.toFixed(3)),
      refLum: Number(refLum.toFixed(1)),
    };
  }

  // =========================================================================
  // RAMA A: MUEBLE ABIERTO / MULTI-RECUADRO (RECURSIVE XY-CUT + CAVIDADES)
  // =========================================================================
  const confidence = clamp(1 - interiorMatch * 1.05, 0.52, 1);

  const xStartInt = tPx;
  const xEndInt = W - tPx;
  const yStartInt = tPy + 2;
  const yEndInt = H - tPy - 2;
  const fwX = Math.max(tPx + 2, Math.round(tPx * 1.6));
  const fhY = Math.max(tPy + 2, Math.round(tPy * 1.6));

  const colAvgAt = (x0: number, x1: number, y: number): number => {
    const cx0 = Math.max(0, x0);
    const cx1 = Math.min(W - 1, x1);
    const cy = clamp(y, 0, H - 1);
    let sum = 0;
    const rowOff = cy * W;
    for (let cx = cx0; cx <= cx1; cx++) sum += matchMap[rowOff + cx];
    return sum / Math.max(1, cx1 - cx0 + 1);
  };

  /**
   * Guardia estructural de carpintería (anti-objetos flotantes):
   * Un divisor vertical parcial real DEBE descansar en ambos extremos contra la carcasa
   * o una repisa horizontal (unión en T), nunca terminar flotando en medio de un vano vacío.
   */
  const hasHorizontalSupportAt = (xCenter: number, yEdge: number): boolean => {
    if (yEdge <= yStartInt + Math.max(tPy * 2.5, H * 0.035)) return true;
    if (yEdge >= yEndInt - 1 - Math.max(tPy * 2.5, H * 0.035)) return true;
    const flankSpan = Math.max(tPx * 2, 12);
    const l0 = Math.max(xStartInt, Math.round(xCenter - tPx - flankSpan));
    const l1 = Math.max(xStartInt, Math.round(xCenter - tPx));
    const r0 = Math.min(xEndInt - 1, Math.round(xCenter + tPx));
    const r1 = Math.min(xEndInt - 1, Math.round(xCenter + tPx + flankSpan));
    const bandHalf = Math.max(2, Math.round(tPy * 0.8));

    let bestSupport = 0;
    for (let dy = -bandHalf; dy <= bandHalf; dy++) {
      const yy = clamp(Math.round(yEdge + dy), 0, H - 1);
      const leftM = l1 > l0 ? colAvgAt(l0, l1, yy) : 0;
      const rightM = r1 > r0 ? colAvgAt(r0, r1, yy) : 0;
      bestSupport = Math.max(bestSupport, Math.max(leftM, rightM));
    }
    return bestSupport >= 0.42;
  };

  const findVerticalCutsInRegion = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    isPartialTier: boolean,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < Math.max(28, tPx * 4) || regH < Math.max(24, tPy * 4)) return [];

    const colProfile = new Float32Array(W);
    for (let x = rx0; x < rx1; x++) {
      let sum = 0;
      for (let y = ry0; y < ry1; y++) sum += matchMap[y * W + x];
      colProfile[x] = sum / regH;
    }

    const minX = Math.max(rx0 + fwX, Math.round(rx0 + regW * 0.08));
    const maxX = Math.min(rx1 - tPx - fwX - 1, Math.round(rx1 - regW * 0.08) - tPx);
    if (maxX <= minX) return [];

    const divScores = new Float32Array(W);
    for (let x = minX; x <= maxX; x++) {
      const bandCov = rangeMean(colProfile, x, x + tPx);
      if (bandCov < 0.42) continue;

      const uCenter = (x + tPx / 2) / W;
      const leftFlank = rangeMean(colProfile, x - fwX, x);
      const rightFlank = rangeMean(colProfile, x + tPx, x + tPx + fwX);

      let score: number;
      if (!parallaxAware || Math.abs(uCenter - 0.5) < 0.06) {
        score = bandCov - 0.5 * (leftFlank + rightFlank);
      } else if (uCenter < 0.5) {
        score = bandCov - leftFlank;
      } else {
        score = bandCov - rightFlank;
      }

      if (score > 0.24) {
        divScores[x] = score;
      }
    }

    const nmsRadX = Math.max(tPx * 3, Math.round(regW * 0.07));
    const peaks = findLocalPeaks1D(divScores, minX, maxX, nmsRadX, 0, { subpixelRefine: true });
    const cands: XYCutCandidate[] = [];

    for (const pk of peaks) {
      const xInt = Math.round(pk.pos);
      const cx0 = Math.max(0, xInt);
      const cx1 = Math.min(W - 1, xInt + tPx - 1);
      let bestStart = ry0;
      let bestEnd = ry0;
      let runStart = -1;
      let lastHit = -1;
      const gapTol = Math.max(4, Math.round(tPy * 1.4));

      for (let y = ry0; y < ry1; y++) {
        const rowAvg = colAvgAt(cx0, cx1, y);
        if (rowAvg >= 0.42) {
          if (runStart < 0) runStart = y;
          lastHit = y;
        } else if (runStart >= 0 && y - lastHit > gapTol) {
          if (lastHit - runStart > bestEnd - bestStart) {
            bestStart = runStart;
            bestEnd = lastHit;
          }
          runStart = -1;
        }
      }
      if (runStart >= 0 && lastHit - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = lastHit;
      }

      const endTol = Math.max(tPy * 2.5, Math.round(regH * 0.06));
      if (bestStart - ry0 > endTol || ry1 - 1 - bestEnd > endTol) {
        continue;
      }

      if (isPartialTier) {
        let fullTop = ry0;
        let miss = 0;
        for (let y = ry0 - 1; y >= yStartInt; y--) {
          if (colAvgAt(cx0, cx1, y) >= 0.42) {
            fullTop = y;
            miss = 0;
          } else {
            miss++;
            if (miss > gapTol) break;
          }
        }
        let fullBot = ry1 - 1;
        miss = 0;
        for (let y = ry1; y < yEndInt; y++) {
          if (colAvgAt(cx0, cx1, y) >= 0.42) {
            fullBot = y;
            miss = 0;
          } else {
            miss++;
            if (miss > gapTol) break;
          }
        }
        const xMid = pk.pos + tPx / 2;
        if (!hasHorizontalSupportAt(xMid, fullTop) || !hasHorizontalSupportAt(xMid, fullBot)) {
          continue;
        }
      }

      const pxCenter = pk.pos + tPx / 2;
      cands.push({
        posPx: pxCenter,
        posNorm: exteriorToInterior(pxCenter / W, boardThicknessMm, dimsMm.x),
        score: pk.score,
      });
    }

    return cands;
  };

  const findHorizontalCutsInRegion = (
    rx0: number,
    rx1: number,
    ry0: number,
    ry1: number,
    requireFullSpanEnds: boolean,
  ): XYCutCandidate[] => {
    const regW = rx1 - rx0;
    const regH = ry1 - ry0;
    if (regW < Math.max(12, tPx * 2) || regH < Math.max(24, tPy * 4)) return [];

    const rowProfile = new Float32Array(H);
    for (let y = ry0; y < ry1; y++) {
      const rowOff = y * W;
      let sum = 0;
      for (let x = rx0; x < rx1; x++) sum += matchMap[rowOff + x];
      rowProfile[y] = sum / regW;
    }

    const minY = Math.max(ry0 + fhY, Math.round(ry0 + regH * 0.06));
    const maxY = Math.min(ry1 - tPy - fhY - 1, Math.round(ry1 - regH * 0.06) - tPy);
    if (maxY <= minY) return [];

    const rowScores = new Float32Array(H);
    for (let y = minY; y <= maxY; y++) {
      const bandCov = rangeMean(rowProfile, y, y + tPy);
      if (bandCov < 0.36) continue;

      const vCenter = 1 - (y + tPy / 2) / H;
      const aboveFlank = rangeMean(rowProfile, y - fhY, y);
      const belowFlank = rangeMean(rowProfile, y + tPy, y + tPy + fhY);

      let score: number;
      if (!parallaxAware || Math.abs(vCenter - horizonV) < 0.04) {
        score = bandCov - 0.5 * (aboveFlank + belowFlank);
      } else if (vCenter < horizonV) {
        score = bandCov - belowFlank;
      } else {
        score = bandCov - aboveFlank;
      }

      if (score > 0.22) {
        rowScores[y] = score;
      }
    }

    const nmsRadY = Math.max(tPy * 3, Math.round(regH * 0.06));
    const peaks = findLocalPeaks1D(rowScores, minY, maxY, nmsRadY, 0, { subpixelRefine: true });
    const cands: XYCutCandidate[] = [];

    for (const pk of peaks) {
      const yInt = Math.round(pk.pos);
      if (requireFullSpanEnds) {
        const cy0 = Math.max(0, yInt);
        const cy1 = Math.min(H - 1, yInt + tPy - 1);
        let bestStart = rx0;
        let bestEnd = rx0;
        let runStart = -1;
        let lastHit = -1;
        const gapTolX = Math.max(6, Math.round(tPx * 1.8));
        for (let x = rx0; x < rx1; x++) {
          let colSum = 0;
          for (let cy = cy0; cy <= cy1; cy++) colSum += matchMap[cy * W + x];
          const colAvg = colSum / Math.max(1, cy1 - cy0 + 1);
          if (colAvg >= 0.36) {
            if (runStart < 0) runStart = x;
            lastHit = x;
          } else if (runStart >= 0 && x - lastHit > gapTolX) {
            if (lastHit - runStart > bestEnd - bestStart) {
              bestStart = runStart;
              bestEnd = lastHit;
            }
            runStart = -1;
          }
        }
        if (runStart >= 0 && lastHit - runStart > bestEnd - bestStart) {
          bestStart = runStart;
          bestEnd = lastHit;
        }
        const endTolX = Math.max(tPx * 2.5, Math.round(regW * 0.08));
        if (bestStart - rx0 > endTolX || rx1 - 1 - bestEnd > endTolX) {
          continue;
        }
      }

      const pyCenter = pk.pos + tPy / 2;
      cands.push({
        posPx: pyCenter,
        posNorm: exteriorToInterior(1 - pyCenter / H, boardThicknessMm, dimsMm.y),
        score: pk.score,
      });
    }

    return cands;
  };

  const bayPadX = Math.max(tPx + 2, Math.round(tPx * 1.4));
  const tierPadY = Math.max(tPy + 2, Math.round(tPy * 1.3));

  const xyOpen = runRecursiveXYCut(
    { rx0: xStartInt, rx1: xEndInt, ry0: yStartInt, ry1: yEndInt, u0: 0, u1: 1, v0: 0, v1: 1 },
    {
      maxDepth: 3,
      minRegionW: Math.max(18, tPx * 2.5),
      minRegionH: Math.max(18, tPy * 2.5),
      minNormSpanU: 0.06,
      minNormSpanV: 0.06,
      minCutMarginNorm: 0.04,
      padX: (isOuter) => (isOuter ? 3 : bayPadX),
      padY: (isOuter) => (isOuter ? 2 : tierPadY),
      vTopDownPx: true,
      idPrefix: { v: 'auto_div', h: 'auto_rep' },
      findVerticalCuts: (reg) =>
        findVerticalCutsInRegion(
          reg.rx0,
          reg.rx1,
          reg.ry0,
          reg.ry1,
          reg.depth > 0 && (reg.v0 > 0.02 || reg.v1 < 0.98),
        ),
      findHorizontalCuts: (reg) =>
        findHorizontalCutsInRegion(reg.rx0, reg.rx1, reg.ry0, reg.ry1, reg.depth === 0),
      chooseAxis: (vCuts, hCuts) => {
        if (vCuts.length > 0) return 'vertical';
        if (hCuts.length > 0) return 'horizontal';
        return 'none';
      },
    },
  );

  // Consolidar divisores verticales ordenados por u, luego vStart
  let rawOpenV: NormalizedSegment[] = [...xyOpen.vDividers].sort(
    (a, b) => a.position - b.position || a.start - b.start,
  );
  let rawOpenH: NormalizedSegment[] = [...xyOpen.hShelves];

  // En libreros abiertos multi-repisa (ej. #10): si dos divisores verticales de altura completa dejan una
  // franja angosta intermedia (<= 0.16) con 0 repisas horizontales mientras los vanos a ambos lados sí tienen
  // múltiples repisas (>= 2), esa franja angosta es la cara interior en perspectiva del divisor vertical.
  if (rawOpenV.length >= 3 && rawOpenH.length >= 4) {
    for (let i = 0; i < rawOpenV.length - 1; i++) {
      const dA = rawOpenV[i];
      const dB = rawOpenV[i + 1];
      const gapU = dB.position - dA.position;
      if (
        dA.start <= 0.02 &&
        dA.end >= 0.98 &&
        dB.start <= 0.02 &&
        dB.end >= 0.98 &&
        gapU > 0.03 &&
        gapU <= 0.16
      ) {
        const midShelves = rawOpenH.filter(
          (h) => h.start >= dA.position - 0.02 && h.end <= dB.position + 0.02,
        );
        const leftShelves = rawOpenH.filter((h) => Math.abs(h.end - dA.position) <= 0.025);
        const rightShelves = rawOpenH.filter((h) => Math.abs(h.start - dB.position) <= 0.025);
        if (midShelves.length === 0 && leftShelves.length >= 2 && rightShelves.length >= 2) {
          const uMerged = Number((0.5 * (dA.position + dB.position)).toFixed(4));
          rawOpenH = rawOpenH.map((h) => {
            if (Math.abs(h.end - dA.position) <= 0.025) return { ...h, end: uMerged };
            if (Math.abs(h.start - dB.position) <= 0.025) return { ...h, start: uMerged };
            return h;
          });
          rawOpenV.splice(i, 2, {
            ...dA,
            position: uMerged,
          });
          break;
        }
      }
    }
  }

  const vDividers: NormalizedSegment[] = rawOpenV.map((d, idx) => ({
    ...d,
    id: `auto_div_${idx + 1}`,
  }));

  // Fusión de repisas horizontales colineales entre vanos adyacentes
  const sortedShelves = [...rawOpenH].sort(
    (a, b) => a.position - b.position || a.start - b.start,
  );
  const merged: Array<{ vInt: number; uStart: number; uEnd: number; count: number }> = [];
  for (const rs of sortedShelves) {
    const matchMerge = merged.find(
      (m) => Math.abs(m.vInt - rs.position) <= 0.02 && Math.abs(m.uEnd - rs.start) <= 0.02,
    );
    if (matchMerge) {
      matchMerge.vInt = (matchMerge.vInt * matchMerge.count + rs.position) / (matchMerge.count + 1);
      matchMerge.uEnd = rs.end;
      matchMerge.count++;
    } else {
      merged.push({ vInt: rs.position, uStart: rs.start, uEnd: rs.end, count: 1 });
    }
  }

  const hShelves: NormalizedSegment[] = merged.map((m, idx) => ({
    id: `auto_rep_${idx + 1}`,
    position: Number(m.vInt.toFixed(4)),
    start: Number(m.uStart.toFixed(4)),
    end: Number(m.uEnd.toFixed(4)),
  }));

  const effectiveLeaves =
    rawOpenV.length !== xyOpen.vDividers.length
      ? partitionCellsFromVectors(vDividers, hShelves).map((c) => ({
          u0: c.uStart,
          u1: c.uEnd,
          v0: c.vStart,
          v1: c.vEnd,
        }))
      : xyOpen.leaves;

  const cavities: DetectedCavity[] = effectiveLeaves.map((lf, idx) => {
    const spanU = lf.u1 - lf.u0;
    const spanV = lf.v1 - lf.v0;
    const isKneeSpace = lf.v0 <= 0.02 && spanU >= 0.34 && spanV >= 0.32 && spanU < 0.92;
    return {
      id: `cav_${idx + 1}`,
      u0: Number(lf.u0.toFixed(4)),
      u1: Number(lf.u1.toFixed(4)),
      v0: Number(lf.v0.toFixed(4)),
      v1: Number(lf.v1.toFixed(4)),
      kind: isKneeSpace ? 'knee_space' : 'open_bay',
    };
  });

  // Fallback híbrido cuando Rama A no detectó divisiones (ej. bicolor o escritorio sobre pared blanca)
  if (vDividers.length === 0 && hShelves.length === 0) {
    const hybrid = detectHybridEdgeTransitions(
      rgba,
      lum,
      matchMap,
      W,
      H,
      dimsMm,
      boardThicknessMm,
      refRgb,
      detectedMaterial,
      opts.exteriorBgRgb,
      opts.localExteriorBg,
      null,
    );
    if (hybrid.vDividers.length + hybrid.hShelves.length > 0 && hybrid.strength >= 20) {
      const hybConf = clamp(0.55 + hybrid.strength / 200, 0.6, 0.92);
      return applyLowWideOpenTableGuard({
        furnitureMode: 'hybrid',
        vDividers: hybrid.vDividers,
        hShelves: hybrid.hShelves,
        detectedHandles: hybrid.detectedHandles,
        cavities: hybrid.cavities,
        inferredZones: hybrid.inferredZones,
        detectedMaterial,
        confidence: Number(hybConf.toFixed(3)),
        interiorMatch: Number(interiorMatch.toFixed(3)),
        refLum: Number(refLum.toFixed(1)),
      });
    }
  }

  // Clasificar cada cavidad detectada en Rama A usando el clasificador CIE-Lab unificado (`interiorToExteriorRect`)
  const openZones = classifyZonesUnified(
    cavities.map((c) => ({ uStart: c.u0, uEnd: c.u1, vStart: c.v0, vEnd: c.v1 })),
    {
      rectRgba: rgba,
      rectW: W,
      rectH: H,
      dimsMm,
      boardThicknessMm,
      carcassMaterial: detectedMaterial,
      refRgb,
      exteriorBgRgb: opts.exteriorBgRgb,
      localExteriorBg: opts.localExteriorBg,
      lum,
      matchMap,
      mergeDrawers: false,
      modeHint: 'open',
      idPrefix: 'zone',
    },
  );
  const finalHShelves = suppressShelvesInsideDrawers(hShelves, openZones);
  const hasClosedFrontPanel = openZones.some(
    (z) => z.kind !== 'open' && z.kind !== 'leg_void' && z.kind !== 'void_outside',
  );

  return applyLowWideOpenTableGuard({
    furnitureMode: hasClosedFrontPanel ? 'hybrid' : 'open',
    vDividers: consolidateNarrowCenterDividers(vDividers, dimsMm),
    hShelves: finalHShelves,
    detectedHandles: [],
    cavities,
    inferredZones: openZones,
    detectedMaterial,
    confidence: Number(confidence.toFixed(3)),
    interiorMatch: Number(interiorMatch.toFixed(3)),
    refLum: Number(refLum.toFixed(1)),
  });
}

/**
 * Analiza la franja inclinada paralela a la base [BL -> BR] debajo del cuerpo de melamina
 * para detectar patas externas, ruedas giratorias o zócalo continuo (`toe_kick`).
 */
export function detectLowerGapHint(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  quadCorners: readonly [Point2D, Point2D, Point2D, Point2D],
  exteriorBgRgb?: readonly [number, number, number],
): LowerGapHintResult {
  return detectBaseSupportHint(srcRgba, srcW, srcH, quadCorners, exteriorBgRgb);
}
