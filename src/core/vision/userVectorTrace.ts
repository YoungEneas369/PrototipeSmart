/**
 * SMARTFURNITURE — VECTORIZACIÓN GUIADA POR EL USUARIO (RECALCAR MÁRGENES -> VECTORES -> 3D EXACTO) v6.0
 * 100% offline, TypeScript puro (cero DOM, cero React).
 *
 * Permite que el usuario recalque directamente sobre la foto:
 *   1) Contorno exterior (con imán opcional de bordes Sobel `snapPointToStrongEdge`).
 *   2) Líneas internas con 1 sola herramienta universal (`vectorizeUserStroke`): detecta automáticamente
 *      si el trazo es horizontal (repisa/junta) o vertical (divisor), lo endereza en espacio de homografía,
 *      hace snap a muros y vectores existentes (T-junctions) y calcula su medida exacta en mm.
 *   3) Partición planar exacta por BFS (`partitionCellsFromVectors`): convierte cualquier combinación de
 *      divisores y repisas (totales o parciales) en celdas rectangulares cerradas sin solapamiento.
 *   4) Auto-clasificación por píxeles dentro de cada celda recalcada (`classifyPartitionedZonesFromPhoto`):
 *      muestrea el color real, contraste marco-centro (vidrio), fondo exterior (hueco piernas) y
 *      acabado bicolor únicamente dentro de los márgenes exactos trazados por el usuario.
 */
import type {
  DiagonalSegment,
  FrontModuleKind,
  FrontZone,
  MelamineMaterial,
  NormalizedSegment,
  Point2D,
} from '../../types/contracts';
import { applyHomography, exteriorToInterior } from '../mathEngine';

export type UserStrokeMode = 'auto' | 'ortho' | 'diagonal';

export type TracedStrokeResult =
  | {
      kind: 'vDivider';
      segment: NormalizedSegment;
      unitVec: [number, number];
      positionMm: number;
      spanMm: number;
      angleDeg: number;
    }
  | {
      kind: 'hShelf';
      segment: NormalizedSegment;
      unitVec: [number, number];
      positionMm: number;
      spanMm: number;
      angleDeg: number;
    }
  | {
      kind: 'diagonal';
      segment: DiagonalSegment;
      unitVec: [number, number];
      positionMm: number;
      spanMm: number;
      angleDeg: number;
    };

export interface PartitionRectCell {
  id: string;
  uStart: number;
  uEnd: number;
  vStart: number;
  vEnd: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function snapToAnchors(val: number, anchors: readonly number[], tol = 0.055): number {
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
 * Imán de bordes (Sobel local): ajusta un punto tocado por el usuario al borde de mayor
 * contraste más cercano dentro de `radiusPx` (ideal para trazos en pantalla táctil o mouse).
 */
export function snapPointToStrongEdge(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  pt: Point2D,
  radiusPx = 8,
  minGradient = 34,
): { snapped: Point2D; didSnap: boolean; gradient: number } {
  if (imgW < 8 || imgH < 8 || rgba.length < imgW * imgH * 4) {
    return { snapped: pt, didSnap: false, gradient: 0 };
  }

  const cx = clamp(Math.round(pt.x), 1, imgW - 2);
  const cy = clamp(Math.round(pt.y), 1, imgH - 2);
  const r = Math.max(2, Math.min(18, Math.round(radiusPx)));

  const lumAt = (x: number, y: number): number => {
    const i = (y * imgW + x) * 4;
    if (rgba[i + 3] < 128) return 255;
    return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  };

  let bestX = cx;
  let bestY = cy;
  let bestScore = -1;
  let bestGrad = 0;

  const y0 = Math.max(1, cy - r);
  const y1 = Math.min(imgH - 2, cy + r);
  const x0 = Math.max(1, cx - r);
  const x1 = Math.min(imgW - 2, cx + r);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > r) continue;
      const gx =
        -lumAt(x - 1, y - 1) +
        lumAt(x + 1, y - 1) -
        2 * lumAt(x - 1, y) +
        2 * lumAt(x + 1, y) -
        lumAt(x - 1, y + 1) +
        lumAt(x + 1, y + 1);
      const gy =
        -lumAt(x - 1, y - 1) -
        2 * lumAt(x, y - 1) -
        lumAt(x + 1, y - 1) +
        lumAt(x - 1, y + 1) +
        2 * lumAt(x, y + 1) +
        lumAt(x + 1, y + 1);
      const grad = Math.hypot(gx, gy);
      if (grad < minGradient) continue;
      // Priorizar borde fuerte cercano al dedo/puntero
      const score = grad / (1 + dist * 0.14);
      if (score > bestScore) {
        bestScore = score;
        bestGrad = grad;
        bestX = x;
        bestY = y;
      }
    }
  }

  if (bestScore > 0) {
    return {
      snapped: { x: bestX, y: bestY },
      didSnap: true,
      gradient: Number(bestGrad.toFixed(1)),
    };
  }
  return { snapped: pt, didSnap: false, gradient: 0 };
}

/**
 * Convierte un trazo libre `p1 -> p2` del usuario sobre la foto en un vector estructural
 * exacto (`vDivider`, `hShelf` o `diagonal`) en el espacio interior normalizado `[0, 1]^2`:
 *  - Modo `'auto'` (default): si el ángulo está dentro de ±18° de H/V endereza a repisa/divisor
 *    (siguiendo la perspectiva del contorno 4 pts); si está entre 18° y 72° conserva una
 *    **división diagonal real** con su ángulo y longitud física exacta en mm.
 *  - Modo `'diagonal'`: conserva SIEMPRE la línea libre/diagonal exacta sin forzar a recta.
 *  - Modo `'ortho'`: endereza siempre a horizontal o vertical con snap a muros y T-junctions.
 */
export function vectorizeUserStroke(
  p1: Point2D,
  p2: Point2D,
  toUnitHomography: number[][],
  existingVDividers: readonly NormalizedSegment[],
  existingHShelves: readonly NormalizedSegment[],
  boardThicknessMm: number,
  dimsMm: { x: number; y: number },
  autoExtend = true,
  strokeMode: UserStrokeMode = 'auto',
): TracedStrokeResult | null {
  const uA = applyHomography(toUnitHomography, p1);
  const uB = applyHomography(toUnitHomography, p2);
  if (!uA || !uB) return null;

  const x1 = exteriorToInterior(uA.x, boardThicknessMm, dimsMm.x);
  const y1 = exteriorToInterior(uA.y, boardThicknessMm, dimsMm.y);
  const x2 = exteriorToInterior(uB.x, boardThicknessMm, dimsMm.x);
  const y2 = exteriorToInterior(uB.y, boardThicknessMm, dimsMm.y);

  const du = x2 - x1;
  const dv = y2 - y1;
  const distNorm = Math.hypot(du, dv);
  if (distNorm < 0.03) return null;

  const xInt = Math.max(1, dimsMm.x - 2 * boardThicknessMm);
  const yInt = Math.max(1, dimsMm.y - 2 * boardThicknessMm);

  // Comparar en escala física real (mm) para ángulo verdadero del mueble
  const dxMmSigned = du * xInt;
  const dyMmSigned = dv * yInt;
  const dxMm = Math.abs(dxMmSigned);
  const dyMm = Math.abs(dyMmSigned);
  const absAngleFromHorizDeg = (Math.atan2(dyMm, dxMm) * 180) / Math.PI; // 0° = horiz, 90° = vert

  const shouldBeDiagonal =
    strokeMode === 'diagonal' ||
    (strokeMode === 'auto' && absAngleFromHorizDeg > 24 && absAngleFromHorizDeg < 66);

  if (shouldBeDiagonal) {
    const allUAnchors = [0, ...existingVDividers.map((d) => d.position), 1];
    const allVAnchors = [0, ...existingHShelves.map((s) => s.position), 1];
    const su1 = clamp(snapToAnchors(clamp(x1, 0, 1), allUAnchors, 0.045), 0, 1);
    const sv1 = clamp(snapToAnchors(clamp(y1, 0, 1), allVAnchors, 0.045), 0, 1);
    const su2 = clamp(snapToAnchors(clamp(x2, 0, 1), allUAnchors, 0.045), 0, 1);
    const sv2 = clamp(snapToAnchors(clamp(y2, 0, 1), allVAnchors, 0.045), 0, 1);

    const fdx = (su2 - su1) * xInt;
    const fdy = (sv2 - sv1) * yInt;
    const lenMm = Math.hypot(fdx, fdy);
    if (lenMm < Math.max(30, boardThicknessMm * 1.5)) return null;

    const angleDeg = Math.round((Math.atan2(fdy, fdx) * 180) / Math.PI);
    return {
      kind: 'diagonal',
      segment: {
        id: `usr_diag_${Date.now()}_${Math.round(lenMm)}`,
        u1: Number(su1.toFixed(4)),
        v1: Number(sv1.toFixed(4)),
        u2: Number(su2.toFixed(4)),
        v2: Number(sv2.toFixed(4)),
      },
      unitVec: [Number((fdx / lenMm).toFixed(4)), Number((fdy / lenMm).toFixed(4))],
      positionMm: Math.round(boardThicknessMm + ((su1 + su2) / 2) * xInt),
      spanMm: Math.round(lenMm),
      angleDeg,
    };
  }

  const isHorizontal = dxMm >= dyMm;

  if (isHorizontal) {
    const vPos = clamp((y1 + y2) / 2, 0.04, 0.96);
    // Anclas verticales (muros 0, 1 + divisores que crucen esta altura vPos)
    const activeVAnchors = [
      0,
      ...existingVDividers
        .filter((d) => vPos >= d.start - 0.04 && vPos <= d.end + 0.04)
        .map((d) => d.position),
      1,
    ].sort((a, b) => a - b);

    let uStart = clamp(Math.min(x1, x2), 0, 1);
    let uEnd = clamp(Math.max(x1, x2), 0, 1);

    uStart = snapToAnchors(uStart, activeVAnchors, 0.065);
    uEnd = snapToAnchors(uEnd, activeVAnchors, 0.065);

    if (autoExtend) {
      // Encajar extremos al muro/divisor envolvente si el trazo quedó casi llegando o fue corto dentro del vano
      const leftWall = [...activeVAnchors].reverse().find((a) => a <= uStart + 0.02) ?? 0;
      const rightWall = activeVAnchors.find((a) => a >= uEnd - 0.02) ?? 1;
      if (uStart - leftWall <= 0.14 || uEnd - uStart < 0.16) uStart = leftWall;
      if (rightWall - uEnd <= 0.14 || uEnd - uStart < 0.16) uEnd = rightWall;
    }

    if (uEnd - uStart < 0.05) return null;

    return {
      kind: 'hShelf',
      segment: {
        id: `usr_rep_${Date.now()}_${Math.round(vPos * 1000)}`,
        position: Number(vPos.toFixed(4)),
        start: Number(uStart.toFixed(4)),
        end: Number(uEnd.toFixed(4)),
      },
      unitVec: [1, 0],
      positionMm: Math.round(boardThicknessMm + vPos * yInt),
      spanMm: Math.round((uEnd - uStart) * xInt),
      angleDeg: 0,
    };
  }

  // Vector Vertical -> Divisor
  const uPos = clamp((x1 + x2) / 2, 0.04, 0.96);
  const activeHAnchors = [
    0,
    ...existingHShelves
      .filter((s) => uPos >= s.start - 0.04 && uPos <= s.end + 0.04)
      .map((s) => s.position),
    1,
  ].sort((a, b) => a - b);

  let vStart = clamp(Math.min(y1, y2), 0, 1);
  let vEnd = clamp(Math.max(y1, y2), 0, 1);

  vStart = snapToAnchors(vStart, activeHAnchors, 0.065);
  vEnd = snapToAnchors(vEnd, activeHAnchors, 0.065);

  if (autoExtend) {
    const botWall = [...activeHAnchors].reverse().find((a) => a <= vStart + 0.02) ?? 0;
    const topWall = activeHAnchors.find((a) => a >= vEnd - 0.02) ?? 1;
    if (vStart - botWall <= 0.14 || vEnd - vStart < 0.16) vStart = botWall;
    if (topWall - vEnd <= 0.14 || vEnd - vStart < 0.16) vEnd = topWall;
  }

  if (vEnd - vStart < 0.05) return null;

  return {
    kind: 'vDivider',
    segment: {
      id: `usr_div_${Date.now()}_${Math.round(uPos * 1000)}`,
      position: Number(uPos.toFixed(4)),
      start: Number(vStart.toFixed(4)),
      end: Number(vEnd.toFixed(4)),
    },
    unitVec: [0, 1],
    positionMm: Math.round(boardThicknessMm + uPos * xInt),
    spanMm: Math.round((vEnd - vStart) * yInt),
    angleDeg: 90,
  };
}

/**
 * Partición planar rectangular exacta de `[0, 1]^2` a partir de divisores verticales y repisas
 * horizontales (totales o parciales). Genera celdas estrictamente rectangulares, disjuntas
 * (cero solapamiento) cuya suma de áreas es exactamente 1.0 incluso en vacíos en forma de L.
 */
export function partitionCellsFromVectors(
  vDividers: readonly NormalizedSegment[],
  hShelves: readonly NormalizedSegment[],
): PartitionRectCell[] {
  const dedupeSorted = (vals: number[], eps = 0.015): number[] => {
    const sorted = [...vals].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) {
      if (out.length === 0 || v - out[out.length - 1] > eps) {
        out.push(v);
      }
    }
    if (out[0] > 0.001) out.unshift(0);
    else out[0] = 0;
    if (out[out.length - 1] < 0.999) out.push(1);
    else out[out.length - 1] = 1;
    return out;
  };

  const us = dedupeSorted([0, 1, ...vDividers.map((d) => clamp(d.position, 0.01, 0.99))]);
  const vs = dedupeSorted([0, 1, ...hShelves.map((s) => clamp(s.position, 0.01, 0.99))]);

  const cols = us.length - 1;
  const rows = vs.length - 1;
  if (cols <= 0 || rows <= 0) {
    return [{ id: 'traced_zone_1', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1 }];
  }

  const tol = 0.025;
  // Verificar si existe una pared vertical bloqueando entre columna (colBorderIdx - 1) y (colBorderIdx) en fila (r)
  const hasVertWall = (colBorderIdx: number, r: number): boolean => {
    const uWall = us[colBorderIdx];
    const vMid = (vs[r] + vs[r + 1]) / 2;
    return vDividers.some(
      (d) => Math.abs(d.position - uWall) <= tol && vMid >= d.start - tol && vMid <= d.end + tol,
    );
  };

  // Verificar si existe una repisa horizontal bloqueando entre fila (rowBorderIdx - 1) y (rowBorderIdx) en columna (c)
  const hasHorizWall = (rowBorderIdx: number, c: number): boolean => {
    const vWall = vs[rowBorderIdx];
    const uMid = (us[c] + us[c + 1]) / 2;
    return hShelves.some(
      (s) => Math.abs(s.position - vWall) <= tol && uMid >= s.start - tol && uMid <= s.end + tol,
    );
  };

  const used = new Uint8Array(rows * cols);
  const cells: PartitionRectCell[] = [];

  const expandHorizontalFirst = (r0: number, c0: number) => {
    let cStart = c0;
    let cEnd = c0;
    while (cEnd + 1 < cols && !used[r0 * cols + (cEnd + 1)] && !hasVertWall(cEnd + 1, r0)) cEnd++;
    while (cStart - 1 >= 0 && !used[r0 * cols + (cStart - 1)] && !hasVertWall(cStart, r0)) cStart--;

    let rStart = r0;
    let rEnd = r0;
    while (rEnd + 1 < rows) {
      let ok = true;
      for (let cc = cStart; cc <= cEnd; cc++) {
        if (used[(rEnd + 1) * cols + cc] || hasHorizWall(rEnd + 1, cc)) {
          ok = false;
          break;
        }
        if (cc < cEnd && hasVertWall(cc + 1, rEnd + 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      rEnd++;
    }
    while (rStart - 1 >= 0) {
      let ok = true;
      for (let cc = cStart; cc <= cEnd; cc++) {
        if (used[(rStart - 1) * cols + cc] || hasHorizWall(rStart, cc)) {
          ok = false;
          break;
        }
        if (cc < cEnd && hasVertWall(cc + 1, rStart - 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      rStart--;
    }
    const area = (us[cEnd + 1] - us[cStart]) * (vs[rEnd + 1] - vs[rStart]);
    return { rStart, rEnd, cStart, cEnd, area };
  };

  const expandVerticalFirst = (r0: number, c0: number) => {
    let rStart = r0;
    let rEnd = r0;
    while (rEnd + 1 < rows && !used[(rEnd + 1) * cols + c0] && !hasHorizWall(rEnd + 1, c0)) rEnd++;
    while (rStart - 1 >= 0 && !used[(rStart - 1) * cols + c0] && !hasHorizWall(rStart, c0)) rStart--;

    let cStart = c0;
    let cEnd = c0;
    while (cEnd + 1 < cols) {
      let ok = true;
      for (let rr = rStart; rr <= rEnd; rr++) {
        if (used[rr * cols + (cEnd + 1)] || hasVertWall(cEnd + 1, rr)) {
          ok = false;
          break;
        }
        if (rr < rEnd && hasHorizWall(rr + 1, cEnd + 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      cEnd++;
    }
    while (cStart - 1 >= 0) {
      let ok = true;
      for (let rr = rStart; rr <= rEnd; rr++) {
        if (used[rr * cols + (cStart - 1)] || hasVertWall(cStart, rr)) {
          ok = false;
          break;
        }
        if (rr < rEnd && hasHorizWall(rr + 1, cStart - 1)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
      cStart--;
    }
    const area = (us[cEnd + 1] - us[cStart]) * (vs[rEnd + 1] - vs[rStart]);
    return { rStart, rEnd, cStart, cEnd, area };
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (used[r * cols + c]) continue;
      const candH = expandHorizontalFirst(r, c);
      const candV = expandVerticalFirst(r, c);
      const best = candV.area > candH.area ? candV : candH;

      for (let rr = best.rStart; rr <= best.rEnd; rr++) {
        for (let cc = best.cStart; cc <= best.cEnd; cc++) {
          used[rr * cols + cc] = 1;
        }
      }

      cells.push({
        id: `cell_${cells.length + 1}`,
        uStart: Number(us[best.cStart].toFixed(4)),
        uEnd: Number(us[best.cEnd + 1].toFixed(4)),
        vStart: Number(vs[best.rStart].toFixed(4)),
        vEnd: Number(vs[best.rEnd + 1].toFixed(4)),
      });
    }
  }

  // Ordenar de izquierda a derecha y de arriba a abajo para lectura natural del cliente
  cells.sort((a, b) => a.uStart - b.uStart || b.vEnd - a.vEnd);
  return cells.map((cell, idx) => ({ ...cell, id: `traced_zone_${idx + 1}` }));
}

function inferMelamineSimple(r: number, g: number, b: number): MelamineMaterial {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const warmth = r - b;
  if (lum >= 175 && Math.abs(r - b) < 28) return 'blanco';
  if (warmth >= 16 && r > g + 3 && lum >= 48) return 'roble';
  if (lum <= 105) return 'grafito';
  return lum >= 162 ? 'blanco' : 'roble';
}

const MAT_REF: Record<MelamineMaterial, [number, number, number]> = {
  blanco: [238, 240, 244],
  roble: [198, 154, 106],
  grafito: [62, 74, 92],
};

/**
 * Clasifica automáticamente cada celda resultante de las líneas recalcadas por el usuario
 * muestreando los píxeles reales de la foto rectificada dentro de cada recuadro exacto.
 * Conserva selecciones manuales previas del usuario si la celda sigue en la misma posición.
 */
export function classifyPartitionedZonesFromPhoto(
  cells: readonly PartitionRectCell[],
  rectRgba: Uint8ClampedArray | null,
  rectW: number,
  rectH: number,
  dimsMm: { x: number; y: number },
  carcassMaterial: MelamineMaterial,
  exteriorBgRgb: [number, number, number] = [245, 245, 245],
  previousZones: readonly FrontZone[] = [],
): FrontZone[] {
  const refRgb = MAT_REF[carcassMaterial];
  const refLum = 0.299 * refRgb[0] + 0.587 * refRgb[1] + 0.114 * refRgb[2];

  return cells.map((cell, idx) => {
    // Si el usuario ya había configurado esta celda casi idéntica, preservar su elección
    const prevMatch = previousZones.find(
      (pz) =>
        Math.abs(pz.uStart - cell.uStart) <= 0.04 &&
        Math.abs(pz.uEnd - cell.uEnd) <= 0.04 &&
        Math.abs(pz.vStart - cell.vStart) <= 0.04 &&
        Math.abs(pz.vEnd - cell.vEnd) <= 0.04,
    );
    if (prevMatch) {
      return {
        ...prevMatch,
        id: cell.id,
        uStart: cell.uStart,
        uEnd: cell.uEnd,
        vStart: cell.vStart,
        vEnd: cell.vEnd,
      };
    }

    if (!rectRgba || rectW < 20 || rectH < 20) {
      return {
        id: cell.id,
        uStart: cell.uStart,
        uEnd: cell.uEnd,
        vStart: cell.vStart,
        vEnd: cell.vEnd,
        kind: 'open',
        label: `Zona ${idx + 1}`,
      };
    }

    const x0 = clamp(Math.round((cell.uStart + (cell.uEnd - cell.uStart) * 0.12) * rectW), 0, rectW - 1);
    const x1 = clamp(Math.round((cell.uEnd - (cell.uEnd - cell.uStart) * 0.12) * rectW), 0, rectW - 1);
    const y0 = clamp(Math.round((1 - cell.vEnd + (cell.vEnd - cell.vStart) * 0.12) * rectH), 0, rectH - 1);
    const y1 = clamp(Math.round((1 - cell.vStart - (cell.vEnd - cell.vStart) * 0.12) * rectH), 0, rectH - 1);

    let sumR = 0, sumG = 0, sumB = 0, sumL = 0, sumL2 = 0, bgHits = 0, cnt = 0;
    let fSum = 0, fCnt = 0, cSum = 0, cCnt = 0;
    const fx0 = x0 + Math.round((x1 - x0) * 0.16);
    const fx1 = x1 - Math.round((x1 - x0) * 0.16);
    const fy0 = y0 + Math.round((y1 - y0) * 0.16);
    const fy1 = y1 - Math.round((y1 - y0) * 0.16);

    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        const p = (y * rectW + x) * 4;
        if (rectRgba[p + 3] < 128) {
          bgHits++;
          cnt++;
          continue;
        }
        const r = rectRgba[p], g = rectRgba[p + 1], b = rectRgba[p + 2];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
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
    const fMean = fCnt > 0 ? fSum / fCnt : meanL;
    const cMean = cCnt > 0 ? cSum / cCnt : meanL;

    const cellWmm = (cell.uEnd - cell.uStart) * dimsMm.x;
    const cellHmm = (cell.vEnd - cell.vStart) * dimsMm.y;
    const cellMat = inferMelamineSimple(meanR, meanG, meanB);
    const distCarcass = Math.hypot(meanR - refRgb[0], meanG - refRgb[1], meanB - refRgb[2]);
    // Madera genuina (evitar falsos positivos en nichos con sombra marrón-grisácea heterogénea)
    const isWarmWood =
      meanR - meanB >= 18 &&
      meanR > meanG + 3 &&
      meanL >= 55 &&
      (stdL <= 30 || meanR - meanB >= 30);
    const matOverride =
      (distCarcass > 38 || (isWarmWood && carcassMaterial !== 'roble')) && cellMat !== carcassMaterial
        ? cellMat
        : undefined;

    let kind: FrontModuleKind;
    if (cell.vStart <= 0.05 && bgRatio >= 0.48 && (cell.uEnd - cell.uStart < 0.94 || cell.vEnd - cell.vStart < 0.92)) {
      kind = 'leg_void';
    } else if (
      // Vano pasante / mesón abierto mostrando pared de fondo (sin tocar el piso)
      (cell.vStart > 0.05 && bgRatio >= 0.65) ||
      // Cavidad oscura interior o nicho sombreado en mueble claro (p. ej. estante abierto con objetos)
      (cMean < 56 && !isWarmWood) ||
      (refLum >= 200 && meanL < refLum - 65 && stdL > 22) ||
      (meanL < refLum - 26 && distCarcass > 32 && !isWarmWood) ||
      (stdL > 35 && bgRatio < 0.45)
    ) {
      kind = 'open';
    } else if (
      !isWarmWood &&
      Math.abs(meanR - meanB) < 22 &&
      cellHmm >= 360 &&
      cellHmm / Math.max(1, cellWmm) >= 1.1 &&
      fMean - cMean >= 13 &&
      stdL < 46
    ) {
      kind = 'door_glass';
    } else if (cellHmm <= 310 && cellWmm > cellHmm * 1.15) {
      kind = 'drawers';
    } else if (cellWmm >= 540 && cellWmm / Math.max(1, cellHmm) >= 0.85) {
      kind = 'door_double';
    } else {
      kind = cell.uStart < 0.48 ? 'door_left' : 'door_right';
    }

    return {
      id: cell.id,
      uStart: cell.uStart,
      uEnd: cell.uEnd,
      vStart: cell.vStart,
      vEnd: cell.vEnd,
      kind,
      drawerCount: kind === 'drawers' ? 1 : undefined,
      label:
        kind === 'leg_void'
          ? 'Hueco Piernas'
          : kind === 'door_glass'
            ? 'Vidrio'
            : kind === 'open'
              ? `Vano ${idx + 1}`
              : kind === 'drawers'
                ? 'Cajón'
                : kind === 'door_double'
                  ? '2 Puertas'
                  : 'Puerta',
      materialOverride: kind === 'open' || kind === 'leg_void' ? undefined : matOverride,
    };
  });
}
