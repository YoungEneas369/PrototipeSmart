/**
 * SMARTFURNITURE — GENERADOR DE PLANOS VECTORIALES 2D TÉCNICOS (v8.0)
 * 100% offline, SVG XML-safe (`escapeXml` compartido), con alzado frontal acotado,
 * perfil lateral ZY con zócalo y frentes de altura parcial `[vStart, vEnd]`, escalones
 * `void_outside` (incluso sin fondo trasero), simbología real de puertas/vidrios/cajones/canastos,
 * vista en planta superior XZ + alzados A/B para muebles en L (90°), y cartela técnica dinámica.
 */
import type {
  BoardPiece,
  CuttingPlanResult,
  DespieceResult,
  FrontZone,
  FurnitureTopology,
  Point2D,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  computePieceWorldAABB,
  evaluateBezierDifferential,
  extractReturnWingTopology,
  resolveBaseSupport,
  resolveLShapePlan,
} from '../mathEngine';
import { escapeXml } from '../utils/xml';

export { CATALOG_14_MUEBLES, cloneCatalogFurniture } from './catalog14';
export type { CatalogFurnitureSpec } from './catalog14';

export interface BlueprintRenderOptions {
  title?: string;
  stageLabel?: string;
  cuttingPlan?: CuttingPlanResult;
}

interface ElevationViewParams {
  lines: string[];
  topology: FurnitureTopology;
  wingPieces: readonly BoardPiece[];
  xf: number;
  yf: number;
  xLeftStart: number;
  xRightEnd: number;
  e: number;
  frontX: number;
  frontY: number;
  sc: number;
  legH: number;
  toeH: number;
  isWheels: boolean;
  supportCount: number;
  wingLegCount?: number;
  headingText: string;
  widthDimLabel: string;
  heightDimLabel?: string;
  localCenterX: (p: BoardPiece) => number;
}

function drawElevationView(cfg: ElevationViewParams): void {
  const {
    lines,
    topology,
    wingPieces,
    xf,
    yf,
    xLeftStart,
    xRightEnd,
    e,
    frontX,
    frontY,
    sc,
    legH,
    toeH,
    isWheels,
    supportCount,
    headingText,
    widthDimLabel,
    heightDimLabel,
    localCenterX,
  } = cfg;

  const fw = xf * sc;
  const fh = yf * sc;
  const baseLiftH = legH + toeH;
  const liftPx = baseLiftH * sc;
  const ep = Math.max(2, e * sc);
  const xInt = Math.max(1, xRightEnd - xLeftStart);
  const yInt = Math.max(1, yf - 2 * e);

  const mapU = (u: number): number => frontX + (xLeftStart + u * xInt) * sc;
  const mapV = (v: number): number => frontY + fh - (e + v * yInt) * sc;

  lines.push(
    `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(frontY - 26).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">${escapeXml(headingText)}</text>`,
  );

  const zones = topology.frontZones ?? [];
  const stepVoidZones = zones.filter((z) => z.kind === 'void_outside');
  const hasStepVoid = stepVoidZones.length > 0;

  if (!hasStepVoid) {
    lines.push(
      `<rect x="${frontX.toFixed(2)}" y="${frontY.toFixed(2)}" width="${fw.toFixed(2)}" height="${fh.toFixed(2)}" fill="#f8fafc" stroke="#0f172a" stroke-width="1.8" />`,
    );
  } else {
    const backPieces = wingPieces.filter((p) => p.tipo === 'fondo');
    if (backPieces.length > 0) {
      for (const bp of backPieces) {
        const bx0 = frontX + (localCenterX(bp) - bp.dimensiones3D[0] / 2) * sc;
        const by0 = frontY + fh - (bp.posicion3D[1] + bp.dimensiones3D[1] / 2) * sc;
        const bw = bp.dimensiones3D[0] * sc;
        const bh = bp.dimensiones3D[1] * sc;
        lines.push(
          `<rect x="${bx0.toFixed(2)}" y="${by0.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1" />`,
        );
      }
    } else {
      lines.push(
        `<rect x="${frontX.toFixed(2)}" y="${frontY.toFixed(2)}" width="${fw.toFixed(2)}" height="${fh.toFixed(2)}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1" />`,
      );
      for (const vz of stepVoidZones) {
        const vx0 = vz.uStart <= 0.02 ? frontX : mapU(vz.uStart);
        const vx1 = vz.uEnd >= 0.98 ? frontX + fw : mapU(vz.uEnd);
        const vy0 = vz.vEnd >= 0.98 ? frontY : mapV(vz.vEnd);
        const vy1 = vz.vStart <= 0.02 ? frontY + fh : mapV(vz.vStart);
        lines.push(
          `<rect class="step-void-cutout" x="${vx0.toFixed(2)}" y="${vy0.toFixed(2)}" width="${Math.max(1, vx1 - vx0).toFixed(2)}" height="${Math.max(1, vy1 - vy0).toFixed(2)}" fill="url(#bpGrid)" stroke="none" />`,
        );
      }
    }
  }

  // Patas externas / Ruedas / Zócalo
  if (legH > 0) {
    const legW = Math.max(5, Math.min(12, fw * 0.032));
    const nLegs = Math.max(2, Math.min(12, supportCount || 4));
    const legXs =
      nLegs >= 5
        ? [frontX + fw * 0.06, frontX + fw * 0.5 - legW / 2, frontX + fw * 0.94 - legW]
        : [frontX + fw * 0.06, frontX + fw * 0.94 - legW];
    if (isWheels) {
      const rW = Math.max(4, Math.min(11, liftPx * 0.4));
      for (const lx of legXs) {
        const cxW = lx + legW / 2;
        const cyW = frontY + fh + liftPx - rW;
        lines.push(
          `<rect x="${(cxW - rW).toFixed(2)}" y="${(frontY + fh).toFixed(2)}" width="${(rW * 2).toFixed(2)}" height="${Math.max(2, liftPx * 0.25).toFixed(2)}" fill="#94a3b8" stroke="#334155" stroke-width="1" />`,
          `<circle cx="${cxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${rW.toFixed(2)}" fill="#334155" stroke="#0f172a" stroke-width="1.2" />`,
          `<circle cx="${cxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${(rW * 0.45).toFixed(2)}" fill="#e2e8f0" />`,
        );
      }
      lines.push(
        `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(frontY + fh + liftPx * 0.72).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#92400e">RUEDAS GIRATORIAS (${nLegs} × ${legH} mm · NO MELAMINA)</text>`,
      );
    } else {
      for (const lx of legXs) {
        lines.push(
          `<rect x="${lx.toFixed(2)}" y="${(frontY + fh).toFixed(2)}" width="${legW.toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#475569" stroke-width="1.2" stroke-dasharray="3,2" />`,
        );
      }
      lines.push(
        `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(frontY + fh + liftPx * 0.65).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#92400e">PATAS EXTERNAS (${legH} mm · NO MELAMINA)</text>`,
      );
    }
  } else if (toeH > 0) {
    lines.push(
      `<rect class="front-toe-kick" x="${(frontX + ep).toFixed(2)}" y="${(frontY + fh).toFixed(2)}" width="${Math.max(4, fw - 2 * ep).toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#334155" stroke-width="1.2" />`,
    );
    const labelY = liftPx >= 11 ? frontY + fh + liftPx * 0.72 : frontY + fh + liftPx + 10;
    lines.push(
      `<text x="${(frontX + fw / 2).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" font-weight="600" fill="#334155">ZÓCALO (${toeH} mm)</text>`,
    );
  }

  // Zonas frontales
  for (const z of zones) {
    const zx0 = mapU(z.uStart);
    const zx1 = mapU(z.uEnd);
    const zy0 = mapV(z.vEnd);
    const zy1 = mapV(z.vStart);
    const zw = Math.max(1, zx1 - zx0);
    const zh = Math.max(1, zy1 - zy0);

    if (z.kind === 'void_outside') {
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="none" stroke="#94a3b8" stroke-width="0.9" stroke-dasharray="4,4" />`,
      );
      if (zw > 38 && zh > 22) {
        lines.push(
          `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy0 + zh / 2 + 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" fill="#94a3b8">SIN MUEBLE</text>`,
        );
      }
      continue;
    }

    if (z.kind === 'baskets') {
      const nb = Math.max(1, Math.min(6, Math.round(z.basketCount ?? 3)));
      const slotH = zh / nb;
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="0.8" />`,
      );
      for (let k = 0; k < nb; k++) {
        const by0 = zy0 + k * slotH + slotH * 0.24;
        const bh = Math.max(6, slotH * 0.66);
        lines.push(
          `<rect x="${(zx0 + 4).toFixed(2)}" y="${by0.toFixed(2)}" width="${Math.max(4, zw - 8).toFixed(2)}" height="${bh.toFixed(2)}" fill="#e2e8f0" fill-opacity="0.55" stroke="#475569" stroke-width="1.2" rx="2" />`,
          `<line x1="${(zx0 + 4).toFixed(1)}" y1="${(by0 + bh / 2).toFixed(1)}" x2="${(zx1 - 4).toFixed(1)}" y2="${(by0 + bh / 2).toFixed(1)}" stroke="#64748b" stroke-width="0.8" />`,
        );
        const wires = Math.max(3, Math.min(7, Math.floor((zw - 12) / 10)));
        for (let wIdx = 1; wIdx < wires; wIdx++) {
          const wx = zx0 + 4 + ((zw - 8) * wIdx) / wires;
          lines.push(
            `<line x1="${wx.toFixed(1)}" y1="${by0.toFixed(1)}" x2="${wx.toFixed(1)}" y2="${(by0 + bh).toFixed(1)}" stroke="#64748b" stroke-width="0.7" />`,
          );
        }
        if (zw > 44 && bh > 16) {
          lines.push(
            `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(by0 + bh - 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="7.5" fill="#334155">Canasto ${k + 1}/${nb}</text>`,
          );
        }
      }
      continue;
    }

    if (z.kind === 'leg_void') {
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="#ffffff" stroke="#94a3b8" stroke-dasharray="4,3" />`,
      );
      const fhPx = zh * 0.42;
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${fhPx.toFixed(2)}" fill="#f1f5f9" stroke="#64748b" stroke-width="1" />`,
      );
      if (zw > 48) {
        lines.push(
          `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy0 + zh * 0.72).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" fill="#64748b">HUECO PIERNAS</text>`,
        );
      }
    } else if (z.kind === 'open') {
      lines.push(
        `<rect x="${zx0.toFixed(2)}" y="${zy0.toFixed(2)}" width="${zw.toFixed(2)}" height="${zh.toFixed(2)}" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="0.8" />`,
      );
      if (z.label && zw > 34 && zh > 24) {
        lines.push(
          `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy0 + zh / 2 + 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" fill="#64748b">${escapeXml(z.label)}</text>`,
        );
      }
    } else if (z.kind === 'door_left' || z.kind === 'door_right' || z.kind === 'door_glass') {
      const fillCol = z.kind === 'door_glass' ? '#e0f2fe' : '#fef9c3';
      lines.push(
        `<rect x="${(zx0 + 2).toFixed(2)}" y="${(zy0 + 2).toFixed(2)}" width="${Math.max(1, zw - 4).toFixed(2)}" height="${Math.max(1, zh - 4).toFixed(2)}" fill="${fillCol}" stroke="#0284c7" stroke-width="1.3" />`,
      );
      if (z.kind === 'door_glass' && zw > 18 && zh > 18) {
        const ins = Math.max(5, Math.min(12, zw * 0.16));
        lines.push(
          `<rect x="${(zx0 + ins).toFixed(2)}" y="${(zy0 + ins).toFixed(2)}" width="${Math.max(2, zw - 2 * ins).toFixed(2)}" height="${Math.max(2, zh - 2 * ins).toFixed(2)}" fill="#bae6fd" stroke="#0369a1" stroke-width="0.9" />`,
        );
        lines.push(
          `<line x1="${(zx0 + ins + 4).toFixed(1)}" y1="${(zy0 + ins + 14).toFixed(1)}" x2="${(zx0 + ins + 14).toFixed(1)}" y2="${(zy0 + ins + 4).toFixed(1)}" stroke="#0284c7" stroke-width="1" />`,
        );
      }
      const hingeX = z.kind === 'door_right' ? zx1 - 2 : zx0 + 2;
      const handleX = z.kind === 'door_right' ? zx0 + 2 : zx1 - 2;
      const midY = zy0 + zh / 2;
      lines.push(
        `<polyline points="${hingeX.toFixed(1)},${(zy0 + 2).toFixed(1)} ${handleX.toFixed(1)},${midY.toFixed(1)} ${hingeX.toFixed(1)},${(zy1 - 2).toFixed(1)}" fill="none" stroke="#0369a1" stroke-width="0.8" stroke-dasharray="4,3" />`,
      );
      const tx =
        z.kind === 'door_right' ? zx0 + Math.min(10, zw * 0.2) : zx1 - Math.min(10, zw * 0.2);
      lines.push(
        `<line x1="${tx.toFixed(1)}" y1="${(midY - 8).toFixed(1)}" x2="${tx.toFixed(1)}" y2="${(midY + 8).toFixed(1)}" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" />`,
      );
      if (zw > 34 && zh > 24) {
        lines.push(
          `<text x="${(zx0 + zw / 2).toFixed(1)}" y="${(zy1 - 8).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8" fill="#0f2b4c">${escapeXml(z.label ?? 'Puerta')}</text>`,
        );
      }
    } else if (z.kind === 'door_double') {
      const midX = zx0 + zw / 2;
      for (const [lx0, lx1, isLeft] of [
        [zx0 + 2, midX - 1, true],
        [midX + 1, zx1 - 2, false],
      ] as const) {
        const lw = Math.max(1, lx1 - lx0);
        const midY = zy0 + zh / 2;
        lines.push(
          `<rect x="${lx0.toFixed(2)}" y="${(zy0 + 2).toFixed(2)}" width="${lw.toFixed(2)}" height="${Math.max(1, zh - 4).toFixed(2)}" fill="#fef9c3" stroke="#0284c7" stroke-width="1.2" />`,
        );
        const hx = isLeft ? lx0 : lx1;
        const ox = isLeft ? lx1 : lx0;
        lines.push(
          `<polyline points="${hx.toFixed(1)},${(zy0 + 2).toFixed(1)} ${ox.toFixed(1)},${midY.toFixed(1)} ${hx.toFixed(1)},${(zy1 - 2).toFixed(1)}" fill="none" stroke="#0369a1" stroke-width="0.7" stroke-dasharray="3,3" />`,
        );
        const tx = isLeft ? lx1 - 5 : lx0 + 5;
        lines.push(
          `<line x1="${tx.toFixed(1)}" y1="${(midY - 7).toFixed(1)}" x2="${tx.toFixed(1)}" y2="${(midY + 7).toFixed(1)}" stroke="#0f172a" stroke-width="2" stroke-linecap="round" />`,
        );
      }
    } else if (z.kind === 'drawers') {
      const n = Math.max(1, Math.round(z.drawerCount ?? 3));
      const dh = zh / n;
      for (let k = 0; k < n; k++) {
        const dy = zy0 + k * dh;
        lines.push(
          `<rect x="${(zx0 + 2).toFixed(2)}" y="${(dy + 2).toFixed(2)}" width="${Math.max(1, zw - 4).toFixed(2)}" height="${Math.max(1, dh - 4).toFixed(2)}" fill="#ffedd5" stroke="#c2410c" stroke-width="1.2" />`,
        );
        const cx = zx0 + zw / 2;
        const cy = dy + dh / 2;
        const hw = Math.min(18, zw * 0.28);
        lines.push(
          `<line x1="${(cx - hw / 2).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + hw / 2).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" />`,
        );
        if (zw > 42 && dh > 22) {
          lines.push(
            `<text x="${cx.toFixed(1)}" y="${(dy + dh - 5).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="7.5" fill="#9a3412">Cajón ${k + 1} (5 pzas)</text>`,
          );
        }
      }
    }
  }

  // Tableros estructurales directamente desde `despiece`
  for (const p of wingPieces) {
    if (
      p.tipo !== 'cubierta' &&
      p.tipo !== 'base' &&
      p.tipo !== 'lateral' &&
      p.tipo !== 'division_vertical' &&
      p.tipo !== 'repisa'
    ) {
      continue;
    }
    const cxMm = localCenterX(p);
    const px0 = frontX + (cxMm - p.dimensiones3D[0] / 2) * sc;
    const py0 = frontY + fh - (p.posicion3D[1] + p.dimensiones3D[1] / 2) * sc;
    const pw = Math.max(1.5, p.dimensiones3D[0] * sc);
    const ph = Math.max(1.5, p.dimensiones3D[1] * sc);
    const isOuter = p.tipo === 'cubierta' || p.tipo === 'base' || p.tipo === 'lateral';
    lines.push(
      `<rect x="${px0.toFixed(2)}" y="${py0.toFixed(2)}" width="${pw.toFixed(2)}" height="${ph.toFixed(2)}" fill="${isOuter ? '#cbd5e1' : '#94a3b8'}" stroke="#0f172a" stroke-width="${isOuter ? '1.1' : '0.9'}" />`,
    );
  }

  // Divisores diagonales
  for (const diag of topology.diagonalDividers ?? []) {
    const x1 = mapU(diag.u1);
    const y1 = mapV(diag.v1);
    const x2 = mapU(diag.u2);
    const y2 = mapV(diag.v2);
    lines.push(
      `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#0f172a" stroke-width="${(ep + 1.4).toFixed(2)}" stroke-linecap="butt" />`,
      `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="#c084fc" stroke-width="${Math.max(1.5, ep - 0.6).toFixed(2)}" stroke-linecap="butt" />`,
    );
  }

  // Trazos y cortes curvos diferenciales en plano XY
  for (const c of topology.curvedCuts ?? []) {
    if (c.plane !== 'xy') continue;
    const [p0, p1, p2, p3] = c.controlPoints;
    const cPts = [p0, p1, p2, p3].map((p) => ({ x: mapU(p.x), y: mapV(p.y) }));
    const dAttr = `M ${cPts[0].x.toFixed(2)} ${cPts[0].y.toFixed(2)} C ${cPts[1].x.toFixed(2)} ${cPts[1].y.toFixed(2)}, ${cPts[2].x.toFixed(2)} ${cPts[2].y.toFixed(2)}, ${cPts[3].x.toFixed(2)} ${cPts[3].y.toFixed(2)}`;
    lines.push(
      `<path class="svg-diff-curve" d="${dAttr}" fill="none" stroke="#0f172a" stroke-width="${(ep + 1.2).toFixed(2)}" stroke-linecap="round" />`,
      `<path d="${dAttr}" fill="none" stroke="#d946ef" stroke-width="${Math.max(1.6, ep - 0.5).toFixed(2)}" stroke-linecap="round" />`,
    );
    const diff =
      c.arcLengthMm !== undefined
        ? null
        : evaluateBezierDifferential([
            { x: p0.x * xf, y: p0.y * yf },
            { x: p1.x * xf, y: p1.y * yf },
            { x: p2.x * xf, y: p2.y * yf },
            { x: p3.x * xf, y: p3.y * yf },
          ]);
    const arcLabel = c.arcLengthMm ?? diff?.arcLengthMm ?? 0;
    if (arcLabel > 0) {
      lines.push(
        `<text x="${((cPts[1].x + cPts[2].x) / 2).toFixed(1)}" y="${((cPts[1].y + cPts[2].y) / 2 - 4).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8" font-weight="700" fill="#a21caf">s=${Math.round(arcLabel)}mm</text>`,
      );
    }
  }

  // Cotas exteriores
  const dimTopY = frontY - 12;
  lines.push(
    `<line x1="${frontX.toFixed(1)}" y1="${dimTopY.toFixed(1)}" x2="${(frontX + fw).toFixed(1)}" y2="${dimTopY.toFixed(1)}" stroke="#0284c7" stroke-width="1.3" />`,
  );
  lines.push(
    `<text x="${(frontX + fw / 2).toFixed(1)}" y="${(dimTopY - 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" font-weight="700" fill="#0284c7">${escapeXml(widthDimLabel)}</text>`,
  );

  if (heightDimLabel) {
    const dimLeftX = frontX - 18;
    lines.push(
      `<line x1="${dimLeftX.toFixed(1)}" y1="${frontY.toFixed(1)}" x2="${dimLeftX.toFixed(1)}" y2="${(frontY + fh).toFixed(1)}" stroke="#059669" stroke-width="1.3" />`,
    );
    lines.push(
      `<text x="${(dimLeftX - 5).toFixed(1)}" y="${(frontY + fh / 2).toFixed(1)}" text-anchor="middle" transform="rotate(-90 ${(dimLeftX - 5).toFixed(1)} ${(frontY + fh / 2).toFixed(1)})" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" font-weight="700" fill="#059669">${escapeXml(heightDimLabel)}</text>`,
    );
  }
}

function drawSideProfileView(cfg: {
  lines: string[];
  zones: readonly FrontZone[];
  hasBackPanel: boolean;
  zf: number;
  yf: number;
  e: number;
  sideX: number;
  sideY: number;
  sc: number;
  legH: number;
  toeH: number;
  isWheels: boolean;
  dimTopY: number;
  headingText?: string;
  wingPieces?: readonly BoardPiece[];
}): void {
  const {
    lines,
    zones,
    hasBackPanel,
    zf,
    yf,
    e,
    sideX,
    sideY,
    sc,
    legH,
    toeH,
    isWheels,
    dimTopY,
    headingText = 'PERFIL LATERAL (ZY)',
    wingPieces,
  } = cfg;
  const sw = zf * sc;
  const fh = yf * sc;
  const ep = Math.max(2, e * sc);
  const liftPx = (legH + toeH) * sc;
  const yInt = Math.max(1, yf - 2 * e);
  const mapV = (v: number): number => sideY + fh - (e + v * yInt) * sc;
  const stepVoidZones = zones.filter((z) => z.kind === 'void_outside');
  const curvedSide = wingPieces?.find(
    (p) =>
      p.tipo === 'lateral' &&
      (!p.wing || p.wing === 'main') &&
      p.curveProfile?.extrudePlane === 'zy',
  );

  lines.push(
    `<text x="${(sideX + sw / 2).toFixed(1)}" y="${(sideY - 26).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">${escapeXml(headingText)}</text>`,
  );
  if (curvedSide?.curveProfile && curvedSide.curveProfile.pointsMm.length >= 3) {
    lines.push(
      `<rect x="${sideX.toFixed(2)}" y="${sideY.toFixed(2)}" width="${sw.toFixed(2)}" height="${fh.toFixed(2)}" fill="none" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2" />`,
    );
    const ptsWorld: Point2D[] = curvedSide.curveProfile.pointsMm.map((pt) => ({
      x: sideX + (curvedSide.posicion3D[2] + pt.x) * sc,
      y: sideY + fh - (curvedSide.posicion3D[1] + pt.y) * sc,
    }));
    const dPoly =
      ptsWorld
        .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`)
        .join(' ') + ' Z';
    lines.push(
      `<path class="side-curve-piece" d="${dPoly}" fill="rgba(217, 70, 239, 0.14)" stroke="#0f172a" stroke-width="1.8" />`,
    );
  } else {
    lines.push(
      `<rect x="${sideX.toFixed(2)}" y="${sideY.toFixed(2)}" width="${sw.toFixed(2)}" height="${fh.toFixed(2)}" fill="#f8fafc" stroke="#0f172a" stroke-width="1.8" />`,
    );
  }
  if (hasBackPanel) {
    lines.push(
      `<rect x="${(sideX - 3).toFixed(2)}" y="${sideY.toFixed(2)}" width="3" height="${fh.toFixed(2)}" fill="#b45309" />`,
    );
  }
  for (const vz of stepVoidZones) {
    const stepV = vz.vEnd >= 0.98 ? vz.vStart : vz.vEnd;
    if (stepV > 0.04 && stepV < 0.96) {
      const syStep = mapV(stepV);
      lines.push(
        `<line class="side-step-line" x1="${sideX.toFixed(2)}" y1="${syStep.toFixed(2)}" x2="${(sideX + sw).toFixed(2)}" y2="${syStep.toFixed(2)}" stroke="#64748b" stroke-width="1" stroke-dasharray="4,3" />`,
      );
    }
  }
  if (legH > 0) {
    if (isWheels) {
      const rW = Math.max(4, Math.min(10, liftPx * 0.4));
      for (const sxW of [sideX + sw * 0.16, sideX + sw * 0.84]) {
        const cyW = sideY + fh + liftPx - rW;
        lines.push(
          `<circle cx="${sxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${rW.toFixed(2)}" fill="#334155" stroke="#0f172a" stroke-width="1.2" />`,
          `<circle cx="${sxW.toFixed(2)}" cy="${cyW.toFixed(2)}" r="${(rW * 0.45).toFixed(2)}" fill="#e2e8f0" />`,
        );
      }
    } else {
      const legW = Math.max(5, Math.min(10, sw * 0.1));
      lines.push(
        `<rect x="${(sideX + sw * 0.12).toFixed(2)}" y="${(sideY + fh).toFixed(2)}" width="${legW.toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#475569" stroke-dasharray="3,2" />`,
      );
      lines.push(
        `<rect x="${(sideX + sw * 0.88 - legW).toFixed(2)}" y="${(sideY + fh).toFixed(2)}" width="${legW.toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#475569" stroke-dasharray="3,2" />`,
      );
    }
  } else if (toeH > 0) {
    const recessPx = Math.min(sw * 0.16, Math.max(3, 35 * sc));
    lines.push(
      `<rect class="side-toe-kick" x="${sideX.toFixed(2)}" y="${(sideY + fh).toFixed(2)}" width="${Math.max(4, sw - recessPx).toFixed(2)}" height="${liftPx.toFixed(2)}" fill="#e2e8f0" stroke="#334155" stroke-width="1.2" />`,
    );
  }

  const sideFrontBands: Array<{ v0: number; v1: number; fill: string; stroke: string }> = [];
  for (const z of zones) {
    if (
      z.kind === 'open' ||
      z.kind === 'leg_void' ||
      z.kind === 'void_outside' ||
      z.kind === 'baskets'
    ) {
      continue;
    }
    const v0 = Math.min(z.vStart, z.vEnd);
    const v1 = Math.max(z.vStart, z.vEnd);
    const fill =
      z.kind === 'door_glass' ? '#bae6fd' : z.kind === 'drawers' ? '#ffedd5' : '#fef9c3';
    const stroke =
      z.kind === 'door_glass' ? '#0369a1' : z.kind === 'drawers' ? '#c2410c' : '#0284c7';
    const dup = sideFrontBands.some(
      (b) => Math.abs(b.v0 - v0) <= 0.015 && Math.abs(b.v1 - v1) <= 0.015 && b.fill === fill,
    );
    if (!dup) {
      sideFrontBands.push({ v0, v1, fill, stroke });
    }
  }
  for (const band of sideFrontBands) {
    const fy0 = band.v1 >= 0.99 ? sideY + 1 : mapV(band.v1) + 1;
    const fy1 = band.v0 <= 0.01 ? sideY + fh - 1 : mapV(band.v0) - 1;
    const bandH = Math.max(2, fy1 - fy0);
    lines.push(
      `<rect class="side-front-panel" x="${(sideX + sw + 1).toFixed(2)}" y="${fy0.toFixed(2)}" width="${ep.toFixed(2)}" height="${bandH.toFixed(2)}" fill="${band.fill}" stroke="${band.stroke}" stroke-width="1" />`,
    );
  }

  lines.push(
    `<line x1="${sideX.toFixed(1)}" y1="${dimTopY.toFixed(1)}" x2="${(sideX + sw).toFixed(1)}" y2="${dimTopY.toFixed(1)}" stroke="#7c3aed" stroke-width="1.3" />`,
  );
  lines.push(
    `<text x="${(sideX + sw / 2).toFixed(1)}" y="${(dimTopY - 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" font-weight="700" fill="#7c3aed">Z = ${Math.round(zf)} mm</text>`,
  );
}

/**
 * Genera el Plano Vectorial 2D técnico completo en SVG:
 * - Mueble recto: Alzado Frontal XY + Perfil Lateral ZY + Cartela.
 * - Mueble en L (90°): Planta Superior XZ acotada + Alzado Ala Principal (A) + Alzado Ala Retorno (B) + Perfil ZY + Cartela.
 */
export function renderFurnitureVectorBlueprintSvg(
  topology: FurnitureTopology,
  params: ScaleAndBoardParams,
  despiece: DespieceResult,
  opts: BlueprintRenderOptions = {},
): string {
  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const e = params.boardThickness;
  const support = resolveBaseSupport(topology);
  const legH = support.type === 'legs' || support.type === 'wheels' ? support.heightMm : 0;
  const toeH = support.type === 'toe_kick' ? support.heightMm : 0;
  const isWheels = support.type === 'wheels';
  const baseLiftH = legH + toeH;
  const totalH = yf + baseLiftH;

  const lPlan = resolveLShapePlan(topology, params);
  const isL = Boolean(lPlan?.enabled);

  const mainPieces = despiece.matrizDespiece.filter((p) => p.wing !== 'return');
  const returnPieces = despiece.matrizDespiece.filter((p) => p.wing === 'return');
  const curvedTopStraight =
    !isL
      ? mainPieces.find(
          (p) =>
            p.tipo === 'cubierta' &&
            (!p.wing || p.wing === 'main') &&
            p.curveProfile?.extrudePlane === 'xz',
        )
      : undefined;

  const svgW = 920;
  const svgH = isL ? 720 : curvedTopStraight ? 660 : 540;
  const lines: string[] = [];
  const title = opts.title ?? topology.furnitureProfileLabel ?? 'Modelo Vectorial SmartFurniture';
  const stage = opts.stageLabel ?? 'MODELO VECTORIAL 2D ACOTADO';

  let scHeader = 0.25;
  let cartelaY = curvedTopStraight ? 566 : 446;

  if (!isL || !lPlan) {
    const drawLeft = 92;
    const drawTop = 78;
    const maxFrontW = 510;
    const maxSideW = 190;
    const maxBodyH = curvedTopStraight ? 300 : 320;

    const scaleX = maxFrontW / Math.max(300, xf);
    const scaleSide = maxSideW / Math.max(200, zf);
    const scaleY = maxBodyH / Math.max(300, totalH);
    const sc = Math.min(scaleX, scaleSide, scaleY);
    scHeader = sc;

    const fw = xf * sc;
    const fh = yf * sc;
    const liftPx = baseLiftH * sc;
    const frontX = drawLeft + (maxFrontW - fw) / 2;
    const frontY = drawTop + (maxBodyH - (fh + liftPx)) / 2;
    const sideX = drawLeft + maxFrontW + 64;

    lines.push(`<rect width="${svgW}" height="${svgH}" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />`);
    lines.push(`<rect x="0" y="0" width="${svgW}" height="44" fill="#0f2b4c" />`);
    lines.push(
      `<text x="18" y="20" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>`,
    );
    lines.push(
      `<text x="18" y="36" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" fill="#7dd3fc">${escapeXml(stage)} · Cuerpo Melamina ${Math.round(xf)}×${Math.round(yf)}×${Math.round(zf)} mm (e=${e} mm)</text>`,
    );
    lines.push(
      `<text x="${svgW - 18}" y="27" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#38bdf8">ESCALA 1:${Math.max(1, Math.round(1 / scHeader))}</text>`,
    );
    lines.push(`<rect x="18" y="54" width="${svgW - 36}" height="${curvedTopStraight ? 502 : 384}" fill="url(#bpGrid)" stroke="#e2e8f0" />`);

    drawElevationView({
      lines,
      topology,
      wingPieces: mainPieces,
      xf,
      yf,
      xLeftStart: e,
      xRightEnd: xf - e,
      e,
      frontX,
      frontY,
      sc,
      legH,
      toeH,
      isWheels,
      supportCount: support.count || 4,
      headingText: 'ALZADO FRONTAL (PLANO XY)',
      widthDimLabel: `Ancho X = ${Math.round(xf)} mm`,
      heightDimLabel: `Alto Y = ${Math.round(yf)} mm`,
      localCenterX: (p) => p.posicion3D[0],
    });

    drawSideProfileView({
      lines,
      zones: topology.frontZones ?? [],
      hasBackPanel: topology.hasBackPanel,
      zf,
      yf,
      e,
      sideX,
      sideY: frontY,
      sc,
      legH,
      toeH,
      isWheels,
      dimTopY: frontY - 12,
      wingPieces: mainPieces,
    });

    if (curvedTopStraight?.curveProfile && curvedTopStraight.curveProfile.pointsMm.length >= 3) {
      const planMaxW = 510;
      const planMaxH = 104;
      const scPlan = Math.min(planMaxW / Math.max(300, xf), planMaxH / Math.max(180, zf));
      const planW = xf * scPlan;
      const planD = zf * scPlan;
      const pxOrigin = drawLeft + (planMaxW - planW) / 2;
      const pyOrigin = 428 + (planMaxH - planD) / 2;

      lines.push(
        `<text x="${(pxOrigin + planW / 2).toFixed(1)}" y="${(pyOrigin - 10).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">PLANTA SUPERIOR (PLANO XZ — CUBIERTA CURVA/CHAFLÁN)</text>`,
      );
      if (topology.hasBackPanel) {
        lines.push(
          `<rect x="${pxOrigin.toFixed(2)}" y="${(pyOrigin - 3).toFixed(2)}" width="${planW.toFixed(2)}" height="3" fill="#b45309" />`,
        );
      }
      lines.push(
        `<rect x="${pxOrigin.toFixed(2)}" y="${pyOrigin.toFixed(2)}" width="${planW.toFixed(2)}" height="${planD.toFixed(2)}" fill="none" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2" />`,
      );
      const ptsWorld: Point2D[] = curvedTopStraight.curveProfile.pointsMm.map((pt) => ({
        x: pxOrigin + (curvedTopStraight.posicion3D[0] + pt.x) * scPlan,
        y: pyOrigin + (curvedTopStraight.posicion3D[2] + pt.y) * scPlan,
      }));
      const dPoly =
        ptsWorld
          .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`)
          .join(' ') + ' Z';
      lines.push(
        `<path class="plan-curve-piece" d="${dPoly}" fill="rgba(217, 70, 239, 0.14)" stroke="#a21caf" stroke-width="1.6" />`,
      );
      lines.push(
        `<text x="${(pxOrigin + planW / 2).toFixed(1)}" y="${(pyOrigin + planD + 13).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9.5" font-weight="700" fill="#7c3aed">X = ${Math.round(xf)} mm · Z = ${Math.round(zf)} mm</text>`,
      );
    }
  } else {
    // MODO MUEBLE EN L (90° EN XZ): Planta Superior + Alzado Ala Principal + Alzado Ala Retorno + Perfil ZY
    let zStartB = lPlan.zStartB;
    let netLenB = lPlan.netLengthMm;
    if (returnPieces.length > 0) {
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const rp of returnPieces) {
        if (rp.tipo === 'puerta' || rp.tipo === 'frente_cajon') continue;
        const box = computePieceWorldAABB(rp);
        minZ = Math.min(minZ, box.minZ);
        maxZ = Math.max(maxZ, box.maxZ);
      }
      if (Number.isFinite(minZ) && Number.isFinite(maxZ) && maxZ > minZ) {
        zStartB = minZ;
        netLenB = maxZ - minZ;
      }
    }
    const totalL2 = zStartB + netLenB;
    const ry = lPlan.heightMm;
    const rz = lPlan.depthMm;

    // Escala compartida para Alzados A/B y Perfil Lateral en fila inferior (y = 330..595)
    const maxBotFrontW = 470;
    const maxBotSideW = 165;
    const maxBotH = 210;
    const scElev = Math.min(
      maxBotFrontW / Math.max(300, xf),
      maxBotSideW / Math.max(200, zf),
      maxBotH / Math.max(300, Math.max(yf, ry) + baseLiftH),
    );
    scHeader = scElev;

    lines.push(`<rect width="${svgW}" height="${svgH}" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5" />`);
    lines.push(`<rect x="0" y="0" width="${svgW}" height="44" fill="#0f2b4c" />`);
    lines.push(
      `<text x="18" y="20" font-family="system-ui, -apple-system, sans-serif" font-size="13" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>`,
    );
    lines.push(
      `<text x="18" y="36" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" fill="#7dd3fc">${escapeXml(stage)} · En L (${lPlan.side === 'right' ? 'Derecha' : 'Izquierda'}): Ala A ${Math.round(xf)}×${Math.round(yf)}×${Math.round(zf)} + Ala B ${Math.round(totalL2)}×${Math.round(ry)}×${Math.round(rz)} mm</text>`,
    );
    lines.push(
      `<text x="${svgW - 18}" y="27" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#38bdf8">ESCALA ALZ. 1:${Math.max(1, Math.round(1 / scElev))}</text>`,
    );

    lines.push(`<rect x="18" y="54" width="${svgW - 36}" height="564" fill="url(#bpGrid)" stroke="#e2e8f0" />`);

    // --- VISTA 1 (SUPERIOR IZQUIERDA): PLANTA SUPERIOR (PLANO XZ) ---
    const planBoxX = 56;
    const planBoxY = 82;
    const planMaxW = 315;
    const planMaxH = 190;
    const scPlan = Math.min(planMaxW / Math.max(300, xf), planMaxH / Math.max(300, totalL2));
    const planW = xf * scPlan;
    const planH = totalL2 * scPlan;
    const pxOrigin = planBoxX + (planMaxW - planW) / 2;
    const pyOrigin = planBoxY + (planMaxH - planH) / 2 + 10;

    lines.push(
      `<text x="${(pxOrigin + planW / 2).toFixed(1)}" y="${(pyOrigin - 24).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">PLANTA SUPERIOR (PLANO XZ — MUEBLE EN L 90°)</text>`,
    );

    const pMainW = xf * scPlan;
    const pMainD = zf * scPlan;
    const pRetXMm = lPlan.side === 'right' ? xf - rz : 0;
    const pRetX = pxOrigin + pRetXMm * scPlan;
    const pRetY = pyOrigin + zStartB * scPlan;
    const pRetW = rz * scPlan;
    const pRetD = netLenB * scPlan;

    // Fondo Durolac en planta (Ala A y Ala B)
    const returnTop = extractReturnWingTopology(topology);
    if (topology.hasBackPanel) {
      lines.push(
        `<rect x="${pxOrigin.toFixed(2)}" y="${(pyOrigin - 3).toFixed(2)}" width="${pMainW.toFixed(2)}" height="3" fill="#b45309" />`,
      );
    }
    if (returnTop.hasBackPanel) {
      const bxRet = lPlan.side === 'right' ? pRetX + pRetW : pRetX - 3;
      lines.push(
        `<rect x="${bxRet.toFixed(2)}" y="${pRetY.toFixed(2)}" width="3" height="${pRetD.toFixed(2)}" fill="#b45309" />`,
      );
    }

    // Rectángulo Ala A y Ala B en planta XZ
    lines.push(
      `<rect class="plan-wing-main" x="${pxOrigin.toFixed(2)}" y="${pyOrigin.toFixed(2)}" width="${pMainW.toFixed(2)}" height="${pMainD.toFixed(2)}" fill="#eff6ff" stroke="#0f172a" stroke-width="1.6" />`,
      `<text x="${(pxOrigin + pMainW / 2).toFixed(1)}" y="${(pyOrigin + pMainD / 2 + 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" font-weight="700" fill="#1e3a8a">ALA A (${Math.round(xf)}×${Math.round(zf)})</text>`,
    );
    lines.push(
      `<rect class="plan-wing-return" x="${pRetX.toFixed(2)}" y="${pRetY.toFixed(2)}" width="${pRetW.toFixed(2)}" height="${pRetD.toFixed(2)}" fill="#ecfdf5" stroke="#0f172a" stroke-width="1.6" />`,
      `<text x="${(pRetX + pRetW / 2).toFixed(1)}" y="${(pRetY + pRetD / 2 + 3).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="8.5" font-weight="700" fill="#065f46">ALA B (${Math.round(rz)}×${Math.round(netLenB)})</text>`,
    );

    if (lPlan.openCorner) {
      lines.push(
        `<line x1="${(pRetX + 2).toFixed(1)}" y1="${pRetY.toFixed(1)}" x2="${(pRetX + pRetW - 2).toFixed(1)}" y2="${pRetY.toFixed(1)}" stroke="#10b981" stroke-width="1.4" stroke-dasharray="4,3" />`,
      );
    }

    // Dibujar perfiles curvos XZ (empalmes diferenciales L / cubiertas curvas) en planta superior
    for (const rp of despiece.matrizDespiece) {
      if (!rp.curveProfile || rp.curveProfile.extrudePlane !== 'xz') continue;
      const ptsWorld: Point2D[] = rp.curveProfile.pointsMm.map((pt) => ({
        x: pxOrigin + (rp.posicion3D[0] + pt.x) * scPlan,
        y: pyOrigin + (rp.posicion3D[2] + pt.y) * scPlan,
      }));
      if (ptsWorld.length >= 3) {
        const dPoly =
          ptsWorld
            .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`)
            .join(' ') + ' Z';
        lines.push(
          `<path class="plan-curve-piece" d="${dPoly}" fill="rgba(217, 70, 239, 0.14)" stroke="#a21caf" stroke-width="1.6" />`,
        );
      }
    }

    // Cotas Planta XZ: L1 arriba, L2 en costado exterior del retorno, Z2 abajo del retorno
    lines.push(
      `<line x1="${pxOrigin.toFixed(1)}" y1="${(pyOrigin - 10).toFixed(1)}" x2="${(pxOrigin + pMainW).toFixed(1)}" y2="${(pyOrigin - 10).toFixed(1)}" stroke="#0284c7" stroke-width="1.2" />`,
      `<text x="${(pxOrigin + pMainW / 2).toFixed(1)}" y="${(pyOrigin - 13).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9.5" font-weight="700" fill="#0284c7">L1 = ${Math.round(xf)} mm</text>`,
    );
    const l2DimX = lPlan.side === 'right' ? pxOrigin + pMainW + 14 : pxOrigin - 14;
    lines.push(
      `<line x1="${l2DimX.toFixed(1)}" y1="${pyOrigin.toFixed(1)}" x2="${l2DimX.toFixed(1)}" y2="${(pyOrigin + planH).toFixed(1)}" stroke="#059669" stroke-width="1.2" />`,
      `<text x="${(l2DimX + (lPlan.side === 'right' ? 6 : -6)).toFixed(1)}" y="${(pyOrigin + planH / 2).toFixed(1)}" text-anchor="middle" transform="rotate(-90 ${(l2DimX + (lPlan.side === 'right' ? 6 : -6)).toFixed(1)} ${(pyOrigin + planH / 2).toFixed(1)})" font-family="system-ui, -apple-system, sans-serif" font-size="9.5" font-weight="700" fill="#059669">L2 = ${Math.round(totalL2)} mm</text>`,
    );
    lines.push(
      `<text x="${(pRetX + pRetW / 2).toFixed(1)}" y="${(pyOrigin + planH + 13).toFixed(1)}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="9" font-weight="700" fill="#7c3aed">Z2 = ${Math.round(rz)} mm</text>`,
    );

    // --- VISTA 2 (SUPERIOR DERECHA): ALZADO ALA RETORNO (B) ---
    const maxRetW = 390;
    const maxRetH = 185;
    const scRet = Math.min(
      maxRetW / Math.max(300, netLenB),
      maxRetH / Math.max(300, ry + baseLiftH),
    );
    const retFw = netLenB * scRet;
    const retFh = ry * scRet;
    const retLiftPx = baseLiftH * scRet;
    const retFrontX = 468 + (maxRetW - retFw) / 2;
    const retFrontY = 92 + (maxRetH - (retFh + retLiftPx)) / 2;

    drawElevationView({
      lines,
      topology: returnTop,
      wingPieces: returnPieces,
      xf: netLenB,
      yf: ry,
      xLeftStart: lPlan.omitLeftLateral ? 0 : e,
      xRightEnd: lPlan.omitRightLateral ? netLenB : netLenB - e,
      e,
      frontX: retFrontX,
      frontY: retFrontY,
      sc: scRet,
      legH,
      toeH,
      isWheels,
      supportCount: 2,
      headingText: `ALZADO ALA RETORNO (B · ${lPlan.openCorner ? 'ESQUINA ABIERTA' : 'TOPE 90°'})`,
      widthDimLabel: `Tramo Neto B = ${Math.round(netLenB)} mm (Total L2=${Math.round(totalL2)})`,
      heightDimLabel: `Alto B = ${Math.round(ry)} mm`,
      localCenterX: (p) =>
        lPlan.side === 'right' ? p.posicion3D[2] - zStartB : zStartB + netLenB - p.posicion3D[2],
    });

    // --- VISTA 3 (INFERIOR IZQUIERDA): ALZADO ALA PRINCIPAL (A) ---
    const mainFw = xf * scElev;
    const mainFh = yf * scElev;
    const mainLiftPx = baseLiftH * scElev;
    const mainFrontX = 80 + (maxBotFrontW - mainFw) / 2;
    const mainFrontY = 368 + (maxBotH - (mainFh + mainLiftPx)) / 2;

    drawElevationView({
      lines,
      topology,
      wingPieces: mainPieces,
      xf,
      yf,
      xLeftStart: e,
      xRightEnd: xf - e,
      e,
      frontX: mainFrontX,
      frontY: mainFrontY,
      sc: scElev,
      legH,
      toeH,
      isWheels,
      supportCount: support.count || 4,
      headingText: 'ALZADO FRONTAL (PLANO XY · ALA PRINCIPAL A)',
      widthDimLabel: `Ancho X = ${Math.round(xf)} mm`,
      heightDimLabel: `Alto Y = ${Math.round(yf)} mm`,
      localCenterX: (p) => p.posicion3D[0],
    });

    // --- VISTA 4 (INFERIOR DERECHA): PERFIL LATERAL ALA PRINCIPAL (ZY) ---
    drawSideProfileView({
      lines,
      zones: topology.frontZones ?? [],
      hasBackPanel: topology.hasBackPanel,
      zf,
      yf,
      e,
      sideX: 625,
      sideY: mainFrontY,
      sc: scElev,
      legH,
      toeH,
      isWheels,
      dimTopY: mainFrontY - 12,
      headingText: 'PERFIL LATERAL (ZY · ALA A)',
      wingPieces: mainPieces,
    });

    cartelaY = 626;
  }

  // =========================================================================
  // CARTELA TÉCNICA INFERIOR (DESPIECE, PLANCHAS DINÁMICAS Y HERRAJES)
  // =========================================================================
  const doorCount = despiece.matrizDespiece.filter((p) => p.tipo === 'puerta').length;
  const drawerCount = despiece.matrizDespiece.filter((p) => p.tipo === 'frente_cajon').length;
  const melPieces = despiece.matrizDespiece.filter((p) => p.espesor >= 10).length;
  const backPieces = despiece.matrizDespiece.filter((p) => p.espesor < 10).length;
  const hwText =
    despiece.hardwareSummary.map((h) => `${h.categoria}: ${h.cantidad}`).join(' · ') ||
    'Sin herrajes adicionales';
  const sheetWcm = Math.round(params.sheetDimensions.width / 10);
  const sheetHcm = Math.round(params.sheetDimensions.height / 10);
  const planText = opts.cuttingPlan
    ? `Planchas ${sheetWcm}×${sheetHcm} cm: ${opts.cuttingPlan.melamineSheetsCount} melamina + ${opts.cuttingPlan.backPanelSheetsCount} fondo ${params.backPanelThickness}mm · Uso ${opts.cuttingPlan.usagePercentage.toFixed(1)}%`
    : `Área neta: ${despiece.totalNetAreaM2.toFixed(2)} m² · Tapacanto: ${despiece.totalEdgeBandingMeters.toFixed(1)} m`;

  lines.push(
    `<rect x="18" y="${cartelaY}" width="${svgW - 36}" height="80" fill="#f8fafc" stroke="#0f2b4c" stroke-width="1.2" rx="4" />`,
  );
  const curveInfo = despiece.differentialMetrics
    ? ` · Curvas: ${despiece.differentialMetrics.curvedCutCount} (arco ${despiece.differentialMetrics.totalArcLengthMm.toFixed(0)} mm, R_mín ${despiece.differentialMetrics.minCurvatureRadiusMm.toFixed(0)} mm)`
    : '';
  lines.push(
    `<text x="30" y="${cartelaY + 20}" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="700" fill="#0f2b4c">RESUMEN DE DESPIECE: ${melPieces} piezas melamina (${e} mm) · ${backPieces} piezas fondo ${params.backPanelThickness} mm · ${doorCount} puerta(s) · ${drawerCount} cajón(es)${escapeXml(curveInfo)}</text>`,
  );
  lines.push(
    `<text x="30" y="${cartelaY + 40}" font-family="system-ui, -apple-system, sans-serif" font-size="10.5" fill="#0369a1">${escapeXml(planText)} · Escala k=(${despiece.scaleFactors.kx.toFixed(2)}, ${despiece.scaleFactors.ky.toFixed(2)}, ${despiece.scaleFactors.kz.toFixed(2)})</text>`,
  );
  lines.push(
    `<text x="30" y="${cartelaY + 60}" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#92400e">HERRAJES (NO MELAMINA): ${escapeXml(hwText)}</text>`,
  );
  lines.push(
    `<text x="${svgW - 30}" y="${cartelaY + 72}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="9" fill="#64748b">Alertas estructurales: ${despiece.alerts.length} · 100% Offline SmartFurniture v8.0</text>`,
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="100%">`,
    '  <defs>',
    '    <pattern id="bpGrid" width="20" height="20" patternUnits="userSpaceOnUse">',
    '      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" stroke-width="0.6" />',
    '    </pattern>',
    '  </defs>',
    ...lines.map((l) => '  ' + l),
    '</svg>',
  ].join('\n');
}
