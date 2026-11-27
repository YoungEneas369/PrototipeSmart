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
    //    Reemplaza el frente (+Z) de cubierta con el contorno curvo libre diseñado arriba.
    if (cut.plane === 'xz' && cut.kind === 'free_bezier') {
      const targetCub = pieces.find(
        (p) => p.tipo === 'cubierta' && (!p.wing || p.wing === 'main'),
      );
      if (targetCub) {
        const w = targetCub.ancho;
        const d = targetCub.alto;
        const [p0, p1, p2, p3] = cut.controlPoints;
        // Mapear Y normalizado del frente a la franja delantera de la cubierta en local XZ
        const mapPt = (pt: Point2D): Point2D => ({
          x: (clamp01(pt.x) - 0.5) * w,
          y: (clamp01(pt.y) - 0.5) * d,
        });
        const sortedEnd =
          p0.x <= p3.x
            ? ([mapPt(p0), mapPt(p1), mapPt(p2), mapPt(p3)] as [Point2D, Point2D, Point2D, Point2D])
            : ([mapPt(p3), mapPt(p2), mapPt(p1), mapPt(p0)] as [Point2D, Point2D, Point2D, Point2D]);
        const diff = evaluateBezierDifferential(sortedEnd, 24);
        if (diff.arcLengthMm > GEOM_EPS) {
          const curvePts = diff.samples.map((s) => s.point);
          const polyPts: Point2D[] = [
            { x: -w / 2, y: -d / 2 },
            { x: w / 2, y: -d / 2 },
            ...curvePts.slice().reverse(),
          ];
          targetCub.curveProfile = {
            pointsMm: polyPts,
            extrudePlane: 'xz',
            extrudeDepthMm: e,
            arcLengthMm: diff.arcLengthMm,
            minRadiusMm: diff.minRadiusMm,
            replaceTopEdgeWithArc: true,
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
