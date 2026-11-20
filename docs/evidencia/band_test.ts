// Synthetic stress test for bandDetector: books in cavities, shadows under shelves,
// strong lighting gradient, sensor noise. Rendered directly in rectified space.
import { detectStructure } from './bandDetector.ts';

function rng(s: number) { return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
interface Sh { v: number; s: number; e: number }
interface Spec { name: string; x: number; y: number; div: number[]; shelves: Sh[]; cavity: number; board: number; books: boolean }
const E = 18;

function render(sp: Spec, W: number, H: number, seed: number) {
  const r = rng(seed), img = new Float32Array(W * H).fill(sp.cavity);
  const X = (mm: number) => (mm / sp.x) * W, R = (mmFloor: number) => (1 - mmFloor / sp.y) * H;
  const ix = (u: number) => E + u * (sp.x - 2 * E), iy = (v: number) => E + v * (sp.y - 2 * E);
  const fill = (x0: number, y0: number, x1: number, y1: number, f: (o: number) => number) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) img[y * W + x] = f(img[y * W + x]);
  };
  if (sp.books) for (let i = 0; i < (W * H) / 350; i++) { // random "books" anywhere behind the front edges
    const x = r() * W, w = 3 + r() * 9, h = 15 + r() * 90, y = r() * H, L = 0.1 + r() * 0.85;
    fill(x, y, x + w, y + h, () => L);
  }
  const tH = (E / sp.y) * H;
  for (const s of sp.shelves) fill(X(ix(s.s)), R(iy(s.v) - E / 2), X(ix(s.e)), R(iy(s.v) - E / 2) + 1.2 * tH, o => o * 0.7); // shadow below
  const board = () => sp.board;
  fill(0, 0, X(E), H, board); fill(X(sp.x - E), 0, W, H, board);            // sides
  fill(0, 0, W, R(sp.y - E), board); fill(0, R(E), W, H, board);            // top / base
  for (const u of sp.div) fill(X(ix(u) - E / 2), R(sp.y - E), X(ix(u) + E / 2), R(E), board);
  for (const s of sp.shelves) fill(X(ix(s.s)), R(iy(s.v) + E / 2), X(ix(s.e)), R(iy(s.v) - E / 2), board);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const L = (0.5 + 0.5 * (x / W)) * (0.8 + 0.2 * (1 - y / H)); // strong side window light
    img[y * W + x] = Math.min(1, Math.max(0, img[y * W + x] * L + (r() - 0.5) * 0.08));
  }
  return img;
}

const eq = (n: number, y: number) => { const hi = y - 2 * E, s = (hi - n * E) / (n + 1); return Array.from({ length: n }, (_, k) => ({ v: (E + s + k * (s + E) + E / 2 - E) / hi, s: 0, e: 1 })); };
const specs: Spec[] = [
  { name: 'Estantería 800x1800, 4 repisas, con libros', x: 800, y: 1800, div: [], shelves: eq(4, 1800), cavity: 0.45, board: 0.88, books: true },
  { name: 'Rack TV 1600x550 (vano mixto), con objetos', x: 1600, y: 550, div: [1 / 3, 2 / 3], shelves: [{ v: 0.5, s: 1 / 3, e: 2 / 3 }], cavity: 0.4, board: 0.88, books: true },
  { name: 'Clóset 1500x2100 (3 izq + 1 der), con ropa', x: 1500, y: 2100, div: [0.5], shelves: [{ v: 0.25, s: 0, e: 0.5 }, { v: 0.5, s: 0, e: 0.5 }, { v: 0.75, s: 0, e: 0.5 }, { v: 0.82, s: 0.5, e: 1 }], cavity: 0.45, board: 0.88, books: true },
  { name: 'Grafito oscuro 800x1800 (tablero más oscuro que el hueco)', x: 800, y: 1800, div: [], shelves: eq(3, 1800), cavity: 0.55, board: 0.22, books: true },
  { name: 'ESTRÉS: blanco con fondo blanco (contraste 0.80 vs 0.88)', x: 800, y: 1800, div: [], shelves: eq(4, 1800), cavity: 0.8, board: 0.88, books: false },
];

let pass = 0;
for (const [i, sp] of specs.entries()) {
  const W = Math.max(360, Math.ceil((6 * sp.x) / E)), H = Math.round((W * sp.y) / sp.x);
  const t0 = performance.now();
  const det = detectStructure(render(sp, W, H, 7 + i), W, H, E / sp.x, E / sp.y);
  const ms = performance.now() - t0;
  const xi = sp.x - 2 * E, yi = sp.y - 2 * E;
  const dErr = sp.div.map(u => Math.min(...det.vDividers.map(d => Math.abs(d.position - u) * xi)));
  const sErr = sp.shelves.map(s => Math.min(...det.hShelves.filter(h => h.start <= s.s + 0.02 && h.end >= s.e - 0.02).map(h => Math.abs(h.position - s.v) * yi)));
  const ok = det.vDividers.length === sp.div.length && det.hShelves.length === sp.shelves.length && [...dErr, ...sErr].every(e => e <= 8);
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${sp.name}  [${W}x${H}, ${ms.toFixed(0)} ms, interiorMatch=${(det.interiorMatch * 100).toFixed(0)}% ${det.interiorMatch > 0.5 ? '-> NO CONFIABLE, pedir trazado manual' : '-> confiable'}]`);
  console.log(`     divisores det=${det.vDividers.length}/${sp.div.length} err(mm)=${dErr.map(e => e.toFixed(1)).join(', ') || '-'} | repisas det=${det.hShelves.length}/${sp.shelves.length} err(mm)=${sErr.map(e => (isFinite(e) ? e.toFixed(1) : 'X')).join(', ')}`);
}
console.log(`\n${pass}/${specs.length} escenarios correctos`);
