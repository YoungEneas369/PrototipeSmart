/**
 * SMARTFURNITURE — FUSIÓN TRI-VISTA (FRENTE + ARRIBA + LADO) Y NORMALIZACIÓN DE MEDIDAS RAZONABLES (v8.0)
 * 100% TypeScript puro, sin dependencias externas ni DOM.
 *
 * 1. `synthesize3DFromTriViews`: Reconcilia proporciones y cortes desde 1, 2 o las 3 vistas
 *    (`Frontal XY`, `Superior XZ`, `Lateral ZY`), generando o actualizando mueble recto, en L o curvo.
 * 2. `makeDrawingMeasurementsReasonable`: Ajusta con un clic las cotas tras dibujar a mano alzada:
 *    - Redondea medidas generales a múltiplos limpios de taller (10 mm) e iguala alturas/profundidades
 *      equivalentes entre alas en L y entre vistas equivalentes.
 *    - Alinea repisas y divisores colineales y ecualiza vanos casi simétricos (1/2, 1/3, 1/4, …)
 *      para que los lados correspondientes midan exactamente lo mismo.
 *    - Ajusta esquinas curvas a radios limpios y recalcula sus invariantes diferenciales (∫ds, κ, R_min).
 */
import type {
  CurvedCutSpec,
  DiagonalSegment,
  FrontZone,
  FurnitureTopology,
  LShapeSide,
  NormalizedSegment,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { buildDefaultLShapeConfig, evaluateBezierDifferential } from '../mathEngine';
import { clamp } from './imageOps';
import type { SketchLShapeInference, SketchRecognitionResult } from './sketchRecognizer';
import { partitionCellsFromVectors } from './userVectorTrace';

export interface TriViewCaptureInput {
  front?: Partial<SketchRecognitionResult> | null;
  top?: (Partial<SketchRecognitionResult> & { planeLinesXZ?: readonly DiagonalSegment[] }) | null;
  side?: (Partial<SketchRecognitionResult> & { planeLinesZY?: readonly DiagonalSegment[] }) | null;
}

export interface ReasonableResult {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  changesSummary: string[];
}

function roundStep(val: number, step: number): number {
  return Math.round(val / step) * step;
}

/**
 * Infiere silueta en L (Derecha / Izquierda, profundidad de ala principal y profundidad de retorno)
 * a partir de líneas vectoriales trazadas en Planta Superior (`Arriba XZ`).
 */
export function inferLShapeFromPlaneLinesXZ(
  lines: readonly DiagonalSegment[],
  aspectRatioXZ?: number,
): SketchLShapeInference | undefined {
  if (lines.length < 2) return undefined;

  interface NormSeg {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
    uMid: number;
    vMid: number;
    du: number;
    dv: number;
  }

  const hSegs: NormSeg[] = [];
  const vSegs: NormSeg[] = [];

  for (const ln of lines) {
    const u1 = clamp(ln.u1, 0, 1);
    const v1 = clamp(ln.v1, 0, 1);
    const u2 = clamp(ln.u2, 0, 1);
    const v2 = clamp(ln.v2, 0, 1);
    const du = Math.abs(u2 - u1);
    const dv = Math.abs(v2 - v1);
    const seg: NormSeg = {
      uMin: Math.min(u1, u2),
      uMax: Math.max(u1, u2),
      vMin: Math.min(v1, v2),
      vMax: Math.max(v1, v2),
      uMid: (u1 + u2) / 2,
      vMid: (v1 + v2) / 2,
      du,
      dv,
    };
    if (dv <= 0.06 && du >= 0.16) {
      hSegs.push(seg);
    } else if (du <= 0.06 && dv >= 0.16) {
      vSegs.push(seg);
    }
  }

  if (hSegs.length === 0 || vSegs.length === 0) return undefined;

  const cornerTol = 0.12;
  let bestCandidate:
    | {
        side: LShapeSide;
        mainDepthFrac: number;
        returnDepthFrac: number;
        returnLengthFrac: number;
        score: number;
      }
    | undefined;

  for (const h of hSegs) {
    if (h.vMid < 0.18 || h.vMid > 0.85) continue;

    for (const v of vSegs) {
      if (v.uMid < 0.12 || v.uMid > 0.88) continue;
      if (v.vMin > 0.22 || v.vMax < 0.18 || v.vMax > 0.9) continue;
      if (Math.abs(v.vMax - h.vMid) > cornerTol) continue;

      // L Derecha: ala principal arriba [vMid..1], retorno baja por derecha [uMid..1]
      const matchesRight =
        h.uMin <= 0.16 &&
        h.uMax >= v.uMid - cornerTol &&
        v.uMid >= 0.22 &&
        v.uMid <= 0.88;
      if (matchesRight) {
        const leftWallBlocksVoid = vSegs.some(
          (ov) => ov.uMid <= 0.12 && ov.vMin < h.vMid - 0.1,
        );
        const botWallBlocksVoid = hSegs.some(
          (oh) => oh.vMid <= 0.12 && oh.uMin < v.uMid - 0.12,
        );
        if (!leftWallBlocksVoid && !botWallBlocksVoid) {
          const retLenFrac = v.vMin <= 0.08 ? 1 : clamp(1 - v.vMin, 0.45, 1);
          const score =
            h.du +
            v.dv -
            Math.abs(v.vMax - h.vMid) -
            (h.uMax <= v.uMid + cornerTol ? 0 : 0.15);
          if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = {
              side: 'right',
              mainDepthFrac: clamp(1 - h.vMid, 0.2, 0.78),
              returnDepthFrac: clamp(1 - v.uMid, 0.2, 0.72),
              returnLengthFrac: retLenFrac,
              score,
            };
          }
        }
      }

      // L Izquierda: ala principal arriba [vMid..1], retorno baja por izquierda [0..uMid]
      const matchesLeft =
        h.uMax >= 0.84 &&
        h.uMin <= v.uMid + cornerTol &&
        v.uMid >= 0.12 &&
        v.uMid <= 0.78;
      if (matchesLeft) {
        const rightWallBlocksVoid = vSegs.some(
          (ov) => ov.uMid >= 0.88 && ov.vMin < h.vMid - 0.1,
        );
        const botWallBlocksVoid = hSegs.some(
          (oh) => oh.vMid <= 0.12 && oh.uMax > v.uMid + 0.12,
        );
        if (!rightWallBlocksVoid && !botWallBlocksVoid) {
          const retLenFrac = v.vMin <= 0.08 ? 1 : clamp(1 - v.vMin, 0.45, 1);
          const score =
            h.du +
            v.dv -
            Math.abs(v.vMax - h.vMid) -
            (h.uMin >= v.uMid - cornerTol ? 0 : 0.15);
          if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = {
              side: 'left',
              mainDepthFrac: clamp(1 - h.vMid, 0.2, 0.78),
              returnDepthFrac: clamp(v.uMid, 0.2, 0.72),
              returnLengthFrac: retLenFrac,
              score,
            };
          }
        }
      }
    }
  }

  if (!bestCandidate) return undefined;
  void aspectRatioXZ;

  return {
    side: bestCandidate.side,
    mainDepthFrac: Number(bestCandidate.mainDepthFrac.toFixed(3)),
    returnLengthFrac: Number(bestCandidate.returnLengthFrac.toFixed(3)),
    returnDepthFrac: Number(bestCandidate.returnDepthFrac.toFixed(3)),
    curvedCorner: false,
    filletRadiusFrac: 0,
  };
}

function detectClosedRectFrac(
  lines: readonly DiagonalSegment[] | undefined,
): { du: number; dv: number } | null {
  if (!lines || lines.length < 3) return null;

  let hCount = 0;
  let vCount = 0;
  let uMin = 1;
  let uMax = 0;
  let vMin = 1;
  let vMax = 0;

  for (const ln of lines) {
    const u1 = clamp(ln.u1, 0, 1);
    const v1 = clamp(ln.v1, 0, 1);
    const u2 = clamp(ln.u2, 0, 1);
    const v2 = clamp(ln.v2, 0, 1);
    const du = Math.abs(u2 - u1);
    const dv = Math.abs(v2 - v1);
    // Cualquier línea oblicua indica chaflán/corte inclinado, no rectángulo cerrado
    if (du > 0.08 && dv > 0.08) return null;
    if (du >= 0.15 && dv <= 0.05) hCount++;
    else if (dv >= 0.15 && du <= 0.05) vCount++;
    uMin = Math.min(uMin, u1, u2);
    uMax = Math.max(uMax, u1, u2);
    vMin = Math.min(vMin, v1, v2);
    vMax = Math.max(vMax, v1, v2);
  }

  if (hCount === 0 || vCount === 0) return null;
  const rectDu = uMax - uMin;
  const rectDv = vMax - vMin;
  if (rectDu < 0.15 || rectDv < 0.15) return null;

  const isClosedBox =
    (hCount >= 2 && vCount >= 2) ||
    (hCount >= 1 && vCount >= 2 && rectDu >= 0.85) ||
    (vCount >= 1 && hCount >= 2 && rectDv >= 0.85);
  return isClosedBox ? { du: rectDu, dv: rectDv } : null;
}

/**
 * Reconcilia medidas, silueta en L y cortes desde las vistas disponibles (`Frente`, `Arriba`, `Lado`).
 */
export function synthesize3DFromTriViews(
  baseTopology: FurnitureTopology,
  baseParams: ScaleAndBoardParams,
  views: TriViewCaptureInput,
): { topology: FurnitureTopology; params: ScaleAndBoardParams; notes: string[] } {
  const notes: string[] = [];
  const nextX = baseParams.targetDimensions.x;
  let nextY = baseParams.targetDimensions.y;
  let nextZ = baseParams.targetDimensions.z;
  let viewsUsed = 0;

  if (views.front) {
    viewsUsed++;
    const arXY = clamp(views.front.aspectRatio ?? nextX / Math.max(1, nextY), 0.25, 4);
    nextY = clamp(Math.round(nextX / arXY), 300, 2600);
    notes.push(`Frente XY aplicado (W/H=${arXY.toFixed(2)})`);
  }

  const topLinesForInfer = views.top?.planeLinesXZ ?? baseTopology.planeLinesXZ;
  const inferredL = views.top
    ? (views.top.lShapeInference ??
      (topLinesForInfer && topLinesForInfer.length >= 2
        ? inferLShapeFromPlaneLinesXZ(topLinesForInfer, views.top.aspectRatio)
        : undefined))
    : undefined;

  let zFromTop: number | null = null;
  let totalL2FromTop = nextZ;
  if (views.top) {
    viewsUsed++;
    const arXZ = clamp(views.top.aspectRatio ?? nextX / Math.max(1, nextZ), 0.3, 5);
    const totalBoxHeightMm = nextX / arXZ;
    totalL2FromTop = totalBoxHeightMm;

    if (inferredL) {
      if (inferredL.mainDepthFrac !== undefined && inferredL.mainDepthFrac > 0) {
        zFromTop = clamp(Math.round(totalBoxHeightMm * inferredL.mainDepthFrac), 180, 900);
      }
    } else {
      let rawZTop = clamp(Math.round(totalBoxHeightMm), 180, 900);
      const closedXZ = detectClosedRectFrac(views.top.planeLinesXZ);
      if (closedXZ && closedXZ.dv < 0.88) {
        rawZTop = clamp(Math.round(rawZTop * closedXZ.dv), 180, 900);
      }
      zFromTop = rawZTop;
    }
  }

  let zFromSide: number | null = null;
  if (views.side) {
    viewsUsed++;
    const arZY = clamp(views.side.aspectRatio ?? nextZ / Math.max(1, nextY), 0.15, 2.5);
    let rawZSide = clamp(Math.round(nextY * arZY), 180, 900);
    const closedZY = detectClosedRectFrac(views.side.planeLinesZY);
    if (closedZY && closedZY.du < 0.88) {
      rawZSide = clamp(Math.round(rawZSide * closedZY.du), 180, 900);
    }
    zFromSide = rawZSide;
  }

  if (zFromTop !== null && zFromSide !== null) {
    nextZ = clamp(Math.round((zFromTop + zFromSide) / 2), 180, 900);
    notes.push(`Profundidad Z promediada entre Arriba (${zFromTop} mm) y Lado (${zFromSide} mm)`);
  } else if (zFromTop !== null) {
    nextZ = zFromTop;
    notes.push(`Profundidad Z estimada desde vista Arriba (${nextZ} mm)`);
  } else if (zFromSide !== null) {
    nextZ = zFromSide;
    notes.push(`Profundidad Z estimada desde vista Lado (${nextZ} mm)`);
  }

  const nextParams: ScaleAndBoardParams = {
    ...baseParams,
    targetDimensions: { x: nextX, y: nextY, z: nextZ },
  };

  let nextTop: FurnitureTopology = {
    ...baseTopology,
    viewsMode: Math.min(3, Math.max(1, viewsUsed)) as 1 | 2 | 3,
    aspectRatioXY: nextY > 0 ? nextX / nextY : baseTopology.aspectRatioXY,
    ...(zFromSide !== null && nextY > 0 ? { aspectRatioZY: nextZ / nextY } : {}),
  };

  if (views.front) {
    const vDivs = views.front.vDividers ?? nextTop.vDividers;
    const hShs = views.front.hShelves ?? nextTop.hShelves;
    const diags = views.front.diagonalDividers ?? nextTop.diagonalDividers;
    const incomingZones = views.front.frontZones;
    const baseHasCustomZones = (baseTopology.frontZones ?? []).some(
      (z) =>
        z.kind !== 'open' ||
        z.materialOverride !== undefined ||
        (z.internalShelves ?? 0) > 0,
    );
    const incomingAllOpen =
      incomingZones !== undefined && incomingZones.every((z) => z.kind === 'open');
    const zones =
      incomingZones && incomingZones.length > 0
        ? baseHasCustomZones && incomingAllOpen
          ? preserveZoneKindsByCentroid(incomingZones, baseTopology.frontZones)
          : incomingZones
        : nextTop.frontZones;

    nextTop = {
      ...nextTop,
      vDividers: vDivs.map((d) => ({ ...d })),
      hShelves: hShs.map((s) => ({ ...s })),
      diagonalDividers: diags ? diags.map((dg) => ({ ...dg })) : undefined,
      frontZones: zones ? zones.map((z) => ({ ...z })) : undefined,
      shelfMode: hShs.length > 0 ? 'custom' : nextTop.shelfMode,
    };
  }

  // Sincronizar planeLinesXZ y planeLinesZY preservando ediciones previas si no se sobrescriben
  const nextPlaneLinesXZ =
    views.top?.planeLinesXZ !== undefined
      ? views.top.planeLinesXZ.map((l) => ({ ...l }))
      : nextTop.planeLinesXZ?.map((l) => ({ ...l }));
  const nextPlaneLinesZY =
    views.side?.planeLinesZY !== undefined
      ? views.side.planeLinesZY.map((l) => ({ ...l }))
      : nextTop.planeLinesZY?.map((l) => ({ ...l }));

  nextTop = {
    ...nextTop,
    ...(nextPlaneLinesXZ && nextPlaneLinesXZ.length > 0
      ? { planeLinesXZ: nextPlaneLinesXZ }
      : { planeLinesXZ: undefined }),
    ...(nextPlaneLinesZY && nextPlaneLinesZY.length > 0
      ? { planeLinesZY: nextPlaneLinesZY }
      : { planeLinesZY: undefined }),
  };

  // Combinar curvas por plano sin perder las de las demás vistas
  const nonOverwrittenCurves = (nextTop.curvedCuts ?? []).filter(
    (c) =>
      !(views.front?.curvedCuts && views.front.curvedCuts.length > 0 && c.plane === 'xy') &&
      !(views.top?.curvedCuts && views.top.curvedCuts.length > 0 && c.plane === 'xz') &&
      !(views.side?.curvedCuts && views.side.curvedCuts.length > 0 && c.plane === 'zy'),
  );
  const addedCurves = [
    ...(views.front?.curvedCuts ?? []),
    ...(views.top?.curvedCuts ?? []),
    ...(views.side?.curvedCuts ?? []),
  ];
  if (addedCurves.length > 0) {
    nextTop = {
      ...nextTop,
      curvedCuts: [...nonOverwrittenCurves, ...addedCurves],
    };
  }

  if (inferredL) {
    const sameSideExisting =
      baseTopology.lShape && baseTopology.lShape.side === inferredL.side
        ? baseTopology.lShape
        : undefined;
    const defaultL = buildDefaultLShapeConfig(
      inferredL.side,
      sameSideExisting ? nextTop : { ...nextTop, lShape: undefined },
      nextParams,
    );
    const estRetDepth = clamp(roundStep(nextX * inferredL.returnDepthFrac, 10), 220, 750);
    const estRetLen = clamp(
      roundStep(Math.max(nextZ + 220, totalL2FromTop), 10),
      nextZ + 180,
      2400,
    );
    nextTop = {
      ...nextTop,
      lShape: {
        ...defaultL,
        ...(sameSideExisting
          ? {
              vDividers: sameSideExisting.vDividers.map((d) => ({ ...d })),
              hShelves: sameSideExisting.hShelves.map((s) => ({ ...s })),
              diagonalDividers: sameSideExisting.diagonalDividers?.map((dg) => ({ ...dg })),
              frontZones: sameSideExisting.frontZones?.map((z) => ({ ...z })),
              openCorner: sameSideExisting.openCorner,
              shelfMode: sameSideExisting.shelfMode,
              equalShelfCount: sameSideExisting.equalShelfCount,
              hasBackPanel: sameSideExisting.hasBackPanel,
              cubiertaMaterialOverride: sameSideExisting.cubiertaMaterialOverride,
              returnHeightMm: sameSideExisting.returnHeightMm,
            }
          : {}),
        enabled: true,
        side: inferredL.side,
        returnDepthMm: estRetDepth,
        returnLengthMm: estRetLen,
      },
    };
    notes.push(
      `Planta en L (${inferredL.side === 'right' ? 'Derecha' : 'Izquierda'}) detectada en vista Arriba`,
    );
  }

  return { topology: nextTop, params: nextParams, notes };
}

function rationalizeWingSegments(
  rawVDividers: readonly NormalizedSegment[],
  rawHShelves: readonly NormalizedSegment[],
  changes: string[],
  wingTag: string,
): { vDividers: NormalizedSegment[]; hShelves: NormalizedSegment[] } {
  const vDivs = rawVDividers.map((d) => ({ ...d }));
  const hShs = rawHShelves.map((s) => ({ ...s }));

  // 1. Clustering colineal de repisas y divisores cercanos (para que queden al mismo nivel)
  const clusterGroup = (segs: NormalizedSegment[], label: string) => {
    const sorted = [...segs].sort((a, b) => a.position - b.position);
    let i = 0;
    while (i < sorted.length) {
      const group = [sorted[i]];
      let j = i + 1;
      while (j < sorted.length && Math.abs(sorted[j].position - group[0].position) <= 0.042) {
        group.push(sorted[j]);
        j++;
      }
      if (group.length > 1) {
        const meanPos = group.reduce((acc, s) => acc + s.position, 0) / group.length;
        const cleanPos = Number(clamp(meanPos, 0.04, 0.96).toFixed(4));
        const hadDiff = group.some((s) => Math.abs(s.position - cleanPos) > 0.002);
        for (const s of group) s.position = cleanPos;
        if (hadDiff) changes.push(`${wingTag}: ${group.length} ${label} alineados entre sí`);
      }
      i = j;
    }
  };

  clusterGroup(vDivs, 'divisores');
  clusterGroup(hShs, 'repisas');

  // 2. Ecualización de vanos continuos (ej. 2 vanos -> 0.50, 3 vanos -> 1/3 y 2/3, 4 vanos -> 1/4, 2/4, 3/4)
  const equalizeSpanning = (segs: NormalizedSegment[], label: string) => {
    const spanning = segs
      .filter((s) => Math.min(s.start, s.end) <= 0.06 && Math.max(s.start, s.end) >= 0.94)
      .sort((a, b) => a.position - b.position);
    const n = spanning.length;
    if (n >= 1 && n <= 6) {
      const uniqueTargets = Array.from({ length: n }, (_, k) => (k + 1) / (n + 1));
      const allCloseToEqual = spanning.every(
        (s, k) => Math.abs(s.position - uniqueTargets[k]) <= 0.065,
      );
      if (allCloseToEqual) {
        let changed = false;
        spanning.forEach((s, k) => {
          const t = Number(uniqueTargets[k].toFixed(4));
          if (Math.abs(s.position - t) > 0.002) changed = true;
          s.position = t;
          s.start = 0;
          s.end = 1;
        });
        if (changed) {
          changes.push(`${wingTag}: ${n + 1} vanos de ${label} igualados simétricamente`);
          return;
        }
      }
    }

    // Si no son todos equidistantes, ajustar posiciones cercanas a fracciones limpias (1/4, 1/3, 1/2, 2/3, 3/4)
    const cleanFractions = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
    for (const s of segs) {
      for (const cf of cleanFractions) {
        if (Math.abs(s.position - cf) <= 0.032) {
          s.position = Number(cf.toFixed(4));
          break;
        }
      }
    }
  };

  equalizeSpanning(vDivs, 'columnas');
  equalizeSpanning(hShs, 'niveles');

  // 3. Snap exacto de extremos (T-junctions) a paredes y segmentos perpendiculares
  const vAnchors = [0, 1, ...vDivs.map((d) => d.position)].sort((a, b) => a - b);
  const hAnchors = [0, 1, ...hShs.map((s) => s.position)].sort((a, b) => a - b);
  const nearestSnap = (val: number, anchors: readonly number[]): number => {
    let best = val;
    let bestD = 0.048;
    for (const a of anchors) {
      const d = Math.abs(val - a);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return Number(clamp(best, 0, 1).toFixed(4));
  };

  for (const d of vDivs) {
    const s0 = nearestSnap(Math.min(d.start, d.end), hAnchors);
    const s1 = nearestSnap(Math.max(d.start, d.end), hAnchors);
    d.start = s0;
    d.end = Math.max(s0 + 0.05, s1);
  }
  for (const s of hShs) {
    const s0 = nearestSnap(Math.min(s.start, s.end), vAnchors);
    const s1 = nearestSnap(Math.max(s.start, s.end), vAnchors);
    s.start = s0;
    s.end = Math.max(s0 + 0.05, s1);
  }

  // Deduplicar líneas superpuestas
  const dedupe = (segs: NormalizedSegment[]) => {
    const sorted = [...segs].sort((a, b) => a.position - b.position);
    const out: NormalizedSegment[] = [];
    for (const cur of sorted) {
      const dup = out.find(
        (prev) =>
          Math.abs(prev.position - cur.position) <= 0.025 &&
          Math.min(prev.end, cur.end) > Math.max(prev.start, cur.start) + 0.04,
      );
      if (!dup) out.push(cur);
    }
    return out;
  };

  return { vDividers: dedupe(vDivs), hShelves: dedupe(hShs) };
}

function preserveZoneKindsByCentroid(
  nextCells: ReturnType<typeof partitionCellsFromVectors>,
  previousZones: readonly FrontZone[] | undefined,
): FrontZone[] {
  const prev = previousZones ?? [];
  return nextCells.map((cell, idx) => {
    const cu = (cell.uStart + cell.uEnd) / 2;
    const cv = (cell.vStart + cell.vEnd) / 2;
    let bestPrev: FrontZone | undefined;
    let bestDist = Infinity;
    for (const pz of prev) {
      const pu = (pz.uStart + pz.uEnd) / 2;
      const pv = (pz.vStart + pz.vEnd) / 2;
      const d = Math.hypot(cu - pu, cv - pv);
      if (d < bestDist) {
        bestDist = d;
        bestPrev = pz;
      }
    }
    if (bestPrev && bestDist <= 0.35) {
      return {
        ...bestPrev,
        id: bestPrev.id,
        uStart: cell.uStart,
        uEnd: cell.uEnd,
        vStart: cell.vStart,
        vEnd: cell.vEnd,
      };
    }
    return {
      id: cell.id || `raz_z_${idx + 1}`,
      uStart: cell.uStart,
      uEnd: cell.uEnd,
      vStart: cell.vStart,
      vEnd: cell.vEnd,
      kind: 'open',
      label: `Parte ${idx + 1}`,
    };
  });
}

/**
 * Normaliza y cuadra un mueble dibujado a mano para volver sus medidas "razonables" en taller:
 * - Redondea cotas externas y radios curvos a múltiplos limpios de 10 mm.
 * - Iguala altura, profundidad o largo entre alas en L cuando coinciden razonablemente.
 * - Alinea repisas/divisores y ecualiza vanos simétricos para que lados homólogos midan lo mismo.
 */
export function makeDrawingMeasurementsReasonable(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
): ReasonableResult {
  const changesSummary: string[] = [];

  // 1. Cotas exteriores a múltiplos limpios de 10 mm
  const nextX = clamp(roundStep(params.targetDimensions.x, 10), 300, 2600);
  const nextY = clamp(roundStep(params.targetDimensions.y, 10), 300, 2600);
  const nextZ = clamp(roundStep(params.targetDimensions.z, 10), 180, 900);

  if (
    nextX !== params.targetDimensions.x ||
    nextY !== params.targetDimensions.y ||
    nextZ !== params.targetDimensions.z
  ) {
    changesSummary.push(`Cotas externas ajustadas a taller: ${nextX}×${nextY}×${nextZ} mm`);
  }

  // 2. Ala Principal: alinear repisas, divisores y diagonales
  const mainRat = rationalizeWingSegments(
    topology.vDividers,
    topology.hShelves,
    changesSummary,
    'Frente A',
  );
  const vAnchors = [0, 1, ...mainRat.vDividers.map((d) => d.position)];
  const hAnchors = [0, 1, ...mainRat.hShelves.map((s) => s.position)];
  const snapNear = (v: number, anchors: readonly number[]) => {
    for (const a of anchors) {
      if (Math.abs(v - a) <= 0.045) return Number(a.toFixed(4));
    }
    return Number(clamp(v, 0, 1).toFixed(4));
  };

  const nextDiags: DiagonalSegment[] | undefined = topology.diagonalDividers?.map((dg) => ({
    ...dg,
    u1: snapNear(dg.u1, vAnchors),
    v1: snapNear(dg.v1, hAnchors),
    u2: snapNear(dg.u2, vAnchors),
    v2: snapNear(dg.v2, hAnchors),
  }));

  const nextMainZones =
    topology.frontZones && topology.frontZones.length > 0
      ? preserveZoneKindsByCentroid(
          partitionCellsFromVectors(mainRat.vDividers, mainRat.hShelves),
          topology.frontZones,
        )
      : topology.frontZones;

  // 3. Ala L: igualar lados correspondientes (altura, profundidad, largo) + vanos simétricos
  let nextLShape = topology.lShape
    ? {
        ...topology.lShape,
        vDividers: topology.lShape.vDividers.map((d) => ({ ...d })),
        hShelves: topology.lShape.hShelves.map((s) => ({ ...s })),
      }
    : undefined;

  if (nextLShape?.enabled) {
    let retH = clamp(roundStep(nextLShape.returnHeightMm ?? nextY, 10), 300, 2600);
    if (Math.abs(retH - nextY) <= 50 && retH !== nextY) {
      retH = nextY;
      changesSummary.push(`Altura de Ala B igualada a Ala A (${nextY} mm)`);
    }
    let retD = clamp(roundStep(nextLShape.returnDepthMm, 10), 180, 900);
    if (Math.abs(retD - nextZ) <= 45 && retD !== nextZ) {
      retD = nextZ;
      changesSummary.push(`Profundidad de Ala B igualada a Ala A (${nextZ} mm)`);
    }
    let retL = clamp(roundStep(nextLShape.returnLengthMm, 10), nextZ + 180, 2600);
    if (Math.abs(retL - nextX) <= 60 && nextX >= nextZ + 220 && retL !== nextX) {
      retL = nextX;
      changesSummary.push(`Largo total de L igualado a ancho principal (${nextX} mm)`);
    }

    const retRat = rationalizeWingSegments(
      nextLShape.vDividers,
      nextLShape.hShelves,
      changesSummary,
      'Ala Retorno B',
    );
    const nextRetZones =
      nextLShape.frontZones && nextLShape.frontZones.length > 0
        ? preserveZoneKindsByCentroid(
            partitionCellsFromVectors(retRat.vDividers, retRat.hShelves),
            nextLShape.frontZones,
          )
        : nextLShape.frontZones;

    nextLShape = {
      ...nextLShape,
      returnLengthMm: retL,
      returnDepthMm: retD,
      returnHeightMm: retH,
      vDividers: retRat.vDividers,
      hShelves: retRat.hShelves,
      frontZones: nextRetZones,
    };
  }

  // 4. Curvas diferenciales: redondear radios a 10 mm y sanear puntos extremos
  let nextCurved: CurvedCutSpec[] | undefined;
  if (topology.curvedCuts && topology.curvedCuts.length > 0) {
    nextCurved = topology.curvedCuts.map((c) => {
      const nextR = c.radiusMm !== undefined ? clamp(roundStep(c.radiusMm, 10), 40, 400) : undefined;
      if (nextR !== undefined && nextR !== c.radiusMm) {
        changesSummary.push(`Radio curvo ajustado a R=${nextR} mm`);
      }
      const snapPt = (pt: Point2D): Point2D => ({
        x: Math.abs(pt.x) <= 0.04 ? 0 : Math.abs(pt.x - 1) <= 0.04 ? 1 : Number(pt.x.toFixed(4)),
        y: Math.abs(pt.y) <= 0.04 ? 0 : Math.abs(pt.y - 1) <= 0.04 ? 1 : Number(pt.y.toFixed(4)),
      });
      const pts: [Point2D, Point2D, Point2D, Point2D] = [
        snapPt(c.controlPoints[0]),
        c.controlPoints[1],
        c.controlPoints[2],
        snapPt(c.controlPoints[3]),
      ];
      const scaleW = c.plane === 'xy' || c.plane === 'xz' ? nextX : nextZ;
      const scaleH =
        c.plane === 'xz' ? (nextLShape?.enabled ? nextLShape.returnLengthMm : nextZ) : nextY;
      const mmPts: [Point2D, Point2D, Point2D, Point2D] = [
        { x: pts[0].x * scaleW, y: pts[0].y * scaleH },
        { x: pts[1].x * scaleW, y: pts[1].y * scaleH },
        { x: pts[2].x * scaleW, y: pts[2].y * scaleH },
        { x: pts[3].x * scaleW, y: pts[3].y * scaleH },
      ];
      const diff = evaluateBezierDifferential(mmPts, 24);
      return {
        ...c,
        radiusMm: nextR,
        controlPoints: pts,
        arcLengthMm: nextR ? Number(((Math.PI * nextR) / 2).toFixed(2)) : diff.arcLengthMm,
        minRadiusMm: nextR ?? diff.minRadiusMm,
        maxCurvature: nextR ? Number((1 / nextR).toFixed(6)) : diff.maxCurvature,
      };
    });
  }

  // 5. Líneas vectoriales en Planta Superior XZ y Perfil Lateral ZY: redondear a múltiplos de 10 mm
  const roundPlaneLinesTo10Mm = (
    lines: readonly DiagonalSegment[] | undefined,
    spanUMm: number,
    spanVMm: number,
  ): { lines: DiagonalSegment[] | undefined; changed: boolean } => {
    if (!lines || lines.length === 0) {
      return { lines: lines ? [] : undefined, changed: false };
    }
    let changed = false;
    const snapCoord = (norm: number, spanMm: number): number => {
      const mm = roundStep(clamp(norm, 0, 1) * spanMm, 10);
      return Number(clamp(mm / Math.max(1, spanMm), 0, 1).toFixed(4));
    };
    const out = lines.map((ln) => {
      let u1 = snapCoord(ln.u1, spanUMm);
      let v1 = snapCoord(ln.v1, spanVMm);
      let u2 = snapCoord(ln.u2, spanUMm);
      let v2 = snapCoord(ln.v2, spanVMm);
      if (Math.abs(v2 - v1) <= 0.025 && Math.abs(u2 - u1) > 0.05) {
        const vAvg = snapCoord((v1 + v2) / 2, spanVMm);
        v1 = vAvg;
        v2 = vAvg;
      } else if (Math.abs(u2 - u1) <= 0.025 && Math.abs(v2 - v1) > 0.05) {
        const uAvg = snapCoord((u1 + u2) / 2, spanUMm);
        u1 = uAvg;
        u2 = uAvg;
      }
      if (
        Math.abs(u1 - ln.u1) > 0.001 ||
        Math.abs(v1 - ln.v1) > 0.001 ||
        Math.abs(u2 - ln.u2) > 0.001 ||
        Math.abs(v2 - ln.v2) > 0.001
      ) {
        changed = true;
      }
      return { ...ln, u1, v1, u2, v2 };
    });
    return { lines: out, changed };
  };

  const xzSpanMm = nextLShape?.enabled ? nextLShape.returnLengthMm : nextZ;
  const roundedXZ = roundPlaneLinesTo10Mm(topology.planeLinesXZ, nextX, xzSpanMm);
  if (roundedXZ.changed) {
    changesSummary.push('Líneas de Planta XZ ajustadas a múltiplos de 10 mm');
  }
  const roundedZY = roundPlaneLinesTo10Mm(topology.planeLinesZY, nextZ, nextY);
  if (roundedZY.changed) {
    changesSummary.push('Líneas de Perfil ZY ajustadas a múltiplos de 10 mm');
  }

  if (changesSummary.length === 0) {
    changesSummary.push('Medidas y simetría ya se encuentran cuadradas al estándar de taller.');
  }

  return {
    topology: {
      ...topology,
      aspectRatioXY: nextY > 0 ? nextX / nextY : topology.aspectRatioXY,
      vDividers: mainRat.vDividers,
      hShelves: mainRat.hShelves,
      diagonalDividers: nextDiags,
      ...(roundedXZ.lines !== undefined ? { planeLinesXZ: roundedXZ.lines } : {}),
      ...(roundedZY.lines !== undefined ? { planeLinesZY: roundedZY.lines } : {}),
      frontZones: nextMainZones,
      lShape: nextLShape,
      curvedCuts: nextCurved,
    },
    params: {
      ...params,
      targetDimensions: { x: nextX, y: nextY, z: nextZ },
    },
    changesSummary,
  };
}
