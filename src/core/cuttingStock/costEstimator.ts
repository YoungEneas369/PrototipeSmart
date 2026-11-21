/**
 * SMARTFURNITURE — ESTIMADOR DE QUINCALLERÍA (BOM) Y PRESUPUESTO REFERENCIAL CLP
 * Portado y adaptado de YoungEneas369/SmartFurniture (v35) — 100% offline y determinista.
 */
import type {
  CuttingPlanResult,
  DespieceResult,
  HardwareCategory,
  ScaleAndBoardParams,
} from '../../types/contracts';

export interface BomLineItem {
  id: string;
  nombre: string;
  cantidad: number;
  unidad: string;
  costoUnitarioClp: number;
  subtotalClp: number;
}

export interface ProjectCostEstimate {
  fasteners: BomLineItem[];
  externalHardware: BomLineItem[];
  melamineSheetsClp: number;
  backPanelSheetsClp: number;
  edgeBandingMetersWithAllowance: number;
  edgeBandingClp: number;
  fastenersClp: number;
  externalHardwareClp: number;
  totalClp: number;
}

const HARDWARE_UNIT_CLP: Record<HardwareCategory, number> = {
  patas: 3990,
  tiradores: 1490,
  bisagras: 1290,
  correderas: 3990,
  otro: 1990,
};

/**
 * Calcula la lista automática de fijaciones (tornillos soberbio, tarugos, clavos de fondo,
 * patines) y el presupuesto referencial completo en Pesos Chilenos (CLP).
 */
export function estimateProjectBomAndCost(
  despiece: DespieceResult,
  cuttingPlan: CuttingPlanResult,
  params: ScaleAndBoardParams,
): ProjectCostEstimate {
  const structuralBoards = despiece.matrizDespiece.filter((p) => p.tipo !== 'fondo');
  const backPanels = despiece.matrizDespiece.filter((p) => p.tipo === 'fondo');
  const hasExternalLegs = despiece.hardwareSummary.some((h) => h.categoria === 'patas');

  const screwCount = Math.max(8, structuralBoards.length * 4);
  const dowelCount = Math.max(8, structuralBoards.length * 2);
  const nailCount = backPanels.length > 0 ? Math.max(20, backPanels.length * 24) : 0;
  const glideCount = hasExternalLegs ? 0 : params.targetDimensions.x >= 1500 ? 6 : 4;

  const fasteners: BomLineItem[] = [
    {
      id: 'bom_tornillos',
      nombre: 'Tornillo soberbio 4×50 mm + tapatornillo',
      cantidad: screwCount,
      unidad: 'unid.',
      costoUnitarioClp: 45,
      subtotalClp: screwCount * 45,
    },
    {
      id: 'bom_tarugos',
      nombre: 'Tarugo de madera estriado 8×35 mm',
      cantidad: dowelCount,
      unidad: 'unid.',
      costoUnitarioClp: 30,
      subtotalClp: dowelCount * 30,
    },
  ];

  if (glideCount > 0) {
    fasteners.push({
      id: 'bom_patines',
      nombre: 'Patín deslizador a piso antihumedad',
      cantidad: glideCount,
      unidad: 'unid.',
      costoUnitarioClp: 250,
      subtotalClp: glideCount * 250,
    });
  }

  if (nailCount > 0) {
    fasteners.push({
      id: 'bom_clavos',
      nombre: 'Clavo / Grapa 15 mm para fondo 3 mm',
      cantidad: nailCount,
      unidad: 'unid.',
      costoUnitarioClp: 15,
      subtotalClp: nailCount * 15,
    });
  }

  const externalHardware: BomLineItem[] = despiece.hardwareSummary.map((hw) => {
    const unitClp = HARDWARE_UNIT_CLP[hw.categoria];
    return {
      id: `cost_${hw.id}`,
      nombre: hw.descripcion,
      cantidad: hw.cantidad,
      unidad: 'unid.',
      costoUnitarioClp: unitClp,
      subtotalClp: hw.cantidad * unitClp,
    };
  });

  // Precio referencial plancha melamina según formato (estándar 2440×1220 vs grande Chile 2500×1830)
  const sheetAreaM2 = (params.sheetDimensions.width * params.sheetDimensions.height) / 1_000_000;
  const melamineUnitClp = sheetAreaM2 > 3.6 ? 39900 : 32900;
  const backPanelUnitClp = 12900;
  const edgeBandingUnitClp = 420;

  const melamineSheetsClp = cuttingPlan.melamineSheetsCount * melamineUnitClp;
  const backPanelSheetsClp = cuttingPlan.backPanelSheetsCount * backPanelUnitClp;
  const edgeBandingMetersWithAllowance = Math.ceil(despiece.totalEdgeBandingMeters * 1.1);
  const edgeBandingClp = edgeBandingMetersWithAllowance * edgeBandingUnitClp;
  const fastenersClp = fasteners.reduce((acc, it) => acc + it.subtotalClp, 0);
  const externalHardwareClp = externalHardware.reduce((acc, it) => acc + it.subtotalClp, 0);
  const totalClp =
    melamineSheetsClp +
    backPanelSheetsClp +
    edgeBandingClp +
    fastenersClp +
    externalHardwareClp;

  return {
    fasteners,
    externalHardware,
    melamineSheetsClp,
    backPanelSheetsClp,
    edgeBandingMetersWithAllowance,
    edgeBandingClp,
    fastenersClp,
    externalHardwareClp,
    totalClp,
  };
}

export function formatClp(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CL')} CLP`;
}
