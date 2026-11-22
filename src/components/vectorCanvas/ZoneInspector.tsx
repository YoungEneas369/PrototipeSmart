/**
 * SMARTFURNITURE v8.0 — INSPECTOR UNIFICADO DE PARTES DEL MUEBLE (`ZoneInspector`)
 * Componente reutilizable montado tanto en `VectorCanvas` (Paso 3) como en `VectorBlueprintPanel`.
 * Sincronizado bidireccionalmente con Canvas 2D y Visor 3D mediante `selectedZoneId` y `hoveredZoneId`.
 */
import { useMemo, useState } from 'react';
import {
  Ban,
  Columns2,
  DoorOpen,
  LayoutGrid,
  Merge,
  Rows2,
  ShoppingBasket,
  Sparkles,
  Square,
} from 'lucide-react';
import type {
  FrontModuleKind,
  FrontZone,
  FurnitureTopology,
  MelamineMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { NumericInput } from '../NumericInput';
import {
  MELAMINE_LABELS,
  ZONE_COLORS,
  ZONE_LABELS,
  ZONE_SHORT_LABELS,
  ensureFrontZonesFromTopology,
  findMergeableNeighbors,
  getSpatialPositionLabel,
  getZoneInteriorDimsMm,
  mergeZoneWithNeighbor,
  resizeZoneDimensionMm,
  splitZoneTopology,
} from './geometryHelpers';
import './vectorCanvas.css';

export interface ZoneInspectorProps {
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  selectedZoneId: string | null;
  hoveredZoneId?: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onHoverZone?: (zoneId: string | null) => void;
  onUpdateTopology: (next: FurnitureTopology) => void;
  onUpdateFrontZones: (zones: FrontZone[]) => void;
  compact?: boolean;
}

interface PartPaletteOption {
  kind: FrontModuleKind;
  label: string;
  hint: string;
  badge: string;
  isDanger?: boolean;
}

const PART_PALETTE: readonly PartPaletteOption[] = [
  { kind: 'open', label: 'Nicho abierto', hint: 'Espacio abierto sin frente', badge: '□' },
  { kind: 'door_left', label: 'Puerta izq.', hint: 'Bisagras a la izquierda', badge: '◧' },
  { kind: 'door_right', label: 'Puerta der.', hint: 'Bisagras a la derecha', badge: '◨' },
  { kind: 'door_double', label: 'Puerta doble', hint: '2 hojas batientes', badge: '⊞' },
  { kind: 'door_glass', label: 'Vitrina vidrio', hint: 'Marco con vidrio templado', badge: '◇' },
  { kind: 'drawers', label: 'Cajones', hint: '1 a 6 cajones con correderas', badge: '≡' },
  { kind: 'baskets', label: 'Canastos', hint: '1 a 6 canastos extraíbles', badge: '▦' },
  { kind: 'leg_void', label: 'Hueco piernas', hint: 'Sin base ni fondo (escritorio)', badge: '⊓' },
  {
    kind: 'void_outside',
    label: 'Recorte vacío',
    hint: 'Fuera del mueble (escalonado)',
    badge: '✕',
    isDanger: true,
  },
];

function summarizeZoneChip(z: FrontZone): string {
  if (z.kind === 'drawers') return `${z.drawerCount ?? 3} Caj.`;
  if (z.kind === 'baskets') return `${z.basketCount ?? 3} Can.`;
  return ZONE_SHORT_LABELS[z.kind];
}

export function ZoneInspector({
  topology,
  params,
  selectedZoneId,
  hoveredZoneId,
  onSelectZone,
  onHoverZone,
  onUpdateTopology,
  onUpdateFrontZones,
  compact = false,
}: ZoneInspectorProps) {
  const [splitCount, setSplitCount] = useState<number>(3);
  const zones = topology.frontZones ?? [];

  const activeZone = useMemo(() => {
    if (zones.length === 0) return null;
    return zones.find((z) => z.id === selectedZoneId) ?? zones[0];
  }, [zones, selectedZoneId]);

  const activeIdx = activeZone ? zones.findIndex((z) => z.id === activeZone.id) : -1;

  const mergeNeighbors = useMemo(
    () => (activeZone ? findMergeableNeighbors(topology, activeZone.id) : []),
    [topology, activeZone],
  );

  // Estado cuando un Preset oficial todavía no tiene `frontZones` inicializadas
  if (zones.length === 0 || !activeZone) {
    return (
      <div className={`zi-card${compact ? ' zi-compact' : ''}`}>
        <div className="zi-empty">
          <div className="zi-empty-text">
            <strong>
              <LayoutGrid size={15} /> Inspector de partes del mueble
            </strong>
            <p>
              Este diseño usa estructura base sin zonas frontales editables todavía. Genera las
              celdas automáticamente para asignar puertas, cajones, canastos, vitrinas o acabados
              bicolor.
            </p>
          </div>
          <button
            type="button"
            className="vc-btn vc-btn-primary"
            onClick={() => {
              const generated = ensureFrontZonesFromTopology(topology, params);
              onUpdateFrontZones(generated);
              if (generated.length > 0) {
                onSelectZone(generated[0].id);
              }
            }}
          >
            <Sparkles size={14} /> Generar zonas desde estructura actual
          </button>
        </div>
      </div>
    );
  }

  const dims = getZoneInteriorDimsMm(activeZone, params);
  const spatialPos = getSpatialPositionLabel(activeZone);
  const canResizeWidth = activeZone.uStart > 0.018 || activeZone.uEnd < 0.982;
  const canResizeHeight = activeZone.vStart > 0.018 || activeZone.vEnd < 0.982;
  const minCellMm = Math.max(40, Math.round(params.boardThickness * 2.5));

  const isClosedFront =
    activeZone.kind === 'door_left' ||
    activeZone.kind === 'door_right' ||
    activeZone.kind === 'door_double' ||
    activeZone.kind === 'door_glass' ||
    activeZone.kind === 'drawers';

  const supportsInternalShelves =
    activeZone.kind === 'open' ||
    activeZone.kind === 'door_left' ||
    activeZone.kind === 'door_right' ||
    activeZone.kind === 'door_double' ||
    activeZone.kind === 'door_glass';

  const patchActiveZone = (updater: (z: FrontZone) => FrontZone) => {
    const nextZones = zones.map((z) => (z.id === activeZone.id ? updater(z) : z));
    onUpdateFrontZones(nextZones);
  };

  const handleSelectKind = (nextKind: FrontModuleKind) => {
    const clearOverride =
      nextKind === 'open' ||
      nextKind === 'baskets' ||
      nextKind === 'leg_void' ||
      nextKind === 'void_outside';

    patchActiveZone((z) => ({
      ...z,
      kind: nextKind,
      drawerCount: nextKind === 'drawers' ? (z.drawerCount ?? 3) : undefined,
      basketCount: nextKind === 'baskets' ? (z.basketCount ?? 3) : undefined,
      internalShelves:
        nextKind === 'drawers' ||
        nextKind === 'baskets' ||
        nextKind === 'leg_void' ||
        nextKind === 'void_outside'
          ? undefined
          : z.internalShelves,
      materialOverride: clearOverride ? undefined : z.materialOverride,
      label:
        !z.label || Object.values(ZONE_LABELS).includes(z.label) || z.label.startsWith('Vano ')
          ? ZONE_LABELS[nextKind]
          : z.label,
    }));
    onSelectZone(activeZone.id);
  };

  const handleSplit = (direction: 'cols' | 'rows', parts: number) => {
    const res = splitZoneTopology(topology, params, activeZone.id, direction, parts);
    if (!res) return;
    onUpdateTopology(res.topology);
    onSelectZone(res.newSelectedZoneId);
  };

  const handleMerge = (neighborId: string) => {
    const res = mergeZoneWithNeighbor(topology, params, activeZone.id, neighborId);
    if (!res) return;
    onUpdateTopology(res.topology);
    onSelectZone(res.mergedZoneId);
  };

  const handleResizeMm = (axis: 'width' | 'height', nextMm: number) => {
    const res = resizeZoneDimensionMm(topology, params, activeZone.id, axis, nextMm);
    if (!res) return;
    onUpdateTopology(res.topology);
  };

  return (
    <div className={`zi-card${compact ? ' zi-compact' : ''}`}>
      {/* Cabecera: chips espaciales Z1..Zn con sincronización hover/selección 2D ↔ 3D */}
      <div className="zi-header">
        <div className="zi-chips-wrap" role="tablist" aria-label="Zonas del mueble">
          <span className="zi-section-title">Partes ({zones.length})</span>
          {zones.map((z, idx) => {
            const isSel = z.id === activeZone.id;
            const isHov = hoveredZoneId === z.id;
            const posLabel = getSpatialPositionLabel(z);
            return (
              <button
                key={z.id}
                type="button"
                role="tab"
                aria-selected={isSel}
                className={`zi-chip${isSel ? ' active' : ''}${isHov ? ' hovered' : ''}${
                  z.kind === 'void_outside' ? ' is-void' : ''
                }`}
                onClick={() => onSelectZone(z.id)}
                onMouseEnter={() => onHoverZone?.(z.id)}
                onMouseLeave={() => onHoverZone?.(null)}
                title={`Z${idx + 1} · ${posLabel} — ${ZONE_LABELS[z.kind]}`}
              >
                <i className="zi-chip-dot" style={{ background: ZONE_COLORS[z.kind].dot }} />
                <span className="zi-chip-code">
                  Z{idx + 1} · {posLabel}
                </span>
                <span className="zi-chip-kind">{summarizeZoneChip(z)}</span>
                {z.materialOverride && (
                  <i
                    className={`zi-swatch-mini zi-swatch-${z.materialOverride}`}
                    title={`Color frente: ${MELAMINE_LABELS[z.materialOverride]}`}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div className="zi-active-summary">
          <span className="zi-active-badge">
            Z{activeIdx + 1} · {spatialPos}
          </span>
          <span className="zi-dims-readout">
            <strong>
              {dims.widthMm} × {dims.heightMm} mm
            </strong>{' '}
            <span className="zi-dims-cm">
              ({dims.widthCm} × {dims.heightCm} cm int.)
            </span>
          </span>
        </div>
      </div>

      {/* Paleta visual de 1 clic (>= 40px) */}
      <div className="zi-palette-grid" role="group" aria-label="Tipo de parte del mueble">
        {PART_PALETTE.map((opt) => {
          const isActive = activeZone.kind === opt.kind;
          return (
            <button
              key={opt.kind}
              type="button"
              className={`zi-part-btn${isActive ? ' active' : ''}${opt.isDanger ? ' danger' : ''}`}
              onClick={() => handleSelectKind(opt.kind)}
              title={opt.hint}
            >
              <span className="zi-part-icon" aria-hidden="true">
                {opt.kind === 'open' ? (
                  <Square size={15} />
                ) : opt.kind === 'door_left' ||
                  opt.kind === 'door_right' ||
                  opt.kind === 'door_double' ? (
                  <DoorOpen size={15} />
                ) : opt.kind === 'baskets' ? (
                  <ShoppingBasket size={15} />
                ) : opt.kind === 'void_outside' ? (
                  <Ban size={15} />
                ) : (
                  opt.badge
                )}
              </span>
              <span className="zi-part-label">{opt.label}</span>
            </button>
          );
        })}
      </div>

      {/* Medidas directas en mm + Estructura (Dividir / Unir) */}
      <div className="zi-controls-row">
        <div className="zi-control-cluster">
          <span className="zi-cluster-label">Medidas celda (int.):</span>
          <label className="zi-mm-field">
            <span>Ancho</span>
            {canResizeWidth ? (
              <NumericInput
                value={dims.widthMm}
                min={minCellMm}
                max={Math.max(minCellMm, dims.xInt - minCellMm)}
                step={5}
                onCommit={(val) => handleResizeMm('width', val)}
                className="zi-mm-input"
                ariaLabel="Ancho interior de la celda en mm"
              />
            ) : (
              <span className="zi-mm-static" title="Esta celda ocupa todo el ancho interior del mueble">
                {dims.widthMm}
              </span>
            )}
            <span className="zi-unit">mm</span>
          </label>
          <label className="zi-mm-field">
            <span>Alto</span>
            {canResizeHeight ? (
              <NumericInput
                value={dims.heightMm}
                min={minCellMm}
                max={Math.max(minCellMm, dims.yInt - minCellMm)}
                step={5}
                onCommit={(val) => handleResizeMm('height', val)}
                className="zi-mm-input"
                ariaLabel="Alto interior de la celda en mm"
              />
            ) : (
              <span className="zi-mm-static" title="Esta celda ocupa todo el alto interior del mueble">
                {dims.heightMm}
              </span>
            )}
            <span className="zi-unit">mm</span>
          </label>
        </div>

        <div className="zi-control-cluster">
          <span className="zi-cluster-label">Estructura:</span>
          <button
            type="button"
            className="vc-chip"
            onClick={() => handleSplit('cols', 2)}
            title="Divide esta celda en 2 columnas iguales agregando un divisor vertical"
          >
            <Columns2 size={13} /> + 2 col.
          </button>
          <button
            type="button"
            className="vc-chip"
            onClick={() => handleSplit('rows', 2)}
            title="Divide esta celda en 2 filas iguales agregando una repisa horizontal"
          >
            <Rows2 size={13} /> + 2 filas
          </button>
          <span className="zi-split-n">
            <select
              className="zi-mini-select"
              value={splitCount}
              onChange={(e) => setSplitCount(Number(e.target.value))}
              aria-label="Número de partes para dividir celda"
            >
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
            <button
              type="button"
              className="vc-chip"
              onClick={() => handleSplit('cols', splitCount)}
              title={`Dividir en ${splitCount} columnas`}
            >
              Col
            </button>
            <button
              type="button"
              className="vc-chip"
              onClick={() => handleSplit('rows', splitCount)}
              title={`Dividir en ${splitCount} filas`}
            >
              Filas
            </button>
          </span>

          {mergeNeighbors.length === 0 ? (
            <button
              type="button"
              className="vc-chip"
              disabled
              title="No hay una celda vecina del mismo ancho o alto para fusionar"
            >
              <Merge size={13} /> Unir con vecina
            </button>
          ) : (
            mergeNeighbors.map((m) => (
              <button
                key={m.neighbor.id}
                type="button"
                className="vc-chip vc-chip-merge"
                onClick={() => handleMerge(m.neighbor.id)}
                title={`Elimina el tabique compartido y une Z${activeIdx + 1} con Z${m.neighborIndex + 1}`}
              >
                <Merge size={13} /> Unir con Z{m.neighborIndex + 1} ({m.sideLabel})
              </button>
            ))
          )}
        </div>
      </div>

      {/* Opciones finas de la parte seleccionada */}
      <div className="zi-options-row">
        {activeZone.kind === 'drawers' && (
          <div className="zi-option-group">
            <span className="zi-cluster-label">Cajones:</span>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                type="button"
                className={(activeZone.drawerCount ?? 3) === n ? 'vc-chip active' : 'vc-chip'}
                onClick={() => patchActiveZone((z) => ({ ...z, drawerCount: n }))}
              >
                ×{n}
              </button>
            ))}
          </div>
        )}

        {activeZone.kind === 'baskets' && (
          <div className="zi-option-group">
            <span className="zi-cluster-label">Canastos:</span>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                type="button"
                className={(activeZone.basketCount ?? 3) === n ? 'vc-chip active' : 'vc-chip'}
                onClick={() => patchActiveZone((z) => ({ ...z, basketCount: n }))}
              >
                ×{n}
              </button>
            ))}
          </div>
        )}

        {supportsInternalShelves && (
          <div className="zi-option-group">
            <span className="zi-cluster-label">Repisas interiores:</span>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={(activeZone.internalShelves ?? 0) === n ? 'vc-chip active' : 'vc-chip'}
                onClick={() =>
                  patchActiveZone((z) => ({ ...z, internalShelves: n <= 0 ? undefined : n }))
                }
              >
                {n}
              </button>
            ))}
          </div>
        )}

        {isClosedFront && (
          <div className="zi-option-group">
            <span className="zi-cluster-label">Acabado frente (bicolor):</span>
            <button
              type="button"
              className={!activeZone.materialOverride ? 'vc-chip active' : 'vc-chip'}
              onClick={() => patchActiveZone((z) => ({ ...z, materialOverride: undefined }))}
            >
              Igual a carcasa
            </button>
            {(['blanco', 'roble', 'grafito'] as MelamineMaterial[]).map((mat) => (
              <button
                key={mat}
                type="button"
                className={activeZone.materialOverride === mat ? 'vc-chip active' : 'vc-chip'}
                onClick={() => patchActiveZone((z) => ({ ...z, materialOverride: mat }))}
              >
                <i className={`zi-swatch-mini zi-swatch-${mat}`} />
                {MELAMINE_LABELS[mat]}
              </button>
            ))}
          </div>
        )}

        <label className="zi-label-field">
          <span className="zi-cluster-label">Etiqueta:</span>
          <input
            type="text"
            className="zi-text-input"
            value={activeZone.label ?? ''}
            maxLength={32}
            placeholder={ZONE_LABELS[activeZone.kind]}
            onChange={(e) =>
              patchActiveZone((z) => ({
                ...z,
                label: e.target.value.trim().length > 0 ? e.target.value : undefined,
              }))
            }
          />
        </label>
      </div>
    </div>
  );
}
