/**
 * Presets oficiales de demostración y validación SmartFurniture v8.0.
 * Incluye valores exactos 1/3 y 2/3 en Rack TV + patas externas excluidas de melamina.
 */
import type { FurnitureTopology, ScaleAndBoardParams } from '../../types/contracts';

export type PresetKey =
  | 'estanteria'
  | 'rack_tv'
  | 'closet'
  | 'escritorio_l'
  | 'cocina_l'
  | 'closet_l';

export interface FurniturePreset {
  key: PresetKey;
  label: string;
  description: string;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
}

const DEFAULT_SHEET = { width: 2440, height: 1220 };

export const CHILE_MELAMINE_SHEET = { width: 2500, height: 1830 };
export const CHILE_DUROLAC_SHEET = { width: 2440, height: 1520 };

export const PRESETS: Record<PresetKey, FurniturePreset> = {
  estanteria: {
    key: 'estanteria',
    label: 'Preset 1 — Estantería Abierta',
    description: '800×1800×320 mm · 4 repisas equidistantes · topOverSides (pandeo > 886 mm)',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 800 / 1800,
      vDividers: [],
      hShelves: [],
      shelfMode: 'equidistant',
      equalShelfCount: 4,
      hasBackPanel: false,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: false,
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 800, y: 1800, z: 320 },
      referenceDimensions: { x: 800, y: 1800, z: 320 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'roble',
    },
  },

  rack_tv: {
    key: 'rack_tv',
    label: 'Preset 2 — Rack de TV',
    description: '1600×550×400 mm · Vanos mixtos exactos (1/3, 2/3) + 4 patas externas 150 mm',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 1600 / 550,
      vDividers: [
        { id: 'div_1', position: 1 / 3, start: 0, end: 1 },
        { id: 'div_2', position: 2 / 3, start: 0, end: 1 },
      ],
      hShelves: [
        { id: 'rep_central', position: 0.5, start: 1 / 3, end: 2 / 3 },
      ],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: false,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: true,
      externalLegHeightMm: 150,
      externalLegCount: 4,
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 1600, y: 550, z: 400 },
      referenceDimensions: { x: 1600, y: 550, z: 400 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topBetweenSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'grafito',
    },
  },

  closet: {
    key: 'closet',
    label: 'Preset 3 — Clóset con Fondo 3 mm',
    description: '1500×2100×550 mm · 1 divisor central + 3 izq / 1 der + Fondo Durolac 3 mm',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 1500 / 2100,
      vDividers: [
        { id: 'div_central', position: 0.5, start: 0, end: 1 },
      ],
      hShelves: [
        { id: 'rep_izq_1', position: 0.25, start: 0, end: 0.5 },
        { id: 'rep_izq_2', position: 0.5, start: 0, end: 0.5 },
        { id: 'rep_izq_3', position: 0.75, start: 0, end: 0.5 },
        { id: 'rep_der_1', position: 0.82, start: 0.5, end: 1 },
      ],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: false,
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 1500, y: 2100, z: 550 },
      referenceDimensions: { x: 1500, y: 2100, z: 550 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'blanco',
    },
  },

  escritorio_l: {
    key: 'escritorio_l',
    label: 'Preset L1 — Escritorio Ejecutivo en L',
    description: '1600×750×600 mm + Retorno 1400×500 mm · Esquina abierta + cajonera retorno',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 1600 / 750,
      vDividers: [{ id: 'div_desk_ped', position: 0.28, start: 0, end: 1 }],
      hShelves: [],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: false,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: false,
      cubiertaMaterialOverride: 'blanco',
      frontZones: [
        {
          id: 'ez1',
          uStart: 0,
          uEnd: 0.28,
          vStart: 0,
          vEnd: 1,
          kind: 'drawers',
          drawerCount: 3,
          label: 'Cajonera Izq',
        },
        {
          id: 'ez2',
          uStart: 0.28,
          uEnd: 1,
          vStart: 0,
          vEnd: 1,
          kind: 'leg_void',
          label: 'Puesto Principal',
        },
      ],
      lShape: {
        enabled: true,
        side: 'right',
        returnLengthMm: 1400,
        returnDepthMm: 500,
        returnHeightMm: 750,
        cornerJoint: 'butt_joint',
        openCorner: true,
        vDividers: [{ id: 'div_ret_ped', position: 0.55, start: 0, end: 1 }],
        hShelves: [],
        shelfMode: 'custom',
        equalShelfCount: 0,
        hasBackPanel: false,
        cubiertaMaterialOverride: 'blanco',
        frontZones: [
          {
            id: 'ezr1',
            uStart: 0,
            uEnd: 0.55,
            vStart: 0,
            vEnd: 1,
            kind: 'leg_void',
            label: 'Retorno Abierto',
          },
          {
            id: 'ezr2',
            uStart: 0.55,
            uEnd: 1,
            vStart: 0,
            vEnd: 1,
            kind: 'drawers',
            drawerCount: 3,
            label: 'Cajonera Retorno',
          },
        ],
      },
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 1600, y: 750, z: 600 },
      referenceDimensions: { x: 1600, y: 750, z: 600 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'roble',
    },
  },

  cocina_l: {
    key: 'cocina_l',
    label: 'Preset L2 — Mueble Cocina Base en L',
    description: '1800×850×600 mm + Retorno 1500×600 mm · Zócalo 100 mm + cubierta mesón',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 1800 / 850,
      vDividers: [
        { id: 'c_div1', position: 1 / 3, start: 0, end: 1 },
        { id: 'c_div2', position: 2 / 3, start: 0, end: 1 },
      ],
      hShelves: [
        { id: 'c_rep1', position: 0.5, start: 0, end: 1 / 3 },
        { id: 'c_rep2', position: 0.5, start: 2 / 3, end: 1 },
      ],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
      detectionSource: 'preset',
      detectionConfidence: 1,
      baseSupportType: 'toe_kick',
      toeKickHeightMm: 100,
      hasExternalLegs: false,
      cubiertaMaterialOverride: 'grafito',
      frontZones: [
        { id: 'cz1', uStart: 0, uEnd: 1 / 3, vStart: 0, vEnd: 1, kind: 'door_left', label: 'Módulo Ollas' },
        {
          id: 'cz2',
          uStart: 1 / 3,
          uEnd: 2 / 3,
          vStart: 0,
          vEnd: 1,
          kind: 'drawers',
          drawerCount: 3,
          label: 'Cajonera Cubiertos',
        },
        { id: 'cz3', uStart: 2 / 3, uEnd: 1, vStart: 0, vEnd: 1, kind: 'door_right', label: 'Esquinero Base' },
      ],
      lShape: {
        enabled: true,
        side: 'right',
        returnLengthMm: 1500,
        returnDepthMm: 600,
        returnHeightMm: 850,
        cornerJoint: 'butt_joint',
        openCorner: false,
        vDividers: [{ id: 'cr_div1', position: 0.5, start: 0, end: 1 }],
        hShelves: [
          { id: 'cr_rep1', position: 0.5, start: 0, end: 0.5 },
          { id: 'cr_rep2', position: 0.5, start: 0.5, end: 1 },
        ],
        shelfMode: 'custom',
        equalShelfCount: 0,
        hasBackPanel: true,
        cubiertaMaterialOverride: 'grafito',
        frontZones: [
          { id: 'cr_z1', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 1, kind: 'door_left', label: 'Retorno Puerta 1' },
          { id: 'cr_z2', uStart: 0.5, uEnd: 1, vStart: 0, vEnd: 1, kind: 'door_right', label: 'Retorno Puerta 2' },
        ],
      },
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 1800, y: 850, z: 600 },
      referenceDimensions: { x: 1800, y: 850, z: 600 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'blanco',
    },
  },

  closet_l: {
    key: 'closet_l',
    label: 'Preset L3 — Clóset Vestidor en L',
    description: '1600×2100×550 mm + Retorno 1450×550 mm · Repisas, vitrina y canastos',
    topology: {
      viewsMode: 1,
      aspectRatioXY: 1600 / 2100,
      vDividers: [{ id: 'cl_d1', position: 0.5, start: 0, end: 1 }],
      hShelves: [
        { id: 'cl_r1', position: 0.25, start: 0.5, end: 1 },
        { id: 'cl_r2', position: 0.55, start: 0.5, end: 1 },
        { id: 'cl_r3', position: 0.8, start: 0, end: 0.5 },
      ],
      shelfMode: 'custom',
      equalShelfCount: 0,
      hasBackPanel: true,
      detectionSource: 'preset',
      detectionConfidence: 1,
      hasExternalLegs: false,
      frontZones: [
        { id: 'cl_z1', uStart: 0, uEnd: 0.5, vStart: 0, vEnd: 0.8, kind: 'door_double', label: 'Colgado Largo' },
        { id: 'cl_z2', uStart: 0, uEnd: 0.5, vStart: 0.8, vEnd: 1, kind: 'door_glass', label: 'Maletero Vidrio' },
        {
          id: 'cl_z3',
          uStart: 0.5,
          uEnd: 1,
          vStart: 0,
          vEnd: 0.25,
          kind: 'baskets',
          basketCount: 2,
          label: 'Canastos',
        },
        { id: 'cl_z4', uStart: 0.5, uEnd: 1, vStart: 0.25, vEnd: 1, kind: 'open', label: 'Repisas Ropa' },
      ],
      lShape: {
        enabled: true,
        side: 'left',
        returnLengthMm: 1450,
        returnDepthMm: 550,
        returnHeightMm: 2100,
        cornerJoint: 'butt_joint',
        openCorner: false,
        vDividers: [],
        hShelves: [],
        shelfMode: 'equidistant',
        equalShelfCount: 4,
        hasBackPanel: true,
        frontZones: [{ id: 'clr_z1', uStart: 0, uEnd: 1, vStart: 0, vEnd: 1, kind: 'open', label: 'Estantería L' }],
      },
      hardwareItems: [],
    },
    params: {
      targetDimensions: { x: 1600, y: 2100, z: 550 },
      referenceDimensions: { x: 1600, y: 2100, z: 550 },
      boardThickness: 18,
      backPanelThickness: 3,
      sheetDimensions: { ...DEFAULT_SHEET },
      trimMm: 0,
      kerf: 4,
      respectGrain: true,
      packingStrategy: 'guillotine',
      cornerJointType: 'topOverSides',
      edgeBandingMode: 'visibleEdgesOnly',
      material: 'roble',
    },
  },
};

export function clonePreset(key: PresetKey): {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
} {
  const preset = PRESETS[key];
  const ls = preset.topology.lShape;
  return {
    topology: {
      ...preset.topology,
      quadCorners: preset.topology.quadCorners
        ? [
            { ...preset.topology.quadCorners[0] },
            { ...preset.topology.quadCorners[1] },
            { ...preset.topology.quadCorners[2] },
            { ...preset.topology.quadCorners[3] },
          ]
        : undefined,
      vDividers: preset.topology.vDividers.map((d) => ({ ...d })),
      hShelves: preset.topology.hShelves.map((s) => ({ ...s })),
      diagonalDividers: preset.topology.diagonalDividers
        ? preset.topology.diagonalDividers.map((d) => ({ ...d }))
        : undefined,
      frontZones: preset.topology.frontZones
        ? preset.topology.frontZones.map((z) => ({ ...z }))
        : undefined,
      lShape: ls
        ? {
            ...ls,
            vDividers: ls.vDividers.map((d) => ({ ...d })),
            hShelves: ls.hShelves.map((s) => ({ ...s })),
            diagonalDividers: ls.diagonalDividers
              ? ls.diagonalDividers.map((d) => ({ ...d }))
              : undefined,
            frontZones: ls.frontZones ? ls.frontZones.map((z) => ({ ...z })) : undefined,
          }
        : undefined,
      hardwareItems: (preset.topology.hardwareItems ?? []).map((h) => ({ ...h })),
    },
    params: {
      ...preset.params,
      targetDimensions: { ...preset.params.targetDimensions },
      referenceDimensions: { ...preset.params.referenceDimensions },
      sheetDimensions: { ...preset.params.sheetDimensions },
      backPanelSheetDimensions: preset.params.backPanelSheetDimensions
        ? { ...preset.params.backPanelSheetDimensions }
        : undefined,
      costConfig: preset.params.costConfig ? { ...preset.params.costConfig } : undefined,
    },
  };
}
