/**
 * SMARTFURNITURE — PANEL DE PLANO VECTORIAL 2D, PARTES Y APROBACIÓN (v8.0)
 * - Compara el diseño original (V₀) frente al plano con nuevas medidas (V_f).
 * - Unifica la edición de módulos frontales con `ZoneInspector` (sincronizado 2D ↔ 3D).
 * - Formato dinámico de plancha y unidad sincronizada (`mm` / `cm`).
 */
import { useMemo, useState } from 'react';
import { CheckCircle2, Download, SlidersHorizontal } from 'lucide-react';
import type {
  CuttingPlanResult,
  DespieceResult,
  FrontZone,
  FurnitureTopology,
  ScaleAndBoardParams,
  WingRole,
} from '../../types/contracts';
import {
  applyReturnWingTopology,
  buildReturnWingParams,
  calculateDespiece,
  extractReturnWingTopology,
} from '../../core/mathEngine';
import { renderFurnitureVectorBlueprintSvg } from '../../core/vectorBlueprint';
import { NumericInput } from '../NumericInput';
import { ZoneInspector } from '../vectorCanvas/ZoneInspector';

export interface VectorBlueprintPanelProps {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  despiece: DespieceResult;
  cuttingPlan: CuttingPlanResult;
  modelApproved: boolean;
  displayUnit?: 'mm' | 'cm';
  selectedZoneId: string | null;
  hoveredZoneId?: string | null;
  editingWing?: WingRole;
  onChangeEditingWing?: (wing: WingRole) => void;
  onSelectZone: (zoneId: string | null) => void;
  onHoverZone?: (zoneId: string | null) => void;
  onUpdateDim: (axis: 'x' | 'y' | 'z', valueMm: number) => void;
  onUpdateTopology: (next: FurnitureTopology) => void;
  onUpdateFrontZones: (zones: FrontZone[]) => void;
  onApproveModel: () => void;
}

function downloadSvg(filename: string, svg: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatDimTriplet(
  dims: { x: number; y: number; z: number },
  unit: 'mm' | 'cm',
): string {
  if (unit === 'cm') {
    const fx = Number((dims.x / 10).toFixed(1));
    const fy = Number((dims.y / 10).toFixed(1));
    const fz = Number((dims.z / 10).toFixed(1));
    return `${fx}×${fy}×${fz} cm`;
  }
  return `${Math.round(dims.x)}×${Math.round(dims.y)}×${Math.round(dims.z)} mm`;
}

export function VectorBlueprintPanel({
  topology,
  params,
  despiece,
  cuttingPlan,
  modelApproved,
  displayUnit = 'mm',
  selectedZoneId,
  hoveredZoneId,
  editingWing,
  onChangeEditingWing,
  onSelectZone,
  onHoverZone,
  onUpdateDim,
  onUpdateTopology,
  onUpdateFrontZones,
  onApproveModel,
}: VectorBlueprintPanelProps) {
  const [internalWing, setInternalWing] = useState<WingRole>('main');
  const isLShape = Boolean(topology.lShape?.enabled);
  const rawWing = editingWing ?? internalWing;
  const activeWing: WingRole = isLShape ? rawWing : 'main';
  const setWing = (nextWing: WingRole) => {
    setInternalWing(nextWing);
    onChangeEditingWing?.(nextWing);
  };

  const inspectorTopology = useMemo(
    () => (activeWing === 'return' ? extractReturnWingTopology(topology) : topology),
    [activeWing, topology],
  );
  const inspectorParams = useMemo(
    () => (activeWing === 'return' ? buildReturnWingParams(topology, params) : params),
    [activeWing, topology, params],
  );

  const handleInspectorTopology = (nextWingTop: FurnitureTopology) => {
    if (activeWing === 'return' && isLShape) {
      onUpdateTopology(applyReturnWingTopology(topology, nextWingTop));
    } else {
      onUpdateTopology(nextWingTop);
    }
  };

  const handleInspectorZones = (zones: FrontZone[]) => {
    if (activeWing === 'return' && isLShape) {
      onUpdateTopology(
        applyReturnWingTopology(topology, {
          ...inspectorTopology,
          frontZones: zones,
        }),
      );
    } else {
      onUpdateFrontZones(zones);
    }
  };

  const originalParams = useMemo<ScaleAndBoardParams>(
    () => ({
      ...params,
      targetDimensions: { ...params.referenceDimensions },
    }),
    [params],
  );

  const despieceOriginal = useMemo(
    () => calculateDespiece(topology, originalParams),
    [topology, originalParams],
  );

  const svgOriginal = useMemo(
    () =>
      renderFurnitureVectorBlueprintSvg(topology, originalParams, despieceOriginal, {
        stageLabel: 'MODELO VECTORIAL ORIGINAL (INTERPRETADO V₀)',
      }),
    [topology, originalParams, despieceOriginal],
  );

  const svgResized = useMemo(
    () =>
      renderFurnitureVectorBlueprintSvg(topology, params, despiece, {
        stageLabel: 'NUEVO MODELO VECTORIAL REDIMENSIONADO (V_f)',
        cuttingPlan,
      }),
    [topology, params, despiece, cuttingPlan],
  );

  const dimsChanged =
    params.targetDimensions.x !== params.referenceDimensions.x ||
    params.targetDimensions.y !== params.referenceDimensions.y ||
    params.targetDimensions.z !== params.referenceDimensions.z;

  const sheetDimLabel = `${Math.round(params.sheetDimensions.width / 10)}×${Math.round(params.sheetDimensions.height / 10)} cm`;
  const isCm = displayUnit === 'cm';
  const toDisplay = (mm: number) => (isCm ? Number((mm / 10).toFixed(1)) : Math.round(mm));
  const fromDisplay = (val: number) => (isCm ? Math.round(val * 10) : Math.round(val));

  return (
    <div className="vector-card">
      <div className="card-header-row">
        <div>
          <h3>2. Plano Técnico 2D y Aprobación</h3>
          <p className="muted small-note">
            Revisa el diseño original (V₀), ajusta tus medidas finales (V<sub>f</sub>) y aprueba
            para generar el corte en planchas {sheetDimLabel}.
          </p>
        </div>
        <div className="export-bar">
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              downloadSvg(
                `plano_vectorial_${params.targetDimensions.x}x${params.targetDimensions.y}.svg`,
                svgResized,
              )
            }
          >
            <Download size={15} /> Descargar SVG
          </button>
          <button
            type="button"
            className={modelApproved ? 'btn-approve is-approved' : 'btn-approve'}
            onClick={onApproveModel}
          >
            <CheckCircle2 size={16} />{' '}
            {modelApproved
              ? `Plano Aprobado — Ir a Taller (${sheetDimLabel})`
              : `Aprobar Plano → Corte y Presupuesto (${sheetDimLabel})`}
          </button>
        </div>
      </div>

      {/* Barra rápida de nuevas medidas sincronizada con la unidad activa */}
      <div className="calib-box">
        <SlidersHorizontal size={15} />
        <strong>Tus medidas finales ({displayUnit}):</strong>
        <label className="small-note inline-num">
          Ancho:
          <NumericInput
            min={isCm ? 30 : 300}
            max={isCm ? 260 : 2600}
            step={isCm ? 1 : 10}
            allowDecimals={isCm}
            unitSuffix={displayUnit}
            value={toDisplay(params.targetDimensions.x)}
            onCommit={(v) => onUpdateDim('x', fromDisplay(v))}
            style={{ width: 96 }}
            ariaLabel={`Ancho X en ${displayUnit}`}
          />
        </label>
        <label className="small-note inline-num">
          Alto:
          <NumericInput
            min={isCm ? 30 : 300}
            max={isCm ? 260 : 2600}
            step={isCm ? 1 : 10}
            allowDecimals={isCm}
            unitSuffix={displayUnit}
            value={toDisplay(params.targetDimensions.y)}
            onCommit={(v) => onUpdateDim('y', fromDisplay(v))}
            style={{ width: 96 }}
            ariaLabel={`Alto Y en ${displayUnit}`}
          />
        </label>
        <label className="small-note inline-num">
          Profundidad:
          <NumericInput
            min={isCm ? 18 : 180}
            max={isCm ? 90 : 900}
            step={isCm ? 1 : 10}
            allowDecimals={isCm}
            unitSuffix={displayUnit}
            value={toDisplay(params.targetDimensions.z)}
            onCommit={(v) => onUpdateDim('z', fromDisplay(v))}
            style={{ width: 92 }}
            ariaLabel={`Profundidad Z en ${displayUnit}`}
          />
        </label>
        <span className="mono small-note muted">
          {dimsChanged ? 'Medidas personalizadas activas' : 'Medidas originales'}
        </span>
      </div>

      {/* Planos Vectoriales SVG: Diseño original V0 vs Medidas finales Vf */}
      <div className="blueprint-grid">
        <div className="blueprint-pane">
          <div className="blueprint-pane-title">
            1. Diseño original (V₀: {formatDimTriplet(params.referenceDimensions, displayUnit)})
          </div>
          <div className="svg-preview" dangerouslySetInnerHTML={{ __html: svgOriginal }} />
        </div>

        <div className="blueprint-pane">
          <div className="blueprint-pane-title resized">
            2. Plano con tus medidas (V_f: {formatDimTriplet(params.targetDimensions, displayUnit)}
            {isLShape && topology.lShape
              ? ` + L ${topology.lShape.side === 'right' ? 'Der' : 'Izq'} ${toDisplay(topology.lShape.returnLengthMm)}×${toDisplay(topology.lShape.returnDepthMm)} ${displayUnit}`
              : ''}
            )
          </div>
          <div className="svg-preview" dangerouslySetInnerHTML={{ __html: svgResized }} />
        </div>
      </div>

      {/* Inspector unificado de zonas frontales compartido con VectorCanvas */}
      <div className="metric-card">
        <div className="card-header-row">
          <h4>
            Inspector de Zonas y Módulos Frontales (
            {(inspectorTopology.frontZones ?? []).length} zonas
            {isLShape
              ? activeWing === 'return'
                ? ' · Ala Retorno B'
                : ' · Ala Principal A'
              : ''}
            )
          </h4>
          {isLShape ? (
            <div className="segmented-2" role="group" aria-label="Ala activa en inspector de zonas">
              <button
                type="button"
                className={activeWing === 'main' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => setWing('main')}
              >
                Ala Principal (A)
              </button>
              <button
                type="button"
                className={activeWing === 'return' ? 'seg-btn active' : 'seg-btn'}
                onClick={() => setWing('return')}
              >
                Ala Retorno (B)
              </button>
            </div>
          ) : (
            <span className="small-note muted">
              Los cambios actualizan al instante el plano 2D, el 3D y el despiece.
            </span>
          )}
        </div>
        <ZoneInspector
          topology={inspectorTopology}
          params={inspectorParams}
          selectedZoneId={selectedZoneId}
          hoveredZoneId={hoveredZoneId}
          onSelectZone={onSelectZone}
          onHoverZone={onHoverZone}
          onUpdateTopology={handleInspectorTopology}
          onUpdateFrontZones={handleInspectorZones}
        />
      </div>
    </div>
  );
}
