/**
 * SMARTFURNITURE — CÁLCULO DIFERENCIAL DE CURVAS Y CORTES NO RECTOS (v8.0)
 * 100% TypeScript puro, sin dependencias externas.
 *
 * Fundamento matemático (Geometría Diferencial de Curvas Planas r(t) = (x(t), y(t))):
 *  - Vector tangente r'(t), vector normal unitario N(t) = (-y'(t), x'(t)) / ||r'(t)||
 *  - Curvatura escalar κ(t) = |x'y'' - y'x''| / (x'² + y'²)^(3/2) y radio osculador R(t) = 1/κ(t)
 *  - Longitud de arco s = ∫₀¹ ||r'(t)|| dt mediante cuadratura compuesta de Gauss-Legendre (5 pts × 8)
 *  - Ajuste cúbico de Bézier por mínimos cuadrados desde trazos libres a mano alzada
 *  - Generación de empalmes curvos radiales (L-interior, L-exterior, frente arqueado) y bandas de grosor e
 */
import type {
  BoardPiece,
  CurvedCutSpec,
  DiagonalSegment,
  DifferentialMetrics,
  FurnitureTopology,
  Point2D,
  ScaleAndBoardParams,
  StructuralAlert,
} from '../../types/contracts';
import type { ResolvedLShapePlan } from './lShapeBuilder';
import { GEOM_EPS, clamp, clamp01, resolveEdgeBanding } from './structuralDin';

export const MIN_SAFE_EDGE_BANDING_RADIUS_MM = 28;
const CIRCLE_BEZIER_K = (4 / 3) * (Math.SQRT2 - 1); // ~0.5522847498

// Nodos y pesos exactos de cuadratura de Gauss-Legendre de 5 puntos en [-1, 1]
const GL5_NODES = [
  -0.906179845938664,
  -0.5384693101056831,
  0,
  0.5384693101056831,
  0.906179845938664,
] as const;
const GL5_WEIGHTS = [
  0.2369268850561891,
  0.4786286704993665,
  0.5688888888888889,
  0.4786286704993665,
  0.2369268850561891,
] as const;

export interface BezierSamplePoint {
  t: number;
  point: Point2D;
  tangent: Point2D;
  normal: Point2D;
  speed: number;
  curvature: number;
}

export interface BezierDifferentialAnalysis {
  arcLengthMm: number;
  maxCurvature: number;
  minRadiusMm: number;
  samples: BezierSamplePoint[];
}

export interface StrokeCurveFitResult {
  isCurved: boolean;
  controlPoints: [Point2D, Point2D, Point2D, Point2D];
  arcLengthMm: number;
  chordLengthMm: number;
  maxChordDeviationMm: number;
  minRadiusMm: number;
  maxCurvature: number;
}

/**
 * Evalúa punto r(t), primera derivada r'(t) y segunda derivada r''(t) de una Bézier cúbica.
 */
export function evaluateCubicBezierDerivatives(
  pts: readonly [Point2D, Point2D, Point2D, Point2D],
  t: number,
): { r: Point2D; dr: Point2D; ddr: Point2D } {
  const [p0, p1, p2, p3] = pts;
  const u = 1 - t;
  const u2 = u * u;
  const t2 = t * t;

  const r: Point2D = {
    x: u2 * u * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t2 * t * p3.x,
    y: u2 * u * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t2 * t * p3.y,
  };

  const dr: Point2D = {
    x: 3 * u2 * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t2 * (p3.x - p2.x),
    y: 3 * u2 * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t2 * (p3.y - p2.y),
  };

  const ddr: Point2D = {
    x: 6 * u * (p2.x - 2 * p1.x + p0.x) + 6 * t * (p3.x - 2 * p2.x + p1.x),
    y: 6 * u * (p2.y - 2 * p1.y + p0.y) + 6 * t * (p3.y - 2 * p2.y + p1.y),
  };

  return { r, dr, ddr };
}

/**
 * Calcula longitud de arco s = ∫ ||r'(t)|| dt (Gauss-Legendre compuesto),
 * curvatura máxima κ_max y radio osculador mínimo R_min = 1 / κ_max en mm.
 */
export function evaluateBezierDifferential(
  ptsMm: readonly [Point2D, Point2D, Point2D, Point2D],
  sampleSteps = 28,
): BezierDifferentialAnalysis {
  const subIntervals = 8;
  const h = 1 / subIntervals;
  let arcLengthMm = 0;

  for (let i = 0; i < subIntervals; i++) {
    const a = i * h;
    const b = (i + 1) * h;
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    let subSum = 0;
    for (let k = 0; k < GL5_NODES.length; k++) {
      const t = mid + half * GL5_NODES[k];
      const { dr } = evaluateCubicBezierDerivatives(ptsMm, t);
      subSum += GL5_WEIGHTS[k] * Math.hypot(dr.x, dr.y);
    }
    arcLengthMm += half * subSum;
  }

  let maxCurvature = 0;
  const samples: BezierSamplePoint[] = [];
  const n = Math.max(8, sampleSteps);

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const { r, dr, ddr } = evaluateCubicBezierDerivatives(ptsMm, t);
    const speed = Math.hypot(dr.x, dr.y);
    const tx = speed > 1e-6 ? dr.x / speed : 1;
    const ty = speed > 1e-6 ? dr.y / speed : 0;
    const nx = -ty;
    const ny = tx;
    const cross = Math.abs(dr.x * ddr.y - dr.y * ddr.x);
    const curvature = speed > 1e-4 ? cross / Math.pow(speed, 3) : 0;
    if (curvature > maxCurvature) {
      maxCurvature = curvature;
    }
    samples.push({
      t,
      point: r,
      tangent: { x: tx, y: ty },
      normal: { x: nx, y: ny },
      speed,
      curvature,
    });
  }

  const minRadiusMm =
    maxCurvature > 1e-6 ? Math.min(10000, 1 / maxCurvature) : 10000;

  return {
    arcLengthMm: Number(arcLengthMm.toFixed(2)),
    maxCurvature: Number(maxCurvature.toFixed(6)),
    minRadiusMm: Number(minRadiusMm.toFixed(1)),
    samples,
  };
}

/**
 * Construye una Bézier cúbica C¹ exacta de empalme circular de cuarto de vuelta para radio `radiusMm`.
 */
export function buildFilletBezier(
  cornerPt: Point2D,
  inwardArmDir: Point2D,
  outwardArmDir: Point2D,
  radiusMm: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const p0: Point2D = {
    x: cornerPt.x + inwardArmDir.x * radiusMm,
    y: cornerPt.y + inwardArmDir.y * radiusMm,
  };
  const p3: Point2D = {
    x: cornerPt.x + outwardArmDir.x * radiusMm,
    y: cornerPt.y + outwardArmDir.y * radiusMm,
  };
  const p1: Point2D = {
    x: p0.x - inwardArmDir.x * (radiusMm * CIRCLE_BEZIER_K),
    y: p0.y - inwardArmDir.y * (radiusMm * CIRCLE_BEZIER_K),
  };
  const p2: Point2D = {
    x: p3.x - outwardArmDir.x * (radiusMm * CIRCLE_BEZIER_K),
    y: p3.y - outwardArmDir.y * (radiusMm * CIRCLE_BEZIER_K),
  };
  return [p0, p1, p2, p3];
}

/**
 * Clasifica un trazo a mano alzada (en mm) usando geometría diferencial discreta
 * (desviación máxima respecto a cuerda + razón arco/cuerda + ángulo de giro acumulado) y ajusta
 * una Bézier cúbica por mínimos cuadrados cuando el trazo es curvo.
 */
export function fitDifferentialCurveFromStroke(
  rawPointsMm: readonly Point2D[],
  forceCurve = false,
): StrokeCurveFitResult | null {
  if (rawPointsMm.length < 2) return null;

  const cleaned: Point2D[] = [{ ...rawPointsMm[0] }];
  for (let i = 1; i < rawPointsMm.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const cur = rawPointsMm[i];
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= 2.5 || i === rawPointsMm.length - 1) {
      cleaned.push({ ...cur });
    }
  }
  if (cleaned.length < 2) return null;

  const pStart = cleaned[0];
  const pEnd = cleaned[cleaned.length - 1];
  const vx = pEnd.x - pStart.x;
  const vy = pEnd.y - pStart.y;
  const chordLengthMm = Math.hypot(vx, vy);
  if (chordLengthMm < 25) return null;

  let rawArcLen = 0;
  const cumS: number[] = [0];
  let maxChordDeviationMm = 0;

  for (let i = 1; i < cleaned.length; i++) {
    const segLen = Math.hypot(cleaned[i].x - cleaned[i - 1].x, cleaned[i].y - cleaned[i - 1].y);
    rawArcLen += segLen;
    cumS.push(rawArcLen);
    const cross = Math.abs(
      (cleaned[i].x - pStart.x) * vy - (cleaned[i].y - pStart.y) * vx,
    );
    const dev = cross / chordLengthMm;
    if (dev > maxChordDeviationMm) {
      maxChordDeviationMm = dev;
    }
  }

  const devRatio = maxChordDeviationMm / Math.max(1, chordLengthMm);
  const arcRatio = rawArcLen / Math.max(1, chordLengthMm);
  const minDevForCurve = forceCurve ? 3 : Math.max(16, chordLengthMm * 0.065);
  const isCurved =
    cleaned.length >= 4 &&
    (maxChordDeviationMm >= minDevForCurve || (forceCurve && (devRatio > 0.008 || arcRatio > 1.004)));

  if (!isCurved) {
    const p1: Point2D = {
      x: pStart.x + vx / 3,
      y: pStart.y + vy / 3,
    };
    const p2: Point2D = {
      x: pStart.x + (2 * vx) / 3,
      y: pStart.y + (2 * vy) / 3,
    };
    return {
      isCurved: false,
      controlPoints: [pStart, p1, p2, pEnd],
      arcLengthMm: Number(chordLengthMm.toFixed(2)),
      chordLengthMm: Number(chordLengthMm.toFixed(2)),
      maxChordDeviationMm: Number(maxChordDeviationMm.toFixed(1)),
      minRadiusMm: 10000,
      maxCurvature: 0,
    };
  }

  // Tangentes extremas estimadas sobre ~20 % de los extremos del trazo
  const idxT1 = Math.min(cleaned.length - 1, Math.max(1, Math.floor(cleaned.length * 0.2)));
  const idxT2 = Math.max(0, Math.min(cleaned.length - 2, Math.floor(cleaned.length * 0.8)));

  let t0x = cleaned[idxT1].x - pStart.x;
  let t0y = cleaned[idxT1].y - pStart.y;
  const n0 = Math.hypot(t0x, t0y) || 1;
  t0x /= n0;
  t0y /= n0;

  let t1x = pEnd.x - cleaned[idxT2].x;
  let t1y = pEnd.y - cleaned[idxT2].y;
  const n1 = Math.hypot(t1x, t1y) || 1;
  t1x /= n1;
  t1y /= n1;

  // Ajuste por mínimos cuadrados de escalares de tangente (α1, α2) estilo Schneider
  const totalS = Math.max(1e-6, rawArcLen);
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0Vec = 0;
  let x1Vec = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const u = cumS[i] / totalS;
    const b0 = Math.pow(1 - u, 3);
    const b1 = 3 * Math.pow(1 - u, 2) * u;
    const b2 = 3 * (1 - u) * u * u;
    const b3 = Math.pow(u, 3);

    const a1x = t0x * b1;
    const a1y = t0y * b1;
    const a2x = -t1x * b2;
    const a2y = -t1y * b2;

    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;

    const rx = cleaned[i].x - ((b0 + b1) * pStart.x + (b2 + b3) * pEnd.x);
    const ry = cleaned[i].y - ((b0 + b1) * pStart.y + (b2 + b3) * pEnd.y);
    x0Vec += a1x * rx + a1y * ry;
    x1Vec += a2x * rx + a2y * ry;
  }

  const det = c00 * c11 - c01 * c01;
  const defaultAlpha = chordLengthMm / 3;
  let alpha1 = defaultAlpha;
  let alpha2 = defaultAlpha;
  if (Math.abs(det) > 1e-6) {
    const cand1 = (x0Vec * c11 - c01 * x1Vec) / det;
    const cand2 = (c00 * x1Vec - x0Vec * c01) / det;
    if (cand1 > chordLengthMm * 0.05 && cand2 > chordLengthMm * 0.05) {
      alpha1 = clamp(cand1, chordLengthMm * 0.08, rawArcLen * 0.85);
      alpha2 = clamp(cand2, chordLengthMm * 0.08, rawArcLen * 0.85);
    }
  }

  const p1: Point2D = { x: pStart.x + t0x * alpha1, y: pStart.y + t0y * alpha1 };
  const p2: Point2D = { x: pEnd.x - t1x * alpha2, y: pEnd.y - t1y * alpha2 };
  const controlPoints: [Point2D, Point2D, Point2D, Point2D] = [pStart, p1, p2, pEnd];
  const diff = evaluateBezierDifferential(controlPoints);

  return {
    isCurved: true,
    controlPoints,
    arcLengthMm: diff.arcLengthMm,
    chordLengthMm: Number(chordLengthMm.toFixed(2)),
    maxChordDeviationMm: Number(maxChordDeviationMm.toFixed(1)),
    minRadiusMm: diff.minRadiusMm,
    maxCurvature: diff.maxCurvature,
  };
}

/**
 * Construye una banda curvilínea física de espesor constante `e` mediante offset por vector normal
 * unitario `N(t)` a ambos lados de `r(t)` en mm.
 */
function buildOffsetRibbonPolygon(
  ptsMm: readonly [Point2D, Point2D, Point2D, Point2D],
  halfThicknessMm: number,
): { polygon: Point2D[]; diff: BezierDifferentialAnalysis } {
  const diff = evaluateBezierDifferential(ptsMm, 24);
  const topPts: Point2D[] = [];
  const botPts: Point2D[] = [];

  for (const s of diff.samples) {
    topPts.push({
      x: Number((s.point.x + s.normal.x * halfThicknessMm).toFixed(2)),
      y: Number((s.point.y + s.normal.y * halfThicknessMm).toFixed(2)),
    });
    botPts.push({
      x: Number((s.point.x - s.normal.x * halfThicknessMm).toFixed(2)),
      y: Number((s.point.y - s.normal.y * halfThicknessMm).toFixed(2)),
    });
  }

  return {
    polygon: [...topPts, ...botPts.reverse()],
    diff,
  };
}

/**
 * Construye un `CurvedCutSpec` normalizado de empalme radial para la esquina interior o exterior
 * de un mueble en L o recto.
 */
export function buildCornerFilletCutSpec(options: {
  id: string;
  cornerTarget: 'l_inner' | 'l_outer' | 'front_top_left' | 'front_top_right';
  radiusMm: number;
  label?: string;
}): CurvedCutSpec {
  const rMm = clamp(Math.round(options.radiusMm), 15, 450);
  const plane =
    options.cornerTarget === 'l_inner' || options.cornerTarget === 'l_outer' ? 'xz' : 'xy';
  // Puntos de control representativos normalizados en [0, 1]^2 según plano
  const controlPoints: [Point2D, Point2D, Point2D, Point2D] =
    options.cornerTarget === 'l_inner'
      ? [
          { x: 0.35, y: 0.4 },
          { x: 0.48, y: 0.4 },
          { x: 0.56, y: 0.48 },
          { x: 0.56, y: 0.62 },
        ]
      : options.cornerTarget === 'l_outer'
        ? [
            { x: 0.78, y: 0 },
            { x: 0.92, y: 0 },
            { x: 1, y: 0.08 },
            { x: 1, y: 0.22 },
          ]
        : options.cornerTarget === 'front_top_left'
          ? [
              { x: 0, y: 0.8 },
              { x: 0, y: 0.92 },
              { x: 0.08, y: 1 },
              { x: 0.2, y: 1 },
            ]
          : [
              { x: 0.8, y: 1 },
              { x: 0.92, y: 1 },
              { x: 1, y: 0.92 },
              { x: 1, y: 0.8 },
            ];

  const nominalBezier = buildFilletBezier(
    { x: rMm, y: rMm },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
    rMm,
  );
  const diff = evaluateBezierDifferential(nominalBezier);

  return {
    id: options.id,
    plane,
    kind: 'corner_fillet',
    controlPoints,
    radiusMm: rMm,
    cornerTarget: options.cornerTarget,
    label:
      options.label ??
      (options.cornerTarget === 'l_inner'
        ? `Curva interior L (R=${rMm} mm)`
        : options.cornerTarget === 'l_outer'
          ? `Esquina exterior curva (R=${rMm} mm)`
          : `Esquina superior curva (R=${rMm} mm)`),
    arcLengthMm: diff.arcLengthMm,
    minRadiusMm: diff.minRadiusMm,
    maxCurvature: diff.maxCurvature,
  };
}

/**
 * Aplica cortes curvos paramétricos y libres (evaluados con cálculo diferencial) sobre el
 * despiece generado, adjuntando `curveProfile` 3D, agregando puente curvo interior en L sin
 * solapamiento AABB y reportando alertas de radio mínimo de tapacanto.
 */
export function applyCurvedCutsToPieces(options: {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  lPlan: ResolvedLShapePlan | null;
  pieces: BoardPiece[];
  alerts: StructuralAlert[];
}): { differentialMetrics?: DifferentialMetrics } {
  const { topology, params, lPlan, pieces, alerts } = options;
  const cuts = topology.curvedCuts ?? [];
  if (cuts.length === 0) {
    return {};
  }

  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const e = params.boardThickness;
  const joint = params.cornerJointType;
  const edgeMode = params.edgeBandingMode;
  const mat = topology.cubiertaMaterialOverride ?? params.material;
  const diagMat = params.material;

  let curvedCutCount = 0;
  let totalArcLengthMm = 0;
  let minCurvatureRadiusMm = Infinity;
  let maxCurvature = 0;

  const recordCurveStats = (arcMm: number, minRMm: number, maxKappa: number, id: string, label?: string) => {
    curvedCutCount++;
    totalArcLengthMm += arcMm;
    if (minRMm < minCurvatureRadiusMm) minCurvatureRadiusMm = minRMm;
    if (maxKappa > maxCurvature) maxCurvature = maxKappa;

    if (minRMm < MIN_SAFE_EDGE_BANDING_RADIUS_MM) {
      alerts.push({
        id: `alert_curva_radio_${id}`,
        severidad: 'warning',
        tipo: 'dimension_invalida',
        mensaje: `${label ?? 'Corte curvo'} tiene radio mínimo R_min=${minRMm.toFixed(1)} mm (< ${MIN_SAFE_EDGE_BANDING_RADIUS_MM} mm): usar tapacanto flexible o fresado CNC.`,
        piezaId: id,
      });
    }
  };

  for (const cut of cuts) {
    // 1. Empalme interior curvo en L (`l_inner` en plano XZ):
    //    Crea pieza puente cóncava limpia en esquina libre interior `[yf - e, yf]` sin invadir alas.
    if (cut.plane === 'xz' && cut.cornerTarget === 'l_inner' && lPlan?.enabled) {
      const maxCornerR =
        lPlan.side === 'right'
          ? Math.min(lPlan.cornerEdgeX - 40, lPlan.netLengthMm - 40, 360)
          : Math.min(xf - lPlan.cornerEdgeX - 40, lPlan.netLengthMm - 40, 360);
      const R = clamp(cut.radiusMm ?? 140, 25, Math.max(25, maxCornerR));
      if (R >= 25) {
        const bez =
          lPlan.side === 'right'
            ? buildFilletBezier(
                { x: -R / 2, y: -R / 2 },
                { x: 1, y: 0 },
                { x: 0, y: 1 },
                R,
              )
            : buildFilletBezier(
                { x: R / 2, y: -R / 2 },
                { x: -1, y: 0 },
                { x: 0, y: 1 },
                R,
              );
        // Vértice posterior donde convergen Ala A y Ala B; arco cóncavo tangente a ambas caras
        const localCorner: Point2D =
          lPlan.side === 'right' ? { x: R / 2, y: -R / 2 } : { x: -R / 2, y: -R / 2 };
        const bezCorner =
          lPlan.side === 'right'
            ? buildFilletBezier(localCorner, { x: -1, y: 0 }, { x: 0, y: 1 }, R)
            : buildFilletBezier(localCorner, { x: 1, y: 0 }, { x: 0, y: 1 }, R);
        const diff = evaluateBezierDifferential(bezCorner, 20);
        const curvePts = diff.samples.map((s) => s.point);
        const polyPts: Point2D[] = [localCorner, ...curvePts];
        void bez;

        const worldCx =
          lPlan.side === 'right' ? lPlan.cornerEdgeX - R / 2 : lPlan.cornerEdgeX + R / 2;
        const worldCz = lPlan.zStartB + R / 2;

        pieces.push({
          id: `cubierta_curva_l_${cut.id}`,
          nombre: `Empalme Curvo L (R=${Math.round(R)} mm)`,
          tipo: 'cubierta',
          ancho: R,
          alto: R,
          espesor: e,
          cantidad: 1,
          respectGrain: true,
          edges: { top: false, bottom: false, left: false, right: false },
          posicion3D: [worldCx, lPlan.heightMm - e / 2, worldCz],
          dimensiones3D: [R, e, R],
          rotacion3D: [0, 0, 0],
          material: topology.lShape?.cubiertaMaterialOverride ?? mat,
          wing: 'main',
          curveProfile: {
            pointsMm: polyPts,
            extrudePlane: 'xz',
            extrudeDepthMm: e,
            arcLengthMm: diff.arcLengthMm,
            minRadiusMm: diff.minRadiusMm,
            useOnlyArcEdge: true,
          },
        });
        recordCurveStats(
          diff.arcLengthMm,
          diff.minRadiusMm,
          diff.maxCurvature,
          `cubierta_curva_l_${cut.id}`,
          cut.label,
        );
      }
      continue;
    }

    // 2. Esquina exterior redondeada en cubierta (planta XZ: L-outer o recta):
    if (cut.plane === 'xz' && (cut.cornerTarget === 'l_outer' || cut.kind === 'corner_fillet')) {
      const targetCub = pieces.find(
        (p) => p.tipo === 'cubierta' && (!p.wing || p.wing === 'main'),
      );
      if (targetCub) {
        const w = targetCub.ancho;
        const d = targetCub.alto;
        const R = clamp(cut.radiusMm ?? 120, 20, Math.min(w, d) * 0.45);
        // Redondear esquina derecha trasera/frontal o derecha exterior dentro del AABB [-w/2, w/2]×[-d/2, d/2]
        const onRight = !lPlan?.enabled || lPlan.side === 'right';
        const cPt: Point2D = onRight ? { x: w / 2, y: -d / 2 } : { x: -w / 2, y: -d / 2 };
        const bez = onRight
          ? buildFilletBezier(cPt, { x: -1, y: 0 }, { x: 0, y: 1 }, R)
          : buildFilletBezier(cPt, { x: 1, y: 0 }, { x: 0, y: 1 }, R);
        const diff = evaluateBezierDifferential(bez, 20);
        const arcPts = diff.samples.map((s) => s.point);
        const polyPts: Point2D[] = onRight
          ? [
              { x: -w / 2, y: -d / 2 },
              ...arcPts,
              { x: w / 2, y: d / 2 },
              { x: -w / 2, y: d / 2 },
            ]
          : [
              { x: w / 2, y: -d / 2 },
              ...arcPts,
              { x: -w / 2, y: d / 2 },
              { x: w / 2, y: d / 2 },
            ];
        targetCub.curveProfile = {
          pointsMm: polyPts,
          extrudePlane: 'xz',
          extrudeDepthMm: e,
          arcLengthMm: diff.arcLengthMm,
          minRadiusMm: diff.minRadiusMm,
          replaceTopEdgeWithArc: false,
        };
        recordCurveStats(
          diff.arcLengthMm,
          diff.minRadiusMm,
          diff.maxCurvature,
          targetCub.id,
          cut.label,
        );
      }
      continue;
    }

    // 3. Trazo curvo libre en Frontal XY (`free_bezier` / `top_arc`):
    //    Crea banda curva de espesor e extruida en Z usando vector normal diferencial N(t).
    if (cut.plane === 'xy') {
      const xInt = Math.max(40, xf - 2 * e);
      const yInt = Math.max(40, yf - 2 * e);
      const toMm = (pt: Point2D): Point2D => ({
        x: e + clamp01(pt.x) * xInt,
        y: e + clamp01(pt.y) * yInt,
      });
      const worldPts = [
        toMm(cut.controlPoints[0]),
        toMm(cut.controlPoints[1]),
        toMm(cut.controlPoints[2]),
        toMm(cut.controlPoints[3]),
      ] as [Point2D, Point2D, Point2D, Point2D];

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const { polygon: rawPoly, diff } = buildOffsetRibbonPolygon(worldPts, e / 2);
      if (diff.arcLengthMm < e * 2) continue;

      for (const pt of rawPoly) {
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const boxW = Math.max(e, maxX - minX);
      const boxH = Math.max(e, maxY - minY);
      const localPoly = rawPoly.map((pt) => ({
        x: Number((pt.x - cx).toFixed(2)),
        y: Number((pt.y - cy).toFixed(2)),
      }));

      const pieceId = `curva_xy_${cut.id}`;
      pieces.push({
        id: pieceId,
        nombre: cut.label ?? `Partición Curva (s=${Math.round(diff.arcLengthMm)} mm)`,
        tipo: 'division_diagonal',
        ancho: Number(diff.arcLengthMm.toFixed(1)),
        alto: zf,
        espesor: e,
        cantidad: 1,
        respectGrain: true,
        edges: resolveEdgeBanding('division_diagonal', joint, edgeMode),
        posicion3D: [cx, cy, zf / 2],
        dimensiones3D: [boxW, boxH, zf],
        rotacion3D: [0, 0, 0],
        material: diagMat,
        wing: lPlan?.enabled ? 'main' : undefined,
        curveProfile: {
          pointsMm: localPoly,
          extrudePlane: 'xy',
          extrudeDepthMm: zf,
          arcLengthMm: diff.arcLengthMm,
          minRadiusMm: diff.minRadiusMm,
          replaceTopEdgeWithArc: true,
        },
      });
      recordCurveStats(diff.arcLengthMm, diff.minRadiusMm, diff.maxCurvature, pieceId, cut.label);
      continue;
    }

    // 4. Trazo curvo libre en Planta Superior XZ (`free_bezier` no pre-emparejado):
    //    Convención XZ unificada: arriba del lienzo (pt.y = 1) es Fondo/Pared (Z = 0 -> local y = -d/2),
    //    abajo (pt.y = 0) es Frente (Z = +D -> local y = +d/2).
    if (cut.plane === 'xz' && cut.kind === 'free_bezier') {
      const targetCub = pieces.find(
        (p) => p.tipo === 'cubierta' && (!p.wing || p.wing === 'main'),
      );
      if (targetCub) {
        const w = targetCub.ancho;
        const d = targetCub.alto;
        const [p0, p1, p2, p3] = cut.controlPoints;
        const mapPt = (pt: Point2D): Point2D => ({
          x: (clamp01(pt.x) - 0.5) * w,
          y: (0.5 - clamp01(pt.y)) * d,
        });
        const isHorizontal = Math.abs(p3.x - p0.x) >= Math.abs(p3.y - p0.y);
        const sortedEnd: [Point2D, Point2D, Point2D, Point2D] = isHorizontal
          ? p0.x <= p3.x
            ? [mapPt(p0), mapPt(p1), mapPt(p2), mapPt(p3)]
            : [mapPt(p3), mapPt(p2), mapPt(p1), mapPt(p0)]
          : p0.y >= p3.y
            ? [mapPt(p0), mapPt(p1), mapPt(p2), mapPt(p3)]
            : [mapPt(p3), mapPt(p2), mapPt(p1), mapPt(p0)];
        const diff = evaluateBezierDifferential(sortedEnd, 24);
        if (diff.arcLengthMm > GEOM_EPS) {
          const curvePts = diff.samples.map((s) => s.point);
          let polyPts: Point2D[];
          let replaceTopEdge = false;
          if (isHorizontal) {
            const meanPtY =
              (clamp01(p0.y) + clamp01(p1.y) + clamp01(p2.y) + clamp01(p3.y)) / 4;
            if (meanPtY <= 0.65) {
              polyPts = [
                { x: -w / 2, y: -d / 2 },
                { x: w / 2, y: -d / 2 },
                ...curvePts.slice().reverse(),
              ];
              replaceTopEdge = true;
            } else {
              polyPts = [
                ...curvePts,
                { x: w / 2, y: d / 2 },
                { x: -w / 2, y: d / 2 },
              ];
            }
          } else {
            const meanPtX =
              (clamp01(p0.x) + clamp01(p1.x) + clamp01(p2.x) + clamp01(p3.x)) / 4;
            if (meanPtX >= 0.5) {
              polyPts = [
                { x: -w / 2, y: -d / 2 },
                ...curvePts,
                { x: -w / 2, y: d / 2 },
              ];
            } else {
              polyPts = [
                { x: w / 2, y: -d / 2 },
                { x: w / 2, y: d / 2 },
                ...curvePts.slice().reverse(),
              ];
            }
          }
          const dedupedPoly = deduplicatePolygonPoints(polyPts);
          if (dedupedPoly.length >= 3) {
            targetCub.curveProfile = {
              pointsMm: dedupedPoly,
              extrudePlane: 'xz',
              extrudeDepthMm: e,
              arcLengthMm: diff.arcLengthMm,
              minRadiusMm: diff.minRadiusMm,
              replaceTopEdgeWithArc: replaceTopEdge,
            };
            recordCurveStats(
              diff.arcLengthMm,
              diff.minRadiusMm,
              diff.maxCurvature,
              targetCub.id,
              cut.label,
            );
          }
        }
      }
      continue;
    }

    // 5. Trazo curvo en Perfil Lateral ZY (`cut.plane === 'zy'`):
    //    Convención ZY unificada: pt.x = 0 -> Fondo (Z = 0 -> local -d/2), pt.x = 1 -> Frente (Z = +D -> local +d/2),
    //    pt.y = 0 -> Base (Y = 0), pt.y = 1 -> Cubierta (Y = yf).
    if (cut.plane === 'zy') {
      const sidePieces = pieces.filter(
        (p) => p.tipo === 'lateral' && (!p.wing || p.wing === 'main'),
      );
      let recordedForCut = false;
      for (const p of sidePieces) {
        const hSide = p.ancho;
        const d = p.alto;
        const cy = p.posicion3D[1];
        const mapPt = (pt: Point2D): Point2D => {
          const localZ = (clamp01(pt.x) - 0.5) * d;
          const worldY = clamp01(pt.y) * yf;
          const localY = clamp(worldY - cy, -hSide / 2, hSide / 2);
          return { x: localZ, y: localY };
        };
        const mappedPts: [Point2D, Point2D, Point2D, Point2D] = [
          mapPt(cut.controlPoints[0]),
          mapPt(cut.controlPoints[1]),
          mapPt(cut.controlPoints[2]),
          mapPt(cut.controlPoints[3]),
        ];
        const diff = evaluateBezierDifferential(mappedPts, 24);
        if (diff.arcLengthMm <= GEOM_EPS) continue;

        const rawCurvePts = diff.samples.map((s) => s.point);
        const curvePts =
          rawCurvePts[0].y <= rawCurvePts[rawCurvePts.length - 1].y
            ? rawCurvePts
            : rawCurvePts.slice().reverse();
        const dedupedPoly = buildZySideProfileFromContour(curvePts, d, hSide);
        if (dedupedPoly.length < 3) continue;

        p.curveProfile = {
          pointsMm: dedupedPoly,
          extrudePlane: 'zy',
          extrudeDepthMm: e,
          arcLengthMm: diff.arcLengthMm,
          minRadiusMm: diff.minRadiusMm,
          replaceTopEdgeWithArc: true,
        };
        if (!recordedForCut) {
          recordCurveStats(
            diff.arcLengthMm,
            diff.minRadiusMm,
            diff.maxCurvature,
            p.id,
            cut.label,
          );
          recordedForCut = true;
        }
      }
    }
  }

  return curvedCutCount > 0
    ? {
        differentialMetrics: {
          curvedCutCount,
          totalArcLengthMm: Number(totalArcLengthMm.toFixed(1)),
          minCurvatureRadiusMm:
            minCurvatureRadiusMm < 10000 ? Number(minCurvatureRadiusMm.toFixed(1)) : 10000,
          maxCurvature: Number(maxCurvature.toFixed(6)),
        },
      }
    : {};
}

function deduplicatePolygonPoints(pts: readonly Point2D[], tol = 0.5): Point2D[] {
  const out: Point2D[] = [];
  for (const pt of pts) {
    const rounded: Point2D = {
      x: Number(pt.x.toFixed(2)),
      y: Number(pt.y.toFixed(2)),
    };
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(rounded.x - prev.x, rounded.y - prev.y) > tol) {
      out.push(rounded);
    }
  }
  while (
    out.length > 2 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol
  ) {
    out.pop();
  }
  return out;
}

function computePolygonArea(pts: readonly Point2D[]): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}

function clipPolygonByHalfPlane(
  poly: readonly Point2D[],
  a: Point2D,
  b: Point2D,
  keepPt: Point2D,
): Point2D[] {
  if (poly.length < 3) return [...poly];
  const cross = (p: Point2D): number => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const keepSign = cross(keepPt);
  if (Math.abs(keepSign) < 1e-6) return [...poly];
  const isInside = (p: Point2D): boolean => cross(p) * keepSign >= -1e-6;

  const out: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = isInside(cur);
    const prevIn = isInside(prev);
    const intersect = (): Point2D => {
      const cPrev = cross(prev);
      const cCur = cross(cur);
      const denom = cPrev - cCur;
      if (Math.abs(denom) < 1e-9) return { ...cur };
      const t = clamp01(cPrev / denom);
      return {
        x: prev.x + t * (cur.x - prev.x),
        y: prev.y + t * (cur.y - prev.y),
      };
    };
    if (curIn) {
      if (!prevIn) out.push(intersect());
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect());
    }
  }
  return deduplicatePolygonPoints(out);
}

function buildZySideProfileFromContour(
  contourPtsLocal: readonly Point2D[],
  d: number,
  hSide: number,
): Point2D[] {
  if (contourPtsLocal.length < 2) return [];
  const ptBot = contourPtsLocal[0];
  const ptTop = contourPtsLocal[contourPtsLocal.length - 1];
  const polyPts: Point2D[] = [];

  if (ptBot.x > -d / 2 + 1 || ptBot.y <= -hSide / 2 + 1) {
    polyPts.push({ x: -d / 2, y: -hSide / 2 });
  }
  if (ptBot.y > -hSide / 2 + 1 && ptBot.x > -d / 2 + 1) {
    polyPts.push({ x: ptBot.x, y: -hSide / 2 });
  }
  polyPts.push(...contourPtsLocal);
  if (ptTop.y < hSide / 2 - 1 && ptTop.x > -d / 2 + 1) {
    polyPts.push({ x: ptTop.x, y: hSide / 2 });
  }
  if (ptTop.x > -d / 2 + 1 || ptTop.y >= hSide / 2 - 1) {
    polyPts.push({ x: -d / 2, y: hSide / 2 });
  }
  return deduplicatePolygonPoints(polyPts);
}

function extractZyFrontContourNorm(
  lines: readonly DiagonalSegment[],
  zf: number,
  yf: number,
): Point2D[] | null {
  interface ZySegInfo {
    a: Point2D;
    b: Point2D;
    kind: 'oblique' | 'vStep' | 'hStep';
    maxU: number;
    scoreLen: number;
  }

  const eligible: ZySegInfo[] = [];
  for (const ln of lines) {
    const u1 = clamp01(ln.u1);
    const v1 = clamp01(ln.v1);
    const u2 = clamp01(ln.u2);
    const v2 = clamp01(ln.v2);
    const onSameBorder =
      (u1 <= 0.02 && u2 <= 0.02) ||
      (u1 >= 0.98 && u2 >= 0.98) ||
      (v1 <= 0.02 && v2 <= 0.02) ||
      (v1 >= 0.98 && v2 >= 0.98);
    if (onSameBorder) continue;

    const duMm = Math.abs(u2 - u1) * zf;
    const dvMm = Math.abs(v2 - v1) * yf;
    const lenMm = Math.hypot(duMm, dvMm);
    if (lenMm < 20) continue;

    const degMm = (Math.atan2(dvMm, duMm) * 180) / Math.PI;
    const uSpan = Math.abs(u2 - u1);
    const vSpan = Math.abs(v2 - v1);
    const degNorm = (Math.atan2(vSpan, uSpan) * 180) / Math.PI;
    const uMid = (u1 + u2) / 2;

    const isOblique =
      uSpan >= 0.06 &&
      vSpan >= 0.08 &&
      ((degNorm >= 12 && degNorm <= 78) || (degMm >= 12 && degMm <= 78));

    if (isOblique) {
      eligible.push({
        a: { x: u1, y: v1 },
        b: { x: u2, y: v2 },
        kind: 'oblique',
        maxU: Math.max(u1, u2),
        scoreLen: lenMm,
      });
    } else if (degNorm > 78 && vSpan < 0.92 && uMid >= 0.12 && uMid <= 0.92) {
      eligible.push({
        a: { x: u1, y: v1 },
        b: { x: u2, y: v2 },
        kind: 'vStep',
        maxU: Math.max(u1, u2),
        scoreLen: lenMm,
      });
    } else if (degNorm < 12 && uSpan < 0.92) {
      eligible.push({
        a: { x: u1, y: v1 },
        b: { x: u2, y: v2 },
        kind: 'hStep',
        maxU: Math.max(u1, u2),
        scoreLen: lenMm,
      });
    }
  }

  if (eligible.length === 0) return null;

  const snapEdge = (v: number): number => (v <= 0.055 ? 0 : v >= 0.945 ? 1 : v);
  const distPt = (p: Point2D, q: Point2D): number => Math.hypot(p.x - q.x, p.y - q.y);
  const tol = 0.08;

  // Construir componentes conexas de segmentos elegibles
  const visited = new Array<boolean>(eligible.length).fill(false);
  let bestChain: Point2D[] | null = null;
  let bestScore = -1;

  for (let startIdx = 0; startIdx < eligible.length; startIdx++) {
    if (visited[startIdx]) continue;
    const queue = [startIdx];
    visited[startIdx] = true;
    const compIndices: number[] = [];

    while (queue.length > 0) {
      const idx = queue.pop()!;
      compIndices.push(idx);
      const s = eligible[idx];
      for (let j = 0; j < eligible.length; j++) {
        if (visited[j]) continue;
        const o = eligible[j];
        if (
          distPt(s.a, o.a) <= tol ||
          distPt(s.a, o.b) <= tol ||
          distPt(s.b, o.a) <= tol ||
          distPt(s.b, o.b) <= tol
        ) {
          visited[j] = true;
          queue.push(j);
        }
      }
    }

    const compSegs = compIndices.map((i) => eligible[i]);
    const hasOblique = compSegs.some((s) => s.kind === 'oblique');
    const hasV = compSegs.some((s) => s.kind === 'vStep');
    const hasH = compSegs.some((s) => s.kind === 'hStep');
    const touchesFrontOrTopBot = compSegs.some(
      (s) =>
        Math.max(s.a.x, s.b.x) >= 0.82 ||
        Math.max(s.a.y, s.b.y) >= 0.88 ||
        Math.min(s.a.y, s.b.y) <= 0.12,
    );

    if (!hasOblique && !(hasV && hasH && touchesFrontOrTopBot)) continue;

    // Ordenar la cadena de segmentos desde el extremo inferior (menor v) al superior (mayor v)
    let orderedPts: Point2D[];
    if (compSegs.length === 1) {
      const s = compSegs[0];
      orderedPts =
        s.a.y < s.b.y || (Math.abs(s.a.y - s.b.y) < 1e-4 && s.a.x >= s.b.x)
          ? [s.a, s.b]
          : [s.b, s.a];
    } else {
      const endpoints: Array<{ pt: Point2D; segIdx: number; other: Point2D }> = [];
      for (let k = 0; k < compSegs.length; k++) {
        const s = compSegs[k];
        const degA = compSegs.filter(
          (o, ok) => ok !== k && (distPt(s.a, o.a) <= tol || distPt(s.a, o.b) <= tol),
        ).length;
        const degB = compSegs.filter(
          (o, ok) => ok !== k && (distPt(s.b, o.a) <= tol || distPt(s.b, o.b) <= tol),
        ).length;
        if (degA === 0) endpoints.push({ pt: s.a, segIdx: k, other: s.b });
        if (degB === 0) endpoints.push({ pt: s.b, segIdx: k, other: s.a });
      }
      if (endpoints.length === 0) continue;

      endpoints.sort(
        (p1, p2) => p1.pt.y - p2.pt.y || p2.pt.x - p1.pt.x,
      );
      const startEp = endpoints[0];
      const usedSeg = new Array<boolean>(compSegs.length).fill(false);
      usedSeg[startEp.segIdx] = true;
      orderedPts = [startEp.pt, startEp.other];

      while (usedSeg.some((u) => !u)) {
        const tip = orderedPts[orderedPts.length - 1];
        let nextK = -1;
        let nextDist = tol;
        let nextPt: Point2D = tip;
        for (let k = 0; k < compSegs.length; k++) {
          if (usedSeg[k]) continue;
          const s = compSegs[k];
          const da = distPt(tip, s.a);
          const db = distPt(tip, s.b);
          if (da <= nextDist) {
            nextDist = da;
            nextK = k;
            nextPt = s.b;
          }
          if (db <= nextDist) {
            nextDist = db;
            nextK = k;
            nextPt = s.a;
          }
        }
        if (nextK < 0) break;
        usedSeg[nextK] = true;
        orderedPts.push(nextPt);
      }

      if (orderedPts[0].y > orderedPts[orderedPts.length - 1].y) {
        orderedPts.reverse();
      }
    }

    const totalScore = compSegs.reduce((acc, s) => acc + s.scoreLen, 0) + (hasOblique ? 100 : 0);
    if (totalScore > bestScore && orderedPts.length >= 2) {
      bestScore = totalScore;
      bestChain = orderedPts.map((pt) => ({
        x: snapEdge(clamp01(pt.x)),
        y: snapEdge(clamp01(pt.y)),
      }));
    }
  }

  return bestChain;
}

/**
 * Conecta geométricamente líneas vectoriales de Planta Superior (`planeLinesXZ`) y Perfil Lateral
 * (`planeLinesZY`) con `curveProfile` 3D de cubiertas y laterales principales cuando no han sido
 * cubiertos previamente por `curvedCuts`.
 */
export function applyPlaneLinesToPieces(options: {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  lPlan: ResolvedLShapePlan | null;
  pieces: BoardPiece[];
}): void {
  const { topology, params, lPlan, pieces } = options;
  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const e = params.boardThickness;

  // 1. Perfil Lateral ZY (`planeLinesZY`): cortes oblicuos (12°..78°) o escalonados frontales en laterales
  const zyLines = topology.planeLinesZY ?? [];
  if (zyLines.length > 0) {
    const hasZyCurveCut = pieces.some(
      (p) => p.tipo === 'lateral' && (!p.wing || p.wing === 'main') && p.curveProfile?.extrudePlane === 'zy',
    );
    if (!hasZyCurveCut) {
      const contourNorm = extractZyFrontContourNorm(zyLines, zf, yf);
      if (contourNorm && contourNorm.length >= 2) {
        const sidePieces = pieces.filter(
          (p) => p.tipo === 'lateral' && (!p.wing || p.wing === 'main'),
        );
        for (const p of sidePieces) {
          const hSide = p.ancho;
          const d = p.alto;
          const cy = p.posicion3D[1];
          const mappedContour = contourNorm.map((pt) => ({
            x: (clamp01(pt.x) - 0.5) * d,
            y: clamp(clamp01(pt.y) * yf - cy, -hSide / 2, hSide / 2),
          }));
          const polyPts = buildZySideProfileFromContour(mappedContour, d, hSide);
          if (polyPts.length < 3) continue;

          // Longitud física del contorno frontal para tapacanto exacto
          let frontLenMm = 0;
          const ptBot = mappedContour[0];
          const ptTop = mappedContour[mappedContour.length - 1];
          if (ptBot.y > -hSide / 2 + 1 && ptBot.x > -d / 2 + 1) {
            frontLenMm += ptBot.y - -hSide / 2;
          }
          for (let i = 1; i < mappedContour.length; i++) {
            frontLenMm += Math.hypot(
              mappedContour[i].x - mappedContour[i - 1].x,
              mappedContour[i].y - mappedContour[i - 1].y,
            );
          }
          if (ptTop.y < hSide / 2 - 1 && ptTop.x > -d / 2 + 1) {
            frontLenMm += hSide / 2 - ptTop.y;
          }

          p.curveProfile = {
            pointsMm: polyPts,
            extrudePlane: 'zy',
            extrudeDepthMm: e,
            arcLengthMm: Number(Math.max(1, frontLenMm).toFixed(2)),
            minRadiusMm: 10000,
            replaceTopEdgeWithArc: true,
          };
        }
      }
    }
  }

  // 2. Planta Superior XZ (`planeLinesXZ`): recorta/achaflana esquinas diagonales (12°..78°) en cubierta
  const xzLines = topology.planeLinesXZ ?? [];
  if (xzLines.length > 0) {
    const targetCub = pieces.find(
      (p) => p.tipo === 'cubierta' && (!p.wing || p.wing === 'main'),
    );
    if (targetCub && targetCub.curveProfile?.extrudePlane !== 'xz') {
      const w = targetCub.ancho;
      const d = targetCub.alto;
      const totalL2 = lPlan?.enabled ? lPlan.zStartB + lPlan.netLengthMm : zf;

      let poly: Point2D[] = [
        { x: -w / 2, y: -d / 2 },
        { x: w / 2, y: -d / 2 },
        { x: w / 2, y: d / 2 },
        { x: -w / 2, y: d / 2 },
      ];
      const baseArea = w * d;
      let appliedChamfer = false;
      let chamferLenSum = 0;

      for (const ln of xzLines) {
        const u1 = clamp01(ln.u1);
        const v1 = clamp01(ln.v1);
        const u2 = clamp01(ln.u2);
        const v2 = clamp01(ln.v2);
        const du = Math.abs(u2 - u1);
        const dv = Math.abs(v2 - v1);
        const dxMm = du * xf;
        const dzMm = dv * totalL2;
        const lenMm = Math.hypot(dxMm, dzMm);
        if (lenMm < 30 || du < 0.06 || dv < 0.06) continue;

        const degNorm = (Math.atan2(dv, du) * 180) / Math.PI;
        const degMm = (Math.atan2(dzMm, dxMm) * 180) / Math.PI;
        if (!((degNorm >= 12 && degNorm <= 78) || (degMm >= 12 && degMm <= 78))) continue;

        const toLocalCub = (u: number, v: number): Point2D => ({
          x: u * xf - targetCub.posicion3D[0],
          y: (1 - v) * totalL2 - targetCub.posicion3D[2],
        });
        const pA = toLocalCub(u1, v1);
        const pB = toLocalCub(u2, v2);
        const midX = (pA.x + pB.x) / 2;
        const midY = (pA.y + pB.y) / 2;

        // Solo recortar líneas que caigan dentro de la huella de `targetCub`
        if (
          Math.min(pA.y, pB.y) > d / 2 + 5 ||
          Math.max(pA.y, pB.y) < -d / 2 - 5 ||
          Math.min(pA.x, pB.x) > w / 2 + 5 ||
          Math.max(pA.x, pB.x) < -w / 2 - 5
        ) {
          continue;
        }

        const keepPt: Point2D = {
          x: midX >= 0 ? -w / 2 : w / 2,
          y: midY >= 0 ? -d / 2 : d / 2,
        };
        const nextPoly = clipPolygonByHalfPlane(poly, pA, pB, keepPt);
        const nextArea = computePolygonArea(nextPoly);
        if (nextPoly.length >= 3 && nextArea >= baseArea * 0.2 && nextArea < computePolygonArea(poly) - 4) {
          poly = nextPoly;
          appliedChamfer = true;
          chamferLenSum += lenMm;
        }
      }

      if (appliedChamfer) {
        targetCub.curveProfile = {
          pointsMm: poly,
          extrudePlane: 'xz',
          extrudeDepthMm: e,
          arcLengthMm: Number(chamferLenSum.toFixed(2)),
          minRadiusMm: 10000,
          replaceTopEdgeWithArc: false,
        };
      }
    }
  }
}
