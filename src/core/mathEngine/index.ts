/**
 * SMARTFURNITURE — MOTOR MATEMÁTICO PURO v3.0
 * Funciones 100% puras, deterministas, sin dependencias externas ni efectos secundarios.
 * Cubre Unidad 3 (Vectores, Escalamiento Matricial, Progresión Aritmética, Sumatorias)
 * y carpintería real en melamina con aislamiento de herrajes/patas externas.
 */
import type {
  BaseMatrixScaleResult,
  BaseSupportType,
  BoardPiece,
  DespieceResult,
  EdgeBandingFlags,
  FurnitureTopology,
  HardwareItem,
  MatrixNx5Row,
  PieceMaterial,
  PieceType,
  ScaleAndBoardParams,
  ShelfProgressionData,
  StructuralAlert,
} from '../../types/contracts';

export {
  applyHomography,
  computeHomography,
  computeQuadToUnitHomography,
  invertMatrix3x3,
} from './homography';
export type { Matrix3x3 } from './homography';
export {
  CHILE_DUROLAC_SHEET,
  CHILE_MELAMINE_SHEET,
  PRESETS,
  clonePreset,
} from './presets';
export type { FurniturePreset, PresetKey } from './presets';

/** Matriz oficial M0 de validación algebraica Etapa 2 (0.8800 m², 6.80 m tapacanto). */
export const ETAPA2_BASE_MATRIX_M0: readonly [number, number, number][] = [
  [800, 400, 18],
  [800, 400, 18],
  [600, 400, 18],
];

const SPAN_WARNING_MM = 850;
const SPAN_CRITICAL_MM = 1050;
const SEGMENT_TOUCH_TOL = 1e-3;
const GEOM_EPS = 1e-4;

function clamp(val: number, min: number, max: number): number {
  if (val < min) return min;
  if (val > max) return max;
  return val;
}

function clamp01(val: number): number {
  return clamp(val, 0, 1);
}

/**
 * Convierte coordenada normalizada EXTERIOR [0,1] -> INTERIOR [0,1] SIN clamp
 * (útil para verificación exacta y detección de puntos fuera del vano interior).
 */
export function exteriorToInteriorRaw(p: number, e: number, dim: number): number {
  const denom = 1 - (2 * e) / dim;
  if (dim <= 0 || Math.abs(denom) < 1e-9) {
    return 0;
  }
  return (p - e / dim) / denom;
}

/**
 * Convierte coordenada normalizada EXTERIOR [0,1] -> INTERIOR [0,1] con clamping seguro.
 */
export function exteriorToInterior(p: number, e: number, dim: number): number {
  return clamp01(exteriorToInteriorRaw(p, e, dim));
}

/**
 * Convierte coordenada normalizada INTERIOR [0,1] -> EXTERIOR [0,1].
 */
export function interiorToExterior(p: number, e: number, dim: number): number {
  if (dim <= 0) {
    return 0;
  }
  return p * (1 - (2 * e) / dim) + e / dim;
}

export interface UnitDirectionVectorResult {
  /** Vector unitario 3D û_V = V / ||V|| ∈ ℝ³ (invariante bajo escalamiento uniforme k·V). */
  unit3D: [number, number, number];
  /** Vector unitario frontal 2D û_XY = (W, H) / ||(W, H)|| (invariante de silueta frontal). */
  unitXY: [number, number];
  /** Norma euclidiana ||V|| = √(W² + H² + D²) en mm. */
  magnitudeMm: number;
  /** Razón de aspecto frontal W / H = û_x / û_y. */
  aspectRatioXY: number;
}

/**
 * Calcula el vector unitario de forma û_V = V / ||V|| en ℝ³ y su proyección frontal û_XY.
 * Demuestra invariancia de forma bajo escalamiento homogéneo V' = k·V (û_{kV} = û_V).
 */
export function computeUnitDirectionVector(dims: {
  x: number;
  y: number;
  z: number;
}): UnitDirectionVectorResult {
  const x = Math.max(0, dims.x);
  const y = Math.max(0, dims.y);
  const z = Math.max(0, dims.z);
  const magnitudeMm = Math.hypot(x, y, z);
  const normXY = Math.hypot(x, y);

  if (magnitudeMm < 1e-9) {
    return {
      unit3D: [0, 0, 0],
      unitXY: [0, 0],
      magnitudeMm: 0,
      aspectRatioXY: 1,
    };
  }

  return {
    unit3D: [x / magnitudeMm, y / magnitudeMm, z / magnitudeMm],
    unitXY: normXY > 1e-9 ? [x / normXY, y / normXY] : [0, 0],
    magnitudeMm,
    aspectRatioXY: y > 1e-9 ? x / y : 1,
  };
}

export interface ShapeComparisonResult {
  photoRatioXY: number;
  realRatioXY: number;
  deformationFactor: number;
  warn: boolean;
  direction: 'ok' | 'estirado_horizontal' | 'estirado_vertical';
}

/**
 * Compara la proporción W/H real respecto a la proporción de referencia/foto (portado de SmartFurniture).
 * Advierte cuando la deformación sale del rango saludable [0.75, 1.33].
 */
export function compareShapeAspect(
  photoRatioXY: number,
  targetX: number,
  targetY: number,
): ShapeComparisonResult | null {
  if (!(photoRatioXY > 0) || !(targetX > 0) || !(targetY > 0)) {
    return null;
  }
  const realRatioXY = targetX / targetY;
  const deformationFactor = realRatioXY / photoRatioXY;
  const direction: ShapeComparisonResult['direction'] =
    deformationFactor > 1.33
      ? 'estirado_horizontal'
      : deformationFactor < 0.75
        ? 'estirado_vertical'
        : 'ok';

  return {
    photoRatioXY,
    realRatioXY,
    deformationFactor,
    warn: direction !== 'ok',
    direction,
  };
}

export interface ShelfDeflectionDIN {
  spanMm: number;
  depthMm: number;
  thicknessMm: number;
  loadKg: number;
  /** Flecha elástica Euler-Bernoulli δ = (5·P·L³) / (384·E·I) en mm. */
  deflectionMm: number;
  /** Límite admisible DIN 68874-1 (L / 200) en mm. */
  allowableMm: number;
  /** Carga máxima uniforme admisible antes de exceder L / 200 (kg). */
  maxLoadKg: number;
  passesDIN: boolean;
  status: 'Excelente' | 'Buena' | 'Al Límite' | 'Pandeo Severo';
}

export interface PieceDeflectionReport extends ShelfDeflectionDIN {
  id: string;
  nombre: string;
}

const MELAMINE_MDP_MODULUS_E = 2700; // N/mm² (MDP estándar)
const GRAVITY_MS2 = 9.80665;

/**
 * Calcula la flecha elástica máxima de una repisa simplemente apoyada bajo carga uniforme
 * según Euler-Bernoulli y la norma DIN 68874-1 (límite L/200).
 */
export function calculateShelfDeflectionDIN(
  spanMm: number,
  depthMm: number,
  thicknessMm = 18,
  loadKg = 25,
): ShelfDeflectionDIN {
  const L = Math.max(50, spanMm);
  const b = Math.max(80, depthMm);
  const e = Math.max(8, thicknessMm);
  const m = Math.max(1, loadKg);

  const I = (b * Math.pow(e, 3)) / 12;
  const P = m * GRAVITY_MS2;
  const L3 = Math.pow(L, 3);

  const deflectionMm = (5 * P * L3) / (384 * MELAMINE_MDP_MODULUS_E * I);
  const allowableMm = L / 200;
  const maxLoadN = (384 * MELAMINE_MDP_MODULUS_E * I * allowableMm) / (5 * L3);
  const maxLoadKg = maxLoadN / GRAVITY_MS2;
  const passesDIN = deflectionMm <= allowableMm;

  let status: ShelfDeflectionDIN['status'] = 'Excelente';
  if (deflectionMm > allowableMm * 1.33) {
    status = 'Pandeo Severo';
  } else if (!passesDIN) {
    status = 'Al Límite';
  } else if (deflectionMm > allowableMm * 0.5) {
    status = 'Buena';
  }

  return {
    spanMm: Number(L.toFixed(1)),
    depthMm: Number(b.toFixed(1)),
    thicknessMm: e,
    loadKg: m,
    deflectionMm: Number(deflectionMm.toFixed(2)),
    allowableMm: Number(allowableMm.toFixed(2)),
    maxLoadKg: Number(maxLoadKg.toFixed(1)),
    passesDIN,
    status,
  };
}

/**
 * Evalúa la rigidez estructural DIN 68874-1 de todas las repisas horizontales del despiece.
 */
export function analyzeShelvesDeflectionDIN(
  pieces: readonly BoardPiece[],
  loadKg = 25,
): PieceDeflectionReport[] {
  return pieces
    .filter((p) => p.tipo === 'repisa')
    .map((p) => ({
      id: p.id,
      nombre: p.nombre,
      ...calculateShelfDeflectionDIN(p.ancho, p.alto, p.espesor, loadKg),
    }));
}

/**
 * Operador algebraico puro de Etapa 2:
 * Aplica M = M0 · diag(kx, ky, 1) preservando invariante la 3ª columna (espesor e).
 */
export function scaleBaseMatrix(
  M0: readonly [number, number, number][],
  kx: number,
  ky: number,
): BaseMatrixScaleResult {
  const scaledMatrix: [number, number, number][] = M0.map(([w, h, e]) => [
    w * kx,
    h * ky,
    e,
  ]);

  let originalAreaMm2 = 0;
  let scaledAreaMm2 = 0;
  let originalPerimMm = 0;
  let scaledPerimMm = 0;

  for (let i = 0; i < M0.length; i++) {
    const [w0, h0] = M0[i];
    const [w1, h1] = scaledMatrix[i];
    originalAreaMm2 += w0 * h0;
    scaledAreaMm2 += w1 * h1;
    originalPerimMm += 2 * (w0 + h0);
    scaledPerimMm += 2 * (w1 + h1);
  }

  return {
    scaledMatrix,
    originalAreaM2: originalAreaMm2 / 1_000_000,
    scaledAreaM2: scaledAreaMm2 / 1_000_000,
    originalEdgeBandingMeters: originalPerimMm / 1000,
    scaledEdgeBandingMeters: scaledPerimMm / 1000,
  };
}

/**
 * Calcula la progresión aritmética exacta de N repisas equidistantes dentro de H_int = y_f - 2e.
 * `terms[k]` almacena la altura desde el piso de la CARA INFERIOR a_n (centro cy = a_n + e/2).
 */
export function calculateShelfProgression(
  yExteriorMm: number,
  boardThickness: number,
  shelfCount: number,
): ShelfProgressionData {
  const hInteriorMm = yExteriorMm - 2 * boardThickness;
  const count = Math.max(0, Math.floor(shelfCount));

  if (count === 0) {
    return {
      count: 0,
      hInteriorMm,
      clearSpanMm: hInteriorMm,
      a1: 0,
      d: 0,
      terms: [],
    };
  }

  const netSpace = hInteriorMm - count * boardThickness;
  if (hInteriorMm <= 0 || netSpace <= 0) {
    return {
      count,
      hInteriorMm,
      clearSpanMm: netSpace / (count + 1),
      a1: 0,
      d: 0,
      terms: [],
    };
  }

  const clearSpanMm = netSpace / (count + 1);
  const a1 = boardThickness + clearSpanMm;
  const d = clearSpanMm + boardThickness;
  const terms: number[] = [];
  for (let n = 1; n <= count; n++) {
    terms.push(a1 + (n - 1) * d);
  }

  return { count, hInteriorMm, clearSpanMm, a1, d, terms };
}

/**
 * Tabla normativa congelada de tapacanto por tipo de pieza, encuentro y modalidad.
 * `top`/`bottom` miden `ancho`; `left`/`right` miden `alto`.
 */
function resolveEdgeBanding(
  tipo: PieceType,
  joint: ScaleAndBoardParams['cornerJointType'],
  mode: ScaleAndBoardParams['edgeBandingMode'],
): EdgeBandingFlags {
  if (tipo === 'fondo' || tipo === 'fondo_cajon') {
    return { top: false, bottom: false, left: false, right: false };
  }
  if (tipo === 'puerta' || tipo === 'frente_cajon') {
    return { top: true, bottom: true, left: true, right: true };
  }
  if (mode === 'fullPerimeter') {
    return { top: true, bottom: true, left: true, right: true };
  }
  // visibleEdgesOnly
  if (tipo === 'costado_cajon' || tipo === 'trasera_cajon') {
    return { top: true, bottom: false, left: false, right: false };
  }
  if (tipo === 'zocalo' || tipo === 'faldon') {
    return { top: true, bottom: true, left: false, right: false };
  }
  if (tipo === 'cubierta' || tipo === 'base') {
    if (joint === 'topOverSides') {
      return { top: true, bottom: false, left: true, right: true };
    }
    return { top: true, bottom: false, left: false, right: false };
  }
  if (tipo === 'lateral') {
    if (joint === 'topOverSides') {
      return { top: true, bottom: false, left: false, right: false };
    }
    return { top: true, bottom: false, left: true, right: true };
  }
  // division_vertical y repisa: solo canto frontal visible
  return { top: true, bottom: false, left: false, right: false };
}

function computePieceEdgeBandingMm(piece: BoardPiece): number {
  let total = 0;
  if (piece.edges.top) total += piece.ancho;
  if (piece.edges.bottom) total += piece.ancho;
  if (piece.edges.left) total += piece.alto;
  if (piece.edges.right) total += piece.alto;
  return total;
}

interface ActiveDividerSpan {
  id: string;
  u: number;
  cx: number;
  y0: number;
  y1: number;
}

interface VirtualShelf {
  id: string;
  labelPrefix: string;
  cy: number;
  uStart: number;
  uEnd: number;
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

function buildHardwareSummary(topology: FurnitureTopology): HardwareItem[] {
  const items: HardwareItem[] = (topology.hardwareItems ?? []).map((item) => ({
    ...item,
  }));
  const support = resolveBaseSupport(topology);

  if (support.type === 'legs' || support.type === 'wheels') {
    const alreadyHasLegs = items.some((i) => i.categoria === 'patas');
    if (!alreadyHasLegs) {
      const isWheels = support.type === 'wheels';
      items.unshift({
        id: isWheels ? 'hw_ruedas_externas' : 'hw_patas_externas',
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
 * Calcula el despiece físico 1:1 completo, coordenadas 3D sin solapamiento,
 * matrices n×3 y n×5, alertas estructurales y resumen de herrajes no-melamina.
 */
export function calculateDespiece(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
): DespieceResult {
  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const { x: x0, y: y0, z: z0 } = params.referenceDimensions;
  const e = params.boardThickness;
  const backE = params.backPanelThickness;

  const scaleFactors = {
    kx: x0 > 0 ? xf / x0 : 1,
    ky: y0 > 0 ? yf / y0 : 1,
    kz: z0 > 0 ? zf / z0 : 1,
  };

  const alerts: StructuralAlert[] = [];
  const hardwareSummary = buildHardwareSummary(topology);
  const shelfProgression =
    topology.shelfMode === 'equidistant'
      ? calculateShelfProgression(yf, e, topology.equalShelfCount)
      : calculateShelfProgression(yf, e, 0);

  const xInt = xf - 2 * e;
  const yInt = yf - 2 * e;

  if (xf <= 0 || yf <= 0 || zf <= 0 || e <= 0 || xInt <= 0 || yInt <= 0) {
    alerts.push({
      id: 'alert_dim_invalida_carcasa',
      severidad: 'critical',
      tipo: 'dimension_invalida',
      mensaje: `Dimensiones interiores inválidas (x_int=${xInt.toFixed(1)} mm, y_int=${yInt.toFixed(1)} mm, z_f=${zf.toFixed(1)} mm).`,
      piezaId: 'carcasa',
    });
    return {
      scaleFactors,
      shelfProgression,
      matrizDespiece: [],
      matrixNx3: [],
      matrixNx5: [],
      consolidatedRows: [],
      totalNetAreaM2: 0,
      backPanelAreaM2: 0,
      totalEdgeBandingMeters: 0,
      alerts,
      hardwareSummary,
    };
  }

  if (
    topology.shelfMode === 'equidistant' &&
    topology.equalShelfCount > 0 &&
    shelfProgression.clearSpanMm <= 0
  ) {
    alerts.push({
      id: 'alert_repisas_no_caben',
      severidad: 'critical',
      tipo: 'dimension_invalida',
      mensaje: `No caben ${topology.equalShelfCount} repisas de ${e} mm en una altura interior de ${yInt.toFixed(1)} mm.`,
      piezaId: 'repisas_equidistantes',
    });
  }

  const pieces: BoardPiece[] = [];
  const mat: PieceMaterial = params.material;
  const joint = params.cornerJointType;
  const edgeMode = params.edgeBandingMode;

  // 1. CARCASA EXTERIOR (Base / Bases parciales con faldón, Cubierta recortada si hay escalón `void_outside`, Laterales)
  const support = resolveBaseSupport(topology);
  const horizWidth = joint === 'topOverSides' ? xf : xInt;
  const frontZones = topology.frontZones ?? [];
  const legVoidsAtBottom = frontZones.filter(
    (z) => z.kind === 'leg_void' && z.vStart <= SEGMENT_TOUCH_TOL,
  );
  const minCy = e + e / 2;
  const maxCy = yf - e - e / 2;
  const minMarginU = Math.min(0.49, (e / 2) / xInt);

  // Detección exacta de recortes escalonados (`void_outside`) en esquina superior derecha y/o izquierda
  interface StepCutout {
    u: number;
    v: number;
    x: number;
    cy: number;
    yBot: number;
    yTop: number;
  }

  const rawTopRight = frontZones.find(
    (z) =>
      z.kind === 'void_outside' &&
      z.uEnd >= 0.98 &&
      z.vEnd >= 0.98 &&
      z.uStart > 0.05 &&
      z.uStart < 0.95 &&
      z.vStart > 0.05 &&
      z.vStart < 0.95,
  );
  let stepR: StepCutout | null = null;
  if (rawTopRight) {
    const uR = clamp(rawTopRight.uStart, minMarginU, 1 - minMarginU);
    const xR = e + uR * xInt;
    const vR = clamp01(rawTopRight.vStart);
    const cyR = clamp(e + vR * yInt, minCy, maxCy);
    const yRBot = cyR - e / 2;
    const yRTop = cyR + e / 2;
    if (
      yRBot > e + GEOM_EPS &&
      yRTop < yf - e - GEOM_EPS &&
      xR + e / 2 < xf - e - GEOM_EPS &&
      xR - e / 2 > e + GEOM_EPS
    ) {
      stepR = { u: uR, v: vR, x: xR, cy: cyR, yBot: yRBot, yTop: yRTop };
    }
  }

  const rawTopLeft = frontZones.find(
    (z) =>
      z.kind === 'void_outside' &&
      z.uStart <= 0.02 &&
      z.vEnd >= 0.98 &&
      z.uEnd > 0.05 &&
      z.uEnd < 0.95 &&
      z.vStart > 0.05 &&
      z.vStart < 0.95,
  );
  let stepL: StepCutout | null = null;
  if (rawTopLeft) {
    const uL = clamp(rawTopLeft.uEnd, minMarginU, 1 - minMarginU);
    const xL = e + uL * xInt;
    const vL = clamp01(rawTopLeft.vStart);
    const cyL = clamp(e + vL * yInt, minCy, maxCy);
    const yLBot = cyL - e / 2;
    const yLTop = cyL + e / 2;
    if (
      yLBot > e + GEOM_EPS &&
      yLTop < yf - e - GEOM_EPS &&
      xL - e / 2 > e + GEOM_EPS &&
      xL + e / 2 < xf - e - GEOM_EPS &&
      (!stepR || xL + e / 2 < stepR.x - e / 2 - GEOM_EPS)
    ) {
      stepL = { u: uL, v: vL, x: xL, cy: cyL, yBot: yLBot, yTop: yLTop };
    }
  }

  if (legVoidsAtBottom.length === 0) {
    pieces.push({
      id: 'base',
      nombre: 'Base',
      tipo: 'base',
      ancho: horizWidth,
      alto: zf,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges: resolveEdgeBanding('base', joint, edgeMode),
      posicion3D: [xf / 2, e / 2, zf / 2],
      dimensiones3D: [horizWidth, e, zf],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  } else {
    // Escritorios: omitir base en hueco de piernas y agregar faldón trasero estructural
    const sortedVoids = [...legVoidsAtBottom].sort((a, b) => a.uStart - b.uStart);
    let curU = 0;
    let baseIdx = 1;
    for (const v of sortedVoids) {
      if (v.uStart - curU > 0.04) {
        const bx0 = e + curU * xInt;
        const bx1 = e + v.uStart * xInt - e / 2;
        const bw = bx1 - bx0;
        if (bw > e) {
          pieces.push({
            id: `base_pedestal_${baseIdx++}`,
            nombre: `Base Pedestal ${baseIdx - 1}`,
            tipo: 'base',
            ancho: bw,
            alto: zf,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('base', joint, edgeMode),
            posicion3D: [(bx0 + bx1) / 2, e / 2, zf / 2],
            dimensiones3D: [bw, e, zf],
            rotacion3D: [0, 0, 0],
            material: mat,
          });
        }
      }
      const fx0 = e + v.uStart * xInt + (v.uStart > 0.02 ? e / 2 : 0);
      const fx1 = e + v.uEnd * xInt - (v.uEnd < 0.98 ? e / 2 : 0);
      const fw = fx1 - fx0;
      const fTop = e + v.vEnd * yInt - e / 2;
      const fh = Math.max(160, Math.min(360, (v.vEnd - v.vStart) * yInt * 0.45));
      // Generar faldón trasero solo en el hueco principal de piernas (evita duplicarlo bajo cajoneras estrechas)
      if (fw >= xInt * 0.34 && fTop - fh > e) {
        pieces.push({
          id: `faldon_${v.id}`,
          nombre: 'Faldón Trasero Escritorio',
          tipo: 'faldon',
          ancho: fw,
          alto: fh,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('faldon', joint, edgeMode),
          posicion3D: [(fx0 + fx1) / 2, fTop - fh / 2, e / 2],
          dimensiones3D: [fw, fh, e],
          rotacion3D: [0, 0, 0],
          material: mat,
        });
      }
      curU = Math.max(curU, v.uEnd);
    }
    if (1 - curU > 0.04) {
      const bx0 = e + curU * xInt + e / 2;
      const bx1 = xf - e;
      const bw = bx1 - bx0;
      if (bw > e) {
        pieces.push({
          id: `base_pedestal_${baseIdx++}`,
          nombre: `Base Pedestal ${baseIdx - 1}`,
          tipo: 'base',
          ancho: bw,
          alto: zf,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('base', joint, edgeMode),
          posicion3D: [(bx0 + bx1) / 2, e / 2, zf / 2],
          dimensiones3D: [bw, e, zf],
          rotacion3D: [0, 0, 0],
          material: mat,
        });
      }
    }
  }

  // Cubierta (recortada exactamente si existe `void_outside` superior derecho o izquierdo)
  const xCub0 = stepL ? stepL.x - e / 2 : joint === 'topOverSides' ? 0 : e;
  const xCub1 = stepR ? stepR.x + e / 2 : joint === 'topOverSides' ? xf : xf - e;
  const cubWidth = xCub1 - xCub0;
  const cubEdges = { ...resolveEdgeBanding('cubierta', joint, edgeMode) };
  if (stepR) cubEdges.right = true;
  if (stepL) cubEdges.left = true;
  pieces.push({
    id: 'cubierta',
    nombre: 'Cubierta',
    tipo: 'cubierta',
    ancho: cubWidth,
    alto: zf,
    espesor: e,
    cantidad: 1,
    respectGrain: true,
    edges: cubEdges,
    posicion3D: [(xCub0 + xCub1) / 2, yf - e / 2, zf / 2],
    dimensiones3D: [cubWidth, e, zf],
    rotacion3D: [0, 0, 0],
    material: mat,
  });

  // Laterales (ancho = altura veta VERTICAL en eje Y, alto = zf profundidad; recortados en escalón)
  const yL0 = joint === 'topOverSides' ? e : 0;
  const yL1 = stepL
    ? joint === 'topOverSides'
      ? stepL.yBot
      : stepL.yTop
    : joint === 'topOverSides'
      ? yf - e
      : yf;
  const hLeft = yL1 - yL0;

  pieces.push({
    id: 'lateral_izq',
    nombre: 'Lateral Izquierdo',
    tipo: 'lateral',
    ancho: hLeft,
    alto: zf,
    espesor: e,
    cantidad: 1,
    respectGrain: true,
    edges: resolveEdgeBanding('lateral', joint, edgeMode),
    posicion3D: [e / 2, (yL0 + yL1) / 2, zf / 2],
    dimensiones3D: [e, hLeft, zf],
    rotacion3D: [0, 0, 0],
    material: mat,
  });

  const yR0 = joint === 'topOverSides' ? e : 0;
  const yR1 = stepR
    ? joint === 'topOverSides'
      ? stepR.yBot
      : stepR.yTop
    : joint === 'topOverSides'
      ? yf - e
      : yf;
  const hRight = yR1 - yR0;

  pieces.push({
    id: 'lateral_der',
    nombre: 'Lateral Derecho',
    tipo: 'lateral',
    ancho: hRight,
    alto: zf,
    espesor: e,
    cantidad: 1,
    respectGrain: true,
    edges: resolveEdgeBanding('lateral', joint, edgeMode),
    posicion3D: [xf - e / 2, (yR0 + yR1) / 2, zf / 2],
    dimensiones3D: [e, hRight, zf],
    rotacion3D: [0, 0, 0],
    material: mat,
  });

  // 2. PREPARACIÓN DE REPISAS VIRTUALES (permite recorte simétrico ±e/2 en divisores parciales y repisas interiores)
  const virtualShelves: VirtualShelf[] = [];

  if (topology.shelfMode === 'equidistant') {
    shelfProgression.terms.forEach((an, idx) => {
      const cy = an + e / 2;
      if (cy >= minCy - GEOM_EPS && cy <= maxCy + GEOM_EPS) {
        virtualShelves.push({
          id: `repisa_eq_${idx + 1}`,
          labelPrefix: `Repisa ${idx + 1}`,
          cy,
          uStart: 0,
          uEnd: 1,
        });
      }
    });
  } else {
    topology.hShelves.forEach((seg, idx) => {
      const rawCy = e + clamp01(seg.position) * yInt;
      const cy = clamp(rawCy, minCy, maxCy);
      const uStart = clamp01(Math.min(seg.start, seg.end));
      const uEnd = clamp01(Math.max(seg.start, seg.end));
      if (uEnd - uStart <= GEOM_EPS) {
        alerts.push({
          id: `alert_rep_invalida_${seg.id}`,
          severidad: 'critical',
          tipo: 'dimension_invalida',
          mensaje: `Repisa "${seg.id}" tiene extensión horizontal nula.`,
          piezaId: seg.id,
        });
        return;
      }
      virtualShelves.push({
        id: seg.id || `repisa_${idx + 1}`,
        labelPrefix: `Repisa ${idx + 1}`,
        cy,
        uStart,
        uEnd,
      });
    });
  }

  // Repisas interiores opcionales definidas dentro de zonas (`zone.internalShelves > 0`)
  for (const zone of frontZones) {
    const nInt = Math.max(0, Math.min(6, Math.round(zone.internalShelves ?? 0)));
    if (
      nInt <= 0 ||
      zone.kind === 'drawers' ||
      zone.kind === 'baskets' ||
      zone.kind === 'leg_void' ||
      zone.kind === 'void_outside'
    ) {
      continue;
    }
    const zU0 = clamp01(Math.min(zone.uStart, zone.uEnd));
    const zU1 = clamp01(Math.max(zone.uStart, zone.uEnd));
    const zV0 = clamp01(Math.min(zone.vStart, zone.vEnd));
    const zV1 = clamp01(Math.max(zone.vStart, zone.vEnd));
    const y0Zone = e + zV0 * yInt;
    const y1Zone = e + zV1 * yInt;
    const hZone = y1Zone - y0Zone;
    const netSpace = hZone - nInt * e;
    if (zU1 - zU0 <= 0.04 || netSpace <= 20) continue;
    const clearGap = netSpace / (nInt + 1);
    for (let k = 1; k <= nInt; k++) {
      const cy = clamp(y0Zone + k * clearGap + (k - 0.5) * e, minCy, maxCy);
      virtualShelves.push({
        id: `rep_int_${zone.id}_${k}`,
        labelPrefix: `Repisa Interior ${zone.label ?? zone.id} #${k}`,
        cy,
        uStart: zU0,
        uEnd: zU1,
      });
    }
  }

  // 3. DIVISORES VERTICALES (continuos y parciales con recorte exacto contra repisas, escalones y anti-colisión)
  const sortedDivs = [...topology.vDividers].sort((a, b) => a.position - b.position);
  const activeDividers: ActiveDividerSpan[] = [];
  const shelfTouchTolMm = Math.max(e * 0.65, yInt * 0.015);

  for (let i = 0; i < sortedDivs.length; i++) {
    const seg = sortedDivs[i];
    const u = clamp(seg.position, minMarginU, 1 - minMarginU);
    const vStart = clamp01(Math.min(seg.start, seg.end));
    const vEnd = clamp01(Math.max(seg.start, seg.end));
    let divY0 = e + vStart * yInt;
    let divY1 = e + vEnd * yInt;
    const cx = e + u * xInt;

    // Si es un divisor parcial que arranca o termina sobre una repisa horizontal,
    // descontar exactamente ±e/2 para topar contra la cara superior/inferior sin solapar en 3D.
    if (vStart > SEGMENT_TOUCH_TOL) {
      const bottomShelf = virtualShelves.find(
        (sh) =>
          Math.abs(sh.cy - divY0) <= shelfTouchTolMm &&
          u >= sh.uStart - SEGMENT_TOUCH_TOL &&
          u <= sh.uEnd + SEGMENT_TOUCH_TOL,
      );
      if (bottomShelf) {
        divY0 = bottomShelf.cy + e / 2;
      } else if (stepR && u >= stepR.u - SEGMENT_TOUCH_TOL && Math.abs(stepR.cy - divY0) <= shelfTouchTolMm) {
        divY0 = stepR.yTop;
      } else if (stepL && u <= stepL.u + SEGMENT_TOUCH_TOL && Math.abs(stepL.cy - divY0) <= shelfTouchTolMm) {
        divY0 = stepL.yTop;
      }
    }
    if (vEnd < 1 - SEGMENT_TOUCH_TOL) {
      const topShelf = virtualShelves.find(
        (sh) =>
          Math.abs(sh.cy - divY1) <= shelfTouchTolMm &&
          u >= sh.uStart - SEGMENT_TOUCH_TOL &&
          u <= sh.uEnd + SEGMENT_TOUCH_TOL,
      );
      if (topShelf) {
        divY1 = topShelf.cy - e / 2;
      } else if (stepR && u >= stepR.u - SEGMENT_TOUCH_TOL && Math.abs(stepR.cy - divY1) <= shelfTouchTolMm) {
        divY1 = stepR.yBot;
      } else if (stepL && u <= stepL.u + SEGMENT_TOUCH_TOL && Math.abs(stepL.cy - divY1) <= shelfTouchTolMm) {
        divY1 = stepL.yBot;
      }
    }

    // Recorte contra vacío exterior escalonado (solo divisores estrictamente dentro del área recortada)
    if (stepR && u > stepR.u + SEGMENT_TOUCH_TOL) {
      divY1 = Math.min(divY1, stepR.yBot);
      if (divY1 - divY0 <= GEOM_EPS) continue;
    }
    if (stepL && u < stepL.u - SEGMENT_TOUCH_TOL) {
      divY1 = Math.min(divY1, stepL.yBot);
      if (divY1 - divY0 <= GEOM_EPS) continue;
    }

    const dy = divY1 - divY0;

    if (dy <= GEOM_EPS) {
      alerts.push({
        id: `alert_div_invalido_${seg.id}`,
        severidad: 'critical',
        tipo: 'dimension_invalida',
        mensaje: `Divisor vertical "${seg.id}" descartado por altura nula o negativa.`,
        piezaId: seg.id,
      });
      continue;
    }

    // Evitar colisión con otro divisor colocado a menos de `e` mm en el mismo rango Y
    const collides = activeDividers.some(
      (prev) =>
        Math.abs(cx - prev.cx) < e - GEOM_EPS &&
        prev.y0 < divY1 - GEOM_EPS &&
        prev.y1 > divY0 + GEOM_EPS,
    );
    if (collides) {
      alerts.push({
        id: `alert_div_colision_${seg.id}`,
        severidad: 'critical',
        tipo: 'dimension_invalida',
        mensaje: `Divisor vertical "${seg.id}" colisiona con otro divisor (< ${e} mm de separación).`,
        piezaId: seg.id,
      });
      continue;
    }

    activeDividers.push({ id: seg.id, u, cx, y0: divY0, y1: divY1 });

    pieces.push({
      id: seg.id || `div_${i + 1}`,
      nombre: `Divisor Vertical ${activeDividers.length}`,
      tipo: 'division_vertical',
      ancho: dy, // veta vertical (eje Y)
      alto: zf,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges: resolveEdgeBanding('division_vertical', joint, edgeMode),
      posicion3D: [cx, (divY0 + divY1) / 2, zf / 2],
      dimensiones3D: [e, dy, zf],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  // 3B. AUTO-CIERRE VERTICAL DE TORRE EN ESCALÓN + CUBIERTAS DE ESCALÓN (0.000 mm overlap)
  const placedShelves: Array<{ x0: number; x1: number; cy: number }> = [];

  if (stepR) {
    const hasTowerWallR = activeDividers.some(
      (d) =>
        Math.abs(d.u - stepR.u) <= SEGMENT_TOUCH_TOL &&
        d.y0 <= stepR.yTop + GEOM_EPS &&
        d.y1 >= yf - e - GEOM_EPS,
    );
    if (!hasTowerWallR) {
      const twH = yf - e - stepR.yTop;
      if (twH > GEOM_EPS) {
        activeDividers.push({
          id: 'lateral_escalon_der',
          u: stepR.u,
          cx: stepR.x,
          y0: stepR.yTop,
          y1: yf - e,
        });
        pieces.push({
          id: 'lateral_escalon_der',
          nombre: 'Lateral Escalón Der',
          tipo: 'lateral',
          ancho: twH,
          alto: zf,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('lateral', joint, edgeMode),
          posicion3D: [stepR.x, (stepR.yTop + (yf - e)) / 2, zf / 2],
          dimensiones3D: [e, twH, zf],
          rotacion3D: [0, 0, 0],
          material: mat,
        });
      }
    }

    const divCrossesR = activeDividers.some(
      (d) =>
        Math.abs(d.u - stepR.u) <= SEGMENT_TOUCH_TOL &&
        d.y0 < stepR.yTop - GEOM_EPS &&
        d.y1 > stepR.yBot + GEOM_EPS,
    );
    const leftShelfAtStepR = virtualShelves.some(
      (s) =>
        Math.abs(s.cy - stepR.cy) < e - GEOM_EPS &&
        s.uStart < stepR.u - SEGMENT_TOUCH_TOL &&
        s.uEnd >= stepR.u - SEGMENT_TOUCH_TOL,
    );
    const xStepR0 = divCrossesR ? stepR.x + e / 2 : leftShelfAtStepR ? stepR.x : stepR.x - e / 2;
    const xStepR1 = joint === 'topOverSides' ? xf : xf - e;
    const wStepR = xStepR1 - xStepR0;
    if (wStepR > GEOM_EPS) {
      placedShelves.push({ x0: xStepR0, x1: xStepR1, cy: stepR.cy });
      pieces.push({
        id: 'cubierta_escalon_der',
        nombre: 'Cubierta Escalón Der',
        tipo: 'cubierta',
        ancho: wStepR,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges:
          edgeMode === 'fullPerimeter'
            ? { top: true, bottom: true, left: true, right: true }
            : { top: true, bottom: false, left: false, right: joint === 'topOverSides' },
        posicion3D: [(xStepR0 + xStepR1) / 2, stepR.cy, zf / 2],
        dimensiones3D: [wStepR, e, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    }
  }

  if (stepL) {
    const hasTowerWallL = activeDividers.some(
      (d) =>
        Math.abs(d.u - stepL.u) <= SEGMENT_TOUCH_TOL &&
        d.y0 <= stepL.yTop + GEOM_EPS &&
        d.y1 >= yf - e - GEOM_EPS,
    );
    if (!hasTowerWallL) {
      const twH = yf - e - stepL.yTop;
      if (twH > GEOM_EPS) {
        activeDividers.push({
          id: 'lateral_escalon_izq',
          u: stepL.u,
          cx: stepL.x,
          y0: stepL.yTop,
          y1: yf - e,
        });
        pieces.push({
          id: 'lateral_escalon_izq',
          nombre: 'Lateral Escalón Izq',
          tipo: 'lateral',
          ancho: twH,
          alto: zf,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('lateral', joint, edgeMode),
          posicion3D: [stepL.x, (stepL.yTop + (yf - e)) / 2, zf / 2],
          dimensiones3D: [e, twH, zf],
          rotacion3D: [0, 0, 0],
          material: mat,
        });
      }
    }

    const divCrossesL = activeDividers.some(
      (d) =>
        Math.abs(d.u - stepL.u) <= SEGMENT_TOUCH_TOL &&
        d.y0 < stepL.yTop - GEOM_EPS &&
        d.y1 > stepL.yBot + GEOM_EPS,
    );
    const rightShelfAtStepL = virtualShelves.some(
      (s) =>
        Math.abs(s.cy - stepL.cy) < e - GEOM_EPS &&
        s.uEnd > stepL.u + SEGMENT_TOUCH_TOL &&
        s.uStart <= stepL.u + SEGMENT_TOUCH_TOL,
    );
    const xStepL0 = joint === 'topOverSides' ? 0 : e;
    const xStepL1 = divCrossesL ? stepL.x - e / 2 : rightShelfAtStepL ? stepL.x : stepL.x + e / 2;
    const wStepL = xStepL1 - xStepL0;
    if (wStepL > GEOM_EPS) {
      placedShelves.push({ x0: xStepL0, x1: xStepL1, cy: stepL.cy });
      pieces.push({
        id: 'cubierta_escalon_izq',
        nombre: 'Cubierta Escalón Izq',
        tipo: 'cubierta',
        ancho: wStepL,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges:
          edgeMode === 'fullPerimeter'
            ? { top: true, bottom: true, left: true, right: true }
            : { top: true, bottom: false, left: joint === 'topOverSides', right: false },
        posicion3D: [(xStepL0 + xStepL1) / 2, stepL.cy, zf / 2],
        dimensiones3D: [wStepL, e, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });
    }
  }

  // 4. PIPELINE UNIFICADO DE REPISAS (`equidistant`, `custom` e interiores pasan por el MISMO recortador)
  for (const rawShelf of virtualShelves) {
    let sUStart = rawShelf.uStart;
    let sUEnd = rawShelf.uEnd;
    if (stepR && rawShelf.cy + e / 2 > stepR.yBot + GEOM_EPS) {
      sUEnd = Math.min(sUEnd, stepR.u);
    }
    if (stepL && rawShelf.cy + e / 2 > stepL.yBot + GEOM_EPS) {
      sUStart = Math.max(sUStart, stepL.u);
    }
    if (sUEnd - sUStart <= GEOM_EPS) continue;
    const shelf: VirtualShelf = { ...rawShelf, uStart: sUStart, uEnd: sUEnd };
    // Divisores verticales que se cruzan con la banda Y de esta repisa
    const crossingDivs = activeDividers.filter(
      (div) => div.y0 < shelf.cy + e / 2 - GEOM_EPS && div.y1 > shelf.cy - e / 2 + GEOM_EPS,
    );

    const interiorCuts = crossingDivs
      .filter(
        (div) =>
          div.u > shelf.uStart + SEGMENT_TOUCH_TOL &&
          div.u < shelf.uEnd - SEGMENT_TOUCH_TOL,
      )
      .map((div) => div.u);

    const splitPoints = [shelf.uStart, ...interiorCuts, shelf.uEnd];

    for (let sIdx = 0; sIdx < splitPoints.length - 1; sIdx++) {
      const a = splitPoints[sIdx];
      const b = splitPoints[sIdx + 1];

      const touchesLeftDiv = crossingDivs.some((div) => Math.abs(div.u - a) <= SEGMENT_TOUCH_TOL);
      const touchesRightDiv = crossingDivs.some((div) => Math.abs(div.u - b) <= SEGMENT_TOUCH_TOL);

      const xLeft = e + a * xInt + (touchesLeftDiv ? e / 2 : 0);
      const xRight = e + b * xInt - (touchesRightDiv ? e / 2 : 0);
      const dx = xRight - xLeft;

      const pieceId =
        splitPoints.length > 2 ? `${shelf.id}_tramo_${sIdx + 1}` : shelf.id;
      const pieceName =
        splitPoints.length > 2
          ? `${shelf.labelPrefix} (Vano ${sIdx + 1})`
          : shelf.labelPrefix;

      if (dx <= GEOM_EPS) {
        alerts.push({
          id: `alert_rep_cero_${pieceId}`,
          severidad: 'critical',
          tipo: 'dimension_invalida',
          mensaje: `${pieceName} resultó con ancho útil <= 0 mm tras descontar divisores.`,
          piezaId: pieceId,
        });
        continue;
      }

      const overlapsVertical = placedShelves.some(
        (prev) =>
          Math.abs(prev.cy - shelf.cy) < e - GEOM_EPS &&
          prev.x0 < xRight - GEOM_EPS &&
          prev.x1 > xLeft + GEOM_EPS,
      );
      if (overlapsVertical) {
        alerts.push({
          id: `alert_rep_colision_${pieceId}`,
          severidad: 'critical',
          tipo: 'dimension_invalida',
          mensaje: `${pieceName} colisiona verticalmente con otra repisa (< ${e} mm).`,
          piezaId: pieceId,
        });
        continue;
      }

      placedShelves.push({ x0: xLeft, x1: xRight, cy: shelf.cy });

      pieces.push({
        id: pieceId,
        nombre: pieceName,
        tipo: 'repisa',
        ancho: dx,
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('repisa', joint, edgeMode),
        posicion3D: [(xLeft + xRight) / 2, shelf.cy, zf / 2],
        dimensiones3D: [dx, e, zf],
        rotacion3D: [0, 0, 0],
        material: mat,
      });

      if (dx > SPAN_WARNING_MM + GEOM_EPS) {
        const din = calculateShelfDeflectionDIN(dx, zf, e, 25);
        alerts.push({
          id: `alert_pandeo_${pieceId}`,
          severidad: dx > SPAN_CRITICAL_MM || !din.passesDIN ? (dx > SPAN_CRITICAL_MM ? 'critical' : 'warning') : 'warning',
          tipo: 'pandeo',
          mensaje: `${pieceName} supera los ${SPAN_WARNING_MM} mm de luz libre (${dx.toFixed(1)} mm). Flecha DIN 68874-1: ${din.deflectionMm.toFixed(2)} mm bajo 25 kg (límite L/200 = ${din.allowableMm.toFixed(2)} mm, máx. ${din.maxLoadKg.toFixed(1)} kg). Agregue un divisor vertical.`,
          piezaId: pieceId,
          luzLibreMm: dx,
        });
      }
    }
  }

  // 4A. DIVISIONES DIAGONALES / OBLICUAS (longitud física real L y rotación Z exacta)
  const diagonalDividers = topology.diagonalDividers ?? [];
  for (let dIdx = 0; dIdx < diagonalDividers.length; dIdx++) {
    const seg = diagonalDividers[dIdx];
    const x1 = e + clamp01(seg.u1) * xInt;
    const y1 = e + clamp01(seg.v1) * yInt;
    const x2 = e + clamp01(seg.u2) * xInt;
    const y2 = e + clamp01(seg.v2) * yInt;
    const dxDiag = x2 - x1;
    const dyDiag = y2 - y1;
    const lenDiag = Math.hypot(dxDiag, dyDiag);
    if (lenDiag < e * 1.5) continue;

    const theta = Math.atan2(dyDiag, dxDiag);
    const deg = Math.round(Math.abs((theta * 180) / Math.PI));
    pieces.push({
      id: seg.id || `diag_${dIdx + 1}`,
      nombre: `Divisor Diagonal ${dIdx + 1} (${deg}°)`,
      tipo: 'division_diagonal',
      ancho: lenDiag,
      alto: zf,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges: resolveEdgeBanding('division_diagonal', joint, edgeMode),
      posicion3D: [(x1 + x2) / 2, (y1 + y2) / 2, zf / 2],
      dimensiones3D: [lenDiag, e, zf],
      rotacion3D: [0, 0, theta],
      material: mat,
    });
  }

  // 4. FONDO DUROLAC / MDF 3 mm (clavado atrás en z ∈ [-backE, 0]; segmentado por escalones `void_outside`)
  if (topology.hasBackPanel && backE > 0) {
    const backSheet = params.backPanelSheetDimensions ?? params.sheetDimensions;
    const minS = Math.min(backSheet.width, backSheet.height);
    const maxS = Math.max(backSheet.width, backSheet.height);

    const backStrips: Array<{ x0: number; x1: number; h: number; label: string }> = [];
    if (stepL && stepR) {
      backStrips.push({ x0: 0, x1: stepL.x - e / 2, h: stepL.yTop, label: 'Escalón Izq' });
      backStrips.push({ x0: stepL.x - e / 2, x1: stepR.x + e / 2, h: yf, label: 'Cuerpo Alto' });
      backStrips.push({ x0: stepR.x + e / 2, x1: xf, h: stepR.yTop, label: 'Escalón Der' });
    } else if (stepR) {
      backStrips.push({ x0: 0, x1: stepR.x + e / 2, h: yf, label: 'Cuerpo Alto' });
      backStrips.push({ x0: stepR.x + e / 2, x1: xf, h: stepR.yTop, label: 'Escalón Der' });
    } else if (stepL) {
      backStrips.push({ x0: 0, x1: stepL.x - e / 2, h: stepL.yTop, label: 'Escalón Izq' });
      backStrips.push({ x0: stepL.x - e / 2, x1: xf, h: yf, label: 'Cuerpo Alto' });
    } else {
      backStrips.push({ x0: 0, x1: xf, h: yf, label: '' });
    }

    const backSubPanels: Array<{ x0: number; x1: number; h: number; label: string }> = [];
    for (const strip of backStrips) {
      const swStrip = strip.x1 - strip.x0;
      const shStrip = strip.h;
      if (swStrip <= GEOM_EPS || shStrip <= GEOM_EPS) continue;
      const needsSplit = (swStrip > minS && shStrip > minS) || swStrip > maxS || shStrip > maxS;
      let xCuts: number[] = [strip.x0, strip.x1];

      if (needsSplit) {
        const innerDivs = activeDividers.filter(
          (d) =>
            d.cx > strip.x0 + e &&
            d.cx < strip.x1 - e &&
            d.y0 <= e + 1 &&
            d.y1 >= shStrip - e - 1,
        );
        if (innerDivs.length > 0) {
          const candidateCuts = [strip.x0, ...innerDivs.map((d) => d.cx), strip.x1];
          const allPanelsFit = candidateCuts.every((cut, idx) => {
            if (idx === candidateCuts.length - 1) return true;
            const pw = candidateCuts[idx + 1] - cut;
            return (pw <= maxS && shStrip <= minS) || (pw <= minS && shStrip <= maxS);
          });
          if (allPanelsFit) {
            xCuts = candidateCuts;
          } else {
            const maxAllowedW = shStrip <= maxS ? minS : maxS;
            const panels = Math.max(2, Math.ceil(swStrip / Math.max(1, maxAllowedW)));
            xCuts = Array.from({ length: panels + 1 }, (_, k) => strip.x0 + (swStrip * k) / panels);
          }
        } else {
          const maxAllowedW = shStrip <= maxS ? minS : maxS;
          const panels = Math.max(2, Math.ceil(swStrip / Math.max(1, maxAllowedW)));
          xCuts = Array.from({ length: panels + 1 }, (_, k) => strip.x0 + (swStrip * k) / panels);
        }
      }

      for (let k = 0; k < xCuts.length - 1; k++) {
        backSubPanels.push({ x0: xCuts[k], x1: xCuts[k + 1], h: shStrip, label: strip.label });
      }
    }

    const totalPanels = backSubPanels.length;
    backSubPanels.forEach((bp, pIdx) => {
      const pw = bp.x1 - bp.x0;
      const pId = totalPanels > 1 ? `fondo_${pIdx + 1}` : 'fondo';
      const pName =
        totalPanels > 1
          ? bp.label
            ? `Fondo 3mm (${bp.label})`
            : `Fondo 3mm (Paño ${pIdx + 1}/${totalPanels})`
          : 'Fondo 3mm';

      pieces.push({
        id: pId,
        nombre: pName,
        tipo: 'fondo',
        ancho: pw,
        alto: bp.h,
        espesor: backE,
        cantidad: 1,
        respectGrain: false,
        edges: resolveEdgeBanding('fondo', joint, edgeMode),
        posicion3D: [(bp.x0 + bp.x1) / 2, bp.h / 2, -backE / 2],
        dimensiones3D: [pw, bp.h, backE],
        rotacion3D: [0, 0, 0],
        material: 'durolac_3mm',
      });
    });
  }

  // 4B. ZONAS FRONTALES FUNCIONALES: PUERTAS, CAJONES (5 PIEZAS), CANASTOS (HERRAJE) Y ZÓCALO
  let autoHinges = 0;
  let autoSlidesPairs = 0;
  let autoGlassPanels = 0;
  let autoFrontHandles = 0;
  let autoBaskets = 0;
  let basketRefWidthMm = 300;
  let slideNominalLenMm = 350;

  for (const zone of frontZones) {
    if (zone.kind === 'open' || zone.kind === 'leg_void' || zone.kind === 'void_outside') continue;

    const zU0 = clamp01(Math.min(zone.uStart, zone.uEnd));
    const zU1 = clamp01(Math.max(zone.uStart, zone.uEnd));
    const zV0 = clamp01(Math.min(zone.vStart, zone.vEnd));
    const zV1 = clamp01(Math.max(zone.vStart, zone.vEnd));

    const zoneX0 = e + zU0 * xInt;
    const zoneX1 = e + zU1 * xInt;
    const zoneY0 = e + zV0 * yInt;
    const zoneY1 = e + zV1 * yInt;

    const touchesL = activeDividers.some((d) => Math.abs(d.u - zU0) <= SEGMENT_TOUCH_TOL);
    const touchesR = activeDividers.some((d) => Math.abs(d.u - zU1) <= SEGMENT_TOUCH_TOL);
    const xInner0 = zoneX0 + (touchesL ? e / 2 : 0);
    const xInner1 = zoneX1 - (touchesR ? e / 2 : 0);
    const innerW = xInner1 - xInner0;

    if (zone.kind === 'baskets') {
      autoBaskets += Math.max(1, Math.min(6, Math.round(zone.basketCount ?? 3)));
      basketRefWidthMm = Math.max(120, Math.round(innerW));
      continue;
    }

    const underStepR =
      stepR !== null &&
      zU0 >= stepR.u - SEGMENT_TOUCH_TOL &&
      Math.abs(zV1 - stepR.v) <= 0.025;
    const underStepL =
      stepL !== null &&
      zU1 <= stepL.u + SEGMENT_TOUCH_TOL &&
      Math.abs(zV1 - stepL.v) <= 0.025;

    const frontX0 = zU0 <= SEGMENT_TOUCH_TOL ? 2 : zoneX0 + 1.5;
    const frontX1 = zU1 >= 1 - SEGMENT_TOUCH_TOL ? xf - 2 : zoneX1 - 1.5;
    const frontY0 = zV0 <= SEGMENT_TOUCH_TOL ? 2 : zoneY0 + 1.5;
    const frontY1 =
      zV1 >= 1 - SEGMENT_TOUCH_TOL
        ? yf - 2
        : underStepR && stepR
          ? stepR.yTop - 2
          : underStepL && stepL
            ? stepL.yTop - 2
            : zoneY1 - 1.5;
    const frontW = frontX1 - frontX0;
    const frontH = frontY1 - frontY0;
    const frontMat: PieceMaterial = zone.materialOverride ?? mat;
    const frontCz = zf + 1 + e / 2;

    if (frontW <= 30 || frontH <= 30) continue;

    if (zone.kind === 'door_left' || zone.kind === 'door_right' || zone.kind === 'door_glass') {
      const label = zone.label ?? (zone.kind === 'door_glass' ? 'Puerta Marco Vidrio' : 'Puerta');
      pieces.push({
        id: `puerta_${zone.id}`,
        nombre: label,
        tipo: 'puerta',
        ancho: frontH,
        alto: frontW,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('puerta', joint, edgeMode),
        posicion3D: [(frontX0 + frontX1) / 2, (frontY0 + frontY1) / 2, frontCz],
        dimensiones3D: [frontW, frontH, e],
        rotacion3D: [0, 0, 0],
        material: frontMat,
      });
      autoHinges += frontH > 900 ? 3 : 2;
      autoFrontHandles += 1;
      if (zone.kind === 'door_glass') autoGlassPanels += 1;
    } else if (zone.kind === 'door_double') {
      const leafW = (frontW - 3) / 2;
      if (leafW > 25) {
        const cxL = frontX0 + leafW / 2;
        const cxR = frontX1 - leafW / 2;
        for (const [suffix, cxLeaf] of [
          ['izq', cxL],
          ['der', cxR],
        ] as const) {
          pieces.push({
            id: `puerta_${zone.id}_${suffix}`,
            nombre: `${zone.label ?? 'Puerta Doble'} (${suffix.toUpperCase()})`,
            tipo: 'puerta',
            ancho: frontH,
            alto: leafW,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('puerta', joint, edgeMode),
            posicion3D: [cxLeaf, (frontY0 + frontY1) / 2, frontCz],
            dimensiones3D: [leafW, frontH, e],
            rotacion3D: [0, 0, 0],
            material: frontMat,
          });
          autoHinges += frontH > 900 ? 3 : 2;
          autoFrontHandles += 1;
        }
      }
    } else if (zone.kind === 'drawers') {
      const nDrawers = Math.max(1, Math.min(8, Math.round(zone.drawerCount ?? 3)));
      const stepH = frontH / nDrawers;
      const boxDepth = Math.max(150, Math.min(zf - 50, 450));
      slideNominalLenMm = Math.max(250, Math.floor(boxDepth / 50) * 50);
      const slideClearance = 13;
      const boxOuterW = innerW - 2 * slideClearance;

      for (let d = 0; d < nDrawers; d++) {
        const dy0 = frontY0 + d * stepH + 1.5;
        const dy1 = frontY0 + (d + 1) * stepH - 1.5;
        const fh = dy1 - dy0;
        const fCy = (dy0 + dy1) / 2;
        const dTag = `${zone.id}_c${d + 1}`;
        const dLabel = `Cajón ${d + 1}/${nDrawers}`;

        pieces.push({
          id: `frente_${dTag}`,
          nombre: `Frente ${dLabel}`,
          tipo: 'frente_cajon',
          ancho: frontW,
          alto: fh,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: resolveEdgeBanding('frente_cajon', joint, edgeMode),
          posicion3D: [(frontX0 + frontX1) / 2, fCy, frontCz],
          dimensiones3D: [frontW, fh, e],
          rotacion3D: [0, 0, 0],
          material: frontMat,
        });

        const innerBandY0 = zoneY0 + (d * (zoneY1 - zoneY0)) / nDrawers;
        const innerBandY1 = zoneY0 + ((d + 1) * (zoneY1 - zoneY0)) / nDrawers;
        const boxH = Math.max(60, Math.min(fh - 34, innerBandY1 - innerBandY0 - 30 - backE));
        const yBoxBase = innerBandY0 + 12 + backE;

        if (boxOuterW > 2 * e + 20 && boxH >= 50 && boxDepth >= 120) {
          const xBoxL = xInner0 + slideClearance;
          const xBoxR = xInner1 - slideClearance;
          const zBoxCenter = zf - 2 - boxDepth / 2;
          const innerBackW = boxOuterW - 2 * e;

          pieces.push({
            id: `costado_izq_${dTag}`,
            nombre: `Costado Izq ${dLabel}`,
            tipo: 'costado_cajon',
            ancho: boxDepth,
            alto: boxH,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('costado_cajon', joint, edgeMode),
            posicion3D: [xBoxL + e / 2, yBoxBase + boxH / 2, zBoxCenter],
            dimensiones3D: [e, boxH, boxDepth],
            rotacion3D: [0, 0, 0],
            material: mat,
          });
          pieces.push({
            id: `costado_der_${dTag}`,
            nombre: `Costado Der ${dLabel}`,
            tipo: 'costado_cajon',
            ancho: boxDepth,
            alto: boxH,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('costado_cajon', joint, edgeMode),
            posicion3D: [xBoxR - e / 2, yBoxBase + boxH / 2, zBoxCenter],
            dimensiones3D: [e, boxH, boxDepth],
            rotacion3D: [0, 0, 0],
            material: mat,
          });
          pieces.push({
            id: `trasera_${dTag}`,
            nombre: `Trasera ${dLabel}`,
            tipo: 'trasera_cajon',
            ancho: innerBackW,
            alto: boxH,
            espesor: e,
            cantidad: 1,
            respectGrain: true,
            edges: resolveEdgeBanding('trasera_cajon', joint, edgeMode),
            posicion3D: [(xBoxL + xBoxR) / 2, yBoxBase + boxH / 2, zf - 2 - boxDepth + e / 2],
            dimensiones3D: [innerBackW, boxH, e],
            rotacion3D: [0, 0, 0],
            material: mat,
          });
          if (backE > 0) {
            pieces.push({
              id: `fondo_cajon_${dTag}`,
              nombre: `Fondo 3mm ${dLabel}`,
              tipo: 'fondo_cajon',
              ancho: boxOuterW,
              alto: boxDepth,
              espesor: backE,
              cantidad: 1,
              respectGrain: false,
              edges: resolveEdgeBanding('fondo_cajon', joint, edgeMode),
              posicion3D: [(xBoxL + xBoxR) / 2, yBoxBase - backE / 2, zBoxCenter],
              dimensiones3D: [boxOuterW, backE, boxDepth],
              rotacion3D: [0, 0, 0],
              material: 'durolac_3mm',
            });
          }
        }

        autoSlidesPairs += 1;
        autoFrontHandles += 1;
      }
    }
  }

  if (support.type === 'toe_kick' && legVoidsAtBottom.length === 0) {
    const tkH = support.heightMm;
    pieces.push({
      id: 'zocalo_frontal',
      nombre: 'Zócalo Frontal',
      tipo: 'zocalo',
      ancho: xInt,
      alto: tkH,
      espesor: e,
      cantidad: 1,
      respectGrain: true,
      edges: resolveEdgeBanding('zocalo', joint, edgeMode),
      posicion3D: [xf / 2, -tkH / 2, Math.max(e / 2, zf - 30)],
      dimensiones3D: [xInt, tkH, e],
      rotacion3D: [0, 0, 0],
      material: mat,
    });
  }

  if (autoBaskets > 0 && !hardwareSummary.some((h) => h.id === 'hw_canastos_calc' || /canasto/i.test(h.descripcion))) {
    hardwareSummary.push({
      id: 'hw_canastos_calc',
      categoria: 'otro',
      descripcion: 'Canastos metálicos cromados extraíbles',
      cantidad: autoBaskets,
      medidaReferenciaMm: basketRefWidthMm,
      notaCompra: `Excluidos de melamina; incluye ${autoBaskets} canasto(s) con rieles laterales para vano de ${basketRefWidthMm} mm.`,
      origen: 'detectado',
    });
  }

  if (autoHinges > 0 && !hardwareSummary.some((h) => h.categoria === 'bisagras')) {
    hardwareSummary.push({
      id: 'hw_bisagras_calc',
      categoria: 'bisagras',
      descripcion: 'Bisagras cazoleta 35 mm (cierre suave)',
      cantidad: autoHinges,
      medidaReferenciaMm: 35,
      notaCompra: `Calculadas automáticamente según puertas del modelo (${autoHinges} u.).`,
      origen: 'detectado',
    });
  }
  if (autoSlidesPairs > 0 && !hardwareSummary.some((h) => h.categoria === 'correderas')) {
    hardwareSummary.push({
      id: 'hw_correderas_calc',
      categoria: 'correderas',
      descripcion: `Pares de correderas telescópicas ${slideNominalLenMm} mm`,
      cantidad: autoSlidesPairs,
      medidaReferenciaMm: slideNominalLenMm,
      notaCompra: `1 par por cada cajón (${autoSlidesPairs} pares, descuento 13 mm/lado aplicado).`,
      origen: 'detectado',
    });
  }
  if (autoGlassPanels > 0 && !hardwareSummary.some((h) => h.id === 'hw_vidrios_calc')) {
    hardwareSummary.push({
      id: 'hw_vidrios_calc',
      categoria: 'otro',
      descripcion: 'Paneles de vidrio transparente 4 mm para puertas vitrina',
      cantidad: autoGlassPanels,
      medidaReferenciaMm: 4,
      notaCompra: 'Insumo de vidriería externo a la melamina.',
      origen: 'detectado',
    });
  }
  if (autoFrontHandles > 0 && !hardwareSummary.some((h) => h.categoria === 'tiradores')) {
    hardwareSummary.push({
      id: 'hw_tiradores_calc',
      categoria: 'tiradores',
      descripcion: 'Tiradores / pomos para puertas y cajones',
      cantidad: autoFrontHandles,
      notaCompra: `Sugeridos según puertas/cajones del modelo (${autoFrontHandles} u.).`,
      origen: 'detectado',
    });
  }

  // 5. MATRICES n×3 (melamina >= 10 mm), n×5 (extendida 18 mm + 3 mm), CONSOLIDACIÓN Y SUMATORIAS
  const matrixNx3: [number, number, number][] = pieces
    .filter((p) => p.tipo !== 'fondo' && p.tipo !== 'fondo_cajon')
    .map((p) => [p.ancho, p.alto, p.espesor]);

  const pluralLabelForType = (tipo: PieceType, fallback: string): string => {
    if (tipo === 'lateral') return 'Laterales';
    if (tipo === 'repisa') return 'Repisas';
    if (tipo === 'division_vertical') return 'Divisores Verticales';
    if (tipo === 'division_diagonal') return 'Divisores Diagonales';
    if (tipo === 'fondo') return 'Fondo Durolac 3 mm';
    if (tipo === 'fondo_cajon') return 'Fondos Cajón 3 mm';
    if (tipo === 'puerta') return 'Puertas';
    if (tipo === 'frente_cajon') return 'Frentes Cajón';
    if (tipo === 'costado_cajon') return 'Costados Cajón';
    if (tipo === 'trasera_cajon') return 'Traseras Cajón';
    return fallback;
  };

  const consolidatedMap = new Map<string, MatrixNx5Row>();
  for (const p of pieces) {
    const key = `${p.tipo}|${p.ancho.toFixed(2)}|${p.alto.toFixed(2)}|${p.espesor.toFixed(2)}|${p.material}`;
    const existing = consolidatedMap.get(key);
    if (existing) {
      existing.cantidad += p.cantidad;
      existing.nombre = pluralLabelForType(p.tipo, existing.nombre);
    } else {
      consolidatedMap.set(key, {
        nombre: p.nombre,
        ancho: Number(p.ancho.toFixed(2)),
        alto: Number(p.alto.toFixed(2)),
        espesor: p.espesor,
        cantidad: p.cantidad,
        material: p.material,
      });
    }
  }

  const consolidatedRows = Array.from(consolidatedMap.values());
  const matrixNx5: [number, number, number, number, PieceMaterial][] =
    consolidatedRows.map((r) => [r.ancho, r.alto, r.espesor, r.cantidad, r.material]);

  let melamineAreaMm2 = 0;
  let backPanelAreaMm2 = 0;
  let edgeBandingMm = 0;

  for (const p of pieces) {
    const area = p.ancho * p.alto * p.cantidad;
    if (p.tipo === 'fondo' || p.tipo === 'fondo_cajon') {
      backPanelAreaMm2 += area;
    } else {
      melamineAreaMm2 += area;
    }
    edgeBandingMm += computePieceEdgeBandingMm(p) * p.cantidad;
  }

  return {
    scaleFactors,
    shelfProgression,
    matrizDespiece: pieces,
    matrixNx3,
    matrixNx5,
    consolidatedRows,
    totalNetAreaM2: (melamineAreaMm2 + backPanelAreaMm2) / 1_000_000,
    backPanelAreaM2: backPanelAreaMm2 / 1_000_000,
    totalEdgeBandingMeters: edgeBandingMm / 1000,
    alerts,
    hardwareSummary,
  };
}
