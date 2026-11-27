/**
 * SMARTFURNITURE — SUBMÓDULO DE APOYO INFERIOR Y ZÓCALO COMPLETO (4 LADOS)
 * - Resuelve `baseSupportType` (`none` | `legs` | `wheels` | `toe_kick`) con retrocompatibilidad.
 * - Genera bastidor de zócalo completo de 4 lados (`zocalo_frontal`, `zocalo_trasero`,
 *   `zocalo_izq`, `zocalo_der`) con 0.000 mm de solapamiento 3D.
 */
import type {
  BaseSupportType,
  BoardPiece,
  FurnitureTopology,
  HardwareItem,
  PieceMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { GEOM_EPS, clamp, resolveEdgeBanding } from './structuralDin';

export interface SupportLegCoordMm {
  x: number;
  z: number;
  wing: 'main' | 'return';
}

export interface ResolvedBaseSupport {
  type: BaseSupportType;
  heightMm: number;
  count: number;
}

/**
 * Resuelve el tipo real de apoyo inferior (`none` | `legs` | `wheels` | `toe_kick`)
 * manteniendo compatibilidad 100% hacia atrás con `hasExternalLegs` y `toeKickHeightMm`.
 */
export function resolveBaseSupport(topology: FurnitureTopology): ResolvedBaseSupport {
  if (topology.baseSupportType) {
    const t = topology.baseSupportType;
    if (t === 'wheels') {
      return {
        type: 'wheels',
        heightMm: Math.max(30, topology.externalLegHeightMm ?? 65),
        count: Math.max(2, Math.round(topology.externalLegCount ?? 4)),
      };
    }
    if (t === 'legs') {
      return {
        type: 'legs',
        heightMm: Math.max(40, topology.externalLegHeightMm ?? 150),
        count: Math.max(2, Math.round(topology.externalLegCount ?? 4)),
      };
    }
    if (t === 'toe_kick') {
      return {
        type: 'toe_kick',
        heightMm: Math.min(200, Math.max(40, topology.toeKickHeightMm ?? 80)),
        count: 0,
      };
    }
    return { type: 'none', heightMm: 0, count: 0 };
  }

  if (topology.hasExternalLegs) {
    const hasWheelHw = (topology.hardwareItems ?? []).some((h) =>
      /rueda|caster|garrucha/i.test(h.descripcion),
    );
    return {
      type: hasWheelHw ? 'wheels' : 'legs',
      heightMm: Math.max(30, topology.externalLegHeightMm ?? (hasWheelHw ? 65 : 150)),
      count: Math.max(2, Math.round(topology.externalLegCount ?? 4)),
    };
  }

  if ((topology.toeKickHeightMm ?? 0) > 0) {
    return {
      type: 'toe_kick',
      heightMm: Math.min(200, Math.max(40, topology.toeKickHeightMm!)),
      count: 0,
    };
  }

  return { type: 'none', heightMm: 0, count: 0 };
}

/**
 * Inicializa la lista de herrajes preservando todos los herrajes manuales del usuario,
 * purgando ítems detectados obsoletos de `categoria: 'patas'` cuando cambia `baseSupportType`
 * (ej. de Ruedas a Zócalo, Al piso o Patas con otra altura/cantidad), y agregando el ítem
 * automático correspondiente a patas/ruedas activas.
 */
export function buildInitialHardwareSummary(topology: FurnitureTopology): HardwareItem[] {
  const support = resolveBaseSupport(topology);
  const isWheels = support.type === 'wheels';
  const wantsExternalSupport = support.type === 'legs' || support.type === 'wheels';

  const items: HardwareItem[] = [];
  for (const raw of topology.hardwareItems ?? []) {
    if (raw.origen === 'detectado' && raw.categoria === 'patas') {
      // Si el usuario cambió a 'none' o 'toe_kick', purgar patas/ruedas detectadas obsoletas
      if (!wantsExternalSupport) {
        continue;
      }
      // Si el usuario cambió entre ruedas <-> patas o modificó cantidad/altura, purgar el ítem viejo
      // para reemplazarlo por uno coherente con `support`
      const itemIsWheel = /rueda|caster|garrucha/i.test(raw.descripcion);
      const sameKind = itemIsWheel === isWheels;
      const sameCount = raw.cantidad === support.count;
      const sameHeight =
        raw.medidaReferenciaMm === undefined ||
        Math.abs(raw.medidaReferenciaMm - support.heightMm) <= 1;
      if (!sameKind || !sameCount || !sameHeight) {
        continue;
      }
    }
    items.push({ ...raw });
  }

  if (wantsExternalSupport) {
    const autoId = isWheels ? 'hw_ruedas_externas' : 'hw_patas_externas';
    const alreadyPresent = items.some(
      (i) => i.id === autoId || (i.origen === 'detectado' && i.categoria === 'patas'),
    );
    if (!alreadyPresent) {
      items.unshift({
        id: autoId,
        categoria: 'patas',
        descripcion: isWheels
          ? `Ruedas giratorias con freno (${support.heightMm} mm)`
          : `Patas independientes externas (${support.heightMm} mm)`,
        cantidad: support.count,
        medidaReferenciaMm: support.heightMm,
        notaCompra: isWheels
          ? `Excluidas del cuerpo de melamina. Adquirir ${support.count} ruedas giratorias (${support.heightMm} mm) con freno.`
          : `Excluidas del cuerpo de melamina. Adquirir ${support.count} patas del mismo tipo (${support.heightMm} mm aprox.) aparte.`,
        origen: topology.detectionSource === 'auto' ? 'detectado' : 'manual',
      });
    }
  }

  return items;
}

/**
 * Genera el bastidor completo de zócalo de 4 lados (`zocalo_frontal`, `zocalo_trasero`,
 * `zocalo_izq`, `zocalo_der`) bajo el cuerpo de melamina (`y ∈ [-tkH, 0]`, que en el
 * Visor 3D con `bodyOffsetY = tkH` se apoya exactamente sobre el piso `y_world ∈ [0, tkH]`).
 * Cero solapamiento 3D entre sus 4 placas y respecto a la base/laterales/fondo.
 */
export function buildToeKickPieces(options: {
  x0: number;
  x1: number;
  zf: number;
  e: number;
  tkH: number;
  mat: PieceMaterial;
  joint: ScaleAndBoardParams['cornerJointType'];
  edgeMode: ScaleAndBoardParams['edgeBandingMode'];
}): BoardPiece[] {
  const { x0, x1, zf, e, tkH, mat, joint, edgeMode } = options;
  const fullW = x1 - x0;
  if (tkH <= GEOM_EPS || fullW <= 2 * e + GEOM_EPS || zf <= e + GEOM_EPS) {
    return [];
  }

  const edges = resolveEdgeBanding('zocalo', joint, edgeMode);
  const cx = (x0 + x1) / 2;
  const cy = -tkH / 2;
  // Retranqueo frontal ergonómico estándar de 30 mm (clamp seguro para muebles poco profundos)
  const frontRecess = Math.min(30, Math.max(0, zf - 2 * e - 20));
  const zFrontMax = Math.max(e, zf - frontRecess);
  const pieces: BoardPiece[] = [];

  // 1. Zócalo Frontal (ancho completo del apoyo inferior para ocultar cantos laterales)
  pieces.push({
    id: 'zocalo_frontal',
    nombre: 'Zócalo Frontal',
    tipo: 'zocalo',
    ancho: fullW,
    alto: tkH,
    espesor: e,
    cantidad: 1,
    respectGrain: true,
    edges,
    posicion3D: [cx, cy, zFrontMax - e / 2],
    dimensiones3D: [fullW, tkH, e],
    rotacion3D: [0, 0, 0],
    material: mat,
  });

  // 2. Zócalo Trasero (apoyo posterior a ras de pared trasera z ∈ [0, e])
  if (zFrontMax - e >= e + GEOM_EPS) {
    pieces.push({
      id: 'zocalo_trasero',
      nombre: 'Zócalo Trasero',
      tipo: 'zocalo',
      ancho: fullW,
      alto: tkH,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges,
      posicion3D: [cx, cy, e / 2],
      dimensiones3D: [fullW, tkH, e],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  // 3 y 4. Zócalos Laterales Izq y Der (encajados entre frontal y trasero: z ∈ [e, zFrontMax - e])
  const sideDepth = zFrontMax - 2 * e;
  if (sideDepth > GEOM_EPS) {
    const czSide = e + sideDepth / 2;
    pieces.push({
      id: 'zocalo_izq',
      nombre: 'Zócalo Izquierdo',
      tipo: 'zocalo',
      ancho: sideDepth,
      alto: tkH,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges,
      posicion3D: [x0 + e / 2, cy, czSide],
      dimensiones3D: [e, tkH, sideDepth],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
    pieces.push({
      id: 'zocalo_der',
      nombre: 'Zócalo Derecho',
      tipo: 'zocalo',
      ancho: sideDepth,
      alto: tkH,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges,
      posicion3D: [x1 - e / 2, cy, czSide],
      dimensiones3D: [e, tkH, sideDepth],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  return pieces;
}

/**
 * Calcula las coordenadas exactas (x, z) en mm sobre el piso de todas las patas/ruedas
 * externas para muebles rectos y muebles en L, compartido 1:1 entre `mathEngine` y `Viewer3D`.
 */
export function computeSupportLegCoordsMm(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  lShapeResolved?: {
    enabled: boolean;
    side: 'right' | 'left';
    zStartB: number;
    netLengthMm: number;
    depthMm: number;
    openCorner: boolean;
  } | null,
): SupportLegCoordMm[] {
  const support = resolveBaseSupport(topology);
  if (support.type !== 'legs' && support.type !== 'wheels') {
    return [];
  }

  const xf = params.targetDimensions.x;
  const zf = params.targetDimensions.z;
  const legInset = Math.min(60, xf * 0.12, zf * 0.18);
  const total = Math.max(2, Math.min(12, Math.round(support.count || 4)));
  const frontCount = Math.ceil(total / 2);
  const backCount = Math.max(1, total - frontCount);
  const spanX = Math.max(20, xf - 2 * legInset);

  const distribute = (start: number, span: number, count: number): number[] => {
    if (count <= 1) return [start + span / 2];
    return Array.from({ length: count }, (_, idx) => start + (span * idx) / (count - 1));
  };

  const coords: SupportLegCoordMm[] = [];
  for (const lx of distribute(legInset, spanX, backCount)) {
    coords.push({ x: lx, z: legInset, wing: 'main' });
  }
  for (const lx of distribute(legInset, spanX, frontCount)) {
    coords.push({ x: lx, z: zf - legInset, wing: 'main' });
  }

  const ls = topology.lShape;
  const useReturn = lShapeResolved?.enabled ?? Boolean(ls?.enabled);
  if (useReturn && ls) {
    const side = lShapeResolved?.side ?? ls.side;
    const zStartB = lShapeResolved?.zStartB ?? zf;
    const depthMm = clamp(Math.round(lShapeResolved?.depthMm ?? ls.returnDepthMm), 180, 900);
    const netLen = lShapeResolved?.netLengthMm ?? Math.round(ls.returnLengthMm) - zStartB;
    const openCorner = lShapeResolved?.openCorner ?? Boolean(ls.openCorner);

    if (netLen > 120) {
      const insetB = Math.min(60, netLen * 0.15, depthMm * 0.18);
      const xMinB = side === 'right' ? xf - depthMm : 0;
      const xMaxB = side === 'right' ? xf : depthMm;
      const xBackWall = side === 'right' ? xMaxB - insetB : xMinB + insetB;
      const xInnerFront = side === 'right' ? xMinB + insetB : xMaxB - insetB;
      const zTip = zStartB + netLen - insetB;

      // En esquinas abiertas cortas de escritorio, solo patas en la punta exterior para no invadir piernas
      const needsCornerPair = !openCorner || netLen >= 1200;
      if (needsCornerPair) {
        const zCornerRow = zStartB + insetB;
        coords.push({ x: xBackWall, z: zCornerRow, wing: 'return' });
        if (!openCorner) {
          coords.push({ x: xInnerFront, z: zCornerRow, wing: 'return' });
        }
      }
      coords.push({ x: xBackWall, z: zTip, wing: 'return' });
      coords.push({ x: xInnerFront, z: zTip, wing: 'return' });
    }
  }

  return coords;
}
