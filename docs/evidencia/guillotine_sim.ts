// Prototype (v2.1 Rev. 2): 2-stage guillotine strip packing with exact coordinates,
// trim margin support, and TRUE 2-orientation search when respectGrain = false.
// Validates that toggling respectGrain genuinely rotates pieces and reduces sheets/waste.
interface Piece { name: string; ancho: number; alto: number; qty: number; grain: boolean }
interface Item { name: string; ancho: number; alto: number; allowRotate: boolean }
interface Placed { name: string; x: number; y: number; ancho: number; alto: number; rotado: boolean }
interface Strip { h: number; usedW: number; items: { name: string; x: number; l: number; h: number; rotado: boolean }[] }
interface Sheet { strips: Strip[]; usedH: number; placed: Placed[] }

function packWithPolicy(
  items: Item[],
  usableW: number,
  usableH: number,
  kerf: number,
  trimMm: number,
  policy: 'default' | 'preferRotated' | 'mixed',
) {
  const oriented: { name: string; l: number; h: number; rotado: boolean; allowRotate: boolean }[] = [];
  for (const it of items) {
    let l = it.ancho, h = it.alto, rotado = false;
    const fitsNormal = l <= usableW && h <= usableH;
    const fitsRot = it.allowRotate && h <= usableW && l <= usableH;
    if (!fitsNormal && fitsRot) {
      [l, h] = [h, l];
      rotado = true;
    } else if (it.allowRotate && fitsRot) {
      if (policy === 'preferRotated' && l > h) {
        [l, h] = [h, l];
        rotado = true;
      } else if (policy === 'default' && h > l) {
        [l, h] = [h, l];
        rotado = true;
      }
    }
    oriented.push({ name: it.name, l, h, rotado, allowRotate: it.allowRotate });
  }

  const unplaced = oriented.filter(it => it.l > usableW || it.h > usableH);
  const ok = oriented
    .filter(it => it.l <= usableW && it.h <= usableH)
    .sort((a, b) => b.h - a.h || b.l - a.l);

  const strips: Strip[] = [];
  for (const it of ok) {
    // In 'mixed' mode, try normal orientation in existing strips, then rotated orientation in existing strips.
    let target = strips.find(s => s.h >= it.h && s.h - it.h <= 0.25 * s.h && s.usedW + it.l + kerf <= usableW + kerf);
    let placedL = it.l, placedH = it.h, placedRot = it.rotado;

    if (!target && policy === 'mixed' && it.allowRotate && it.h <= usableW && it.l <= usableH) {
      const rotTarget = strips.find(s => s.h >= it.l && s.h - it.l <= 0.25 * s.h && s.usedW + it.h + kerf <= usableW + kerf);
      if (rotTarget) {
        target = rotTarget;
        placedL = it.h;
        placedH = it.l;
        placedRot = !it.rotado;
      }
    }

    if (target) {
      const x = trimMm + target.usedW;
      target.usedW += placedL + kerf;
      target.items.push({ name: it.name, x, l: placedL, h: placedH, rotado: placedRot });
    } else {
      strips.push({
        h: placedH,
        usedW: placedL + kerf,
        items: [{ name: it.name, x: trimMm, l: placedL, h: placedH, rotado: placedRot }],
      });
    }
  }

  const sheets: Sheet[] = [];
  for (const st of strips.sort((a, b) => b.h - a.h)) {
    const sh = sheets.find(s => s.usedH + st.h + kerf <= usableH + kerf);
    const y = trimMm + (sh ? sh.usedH : 0);
    const placedItems: Placed[] = st.items.map(it => ({
      name: it.name, x: it.x, y, ancho: it.l, alto: it.h, rotado: it.rotado,
    }));
    if (sh) {
      sh.usedH += st.h + kerf;
      sh.strips.push(st);
      sh.placed.push(...placedItems);
    } else {
      sheets.push({ strips: [st], usedH: st.h + kerf, placed: placedItems });
    }
  }

  return { sheets, unplaced, strips: strips.length };
}

export function packStrips(pieces: Piece[], W: number, H: number, kerf: number, respectGrain = true, trimMm = 0) {
  const usableW = W - 2 * trimMm;
  const usableH = H - 2 * trimMm;
  const items: Item[] = [];
  for (const p of pieces) {
    for (let i = 0; i < p.qty; i++) {
      items.push({ name: p.name, ancho: p.ancho, alto: p.alto, allowRotate: !(respectGrain && p.grain) });
    }
  }

  const policies: ('default' | 'preferRotated' | 'mixed')[] = items.some(i => i.allowRotate)
    ? ['default', 'preferRotated', 'mixed']
    : ['default'];

  let best = packWithPolicy(items, usableW, usableH, kerf, trimMm, 'default');
  for (const pol of policies.slice(1)) {
    const cand = packWithPolicy(items, usableW, usableH, kerf, trimMm, pol);
    if (
      cand.unplaced.length < best.unplaced.length
      || (cand.unplaced.length === best.unplaced.length && cand.sheets.length < best.sheets.length)
      || (cand.unplaced.length === best.unplaced.length
        && cand.sheets.length === best.sheets.length
        && cand.strips < best.strips)
    ) {
      best = cand;
    }
  }

  // Verify invariants: bounds + pairwise zero-overlap with >= kerf separation
  for (const sh of best.sheets) {
    for (const a of sh.placed) {
      if (a.x < trimMm - 1e-6 || a.y < trimMm - 1e-6 || a.x + a.ancho > W - trimMm + 1e-6 || a.y + a.alto > H - trimMm + 1e-6) {
        throw new Error(`Bounds violation: ${JSON.stringify(a)}`);
      }
    }
    for (let i = 0; i < sh.placed.length; i++) {
      for (let j = i + 1; j < sh.placed.length; j++) {
        const a = sh.placed[i], b = sh.placed[j];
        const sepX = Math.max(b.x - (a.x + a.ancho), a.x - (b.x + b.ancho));
        const sepY = Math.max(b.y - (a.y + a.alto), a.y - (b.y + b.alto));
        if (Math.max(sepX, sepY) < kerf - 1e-6) {
          throw new Error(`Kerf/overlap violation between ${a.name} and ${b.name}`);
        }
      }
    }
  }

  const area = best.sheets.reduce((acc, sh) => acc + sh.placed.reduce((s, p) => s + p.ancho * p.alto, 0), 0);
  const rotatedCount = best.sheets.reduce((acc, sh) => acc + sh.placed.filter(p => p.rotado).length, 0);
  return {
    sheets: best.sheets.length,
    usage: (100 * area) / (best.sheets.length * W * H || 1),
    lowerBound: Math.ceil(area / (W * H)),
    unplaced: best.unplaced.length,
    strips: best.strips,
    rotatedCount,
  };
}

const k = 4;
const t1 = packStrips([{ name: 'full', ancho: 2440, alto: 1220, qty: 1, grain: true }], 2440, 1220, k);
const t2 = packStrips([{ name: 'a', ancho: 1218, alto: 600, qty: 2, grain: true }], 2440, 1220, k);
const t3 = packStrips([{ name: 'a', ancho: 1220, alto: 600, qty: 2, grain: true }], 2440, 1220, k);
const t4 = packStrips([{ name: 'big', ancho: 2600, alto: 1500, qty: 1, grain: true }], 2440, 1220, k);
console.log(`Kerf: 2440x1220 cabe=${t1.sheets === 1 && t1.unplaced === 0} | 2x1218 en 1 franja=${t2.strips === 1} | 2x1220 requiere 2 franjas=${t3.strips === 2} | 2600x1500 no ubicada=${t4.unplaced === 1}`);

const presets: Record<string, Piece[]> = {
  'Estantería 800x1800x320': [
    { name: 'cubierta/base', ancho: 800, alto: 320, qty: 2, grain: true },
    { name: 'lateral', ancho: 1764, alto: 320, qty: 2, grain: true },
    { name: 'repisa', ancho: 764, alto: 320, qty: 4, grain: true },
  ],
  'Rack TV 1600x550x400': [
    { name: 'lateral', ancho: 550, alto: 400, qty: 2, grain: true },
    { name: 'cubierta/base', ancho: 1564, alto: 400, qty: 2, grain: true },
    { name: 'divisor', ancho: 514, alto: 400, qty: 2, grain: true },
    { name: 'repisa', ancho: 503.33, alto: 400, qty: 1, grain: true },
  ],
  'Clóset 1500x2100x550 (18 mm)': [
    { name: 'cubierta/base', ancho: 1500, alto: 550, qty: 2, grain: true },
    { name: 'lateral', ancho: 2064, alto: 550, qty: 2, grain: true },
    { name: 'divisor', ancho: 2064, alto: 550, qty: 1, grain: true },
    { name: 'repisa', ancho: 723, alto: 550, qty: 4, grain: true },
  ],
};

for (const [n, p] of Object.entries(presets)) {
  for (const [W, H, label] of [[2440, 1220, 'pauta 2440x1220'], [2500, 1830, 'Chile 2500x1830']] as const) {
    const r = packStrips(p, W, H, k, true);
    console.log(`${n.padEnd(30)} ${label}: ${r.sheets} plancha(s) (cota inf ${r.lowerBound}), uso ${r.usage.toFixed(1)} %, franjas ${r.strips}, rotadas ${r.rotatedCount}, no ubicadas ${r.unplaced}`);
  }
}

const back = [{ name: 'fondo', ancho: 750, alto: 2100, qty: 2, grain: false }];
for (const [W, H, label] of [[2440, 1220, 'pauta 2440x1220'], [2440, 1520, 'Durolac Chile 2440x1520']] as const) {
  const r = packStrips(back, W, H, k, true);
  console.log(`Clóset fondo 2x 750x2100x3 mm   ${label}: ${r.sheets} plancha(s), uso ${r.usage.toFixed(1)} %, rotadas ${r.rotatedCount}, no ubicadas ${r.unplaced}`);
}

// Grain toggle test: module 900x1150x410 (1 shelf) -> 2 sheets with grain lock vs 1 sheet without!
const grainCase: Piece[] = [
  { name: 'lateral', ancho: 1114, alto: 410, qty: 2, grain: true },
  { name: 'cubierta/base', ancho: 900, alto: 410, qty: 2, grain: true },
  { name: 'repisa', ancho: 864, alto: 410, qty: 1, grain: true },
];
const gOn = packStrips(grainCase, 2440, 1220, k, true);
const gOff = packStrips(grainCase, 2440, 1220, k, false);
console.log(`\nDemo cambio de veta (Módulo 900x1150x410):`);
console.log(`  respectGrain=true  -> ${gOn.sheets} plancha(s), uso ${gOn.usage.toFixed(1)} %, rotadas ${gOn.rotatedCount}`);
console.log(`  respectGrain=false -> ${gOff.sheets} plancha(s), uso ${gOff.usage.toFixed(1)} %, rotadas ${gOff.rotatedCount}`);
