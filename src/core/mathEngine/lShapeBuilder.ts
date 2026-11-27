/**
 * SMARTFURNITURE — SUBMÓDULO DE MUEBLES EN L (PLANTA 3D A 90° EN XZ)
 * - Resuelve dimensiones netas y geometría de esquina sin solapamiento (`butt_joint`).
 * - Transforma piezas locales del ala de retorno [0, netLen]×[0, ry]×[0, rz] a 3D mundial.
 * - Adapta bidireccionalmente `LShapeWingConfig` <-> `FurnitureTopology` para reutilizar
 *   `ZoneInspector`, `calculateDespiece` y planos vectoriales sin duplicar lógica.
 */
import type {
  BoardPiece,
  FrontZone,
  FurnitureTopology,
  HardwareItem,
  LShapeSide,
  LShapeWingConfig,
  ScaleAndBoardParams,
} from '../../types/contracts';
import type { ResolvedBaseSupport } from './baseSupport';
import { GEOM_EPS, SEGMENT_TOUCH_TOL, clamp } from './structuralDin';

export interface ResolvedLShapePlan {
  enabled: boolean;
  side: LShapeSide;
  totalLengthMm: number;
  depthMm: number;
  heightMm: number;
  zStartB: number;
  netLengthMm: number;
  openCorner: boolean;
  omitLeftLateral: boolean;
  omitRightLateral: boolean;
  cornerEdgeX: number;
  cornerBandX0: number;
  cornerBandX1: number;
}

export interface WorldAABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * Calcula la caja envolvente axis-aligned real en coordenadas mundiales (mm) para cualquier
 * `BoardPiece` (incluyendo piezas rotadas en Y ±90° del ala en L y diagonales rotadas en Z).
 */
export function computePieceWorldAABB(piece: BoardPiece): WorldAABB {
  const [cx, cy, cz] = piece.posicion3D;
  const [dx, dy, dz] = piece.dimensiones3D;
  const [, rotY, rotZ] = piece.rotacion3D;

  const cosZ = Math.abs(Math.cos(rotZ));
  const sinZ = Math.abs(Math.sin(rotZ));
  const dxAfterZ = dx * cosZ + dy * sinZ;
  const dyAfterZ = dx * sinZ + dy * cosZ;

  const cosY = Math.abs(Math.cos(rotY));
  const sinY = Math.abs(Math.sin(rotY));
  const worldDx = dxAfterZ * cosY + dz * sinY;
  const worldDz = dxAfterZ * sinY + dz * cosY;

  return {
    minX: cx - worldDx / 2,
    maxX: cx + worldDx / 2,
    minY: cy - dyAfterZ / 2,
    maxY: cy + dyAfterZ / 2,
    minZ: cz - worldDz / 2,
    maxZ: cz + worldDz / 2,
  };
}

function hasLegVoidAtSide(
  zones: readonly FrontZone[] | undefined,
  edge: 'left' | 'right',
): boolean {
  if (!zones || zones.length === 0) return false;
  return zones.some((z) => {
    if (z.kind !== 'leg_void') return false;
    const u0 = Math.min(z.uStart, z.uEnd);
    const u1 = Math.max(z.uStart, z.uEnd);
    return edge === 'left' ? u0 <= SEGMENT_TOUCH_TOL : u1 >= 1 - SEGMENT_TOUCH_TOL;
  });
}

/**
 * Resuelve la geometría constructiva base del ala de retorno en planta XZ.
 */
export function resolveLShapePlan(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  zStartBOverride?: number,
): ResolvedLShapePlan | null {
  const ls = topology.lShape;
  if (!ls || !ls.enabled) return null;

  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const side: LShapeSide = ls.side === 'left' ? 'left' : 'right';
  const depthMm = clamp(Math.round(ls.returnDepthMm || Math.min(500, zf)), 180, 900);
  const heightMm = clamp(Math.round(ls.returnHeightMm ?? yf), 300, 2600);
  const totalLengthMm = Math.round(ls.returnLengthMm);
  const zStartB = Math.max(zf, zStartBOverride ?? zf);
  const netLengthMm = totalLengthMm - zStartB;

  const mainCornerLegVoid = hasLegVoidAtSide(topology.frontZones, side);
  const returnCornerEdge: 'left' | 'right' = side === 'right' ? 'left' : 'right';
  const returnCornerLegVoid = hasLegVoidAtSide(ls.frontZones, returnCornerEdge);

  const openCorner =
    ls.openCorner !== undefined
      ? Boolean(ls.openCorner)
      : mainCornerLegVoid && returnCornerLegVoid && Math.abs(heightMm - yf) <= 2;

  const cornerBandX0 = side === 'right' ? Math.max(0, xf - depthMm) : 0;
  const cornerBandX1 = side === 'right' ? xf : Math.min(xf, depthMm);
  const cornerEdgeX = side === 'right' ? xf - depthMm : depthMm;

  return {
    enabled: true,
    side,
    totalLengthMm,
    depthMm,
    heightMm,
    zStartB,
    netLengthMm,
    openCorner,
    omitLeftLateral: openCorner && side === 'right',
    omitRightLateral: openCorner && side === 'left',
    cornerEdgeX,
    cornerBandX0,
    cornerBandX1,
  };
}

/**
 * Determina el inicio real en Z del ala de retorno (`zStartB`) y la holgura frontal de esquina
 * (`cornerFrontTrimMm`) según los frentes salientes (puertas/cajones) del ala principal.
 * Garantiza 0.000 mm de solapamiento incluso al activar L sobre un mueble cerrado existente.
 */
export function resolveCornerFrontClearance(
  mainPieces: readonly BoardPiece[],
  plan: ResolvedLShapePlan,
  zf: number,
  e: number,
): { zStartB: number; cornerFrontTrimMm: number } {
  let maxZInCornerBand = zf;
  let maxZAtInnerEdge = zf;
  const edgeProbeTol = e + 3;

  for (const p of mainPieces) {
    if (p.tipo !== 'puerta' && p.tipo !== 'frente_cajon') continue;
    const box = computePieceWorldAABB(p);
    if (box.maxZ <= zf + GEOM_EPS) continue;
    if (box.minY >= plan.heightMm - GEOM_EPS) continue;

    // 1. ¿El frente del ala principal invade la franja donde apoya el ala de retorno?
    const overlapBandX =
      Math.min(box.maxX, plan.cornerBandX1) - Math.max(box.minX, plan.cornerBandX0);
    if (overlapBandX > 1) {
      maxZInCornerBand = Math.max(maxZInCornerBand, box.maxZ);
    }

    // 2. ¿Un frente adyacente (lado libre) llega hasta el vértice interior `cornerEdgeX`?
    const touchesInnerCorner =
      plan.side === 'right'
        ? box.minX < plan.cornerEdgeX - 1 && box.maxX > plan.cornerEdgeX - edgeProbeTol
        : box.maxX > plan.cornerEdgeX + 1 && box.minX < plan.cornerEdgeX + edgeProbeTol;
    if (touchesInnerCorner) {
      maxZAtInnerEdge = Math.max(maxZAtInnerEdge, box.maxZ);
    }
  }

  const zStartB = maxZInCornerBand > zf + GEOM_EPS ? maxZInCornerBand : zf;
  const cornerFrontTrimMm =
    maxZAtInnerEdge > zStartB + GEOM_EPS ? Math.max(0, maxZAtInnerEdge - zStartB + 2) : 0;

  return { zStartB, cornerFrontTrimMm };
}

/**
 * Transforma una `BoardPiece` generada en el sistema local del ala de retorno
 * `[0, netLengthMm] × [0, ry] × [0, rz]` hacia coordenadas mundiales 3D de la L.
 */
export function transformReturnPieceToWorld(
  piece: BoardPiece,
  side: LShapeSide,
  xf: number,
  zStartB: number,
  netLengthMm: number,
): BoardPiece {
  const [lx, ly, lz] = piece.posicion3D;
  const [rx, , rzRot] = piece.rotacion3D;

  const worldPos: [number, number, number] =
    side === 'right'
      ? [xf - lz, ly, zStartB + lx]
      : [lz, ly, zStartB + netLengthMm - lx];

  const rotY = side === 'right' ? -Math.PI / 2 : Math.PI / 2;

  return {
    ...piece,
    id: `ret_${piece.id}`,
    nombre: `${piece.nombre} (Ala L)`,
    posicion3D: worldPos,
    rotacion3D: [rx, rotY, rzRot],
    wing: 'return',
  };
}

/**
 * Convierte `topology.lShape` en una `FurnitureTopology` estándar para reutilizar
 * `calculateDespiece` de ala única, `ZoneInspector` y `geometryHelpers`.
 */
export function extractReturnWingTopology(topology: FurnitureTopology): FurnitureTopology {
  const ls = topology.lShape;
  return {
    viewsMode: 1,
    aspectRatioXY: 1,
    vDividers: (ls?.vDividers ?? []).map((d) => ({ ...d })),
    hShelves: (ls?.hShelves ?? []).map((s) => ({ ...s })),
    diagonalDividers: ls?.diagonalDividers
      ? ls.diagonalDividers.map((dg) => ({ ...dg }))
      : undefined,
    shelfMode: ls?.shelfMode ?? 'custom',
    equalShelfCount: ls?.equalShelfCount ?? 0,
    hasBackPanel: ls?.hasBackPanel ?? topology.hasBackPanel,
    detectionSource: topology.detectionSource ?? 'manual',
    baseSupportType: topology.baseSupportType,
    hasExternalLegs: topology.hasExternalLegs,
    externalLegHeightMm: topology.externalLegHeightMm,
    externalLegCount: topology.externalLegCount,
    toeKickHeightMm: topology.toeKickHeightMm,
    cubiertaMaterialOverride:
      ls?.cubiertaMaterialOverride ?? topology.cubiertaMaterialOverride,
    frontZones: ls?.frontZones ? ls.frontZones.map((z) => ({ ...z })) : undefined,
    hardwareItems: [],
  };
}

/**
 * Crea un `ScaleAndBoardParams` con dimensiones netas para evaluar el ala de retorno
 * en `ZoneInspector` o en el constructor de carcasa.
 */
export function buildReturnWingParams(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
): ScaleAndBoardParams {
  const plan = resolveLShapePlan(topology, params);
  const netX = Math.max(120, plan?.netLengthMm ?? 600);
  const ry = plan?.heightMm ?? params.targetDimensions.y;
  const rz = plan?.depthMm ?? params.targetDimensions.z;
  return {
    ...params,
    targetDimensions: { x: netX, y: ry, z: rz },
    referenceDimensions: { x: netX, y: ry, z: rz },
  };
}

/**
 * Propaga cambios realizados en la topología/zonas del ala de retorno hacia `baseTopology.lShape`.
 */
export function applyReturnWingTopology(
  baseTopology: FurnitureTopology,
  updatedWing: FurnitureTopology,
): FurnitureTopology {
  if (!baseTopology.lShape) return baseTopology;
  return {
    ...baseTopology,
    lShape: {
      ...baseTopology.lShape,
      shelfMode: updatedWing.shelfMode,
      equalShelfCount: updatedWing.equalShelfCount,
      vDividers: updatedWing.vDividers.map((d) => ({ ...d })),
      hShelves: updatedWing.hShelves.map((s) => ({ ...s })),
      diagonalDividers: updatedWing.diagonalDividers
        ? updatedWing.diagonalDividers.map((dg) => ({ ...dg }))
        : undefined,
      frontZones: updatedWing.frontZones
        ? updatedWing.frontZones.map((z) => ({ ...z }))
        : undefined,
      hasBackPanel: updatedWing.hasBackPanel,
      cubiertaMaterialOverride: updatedWing.cubiertaMaterialOverride,
    },
  };
}

/**
 * Crea una configuración inicial sensata de ala en L al activar `L Derecha` o `L Izquierda`
 * sobre cualquier mueble recto existente.
 */
export function buildDefaultLShapeConfig(
  side: LShapeSide,
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
): LShapeWingConfig {
  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const existing = topology.lShape;
  if (existing) {
    return {
      ...existing,
      enabled: true,
      side,
      returnLengthMm: Math.max(zf + 350, existing.returnLengthMm),
    };
  }

  const isDeskLike = (topology.frontZones ?? []).some((z) => z.kind === 'leg_void');
  const returnDepthMm = isDeskLike ? Math.min(550, zf) : Math.min(500, Math.max(320, zf));
  const returnLengthMm = clamp(Math.max(zf + 600, Math.round(xf * 0.85)), zf + 350, 2400);

  return {
    enabled: true,
    side,
    returnLengthMm,
    returnDepthMm,
    returnHeightMm: yf,
    cornerJoint: 'butt_joint',
    openCorner: isDeskLike,
    vDividers: [],
    hShelves: [],
    shelfMode: isDeskLike ? 'custom' : topology.shelfMode,
    equalShelfCount: isDeskLike ? 0 : Math.min(3, topology.equalShelfCount),
    hasBackPanel: isDeskLike ? false : topology.hasBackPanel,
    cubiertaMaterialOverride: topology.cubiertaMaterialOverride,
    frontZones: [
      {
        id: 'ret_z1',
        uStart: 0,
        uEnd: 1,
        vStart: 0,
        vEnd: 1,
        kind: isDeskLike ? 'leg_void' : 'open',
        label: isDeskLike ? 'Retorno Escritorio' : 'Ala Retorno',
      },
    ],
  };
}

/**
 * Fusiona los herrajes automáticos de ambas alas en `hardwareSummary` evitando duplicados
 * y preservando íntegramente los herrajes manuales del usuario.
 */
export function mergeLShapeHardwareSummaries(
  mainHardware: readonly HardwareItem[],
  returnHardware: readonly HardwareItem[],
  totalSupportLegsCount: number,
  support: ResolvedBaseSupport,
): HardwareItem[] {
  const merged = mainHardware.map((h) => ({ ...h }));

  if (support.type === 'legs' || support.type === 'wheels') {
    const legIdx = merged.findIndex((h) => h.categoria === 'patas');
    if (legIdx !== -1) {
      const isWheel = support.type === 'wheels';
      merged[legIdx] = {
        ...merged[legIdx],
        cantidad: totalSupportLegsCount,
        descripcion: isWheel
          ? `Ruedas giratorias con freno (${support.heightMm} mm)`
          : `Patas independientes externas (${support.heightMm} mm)`,
        notaCompra: isWheel
          ? `Excluidas del cuerpo de melamina. Total L: ${totalSupportLegsCount} ruedas giratorias (${support.heightMm} mm).`
          : `Excluidas del cuerpo de melamina. Total L: ${totalSupportLegsCount} patas (${support.heightMm} mm) distribuidas en ambas alas.`,
      };
    }
  }

  for (const rItem of returnHardware) {
    // Ignorar patas en retorno (ya unificadas arriba con el conteo real 3D de ambas alas)
    if (rItem.categoria === 'patas') continue;

    const existing = merged.find(
      (m) =>
        m.id === rItem.id ||
        (m.origen === 'detectado' &&
          rItem.origen === 'detectado' &&
          m.categoria === rItem.categoria &&
          (rItem.categoria !== 'otro' ||
            (m.medidaReferenciaMm === rItem.medidaReferenciaMm &&
              m.descripcion === rItem.descripcion))),
    );

    if (existing) {
      const nextQty = existing.cantidad + rItem.cantidad;
      existing.cantidad = nextQty;
      existing.notaCompra = `Total en ambas alas del mueble en L: ${nextQty} unid.`;
    } else {
      merged.push({ ...rItem });
    }
  }

  return merged;
}
