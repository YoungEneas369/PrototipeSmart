/**
 * SMARTFURNITURE — CLASIFICADOR CROMÁTICO CIE-LAB Y CLUSTERING BICOLOR (v8.0)
 * 100% offline, álgebra de color pura (sRGB -> XYZ D65 -> CIE-L*a*b*), cero dependencias externas.
 *
 * Reemplaza las copias divergentes de clasificación RGB (`bandDetector`, `vectorLines`, `userVectorTrace`)
 * con una única fuente de verdad invariante a temperatura de iluminación interior (cálida 2700K / fría 6500K).
 */
import type { MelamineMaterial, PieceMaterial } from '../../types/contracts';
import { clamp } from './imageOps';

export type LabColor = [number, number, number];

export const MATERIAL_BASE_RGB: Record<PieceMaterial, [number, number, number]> = {
  blanco: [238, 240, 244],
  roble: [198, 154, 106],
  grafito: [62, 74, 92],
  durolac_3mm: [148, 114, 82],
};

// Blanco de referencia CIE D65 (2°)
const D65_XN = 0.95047;
const D65_YN = 1.0;
const D65_ZN = 1.08883;

function srgbToLinear(c255: number): number {
  const c = clamp(c255, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/**
 * Convierte sRGB `[0..255]^3` al espacio perceptualmente uniforme CIE-L*a*b* (iluminante D65).
 *  - `L* ∈ [0, 100]` (claridad)
 *  - `a* ∈ [-128, 127]` (verde <-> rojo)
 *  - `b* ∈ [-128, 127]` (azul <-> amarillo)
 */
export function rgbToLab(r: number, g: number, b: number): LabColor {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / D65_XN;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) / D65_YN;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / D65_ZN;

  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Distancia perceptual CIE76 `ΔE*` entre dos colores en CIE-Lab.
 */
export function deltaE76(
  lab1: readonly [number, number, number],
  lab2: readonly [number, number, number],
): number {
  return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);
}

/**
 * Distancia perceptual CIE76 `ΔE*` directa entre dos colores sRGB.
 */
export function rgbDeltaE(
  rgb1: readonly [number, number, number],
  rgb2: readonly [number, number, number],
): number {
  return deltaE76(rgbToLab(rgb1[0], rgb1[1], rgb1[2]), rgbToLab(rgb2[0], rgb2[1], rgb2[2]));
}

/**
 * Adaptación cromática suave (constancia de color tipo von Kries) cuando se conoce un
 * blanco de referencia ambiental (p. ej. pared blanca bajo luz cálida 2700K o fría 6500K).
 */
function applyChromaticAdaptation(
  r: number,
  g: number,
  b: number,
  ambientWhiteRgb?: readonly [number, number, number],
): [number, number, number] {
  if (!ambientWhiteRgb) return [r, g, b];
  const [ar, ag, ab] = ambientWhiteRgb;
  const ambLab = rgbToLab(ar, ag, ab);
  const ambChroma = Math.hypot(ambLab[1], ambLab[2]);
  // Aplicar balance de blancos solo si la referencia es realmente una pared clara casi neutra
  if (ambLab[0] < 72 || ambChroma > 18 || Math.min(ar, ag, ab) < 150) {
    return [r, g, b];
  }
  const avg = (ar + ag + ab) / 3;
  const strength = 0.55;
  const gR = clamp(1 + (avg / Math.max(1, ar) - 1) * strength, 0.84, 1.18);
  const gG = clamp(1 + (avg / Math.max(1, ag) - 1) * strength, 0.84, 1.18);
  const gB = clamp(1 + (avg / Math.max(1, ab) - 1) * strength, 0.84, 1.18);
  return [clamp(r * gR, 0, 255), clamp(g * gG, 0, 255), clamp(b * gB, 0, 255)];
}

/**
 * Determina en espacio CIE-Lab si un color corresponde a madera genuina (`roble` / pino / nogal),
 * separándola de blancos bajo luz cálida (alta `L*`, bajo croma) y sombras neutras.
 */
export function isWarmWoodLab(
  lab: readonly [number, number, number],
  stdL?: number,
): boolean {
  const [L, a, b] = lab;
  if (L < 22 || L > 86) return false;
  if (b < 13.5 || a < 1.5) return false;
  const chroma = Math.hypot(a, b);
  // Para tonos muy claros (L* > 80) exigir mayor croma para no confundir blanco bajo luz cálida
  const minChroma = L > 80 ? 20.5 : 15.5;
  if (chroma < minChroma) return false;
  if (L > 80 && b < 18) return false;
  // Ángulo de tono en el cuadrante cálido amarillo-naranja (aprox. 28°..85°)
  const hueDeg = (Math.atan2(b, a) * 180) / Math.PI;
  if (hueDeg < 26 || hueDeg > 86) return false;
  if (stdL !== undefined && stdL > 34 && b < 22) return false;
  return true;
}

/**
 * Clasificador unificado de acabado de melamina (`blanco` | `roble` | `grafito`) en CIE-Lab.
 * Invariante a luz cálida/fría interior y distingue nogal oscuro (`roble`) de `grafito`.
 */
export function classifyMelamineMaterial(
  r: number,
  g: number,
  b: number,
  ambientWhiteRgb?: readonly [number, number, number],
): MelamineMaterial {
  const [cr, cg, cb] = applyChromaticAdaptation(r, g, b, ambientWhiteRgb);
  const lab = rgbToLab(cr, cg, cb);
  const [L, a, bVal] = lab;

  // 1. Madera cálida genuina (incluye nogal oscuro L* ≈ 35..45 y roble claro L* ≈ 75)
  if (isWarmWoodLab(lab)) {
    return 'roble';
  }

  // 2. Melamina blanca (incluso bajo iluminación cálida suave o fría azulada)
  if (L >= 68) {
    return 'blanco';
  }

  // 3. Melamina grafito / gris oficina
  if (L <= 55) {
    return 'grafito';
  }

  // 4. Zona intermedia (55 < L* < 68): desempate por calidez Lab
  if (bVal >= 12 && a >= 1.0) {
    return 'roble';
  }
  return L >= 62 ? 'blanco' : 'grafito';
}

/**
 * Alias explícito para uso desde la UI (`VectorCanvas`) y pruebas sin duplicar heurísticas RGB.
 */
export const classifyMelamineMaterialFromRgb = classifyMelamineMaterial;

/**
 * Evalúa si el color de una celda justifica un `materialOverride` bicolor frente a la carcasa.
 */
export function inferMaterialOverrideLab(
  cellRgb: readonly [number, number, number],
  carcassRgb: readonly [number, number, number],
  carcassMaterial: MelamineMaterial,
  stdL?: number,
  ambientWhiteRgb?: readonly [number, number, number],
): MelamineMaterial | undefined {
  const [cr, cg, cb] = applyChromaticAdaptation(cellRgb[0], cellRgb[1], cellRgb[2], ambientWhiteRgb);
  const [kr, kg, kb] = applyChromaticAdaptation(
    carcassRgb[0],
    carcassRgb[1],
    carcassRgb[2],
    ambientWhiteRgb,
  );
  const cellLab = rgbToLab(cr, cg, cb);
  const carcassLab = rgbToLab(kr, kg, kb);
  const dE = deltaE76(cellLab, carcassLab);
  const warmWood = isWarmWoodLab(cellLab, stdL);
  const cellMat = warmWood ? 'roble' : classifyMelamineMaterial(cr, cg, cb);

  if (cellMat === carcassMaterial) return undefined;
  if (dE >= 17 || (warmWood && carcassMaterial !== 'roble' && dE >= 13)) {
    return cellMat;
  }
  return undefined;
}

export interface BicolorClusterResult {
  carcassLab: LabColor;
  secondaryLab: LabColor | null;
  isBicolor: boolean;
  secondaryMaterial: MelamineMaterial | null;
  assignments: Array<'carcass' | 'secondary'>;
}

/**
 * Clustering ligero determinista (2-means en CIE-Lab anclado a la carcasa) para distinguir
 * muebles monocromáticos vs muebles bicolores (ej. carcasa blanca + cajones roble, o
 * carcasa grafito + puertas nogal).
 */
export function clusterCarcassVsFronts(
  carcassRgb: readonly [number, number, number],
  carcassMaterial: MelamineMaterial,
  cellRgbs: ReadonlyArray<readonly [number, number, number]>,
  ambientWhiteRgb?: readonly [number, number, number],
): BicolorClusterResult {
  const [kr, kg, kb] = applyChromaticAdaptation(
    carcassRgb[0],
    carcassRgb[1],
    carcassRgb[2],
    ambientWhiteRgb,
  );
  const carcassLab = rgbToLab(kr, kg, kb);

  if (cellRgbs.length === 0) {
    return {
      carcassLab,
      secondaryLab: null,
      isBicolor: false,
      secondaryMaterial: null,
      assignments: [],
    };
  }

  const adaptedRgbs = cellRgbs.map((c) =>
    applyChromaticAdaptation(c[0], c[1], c[2], ambientWhiteRgb),
  );
  const cellLabs = adaptedRgbs.map((c) => rgbToLab(c[0], c[1], c[2]));

  // Inicialización determinista por punto más lejano a la carcasa en ΔE*
  let farthestIdx = -1;
  let maxDist = 0;
  for (let i = 0; i < cellLabs.length; i++) {
    const d = deltaE76(cellLabs[i], carcassLab);
    if (d > maxDist) {
      maxDist = d;
      farthestIdx = i;
    }
  }

  if (farthestIdx < 0 || maxDist < 16) {
    return {
      carcassLab,
      secondaryLab: null,
      isBicolor: false,
      secondaryMaterial: null,
      assignments: cellRgbs.map(() => 'carcass'),
    };
  }

  let c0: LabColor = [...carcassLab];
  let c1: LabColor = [...cellLabs[farthestIdx]];
  const assign = new Array<'carcass' | 'secondary'>(cellLabs.length).fill('carcass');

  for (let iter = 0; iter < 6; iter++) {
    let s0L = carcassLab[0] * 1.5,
      s0a = carcassLab[1] * 1.5,
      s0b = carcassLab[2] * 1.5,
      n0 = 1.5;
    let s1L = 0,
      s1a = 0,
      s1b = 0,
      n1 = 0;
    let changed = false;

    for (let i = 0; i < cellLabs.length; i++) {
      const d0 = deltaE76(cellLabs[i], c0);
      const d1 = deltaE76(cellLabs[i], c1);
      const next: 'carcass' | 'secondary' = d1 + 1.5 < d0 && d0 >= 14 ? 'secondary' : 'carcass';
      if (next !== assign[i]) {
        assign[i] = next;
        changed = true;
      }
      if (next === 'carcass') {
        s0L += cellLabs[i][0];
        s0a += cellLabs[i][1];
        s0b += cellLabs[i][2];
        n0++;
      } else {
        s1L += cellLabs[i][0];
        s1a += cellLabs[i][1];
        s1b += cellLabs[i][2];
        n1++;
      }
    }

    c0 = [s0L / n0, s0a / n0, s0b / n0];
    if (n1 > 0) {
      c1 = [s1L / n1, s1a / n1, s1b / n1];
    }
    if (!changed) break;
  }

  const secIndices: number[] = [];
  for (let i = 0; i < assign.length; i++) {
    if (assign[i] === 'secondary') secIndices.push(i);
  }
  if (secIndices.length === 0 || deltaE76(c0, c1) < 16) {
    return {
      carcassLab,
      secondaryLab: null,
      isBicolor: false,
      secondaryMaterial: null,
      assignments: cellRgbs.map(() => 'carcass'),
    };
  }

  // Promedio RGB del clúster secundario para clasificar acabado
  let sr = 0,
    sg = 0,
    sb = 0;
  for (const idx of secIndices) {
    sr += adaptedRgbs[idx][0];
    sg += adaptedRgbs[idx][1];
    sb += adaptedRgbs[idx][2];
  }
  const secMat = classifyMelamineMaterial(
    sr / secIndices.length,
    sg / secIndices.length,
    sb / secIndices.length,
  );

  if (secMat === carcassMaterial) {
    return {
      carcassLab,
      secondaryLab: null,
      isBicolor: false,
      secondaryMaterial: null,
      assignments: cellRgbs.map(() => 'carcass'),
    };
  }

  return {
    carcassLab,
    secondaryLab: c1,
    isBicolor: true,
    secondaryMaterial: secMat,
    assignments: assign,
  };
}
