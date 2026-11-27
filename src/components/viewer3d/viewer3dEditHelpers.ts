/**
 * SMARTFURNITURE — HELPERS PUROS DE EDICIÓN DIRECTA EN 3D (`viewer3dEditHelpers.ts`)
 * - Opera exclusivamente sobre campos tipados (`tipo`, `wing`, `zoneId`, `posicion3D`, `dimensiones3D`).
 * - Cero parsing de cadenas en `piece.id`, cero dependencias de React/Three/DOM.
 * - Soporta de forma uniforme el ala principal (`main`) y el ala de retorno L (`return`).
 */
import type {
  BoardPiece,
  FrontModuleKind,
  FrontZone,
  FurnitureTopology,
  MelamineMaterial,
  NormalizedSegment,
  ScaleAndBoardParams,
  WingRole,
} from '../../types/contracts';
import {
  applyReturnWingTopology,
  buildReturnWingParams,
  extractReturnWingTopology,
  resolveLShapePlan,
  type ResolvedLShapePlan,
} from '../../core/mathEngine/lShapeBuilder';
import { calculateShelfProgression, clamp } from '../../core/mathEngine/structuralDin';
import {
  ensureFrontZonesFromTopology,
  splitZoneTopology,
} from '../vectorCanvas/geometryHelpers';

export interface WingEditContext {
  wing: WingRole;
  wingTopology: FurnitureTopology;
  wingParams: ScaleAndBoardParams;
  xLeftStart: number;
  xInt: number;
  yf: number;
  yInt: number;
}

export interface Edit3DHandleSpec {
  key: string;
  axis: 'shelf' | 'divider';
  deltaMm: number;
  label: string;
  positionM: [number, number, number];
  rotationRad: [number, number, number];
  color: string;
}

const SEG_TOL = 0.018;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Resuelve el plan del ala de retorno L sincronizado con el desplazamiento real frontal `zStartB`
 * aplicado tras la holgura de puertas/cajones (`resolveCornerFrontClearance`).
 */
export function resolveEffectiveLShapePlan(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  allPieces?: readonly BoardPiece[],
): ResolvedLShapePlan | null {
  const basePlan = resolveLShapePlan(topology, params);
  if (!basePlan?.enabled) return null;
  if (!allPieces || allPieces.length === 0) return basePlan;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of allPieces) {
    if (p.wing !== 'return' || p.tipo === 'puerta' || p.tipo === 'frente_cajon') continue;
    const rotY = p.rotacion3D[1] ?? 0;
    const cosY = Math.abs(Math.cos(rotY));
    const sinY = Math.abs(Math.sin(rotY));
    const worldDz = p.dimensiones3D[0] * sinY + p.dimensiones3D[2] * cosY;
    minZ = Math.min(minZ, p.posicion3D[2] - worldDz / 2);
    maxZ = Math.max(maxZ, p.posicion3D[2] + worldDz / 2);
  }
  if (Number.isFinite(minZ) && Number.isFinite(maxZ) && maxZ > minZ) {
    const resolved = resolveLShapePlan(topology, params, minZ) ?? basePlan;
    return {
      ...resolved,
      zStartB: minZ,
      netLengthMm: maxZ - minZ,
      totalLengthMm: maxZ,
    };
  }
  return basePlan;
}

export function resolveWingEditContext(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  wing: WingRole = 'main',
  allPieces?: readonly BoardPiece[],
): WingEditContext {
  const e = params.boardThickness;
  if (wing === 'return') {
    const plan = resolveEffectiveLShapePlan(topology, params, allPieces);
    if (plan?.enabled) {
      const wingTopology = extractReturnWingTopology(topology);
      const baseRetParams = buildReturnWingParams(topology, params);
      const netX = Math.max(120, plan.netLengthMm);
      const wingParams: ScaleAndBoardParams = {
        ...baseRetParams,
        targetDimensions: { x: netX, y: plan.heightMm, z: plan.depthMm },
        referenceDimensions: { x: netX, y: plan.heightMm, z: plan.depthMm },
      };
      const xLeftStart = plan.omitLeftLateral ? 0 : e;
      const xRightEnd = plan.omitRightLateral ? plan.netLengthMm : plan.netLengthMm - e;
      return {
        wing: 'return',
        wingTopology,
        wingParams,
        xLeftStart,
        xInt: Math.max(1, xRightEnd - xLeftStart),
        yf: plan.heightMm,
        yInt: Math.max(1, plan.heightMm - 2 * e),
      };
    }
  }
  return {
    wing: 'main',
    wingTopology: topology,
    wingParams: params,
    xLeftStart: e,
    xInt: Math.max(1, params.targetDimensions.x - 2 * e),
    yf: params.targetDimensions.y,
    yInt: Math.max(1, params.targetDimensions.y - 2 * e),
  };
}

function commitWingTopology(
  baseTopology: FurnitureTopology,
  updatedWing: FurnitureTopology,
  wing: WingRole,
): FurnitureTopology {
  return wing === 'return' ? applyReturnWingTopology(baseTopology, updatedWing) : updatedWing;
}

/** Convierte coordenadas mundiales 3D de una `BoardPiece` a coordenadas locales `(lx, ly)` del ala. */
function pieceWorldToWingLocalXY(
  piece: BoardPiece,
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  allPieces?: readonly BoardPiece[],
): { wing: WingRole; lx: number; ly: number; worldDxM: number; worldDzM: number } {
  const [wx, wy, wz] = piece.posicion3D;
  if (piece.wing === 'return') {
    const plan = resolveEffectiveLShapePlan(topology, params, allPieces);
    if (plan?.enabled) {
      const lx =
        plan.side === 'right'
          ? wz - plan.zStartB
          : plan.zStartB + plan.netLengthMm - wz;
      return {
        wing: 'return',
        lx,
        ly: wy,
        worldDxM: piece.dimensiones3D[0] / 1000,
        worldDzM: piece.dimensiones3D[2] / 1000,
      };
    }
  }
  return {
    wing: 'main',
    lx: wx,
    ly: wy,
    worldDxM: piece.dimensiones3D[0] / 1000,
    worldDzM: piece.dimensiones3D[2] / 1000,
  };
}

/** Materializa `hShelves` (incluyendo progresión `equidistant` exacta) dentro del ala indicada. */
function materializeWingShelves(ctx: WingEditContext): NormalizedSegment[] {
  const { wingTopology, yf, wingParams, yInt } = ctx;
  const e = wingParams.boardThickness;
  if (wingTopology.shelfMode === 'equidistant' && wingTopology.equalShelfCount > 0) {
    const prog = calculateShelfProgression(yf, e, wingTopology.equalShelfCount);
    return prog.terms.map((an, idx) => ({
      id: `rep_eq_${idx + 1}`,
      position: round4(clamp((an + e / 2 - e) / yInt, 0.02, 0.98)),
      start: 0,
      end: 1,
    }));
  }
  return wingTopology.hShelves.map((s) => ({ ...s }));
}

function findMatchingShelfIndex(
  shelves: readonly NormalizedSegment[],
  ctx: WingEditContext,
  lx: number,
  ly: number,
): number {
  const e = ctx.wingParams.boardThickness;
  const tolMm = Math.max(4, e * 0.45);
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < shelves.length; i++) {
    const s = shelves[i];
    const cy = clamp(e + clamp(s.position, 0, 1) * ctx.yInt, e * 1.5, ctx.yf - e * 1.5);
    const dy = Math.abs(cy - ly);
    if (dy > tolMm) continue;
    const x0 = ctx.xLeftStart + Math.min(s.start, s.end) * ctx.xInt;
    const x1 = ctx.xLeftStart + Math.max(s.start, s.end) * ctx.xInt;
    if (lx < x0 - 12 || lx > x1 + 12) continue;
    if (dy < bestDist) {
      bestDist = dy;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function findMatchingDividerIndex(
  dividers: readonly NormalizedSegment[],
  ctx: WingEditContext,
  lx: number,
  ly: number,
): number {
  const e = ctx.wingParams.boardThickness;
  const tolMm = Math.max(4, e * 0.45);
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < dividers.length; i++) {
    const d = dividers[i];
    const cx = clamp(
      ctx.xLeftStart + clamp(d.position, 0, 1) * ctx.xInt,
      e * 1.5,
      ctx.wingParams.targetDimensions.x - e * 1.5,
    );
    const dx = Math.abs(cx - lx);
    if (dx > tolMm) continue;
    const y0 = e + Math.min(d.start, d.end) * ctx.yInt;
    const y1 = e + Math.max(d.start, d.end) * ctx.yInt;
    if (ly < y0 - 12 || ly > y1 + 12) continue;
    if (dx < bestDist) {
      bestDist = dx;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function canEditPiecePositionIn3D(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  piece: BoardPiece,
  allPieces?: readonly BoardPiece[],
): boolean {
  const local = pieceWorldToWingLocalXY(piece, topology, params, allPieces);
  const ctx = resolveWingEditContext(topology, params, local.wing, allPieces);
  if (piece.tipo === 'repisa') {
    const shelves = materializeWingShelves(ctx);
    return findMatchingShelfIndex(shelves, ctx, local.lx, local.ly) !== -1;
  }
  if (piece.tipo === 'division_vertical') {
    return (
      findMatchingDividerIndex(ctx.wingTopology.vDividers, ctx, local.lx, local.ly) !== -1
    );
  }
  return false;
}

export function nudgeShelfMmIn3D(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  piece: BoardPiece,
  deltaMm: number,
  allPieces?: readonly BoardPiece[],
): FurnitureTopology | null {
  if (piece.tipo !== 'repisa' || Math.abs(deltaMm) < 1e-3) return null;
  const local = pieceWorldToWingLocalXY(piece, topology, params, allPieces);
  const ctx = resolveWingEditContext(topology, params, local.wing, allPieces);
  const shelves = materializeWingShelves(ctx);
  const idx = findMatchingShelfIndex(shelves, ctx, local.lx, local.ly);
  if (idx === -1) return null;

  const e = ctx.wingParams.boardThickness;
  const target = shelves[idx];
  const oldV = target.position;
  const minMarginV = clamp((e * 1.6) / ctx.yInt, 0.03, 0.45);
  const newV = round4(clamp(oldV + deltaMm / ctx.yInt, minMarginV, 1 - minMarginV));
  if (Math.abs(newV - oldV) < 1e-4) return null;

  const u0 = Math.min(target.start, target.end);
  const u1 = Math.max(target.start, target.end);

  const nextShelves = shelves.map((s, sIdx) => (sIdx === idx ? { ...s, position: newV } : s));
  const nextDividers = ctx.wingTopology.vDividers.map((d) => {
    if (d.position < u0 - SEG_TOL || d.position > u1 + SEG_TOL) return d;
    const start = Math.abs(d.start - oldV) <= SEG_TOL ? newV : d.start;
    const end = Math.abs(d.end - oldV) <= SEG_TOL ? newV : d.end;
    return start !== d.start || end !== d.end ? { ...d, start, end } : d;
  });

  const nextZones = (ctx.wingTopology.frontZones ?? []).map((z) => {
    if (Math.min(z.uEnd, u1) - Math.max(z.uStart, u0) <= 0.01) return z;
    const vEnd = Math.abs(z.vEnd - oldV) <= SEG_TOL ? newV : z.vEnd;
    const vStart = Math.abs(z.vStart - oldV) <= SEG_TOL ? newV : z.vStart;
    return vStart !== z.vStart || vEnd !== z.vEnd ? { ...z, vStart, vEnd } : z;
  });

  const updatedWing: FurnitureTopology = {
    ...ctx.wingTopology,
    shelfMode: 'custom',
    equalShelfCount: 0,
    hShelves: nextShelves,
    vDividers: nextDividers,
    frontZones: nextZones.length > 0 ? nextZones : ctx.wingTopology.frontZones,
    detectionSource: 'manual',
  };
  return commitWingTopology(topology, updatedWing, local.wing);
}

export function nudgeDividerMmIn3D(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  piece: BoardPiece,
  deltaMm: number,
  allPieces?: readonly BoardPiece[],
): FurnitureTopology | null {
  if (piece.tipo !== 'division_vertical' || Math.abs(deltaMm) < 1e-3) return null;
  const local = pieceWorldToWingLocalXY(piece, topology, params, allPieces);
  const ctx = resolveWingEditContext(topology, params, local.wing, allPieces);
  const idx = findMatchingDividerIndex(ctx.wingTopology.vDividers, ctx, local.lx, local.ly);
  if (idx === -1) return null;

  const e = ctx.wingParams.boardThickness;
  const target = ctx.wingTopology.vDividers[idx];
  const oldU = target.position;
  const minMarginU = clamp((e * 1.6) / ctx.xInt, 0.03, 0.45);
  const newU = round4(clamp(oldU + deltaMm / ctx.xInt, minMarginU, 1 - minMarginU));
  if (Math.abs(newU - oldU) < 1e-4) return null;

  const v0 = Math.min(target.start, target.end);
  const v1 = Math.max(target.start, target.end);

  const nextDividers = ctx.wingTopology.vDividers.map((d, dIdx) =>
    dIdx === idx ? { ...d, position: newU } : d,
  );
  const shelves = materializeWingShelves(ctx).map((s) => {
    if (s.position < v0 - SEG_TOL || s.position > v1 + SEG_TOL) return s;
    const start = Math.abs(s.start - oldU) <= SEG_TOL ? newU : s.start;
    const end = Math.abs(s.end - oldU) <= SEG_TOL ? newU : s.end;
    return start !== s.start || end !== s.end ? { ...s, start, end } : s;
  });

  const nextZones = (ctx.wingTopology.frontZones ?? []).map((z) => {
    if (Math.min(z.vEnd, v1) - Math.max(z.vStart, v0) <= 0.01) return z;
    const uEnd = Math.abs(z.uEnd - oldU) <= SEG_TOL ? newU : z.uEnd;
    const uStart = Math.abs(z.uStart - oldU) <= SEG_TOL ? newU : z.uStart;
    return uStart !== z.uStart || uEnd !== z.uEnd ? { ...z, uStart, uEnd } : z;
  });

  const updatedWing: FurnitureTopology = {
    ...ctx.wingTopology,
    shelfMode: ctx.wingTopology.shelfMode === 'equidistant' ? 'equidistant' : 'custom',
    vDividers: nextDividers,
    hShelves: ctx.wingTopology.shelfMode === 'equidistant' ? ctx.wingTopology.hShelves : shelves,
    frontZones: nextZones.length > 0 ? nextZones : ctx.wingTopology.frontZones,
    detectionSource: 'manual',
  };
  return commitWingTopology(topology, updatedWing, local.wing);
}

export function removeShelfIn3D(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  piece: BoardPiece,
  allPieces?: readonly BoardPiece[],
): FurnitureTopology | null {
  if (piece.tipo !== 'repisa') return null;
  const local = pieceWorldToWingLocalXY(piece, topology, params, allPieces);
  const ctx = resolveWingEditContext(topology, params, local.wing, allPieces);
  const shelves = materializeWingShelves(ctx);
  const idx = findMatchingShelfIndex(shelves, ctx, local.lx, local.ly);
  if (idx === -1) return null;

  const nextShelves = shelves.filter((_, sIdx) => sIdx !== idx);
  const intermediate: FurnitureTopology = {
    ...ctx.wingTopology,
    shelfMode: 'custom',
    equalShelfCount: 0,
    hShelves: nextShelves,
    frontZones: undefined,
    detectionSource: 'manual',
  };
  const rebuiltZones = ctx.wingTopology.frontZones
    ? ensureFrontZonesFromTopology(intermediate, ctx.wingParams)
    : undefined;
  return commitWingTopology(
    topology,
    { ...intermediate, frontZones: rebuiltZones },
    local.wing,
  );
}

export function removeDividerIn3D(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  piece: BoardPiece,
  allPieces?: readonly BoardPiece[],
): FurnitureTopology | null {
  if (piece.tipo !== 'division_vertical') return null;
  const local = pieceWorldToWingLocalXY(piece, topology, params, allPieces);
  const ctx = resolveWingEditContext(topology, params, local.wing, allPieces);
  const idx = findMatchingDividerIndex(ctx.wingTopology.vDividers, ctx, local.lx, local.ly);
  if (idx === -1) return null;

  const nextDividers = ctx.wingTopology.vDividers.filter((_, dIdx) => dIdx !== idx);
  const intermediate: FurnitureTopology = {
    ...ctx.wingTopology,
    vDividers: nextDividers,
    frontZones: undefined,
    detectionSource: 'manual',
  };
  const rebuiltZones = ctx.wingTopology.frontZones
    ? ensureFrontZonesFromTopology(intermediate, ctx.wingParams)
    : undefined;
  return commitWingTopology(
    topology,
    { ...intermediate, frontZones: rebuiltZones },
    local.wing,
  );
}

export function updateZoneFrom3D(
  topology: FurnitureTopology,
  wing: WingRole,
  zoneId: string,
  patch: Partial<FrontZone>,
): FurnitureTopology {
  const baseWing = wing === 'return' ? extractReturnWingTopology(topology) : topology;
  const zones = (baseWing.frontZones ?? []).map((z) =>
    z.id === zoneId ? { ...z, ...patch } : z,
  );
  return commitWingTopology(
    topology,
    { ...baseWing, frontZones: zones, detectionSource: 'manual' },
    wing,
  );
}

export function changeZoneKindFrom3D(
  topology: FurnitureTopology,
  wing: WingRole,
  zoneId: string,
  nextKind: FrontModuleKind,
): FurnitureTopology {
  const clearOverride =
    nextKind === 'open' ||
    nextKind === 'baskets' ||
    nextKind === 'leg_void' ||
    nextKind === 'void_outside';

  const baseWing = wing === 'return' ? extractReturnWingTopology(topology) : topology;
  const zones = (baseWing.frontZones ?? []).map((z) => {
    if (z.id !== zoneId) return z;
    return {
      ...z,
      kind: nextKind,
      drawerCount: nextKind === 'drawers' ? (z.drawerCount ?? 3) : undefined,
      basketCount: nextKind === 'baskets' ? (z.basketCount ?? 3) : undefined,
      internalShelves:
        nextKind === 'drawers' ||
        nextKind === 'baskets' ||
        nextKind === 'leg_void' ||
        nextKind === 'void_outside'
          ? undefined
          : z.internalShelves,
      materialOverride: clearOverride ? undefined : z.materialOverride,
    };
  });
  return commitWingTopology(
    topology,
    { ...baseWing, frontZones: zones, detectionSource: 'manual' },
    wing,
  );
}

export function splitZoneIn3D(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  wing: WingRole,
  zoneId: string,
  direction: 'cols' | 'rows',
): { topology: FurnitureTopology; newSelectedZoneId: string } | null {
  const ctx = resolveWingEditContext(topology, params, wing);
  const res = splitZoneTopology(ctx.wingTopology, ctx.wingParams, zoneId, direction, 2);
  if (!res) return null;
  return {
    topology: commitWingTopology(topology, res.topology, wing),
    newSelectedZoneId: res.newSelectedZoneId,
  };
}

export function updateCubiertaMaterialIn3D(
  topology: FurnitureTopology,
  wing: WingRole,
  material: MelamineMaterial | undefined,
): FurnitureTopology {
  const baseWing = wing === 'return' ? extractReturnWingTopology(topology) : topology;
  return commitWingTopology(
    topology,
    { ...baseWing, cubiertaMaterialOverride: material },
    wing,
  );
}

/**
 * Calcula las flechas interactivas 3D directamente sobre el frente del tablero seleccionado
 * (uniforme para ala principal `rotY = 0` y ala de retorno `rotY = ±π/2`).
 */
export function compute3DEditHandlePositions(
  piece: BoardPiece,
  piecePosM: readonly [number, number, number],
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  allPieces?: readonly BoardPiece[],
): Edit3DHandleSpec[] {
  if (!canEditPiecePositionIn3D(topology, params, piece, allPieces)) return [];
  if (piece.curveProfile) return [];

  const rotY = piece.rotacion3D[1] ?? 0;
  const localX: [number, number, number] = [Math.cos(rotY), 0, -Math.sin(rotY)];
  const localZ: [number, number, number] = [Math.sin(rotY), 0, Math.cos(rotY)];
  const eM = params.boardThickness / 1000;
  const dzM = piece.dimensiones3D[2] / 1000;
  const frontOffset = dzM / 2 + 0.024;

  const fx = piecePosM[0] + localZ[0] * frontOffset;
  const fy = piecePosM[1];
  const fz = piecePosM[2] + localZ[2] * frontOffset;

  if (piece.tipo === 'repisa') {
    const stepY = eM / 2 + 0.044;
    return [
      {
        key: `${piece.id}_up`,
        axis: 'shelf',
        deltaMm: 20,
        label: 'Subir repisa +20 mm',
        positionM: [fx, fy + stepY, fz],
        rotationRad: [0, rotY, 0],
        color: '#0ea5e9',
      },
      {
        key: `${piece.id}_down`,
        axis: 'shelf',
        deltaMm: -20,
        label: 'Bajar repisa -20 mm',
        positionM: [fx, fy - stepY, fz],
        rotationRad: [Math.PI, rotY, 0],
        color: '#0284c7',
      },
    ];
  }

  if (piece.tipo === 'division_vertical') {
    const stepX = eM / 2 + 0.046;
    return [
      {
        key: `${piece.id}_right`,
        axis: 'divider',
        deltaMm: 20,
        label: 'Mover divisor +20 mm',
        positionM: [fx + localX[0] * stepX, fy, fz + localX[2] * stepX],
        rotationRad: [0, rotY, -Math.PI / 2],
        color: '#0ea5e9',
      },
      {
        key: `${piece.id}_left`,
        axis: 'divider',
        deltaMm: -20,
        label: 'Mover divisor -20 mm',
        positionM: [fx - localX[0] * stepX, fy, fz - localX[2] * stepX],
        rotationRad: [0, rotY, Math.PI / 2],
        color: '#0284c7',
      },
    ];
  }

  return [];
}
