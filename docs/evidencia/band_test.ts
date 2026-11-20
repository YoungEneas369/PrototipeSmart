// Synthetic stress test (v2.1 Rev. 2) for bandDetector:
// Covers original 5 scenarios + 3 real-photo failure modes:
//   (6) Severe 3D perspective parallax (550 mm deep closet @ 3 m -> up to ~128 mm visible shelf top/underside)
//   (7) Corner-click jitter (outer border shifted by 3 px onto wall background)
//   (8) Warm wood (Roble) board vs equal-luminance cool gray cavity (tests chroma+luminance RGBA path)
import { detectStructure, detectStructureRGBA } from './bandDetector.ts';

function rng(s: number) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Sh { v: number; s: number; e: number }
interface Spec {
  name: string;
  x: number;
  y: number;
  depth?: number;
  camDist?: number;
  div: number[];
  shelves: Sh[];
  cavityRGB: [number, number, number];
  boardRGB: [number, number, number];
  books: boolean;
  borderJitterPx?: number;
  useRGBA?: boolean;
  expectUnreliable?: boolean;
}

const E = 18;

function renderRGBA(sp: Spec, W: number, H: number, seed: number): Uint8ClampedArray {
  const r = rng(seed);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const setPx = (x: number, y: number, R: number, G: number, B: number) => {
    const idx = (y * W + x) * 4;
    rgba[idx] = Math.max(0, Math.min(255, Math.round(R)));
    rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(G)));
    rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(B)));
    rgba[idx + 3] = 255;
  };
  const fill = (
    x0: number, y0: number, x1: number, y1: number,
    fn: (R: number, G: number, B: number) => [number, number, number],
  ) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) {
        const idx = (y * W + x) * 4;
        const [nr, ng, nb] = fn(rgba[idx], rgba[idx + 1], rgba[idx + 2]);
        setPx(x, y, nr, ng, nb);
      }
    }
  };

  // Base cavity fill
  fill(0, 0, W, H, () => sp.cavityRGB);

  const X = (mm: number) => (mm / sp.x) * W;
  const R = (mmFloor: number) => (1 - mmFloor / sp.y) * H;
  const ix = (u: number) => E + u * (sp.x - 2 * E);
  const iy = (v: number) => E + v * (sp.y - 2 * E);

  if (sp.books) {
    for (let i = 0; i < (W * H) / 350; i++) {
      const x = r() * W, w = 3 + r() * 9, h = 15 + r() * 90, y = r() * H;
      const L = 25 + r() * 215;
      fill(x, y, x + w, y + h, () => [L, L * 0.96, L * 0.92]);
    }
  }

  // Simulate realistic 3D parallax: visible top surface (below horizon) or underside (above horizon)
  // in the SAME melamine color (slightly shaded inside cavity) + visible side face on off-center dividers.
  const depth = sp.depth ?? 0;
  const camDist = sp.camDist ?? 3000;
  const camY = sp.y * 0.5;
  const camX = sp.x * 0.5;
  const surfaceRGB: [number, number, number] = [
    sp.boardRGB[0] * 0.92, sp.boardRGB[1] * 0.92, sp.boardRGB[2] * 0.92,
  ];

  if (depth > 0) {
    for (const s of sp.shelves) {
      const shelfY = iy(s.v);
      const dy = shelfY - camY; // negative = below eye level -> top surface visible ABOVE front edge
      const projBackY = camY + dy * (camDist / (camDist + depth));
      const yA = R(Math.max(shelfY + E / 2, projBackY));
      const yB = R(Math.min(shelfY - E / 2, projBackY));
      fill(X(ix(s.s)), yA, X(ix(s.e)), yB, () => surfaceRGB);
    }
    for (const u of sp.div) {
      const divX = ix(u);
      const dx = divX - camX;
      const projBackX = camX + dx * (camDist / (camDist + depth));
      const xA = X(Math.min(divX - E / 2, projBackX));
      const xB = X(Math.max(divX + E / 2, projBackX));
      fill(xA, R(sp.y - E), xB, R(E), () => surfaceRGB);
    }
  }

  // Shadow directly below each shelf front edge
  const tH = (E / sp.y) * H;
  for (const s of sp.shelves) {
    fill(X(ix(s.s)), R(iy(s.v) - E / 2), X(ix(s.e)), R(iy(s.v) - E / 2) + 1.2 * tH, (rr, gg, bb) => [
      rr * 0.68, gg * 0.68, bb * 0.68,
    ]);
  }

  // Carcass outer boards + internal front edges (18 mm)
  const board = (): [number, number, number] => sp.boardRGB;
  fill(0, 0, X(E), H, board);
  fill(X(sp.x - E), 0, W, H, board);
  fill(0, 0, W, R(sp.y - E), board);
  fill(0, R(E), W, H, board);
  for (const u of sp.div) fill(X(ix(u) - E / 2), R(sp.y - E), X(ix(u) + E / 2), R(E), board);
  for (const s of sp.shelves) fill(X(ix(s.s)), R(iy(s.v) + E / 2), X(ix(s.e)), R(iy(s.v) - E / 2), board);

  // Optional corner-click jitter: contaminate left outer border with wall pixels
  if (sp.borderJitterPx && sp.borderJitterPx > 0) {
    fill(0, 0, sp.borderJitterPx, H, () => [120, 125, 130]);
  }

  // Strong window lighting gradient + sensor noise
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const L = (0.55 + 0.45 * (x / W)) * (0.82 + 0.18 * (1 - y / H));
      const idx = (y * W + x) * 4;
      const noise = (r() - 0.5) * 18;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(rgba[idx] * L + noise)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(rgba[idx + 1] * L + noise)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(rgba[idx + 2] * L + noise)));
    }
  }
  return rgba;
}

function rgbaToGray(rgba: Uint8ClampedArray, W: number, H: number): Float32Array {
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    g[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
  }
  return g;
}

const eq = (n: number, y: number) => {
  const hi = y - 2 * E, s = (hi - n * E) / (n + 1);
  return Array.from({ length: n }, (_, k) => ({ v: (E + s + k * (s + E) + E / 2 - E) / hi, s: 0, e: 1 }));
};

const specs: Spec[] = [
  { name: 'Estantería 800x1800, 4 repisas, con libros', x: 800, y: 1800, div: [], shelves: eq(4, 1800), cavityRGB: [115, 115, 115], boardRGB: [224, 224, 224], books: true },
  { name: 'Rack TV 1600x550 (vano mixto), con objetos', x: 1600, y: 550, div: [1 / 3, 2 / 3], shelves: [{ v: 0.5, s: 1 / 3, e: 2 / 3 }], cavityRGB: [102, 102, 102], boardRGB: [224, 224, 224], books: true },
  { name: 'Clóset 1500x2100 (3 izq + 1 der), con ropa', x: 1500, y: 2100, div: [0.5], shelves: [{ v: 0.25, s: 0, e: 0.5 }, { v: 0.5, s: 0, e: 0.5 }, { v: 0.75, s: 0, e: 0.5 }, { v: 0.82, s: 0.5, e: 1 }], cavityRGB: [115, 115, 115], boardRGB: [224, 224, 224], books: true },
  { name: 'Grafito oscuro 800x1800 (tablero más oscuro)', x: 800, y: 1800, div: [], shelves: eq(3, 1800), cavityRGB: [140, 140, 140], boardRGB: [56, 56, 56], books: true },
  { name: 'PARALAJE REAL: Clóset 1500x2100x550 a 3 m (cara visible ~100 mm)', x: 1500, y: 2100, depth: 550, camDist: 3000, div: [0.5], shelves: [{ v: 0.25, s: 0, e: 0.5 }, { v: 0.5, s: 0, e: 0.5 }, { v: 0.75, s: 0, e: 0.5 }, { v: 0.82, s: 0.5, e: 1 }], cavityRGB: [110, 110, 110], boardRGB: [224, 224, 224], books: true, useRGBA: true },
  { name: 'ERROR DE CLIC (3 px en borde izq) + paralaje Estantería 320 mm', x: 800, y: 1800, depth: 320, camDist: 3000, div: [], shelves: eq(4, 1800), cavityRGB: [108, 108, 108], boardRGB: [224, 224, 224], books: true, borderJitterPx: 3, useRGBA: true },
  { name: 'ROBLE vs HUECO MISMA LUMINANCIA (croma RGBA)', x: 800, y: 1800, depth: 320, camDist: 3000, div: [], shelves: eq(4, 1800), cavityRGB: [146, 152, 160], boardRGB: [188, 145, 92], books: true, useRGBA: true },
  { name: 'ESTRÉS: blanco sobre blanco (debe marcar NO CONFIABLE)', x: 800, y: 1800, div: [], shelves: eq(4, 1800), cavityRGB: [204, 204, 204], boardRGB: [224, 224, 224], books: false, useRGBA: true, expectUnreliable: true },
];

let pass = 0;
for (const [i, sp] of specs.entries()) {
  const W = Math.max(360, Math.ceil((6 * sp.x) / E)), H = Math.round((W * sp.y) / sp.x);
  const rgba = renderRGBA(sp, W, H, 7 + i);
  const t0 = performance.now();
  const det = sp.useRGBA
    ? detectStructureRGBA(rgba, W, H, E / sp.x, E / sp.y)
    : detectStructure(rgbaToGray(rgba, W, H), W, H, E / sp.x, E / sp.y);
  const ms = performance.now() - t0;
  const xi = sp.x - 2 * E, yi = sp.y - 2 * E;
  const dErr = sp.div.map(u => Math.min(...det.vDividers.map(d => Math.abs(d.position - u) * xi)));
  const sErr = sp.shelves.map(s => Math.min(
    ...det.hShelves
      .filter(h => h.start <= s.s + 0.02 && h.end >= s.e - 0.02)
      .map(h => Math.abs(h.position - s.v) * yi),
  ));

  const ok = sp.expectUnreliable
    ? det.confidence < 0.5 && det.interiorMatch > 0.5
    : det.vDividers.length === sp.div.length
      && det.hShelves.length === sp.shelves.length
      && [...dErr, ...sErr].every(e => e <= 8)
      && det.confidence >= 0.5;
  if (ok) pass++;

  const status = det.confidence < 0.5 ? 'NO CONFIABLE -> pedir trazado manual' : `confiable (${(det.confidence * 100).toFixed(0)}%)`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sp.name}  [${W}x${H}, ${ms.toFixed(0)} ms, interiorMatch=${(det.interiorMatch * 100).toFixed(0)}%, ${status}]`);
  console.log(`     divisores det=${det.vDividers.length}/${sp.div.length} err(mm)=${dErr.map(e => (isFinite(e) ? e.toFixed(1) : 'X')).join(', ') || '-'} | repisas det=${det.hShelves.length}/${sp.shelves.length} err(mm)=${sErr.map(e => (isFinite(e) ? e.toFixed(1) : 'X')).join(', ')}`);
}
console.log(`\n${pass}/${specs.length} escenarios correctos`);
