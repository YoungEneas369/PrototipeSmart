// Prototype: 2-stage guillotine strip packing (rip strips along grain, then crosscut by length, FFD).
// Validates the audit claim that furniture carcasses collapse to ~1D because most pieces share alto = z_f.
interface Piece { name: string; ancho: number; alto: number; qty: number; grain: boolean }
interface Strip { h: number; used: number; items: string[] }
interface Sheet { strips: Strip[]; usedH: number }

export function packStrips(pieces: Piece[], W: number, H: number, kerf: number) {
  const items: { name: string; l: number; h: number }[] = [];
  for (const p of pieces) for (let i = 0; i < p.qty; i++) {
    let l = p.ancho, h = p.alto; // ancho along grain (sheet width W)
    if (!p.grain && (l > W || (h > H && l <= H)) ) [l, h] = [h, l];          // rotate only if needed / allowed
    if (!p.grain && h > l && h <= W && l <= H) [l, h] = [h, l];               // prefer long side along W
    items.push({ name: p.name, l, h });
  }
  const unplaced = items.filter(it => it.l > W || it.h > H);
  const ok = items.filter(it => it.l <= W && it.h <= H).sort((a, b) => b.h - a.h || b.l - a.l);
  const strips: Strip[] = [];
  for (const it of ok) { // virtual pad: capacity W + kerf, each item consumes l + kerf
    const s = strips.find(s => s.h >= it.h && s.h - it.h <= 0.25 * s.h && s.used + it.l + kerf <= W + kerf);
    if (s) { s.used += it.l + kerf; s.items.push(it.name); } else strips.push({ h: it.h, used: it.l + kerf, items: [it.name] });
  }
  const sheets: Sheet[] = [];
  for (const s of strips.sort((a, b) => b.h - a.h)) {
    const sh = sheets.find(sh => sh.usedH + s.h + kerf <= H + kerf);
    if (sh) { sh.usedH += s.h + kerf; sh.strips.push(s); } else sheets.push({ strips: [s], usedH: s.h + kerf });
  }
  const area = ok.reduce((a, it) => a + it.l * it.h, 0);
  return { sheets: sheets.length, usage: (100 * area) / (sheets.length * W * H || 1), lowerBound: Math.ceil(area / (W * H)), unplaced: unplaced.length, strips: strips.length };
}

const k = 4;
// Kerf edge cases from the Bloque 2 spec
const t1 = packStrips([{ name: 'full', ancho: 2440, alto: 1220, qty: 1, grain: true }], 2440, 1220, k);
const t2 = packStrips([{ name: 'a', ancho: 1218, alto: 600, qty: 2, grain: true }], 2440, 1220, k);
const t3 = packStrips([{ name: 'a', ancho: 1220, alto: 600, qty: 2, grain: true }], 2440, 1220, k);
console.log(`Kerf: 2440x1220 cabe=${t1.sheets === 1 && t1.unplaced === 0} | 2x1218 en 1 franja=${t2.strips === 1} | 2x1220 requiere 2 franjas=${t3.strips === 2} | 2600x1500 no ubicada=${packStrips([{ name: 'big', ancho: 2600, alto: 1500, qty: 1, grain: true }], 2440, 1220, k).unplaced === 1}`);

const presets: Record<string, Piece[]> = {
  'Estantería 800x1800x320': [
    { name: 'cubierta/base', ancho: 800, alto: 320, qty: 2, grain: true }, { name: 'lateral', ancho: 1764, alto: 320, qty: 2, grain: true },
    { name: 'repisa', ancho: 764, alto: 320, qty: 4, grain: true }],
  'Rack TV 1600x550x400': [
    { name: 'lateral', ancho: 550, alto: 400, qty: 2, grain: true }, { name: 'cubierta/base', ancho: 1564, alto: 400, qty: 2, grain: true },
    { name: 'divisor', ancho: 514, alto: 400, qty: 2, grain: true }, { name: 'repisa', ancho: 503.33, alto: 400, qty: 1, grain: true }],
  'Clóset 1500x2100x550 (18 mm)': [
    { name: 'cubierta/base', ancho: 1500, alto: 550, qty: 2, grain: true }, { name: 'lateral', ancho: 2064, alto: 550, qty: 2, grain: true },
    { name: 'divisor', ancho: 2064, alto: 550, qty: 1, grain: true }, { name: 'repisa', ancho: 723, alto: 550, qty: 4, grain: true }],
};
const back = [{ name: 'fondo', ancho: 750, alto: 2100, qty: 2, grain: false }];
for (const [n, p] of Object.entries(presets)) for (const [W, H, label] of [[2440, 1220, 'pauta 2440x1220'], [2500, 1830, 'Chile 2500x1830']] as const) {
  const r = packStrips(p, W, H, k);
  console.log(`${n.padEnd(30)} ${label}: ${r.sheets} plancha(s) (cota inferior por área ${r.lowerBound}), uso ${r.usage.toFixed(1)} %, franjas ${r.strips}, no ubicadas ${r.unplaced}`);
}
for (const [W, H, label] of [[2440, 1220, 'pauta 2440x1220'], [2440, 1520, 'Durolac Chile 2440x1520']] as const) {
  const r = packStrips(back, W, H, k);
  console.log(`Clóset fondo 2x 750x2100x3 mm   ${label}: ${r.sheets} plancha(s), uso ${r.usage.toFixed(1)} %, no ubicadas ${r.unplaced}`);
}
