import { describe, expect, it } from 'vitest';
import type { BoardPiece, Point2D } from '../../types/contracts';
import {
  ETAPA2_BASE_MATRIX_M0,
  analyzeShelvesDeflectionDIN,
  applyHomography,
  calculateDespiece,
  calculateShelfDeflectionDIN,
  calculateShelfProgression,
  clonePreset,
  compareShapeAspect,
  computeQuadToUnitHomography,
  computeUnitDirectionVector,
  exteriorToInterior,
  exteriorToInteriorRaw,
  interiorToExterior,
  scaleBaseMatrix,
} from './index';

/**
 * Invariante geométrico estricto: verifica que NINGÚN par de placas físicas en 3D
 * se solape en su volumen AABB (tolerancia 1e-4 mm).
 */
function assertNo3DOverlap(pieces: readonly BoardPiece[]): void {
  const tol = 1e-4;
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i];
    const [ax, ay, az] = a.posicion3D;
    const [adx, ady, adz] = a.dimensiones3D;
    const aMin = [ax - adx / 2, ay - ady / 2, az - adz / 2];
    const aMax = [ax + adx / 2, ay + ady / 2, az + adz / 2];

    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j];
      const [bx, by, bz] = b.posicion3D;
      const [bdx, bdy, bdz] = b.dimensiones3D;
      const bMin = [bx - bdx / 2, by - bdy / 2, bz - bdz / 2];
      const bMax = [bx + bdx / 2, by + bdy / 2, bz + bdz / 2];

      const overlapX = Math.min(aMax[0], bMax[0]) - Math.max(aMin[0], bMin[0]);
      const overlapY = Math.min(aMax[1], bMax[1]) - Math.max(aMin[1], bMin[1]);
      const overlapZ = Math.min(aMax[2], bMax[2]) - Math.max(aMin[2], bMin[2]);

      const overlaps = overlapX > tol && overlapY > tol && overlapZ > tol;
      expect(
        overlaps,
        `Solapamiento 3D entre "${a.id}" y "${b.id}" (dx=${overlapX.toFixed(3)}, dy=${overlapY.toFixed(3)}, dz=${overlapZ.toFixed(3)})`,
      ).toBe(false);
    }
  }
}

describe('SmartFurniture Bloque 1 — Motor Matemático y Homografía (v3.0)', () => {
  it('Etapa 2 exacta: M0 escalada por k=1.2 pasa 0.8800 -> 1.2672 m² y 6.80 -> 8.16 m con e=18 mm invariante', () => {
    const res = scaleBaseMatrix(ETAPA2_BASE_MATRIX_M0, 1.2, 1.2);
    expect(res.originalAreaM2).toBeCloseTo(0.88, 6);
    expect(res.scaledAreaM2).toBeCloseTo(1.2672, 6);
    expect(res.originalEdgeBandingMeters).toBeCloseTo(6.8, 6);
    expect(res.scaledEdgeBandingMeters).toBeCloseTo(8.16, 6);
    for (const row of res.scaledMatrix) {
      expect(row[2]).toBe(18);
    }
  });

  it('Conversión exterior <-> interior exacta y clamping seguro en bordes', () => {
    const uInt = exteriorToInterior(0.25, 18, 800);
    expect(uInt).toBeCloseTo(0.238219895, 5);
    expect(interiorToExterior(uInt, 18, 800)).toBeCloseTo(0.25, 6);

    // Clamping seguro si el clic cae sobre el borde exterior (< e/dim)
    expect(exteriorToInteriorRaw(0.01, 18, 800)).toBeLessThan(0);
    expect(exteriorToInterior(0.01, 18, 800)).toBe(0);
    expect(exteriorToInterior(0.995, 18, 800)).toBe(1);
  });

  it('Progresión aritmética exacta para N = 3, 4 y 5 repisas en y_f = 1800 mm', () => {
    for (const n of [3, 4, 5]) {
      const prog = calculateShelfProgression(1800, 18, n);
      expect(prog.hInteriorMm).toBe(1764);
      expect(prog.terms).toHaveLength(n);
      const expectedClear = (1764 - n * 18) / (n + 1);
      expect(prog.clearSpanMm).toBeCloseTo(expectedClear, 6);
      expect(prog.a1).toBeCloseTo(18 + expectedClear, 6);
      expect(prog.d).toBeCloseTo(expectedClear + 18, 6);

      // Comprobación simétrica: espacio libre sobre última repisa hasta cara inferior de cubierta
      const lastTop = prog.terms[n - 1] + 18;
      const topGap = 1800 - 18 - lastTop;
      expect(topGap).toBeCloseTo(expectedClear, 6);
    }
  });

  it('Descuentos topOverSides vs topBetweenSides y cero solapamiento 3D en los 3 presets', () => {
    for (const key of ['estanteria', 'rack_tv', 'closet'] as const) {
      const { topology, params } = clonePreset(key);
      const res = calculateDespiece(topology, params);
      expect(res.matrizDespiece.length).toBeGreaterThan(0);
      assertNo3DOverlap(res.matrizDespiece);
    }

    const est = clonePreset('estanteria');
    const resOver = calculateDespiece(est.topology, est.params);
    const cubiertaOver = resOver.matrizDespiece.find((p) => p.id === 'cubierta')!;
    const lateralOver = resOver.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(cubiertaOver.ancho).toBe(800);
    expect(lateralOver.ancho).toBe(1764);

    est.params.cornerJointType = 'topBetweenSides';
    const resBetween = calculateDespiece(est.topology, est.params);
    assertNo3DOverlap(resBetween.matrizDespiece);
    const cubiertaBetween = resBetween.matrizDespiece.find((p) => p.id === 'cubierta')!;
    const lateralBetween = resBetween.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(cubiertaBetween.ancho).toBe(764);
    expect(lateralBetween.ancho).toBe(1800);
  });

  it('Preset 2 (rack_tv): repisa central exacta 503.33 mm y patas externas 150 mm aisladas del cuerpo', () => {
    const { topology, params } = clonePreset('rack_tv');
    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);

    const centralShelf = res.matrizDespiece.find((p) => p.id === 'rep_central')!;
    expect(centralShelf.ancho).toBeCloseTo(503.3333, 2);

    // Patas externas excluidas de la melamina y listadas en hardwareSummary
    const lateral = res.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(lateral.ancho).toBe(550); // cuerpo puro sin sumar patas
    const legs = res.hardwareSummary.find((h) => h.categoria === 'patas');
    expect(legs).toBeDefined();
    expect(legs?.cantidad).toBe(4);
    expect(legs?.medidaReferenciaMm).toBe(150);
  });

  it('Preset 3 (closet): repisas 723 mm, veta vertical en laterales (2064×550) y 2 fondos 750×2100×3 mm', () => {
    const { topology, params } = clonePreset('closet');
    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);

    const shelves = res.matrizDespiece.filter((p) => p.tipo === 'repisa');
    expect(shelves).toHaveLength(4);
    for (const s of shelves) {
      expect(s.ancho).toBeCloseTo(723, 4);
    }

    // Orientación de veta vertical en laterales
    const lat = res.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
    expect(lat.ancho).toBe(2064);
    expect(lat.alto).toBe(550);

    // Fondo Durolac 3 mm subdividido en 2 paños de 750×2100×3 mm sin veta ni tapacanto
    const backPanels = res.matrizDespiece.filter((p) => p.tipo === 'fondo');
    expect(backPanels).toHaveLength(2);
    for (const bp of backPanels) {
      expect(bp.ancho).toBeCloseTo(750, 4);
      expect(bp.alto).toBe(2100);
      expect(bp.espesor).toBe(3);
      expect(bp.respectGrain).toBe(false);
      expect(bp.edges).toEqual({ top: false, bottom: false, left: false, right: false });
      expect(bp.posicion3D[2]).toBe(-1.5);
    }
    expect(res.matrixNx5.some((r) => r[4] === 'durolac_3mm')).toBe(true);
    // matrixNx3 contiene exclusivamente placas de melamina 18 mm; consolidatedRows agrupa etiquetas limpias
    expect(res.matrixNx3.every((r) => r[2] === 18)).toBe(true);
    expect(res.consolidatedRows.some((r) => r.nombre === 'Laterales' && r.cantidad === 2)).toBe(true);
    expect(res.consolidatedRows.some((r) => r.nombre === 'Repisas' && r.cantidad === 4)).toBe(true);
  });

  it('ANTI-BUG H2: Estantería (equidistant) > 886 mm dispara pandeo y se apaga al agregar vDivider en u=0.5 sin solapamiento', () => {
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions.x = 1000;

    const resBefore = calculateDespiece(topology, params);
    const pandeoBefore = resBefore.alerts.filter((a) => a.tipo === 'pandeo');
    expect(pandeoBefore).toHaveLength(4);
    expect(pandeoBefore[0].luzLibreMm).toBeCloseTo(964, 3);

    // Agregar divisor vertical central en modo equidistant
    topology.vDividers.push({ id: 'div_centro', position: 0.5, start: 0, end: 1 });
    const resAfter = calculateDespiece(topology, params);
    assertNo3DOverlap(resAfter.matrizDespiece);

    const shelvesAfter = resAfter.matrizDespiece.filter((p) => p.tipo === 'repisa');
    expect(shelvesAfter).toHaveLength(8);
    for (const s of shelvesAfter) {
      expect(s.ancho).toBeCloseTo(473, 4);
    }
    expect(resAfter.alerts.filter((a) => a.tipo === 'pandeo')).toHaveLength(0);
  });

  it('Subdivisión de fondo 3 mm también cuando un solo eje excede 2440 mm', () => {
    const { topology, params } = clonePreset('estanteria');
    topology.hasBackPanel = true;
    params.targetDimensions = { x: 2600, y: 1000, z: 320 };
    const res = calculateDespiece(topology, params);
    const backPanels = res.matrizDespiece.filter((p) => p.tipo === 'fondo');
    expect(backPanels.length).toBeGreaterThanOrEqual(2);
    for (const bp of backPanels) {
      expect(bp.ancho).toBeLessThanOrEqual(1220);
    }
  });

  it('Homografía 3×3: mapeo exacto con eje Y invertido, ida y vuelta < 1e-6 y rechazo de cuadrilátero degenerado', () => {
    const quad: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 180, y: 90 },  // TL
      { x: 820, y: 120 }, // TR
      { x: 880, y: 690 }, // BR
      { x: 140, y: 660 }, // BL
    ];

    const hom = computeQuadToUnitHomography(quad);
    expect(hom).not.toBeNull();
    const { toUnit, toCanvas } = hom!;

    const expectedUnit: Point2D[] = [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ];

    for (let i = 0; i < 4; i++) {
      const u = applyHomography(toUnit, quad[i])!;
      expect(u.x).toBeCloseTo(expectedUnit[i].x, 6);
      expect(u.y).toBeCloseTo(expectedUnit[i].y, 6);
      const back = applyHomography(toCanvas, u)!;
      expect(Math.hypot(back.x - quad[i].x, back.y - quad[i].y)).toBeLessThan(1e-6);
    }

    // Punto interior ida y vuelta
    const probe: Point2D = { x: 480, y: 390 };
    const mapped = applyHomography(toUnit, probe)!;
    const restored = applyHomography(toCanvas, mapped)!;
    expect(Math.hypot(restored.x - probe.x, restored.y - probe.y)).toBeLessThan(1e-6);

    // Cuadrilátero degenerado (3 puntos colineales) -> null
    const degenerate: [Point2D, Point2D, Point2D, Point2D] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 50, y: 100 },
    ];
    expect(computeQuadToUnitHomography(degenerate)).toBeNull();
  });

  it('Vector unitario de forma û_V = V/||V||: norma 1 e invariancia exacta bajo k·V (0.5, 1.2, 2.0) + compararForma', () => {
    const base = { x: 800, y: 1800, z: 320 };
    const u0 = computeUnitDirectionVector(base);
    expect(Math.hypot(...u0.unit3D)).toBeCloseTo(1, 8);
    expect(Math.hypot(...u0.unitXY)).toBeCloseTo(1, 8);
    expect(u0.aspectRatioXY).toBeCloseTo(800 / 1800, 6);

    for (const k of [0.5, 1.2, 2.0]) {
      const uk = computeUnitDirectionVector({
        x: base.x * k,
        y: base.y * k,
        z: base.z * k,
      });
      expect(uk.unit3D[0]).toBeCloseTo(u0.unit3D[0], 8);
      expect(uk.unit3D[1]).toBeCloseTo(u0.unit3D[1], 8);
      expect(uk.unit3D[2]).toBeCloseTo(u0.unit3D[2], 8);
      expect(uk.unitXY[0]).toBeCloseTo(u0.unitXY[0], 8);
      expect(uk.unitXY[1]).toBeCloseTo(u0.unitXY[1], 8);
      expect(uk.magnitudeMm).toBeCloseTo(u0.magnitudeMm * k, 4);
    }

    // compararForma: sin deformación vs estirado horizontal/vertical
    const ok = compareShapeAspect(0.5, 900, 1800)!;
    expect(ok.warn).toBe(false);
    expect(ok.direction).toBe('ok');

    const wide = compareShapeAspect(0.5, 1500, 1800)!;
    expect(wide.warn).toBe(true);
    expect(wide.direction).toBe('estirado_horizontal');

    const tall = compareShapeAspect(1.5, 800, 1800)!;
    expect(tall.warn).toBe(true);
    expect(tall.direction).toBe('estirado_vertical');
  });

  it('Euler-Bernoulli DIN 68874-1: 800 mm cumple, 1000 mm falla con pandeo severo y divisor central recupera rigidez', () => {
    const d800 = calculateShelfDeflectionDIN(800, 320, 18, 25);
    expect(d800.passesDIN).toBe(true);
    expect(d800.allowableMm).toBeCloseTo(4.0, 2);
    expect(d800.deflectionMm).toBeCloseTo(3.89, 1);

    const d1000 = calculateShelfDeflectionDIN(1000, 320, 18, 25);
    expect(d1000.passesDIN).toBe(false);
    expect(d1000.status).toBe('Pandeo Severo');
    expect(d1000.deflectionMm).toBeGreaterThan(d1000.allowableMm);
    expect(d1000.maxLoadKg).toBeLessThan(20);

    // Con divisor central en mueble de 1000 mm -> luz 473 mm -> excelente rigidez
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions.x = 1000;
    topology.vDividers.push({ id: 'div_c', position: 0.5, start: 0, end: 1 });
    const res = calculateDespiece(topology, params);
    const reports = analyzeShelvesDeflectionDIN(res.matrizDespiece, 25);
    expect(reports).toHaveLength(8);
    expect(reports.every((r) => r.passesDIN && r.status === 'Excelente')).toBe(true);
  });

  it('Escritorio asimétrico con divisores verticales parciales (XY-Cut) -> cero solapamiento 3D exacto', () => {
    const { topology, params } = clonePreset('estanteria');
    params.targetDimensions = { x: 1400, y: 1200, z: 550 };
    params.referenceDimensions = { x: 1400, y: 1200, z: 550 };
    topology.shelfMode = 'custom';
    topology.vDividers = [
      { id: 'pedestal_div', position: 0.65, start: 0, end: 0.58 },
      { id: 'cubo_div_1', position: 1 / 3, start: 0.58, end: 1 },
      { id: 'cubo_div_2', position: 2 / 3, start: 0.58, end: 1 },
    ];
    topology.hShelves = [
      { id: 'escritorio_cubierta', position: 0.58, start: 0, end: 1 },
      { id: 'pedestal_rep_1', position: 0.2, start: 0.65, end: 1 },
      { id: 'pedestal_rep_2', position: 0.39, start: 0.65, end: 1 },
    ];

    const res = calculateDespiece(topology, params);
    assertNo3DOverlap(res.matrizDespiece);

    // La cubierta intermedia del escritorio queda en una sola pieza continua (no partida por divisores parciales)
    const desktop = res.matrizDespiece.find((p) => p.id === 'escritorio_cubierta')!;
    expect(desktop).toBeDefined();
    expect(desktop.ancho).toBeCloseTo(1400 - 36, 3);

    // Las 2 repisas del pedestal tienen ancho neto exacto descontando e/2 del divisor pedestal
    const pedShelves = res.matrizDespiece.filter((p) => p.id.startsWith('pedestal_rep_'));
    expect(pedShelves).toHaveLength(2);
    for (const ps of pedShelves) {
      expect(ps.ancho).toBeCloseTo((1400 - 36) * 0.35 - 9, 2);
    }
  });

  it('13. Mueble escalonado con espacio vacío exterior (`void_outside`), canastos metálicos, repisas interiores y ruedas (Imagen 12 v7.0): 0.000 mm overlap en ambos encuentros', () => {
    for (const joint of ['topOverSides', 'topBetweenSides'] as const) {
      const { topology, params } = clonePreset('estanteria');
      params.targetDimensions = { x: 950, y: 820, z: 420 };
      params.referenceDimensions = { x: 950, y: 820, z: 420 };
      params.cornerJointType = joint;
      params.material = 'roble';
      topology.shelfMode = 'custom';
      topology.hasBackPanel = true;
      topology.baseSupportType = 'wheels';
      topology.hasExternalLegs = true;
      topology.externalLegHeightMm = 65;
      topology.externalLegCount = 4;
      topology.vDividers = [
        { id: 'd1', position: 0.34, start: 0, end: 0.78 },
        { id: 'd2', position: 0.68, start: 0, end: 1 },
      ];
      topology.hShelves = [
        { id: 'r_caj', position: 0.78, start: 0, end: 0.68 },
        { id: 'r_step', position: 0.72, start: 0.68, end: 1 },
      ];
      topology.frontZones = [
        { id: 'c_sup', uStart: 0, uEnd: 0.68, vStart: 0.78, vEnd: 1, kind: 'drawers', drawerCount: 1, materialOverride: 'blanco' },
        { id: 'canastos', uStart: 0, uEnd: 0.34, vStart: 0, vEnd: 0.78, kind: 'baskets', basketCount: 3 },
        { id: 'p_cen', uStart: 0.34, uEnd: 0.68, vStart: 0, vEnd: 0.78, kind: 'door_left', internalShelves: 1, materialOverride: 'blanco' },
        { id: 'p_der', uStart: 0.68, uEnd: 1, vStart: 0, vEnd: 0.72, kind: 'door_right', materialOverride: 'blanco' },
        { id: 'void_step', uStart: 0.68, uEnd: 1, vStart: 0.72, vEnd: 1, kind: 'void_outside' },
      ];

      const res = calculateDespiece(topology, params);
      assertNo3DOverlap(res.matrizDespiece);

      const cubierta = res.matrizDespiece.find((p) => p.id === 'cubierta')!;
      const stepCap = res.matrizDespiece.find((p) => p.id === 'cubierta_escalon_der')!;
      const latIzq = res.matrizDespiece.find((p) => p.id === 'lateral_izq')!;
      const latDer = res.matrizDespiece.find((p) => p.id === 'lateral_der')!;
      const fondos = res.matrizDespiece.filter((p) => p.tipo === 'fondo');

      // Cubierta recortada a la torre alta (~648.5 mm en topOverSides, < 950 mm)
      expect(cubierta.ancho).toBeLessThan(700);
      expect(stepCap).toBeDefined();
      expect(stepCap.ancho).toBeGreaterThan(250);
      // Lateral derecho más bajo que el izquierdo por el escalón
      expect(latDer.ancho).toBeLessThan(latIzq.ancho - 150);
      // Fondo Durolac 3 mm segmentado en 2 paños (ninguno invade el espacio vacío arriba-derecha)
      expect(fondos).toHaveLength(2);
      expect(fondos.some((f) => f.alto < 620)).toBe(true);
      // Repisa interior dentro de puerta central creada sin colisión
      expect(res.matrizDespiece.some((p) => p.id.startsWith('rep_int_p_cen_'))).toBe(true);
      // Herrajes no-melamina: ruedas y 3 canastos metálicos
      expect(res.hardwareSummary.some((h) => /rueda/i.test(h.descripcion) && h.cantidad === 4)).toBe(true);
      expect(res.hardwareSummary.some((h) => /canasto/i.test(h.descripcion) && h.cantidad === 3)).toBe(true);
    }
  });
});
