/**
 * SMARTFURNITURE v4.0 — APLICACIÓN PRINCIPAL 100% LOCAL Y OFFLINE
 * Visión Híbrida 1-Drag + Catálogo QA (14 muebles reales) + Plano Vectorial 2D (V0 vs Vf)
 * + Visor 3D Bicolor/Vidrio/Tiradores + Unidad 3 + Corte 2D 244×122 + Exportación Excel/CSV/SVG.
 */
import { useMemo, useState } from 'react';
import { Lock, Unlock } from 'lucide-react';
import type {
  FrontZone,
  FurnitureTopology,
  HardwareItem,
  MelamineMaterial,
  ScaleAndBoardParams,
} from './types/contracts';
import {
  CHILE_DUROLAC_SHEET,
  CHILE_MELAMINE_SHEET,
  PRESETS,
  calculateDespiece,
  clonePreset,
  compareShapeAspect,
  computeUnitDirectionVector,
  type PresetKey,
} from './core/mathEngine';
import { generateCuttingPlan } from './core/cuttingStock';
import { CATALOG_14_MUEBLES, cloneCatalogFurniture } from './core/vectorBlueprint/catalog14';
import { Viewer3D } from './components/viewer3d/Viewer3D';
import { MathPanel } from './components/mathPanel/MathPanel';
import { VectorCanvas } from './components/vectorCanvas/VectorCanvas';
import { VectorBlueprintPanel } from './components/vectorBlueprint/VectorBlueprintPanel';
import { NumericInput } from './components/NumericInput';

type ActiveStep = 'split' | 'blueprint' | '3d' | 'foto';
type SheetStandard = 'pauta' | 'chile';

export default function App() {
  const initial = useMemo(() => clonePreset('estanteria'), []);
  const [activePreset, setActivePreset] = useState<PresetKey | null>('estanteria');
  const [activeCatalogId, setActiveCatalogId] = useState<string>('');
  const [externalPhotoUrl, setExternalPhotoUrl] = useState<string | null>(null);
  const [externalPhotoLabel, setExternalPhotoLabel] = useState<string | null>(null);
  const [topology, setTopology] = useState<FurnitureTopology>(initial.topology);
  const [params, setParams] = useState<ScaleAndBoardParams>(initial.params);
  const [explodeFactor, setExplodeFactor] = useState<number>(0);
  const [sheetStandard, setSheetStandard] = useState<SheetStandard>('pauta');
  const [activeStep, setActiveStep] = useState<ActiveStep>('split');
  const [modelApproved, setModelApproved] = useState<boolean>(false);
  const [lockProportion, setLockProportion] = useState<boolean>(false);
  const [lockedRatioXY, setLockedRatioXY] = useState<number>(initial.topology.aspectRatioXY);

  const despiece = useMemo(() => calculateDespiece(topology, params), [topology, params]);

  const cuttingPlan = useMemo(
    () => generateCuttingPlan(despiece.matrizDespiece, params),
    [despiece.matrizDespiece, params],
  );

  const unitVec = useMemo(
    () => computeUnitDirectionVector(params.targetDimensions),
    [params.targetDimensions],
  );

  const shapeComp = useMemo(
    () => compareShapeAspect(topology.aspectRatioXY, params.targetDimensions.x, params.targetDimensions.y),
    [topology.aspectRatioXY, params.targetDimensions.x, params.targetDimensions.y],
  );

  const handleLoadPreset = (key: PresetKey) => {
    const cloned = clonePreset(key);
    if (sheetStandard === 'chile') {
      cloned.params.sheetDimensions = { ...CHILE_MELAMINE_SHEET };
      cloned.params.backPanelSheetDimensions = { ...CHILE_DUROLAC_SHEET };
    }
    setActivePreset(key);
    setActiveCatalogId('');
    setTopology(cloned.topology);
    setParams(cloned.params);
    setModelApproved(false);
    setLockProportion(false);
    setLockedRatioXY(cloned.topology.aspectRatioXY);
    setExplodeFactor(0);
  };

  const handleLoadCatalogFurniture = (catalogId: string) => {
    if (!catalogId) return;
    const cloned = cloneCatalogFurniture(catalogId);
    if (!cloned) return;
    if (sheetStandard === 'chile') {
      cloned.params.sheetDimensions = { ...CHILE_MELAMINE_SHEET };
      cloned.params.backPanelSheetDimensions = { ...CHILE_DUROLAC_SHEET };
    }
    setActivePreset(null);
    setActiveCatalogId(catalogId);
    setTopology(cloned.topology);
    setParams(cloned.params);
    setExternalPhotoUrl(`./ejemplos/${cloned.spec.photoFile}`);
    setExternalPhotoLabel(cloned.spec.name);
    setModelApproved(false);
    setLockProportion(false);
    setLockedRatioXY(cloned.topology.aspectRatioXY);
    setExplodeFactor(0);
    setActiveStep('split');
  };

  const handleUpdateFrontZones = (zones: FrontZone[]) => {
    setActivePreset(null);
    setModelApproved(false);
    setTopology((prev) => ({
      ...prev,
      frontZones: zones,
      hasBackPanel: zones.some((z) => z.kind === 'leg_void') ? false : prev.hasBackPanel,
    }));
  };

  const handleSheetStandardChange = (std: SheetStandard) => {
    setSheetStandard(std);
    setParams((prev) => ({
      ...prev,
      sheetDimensions: std === 'chile' ? { ...CHILE_MELAMINE_SHEET } : { width: 2440, height: 1220 },
      backPanelSheetDimensions: std === 'chile' ? { ...CHILE_DUROLAC_SHEET } : undefined,
    }));
  };

  const updateTargetDim = (axis: 'x' | 'y' | 'z', value: number) => {
    const clamped =
      axis === 'z'
        ? Math.max(200, Math.min(800, value))
        : Math.max(300, Math.min(2400, value));

    if (lockProportion && (axis === 'x' || axis === 'y') && lockedRatioXY > 0.05) {
      setParams((prev) => {
        if (axis === 'x') {
          const nextY = Math.max(300, Math.min(2400, Math.round(clamped / lockedRatioXY)));
          return {
            ...prev,
            targetDimensions: { ...prev.targetDimensions, x: clamped, y: nextY },
          };
        }
        const nextX = Math.max(300, Math.min(2400, Math.round(clamped * lockedRatioXY)));
        return {
          ...prev,
          targetDimensions: { ...prev.targetDimensions, x: nextX, y: clamped },
        };
      });
      return;
    }

    setParams((prev) => ({
      ...prev,
      targetDimensions: { ...prev.targetDimensions, [axis]: clamped },
    }));
  };

  const handleToggleLockProportion = () => {
    setLockProportion((prev) => {
      if (!prev) {
        const curRatio =
          params.targetDimensions.y > 0
            ? params.targetDimensions.x / params.targetDimensions.y
            : topology.aspectRatioXY;
        setLockedRatioXY(curRatio);
      }
      return !prev;
    });
  };

  const handleRestoreShapeProportion = () => {
    const refRatio = Math.max(0.2, Math.min(4, topology.aspectRatioXY));
    const nextY = Math.max(300, Math.min(2400, Math.round(params.targetDimensions.x / refRatio)));
    setLockedRatioXY(refRatio);
    setParams((prev) => ({
      ...prev,
      targetDimensions: { ...prev.targetDimensions, y: nextY },
    }));
  };

  const handleAutoPhotoReconstructed = (
    dims: { x: number; y: number; z: number },
    detectedMaterial?: MelamineMaterial,
  ) => {
    if (dims.y > 0) {
      setLockedRatioXY(dims.x / dims.y);
      setLockProportion(true);
    }
    setModelApproved(false);
    setParams((p) => ({
      ...p,
      referenceDimensions: { ...dims },
      targetDimensions: { ...dims },
      material: detectedMaterial ?? p.material,
    }));
    setActiveStep((cur) => (cur === 'foto' ? 'split' : cur));
  };

  const handleToggleCenterDivider = () => {
    setTopology((prev) => {
      const hasCenter = prev.vDividers.some((d) => Math.abs(d.position - 0.5) < 0.03);
      if (hasCenter) {
        return {
          ...prev,
          vDividers: prev.vDividers.filter((d) => Math.abs(d.position - 0.5) >= 0.03),
        };
      }
      return {
        ...prev,
        vDividers: [
          ...prev.vDividers,
          { id: 'div_central_rapido', position: 0.5, start: 0, end: 1 },
        ],
      };
    });
  };

  const handleToggleExternalLegs = (checked: boolean, heightMm?: number, count?: number) => {
    setTopology((prev) => ({
      ...prev,
      hasExternalLegs: checked,
      externalLegHeightMm: heightMm ?? prev.externalLegHeightMm ?? 150,
      externalLegCount: count ?? prev.externalLegCount ?? 4,
    }));
  };

  const handleAddHardwareItem = (item: HardwareItem) => {
    setTopology((prev) => ({
      ...prev,
      hardwareItems: [...(prev.hardwareItems ?? []), item],
    }));
  };

  const handleRemoveHardwareItem = (id: string) => {
    setTopology((prev) => ({
      ...prev,
      hardwareItems: (prev.hardwareItems ?? []).filter((h) => h.id !== id),
    }));
  };

  const hasCenterDivider = topology.vDividers.some((d) => Math.abs(d.position - 0.5) < 0.03);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="brand-title">SmartFurniture v5.0 — Vectores 2D, 3D &amp; Corte 244×122</div>
          <div className="brand-sub">
            100% Local Offline · Sube tu foto → Vectores y Márgenes → Modelo 3D → Plano de Corte
          </div>
        </div>
        <div className="preset-bar">
          {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={activePreset === k ? 'preset-btn active' : 'preset-btn'}
              onClick={() => handleLoadPreset(k)}
            >
              {PRESETS[k].label}
            </button>
          ))}
          <select
            className="catalog-select"
            value={activeCatalogId}
            onChange={(e) => handleLoadCatalogFurniture(e.target.value)}
            aria-label="Catálogo QA de 14 muebles reales con foto"
            title="Cargar cualquiera de los 14 muebles reales de prueba con su foto original"
          >
            <option value="">Probar 14 Fotos Reales…</option>
            {CATALOG_14_MUEBLES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <nav className="stepper-bar">
        <div className="step-group">
          <button
            type="button"
            className={activeStep === 'split' ? 'step-btn active' : 'step-btn'}
            onClick={() => setActiveStep('split')}
          >
            1. Foto, Vectores y 3D
          </button>
          <button
            type="button"
            className={activeStep === 'blueprint' ? 'step-btn active' : 'step-btn'}
            onClick={() => setActiveStep('blueprint')}
          >
            2. Plano 2D y Medidas
          </button>
          <button
            type="button"
            className={activeStep === '3d' ? 'step-btn active' : 'step-btn'}
            onClick={() => setActiveStep('3d')}
          >
            3. Taller: 3D, Unidad 3 y Corte
          </button>
          <button
            type="button"
            className={activeStep === 'foto' ? 'step-btn active' : 'step-btn'}
            onClick={() => setActiveStep('foto')}
          >
            Ampliar Foto
          </button>
        </div>
        <span className="small-note muted">
          <strong>
            {(params.targetDimensions.x / 10).toFixed(0)}×{(params.targetDimensions.y / 10).toFixed(0)}×
            {(params.targetDimensions.z / 10).toFixed(0)} cm
          </strong>{' '}
          ({params.targetDimensions.x}×{params.targetDimensions.y}×{params.targetDimensions.z} mm) ·{' '}
          {cuttingPlan.totalSheetsCount} plancha(s) ({cuttingPlan.usagePercentage.toFixed(0)}% uso)
        </span>
      </nav>

      <div className="workspace-grid">
        {/* PANEL LATERAL DE PARÁMETROS (pasa debajo del 3D/Foto automáticamente en móvil) */}
        <aside className="sidebar-controls">
          <div className="control-group">
            <div className="card-header-row">
              <h3>Dimensiones Cuerpo V<sub>f</sub> (mm)</h3>
              <button
                type="button"
                className={lockProportion ? 'chip-btn active' : 'chip-btn'}
                onClick={handleToggleLockProportion}
                title="Bloquea el vector unitario frontal û_XY para escalar Ancho y Alto proporcionalmente sin deformar la silueta"
              >
                {lockProportion ? <Lock size={12} /> : <Unlock size={12} />}
                {lockProportion ? 'û_XY fijo' : 'Proporción'}
              </button>
            </div>
            <div className="mono small-note muted">
              û<sub>XY</sub> = ({unitVec.unitXY[0].toFixed(3)}, {unitVec.unitXY[1].toFixed(3)}) · r ={' '}
              {unitVec.aspectRatioXY.toFixed(2)}
            </div>
            {shapeComp?.warn && (
              <div className="alert-box warning compact-alert">
                <span>
                  Silueta{' '}
                  {shapeComp.direction === 'estirado_horizontal' ? 'muy ancha' : 'muy alta'} vs
                  foto ({(shapeComp.deformationFactor * 100).toFixed(0)}%).
                </span>
                <button
                  type="button"
                  className="btn-small"
                  onClick={handleRestoreShapeProportion}
                >
                  Restaurar
                </button>
              </div>
            )}
            <div className="slider-row">
              <div className="slider-head">
                <label>Ancho X ({(params.targetDimensions.x / 10).toFixed(0)} cm)</label>
                <NumericInput
                  min={300}
                  max={2400}
                  step={10}
                  value={params.targetDimensions.x}
                  onCommit={(v) => updateTargetDim('x', v)}
                  ariaLabel="Ancho X en milímetros"
                />
              </div>
              <input
                type="range"
                min={300}
                max={2400}
                step={10}
                value={params.targetDimensions.x}
                onChange={(e) => updateTargetDim('x', Number(e.target.value))}
              />
            </div>

            <div className="slider-row">
              <div className="slider-head">
                <label>Alto Y ({(params.targetDimensions.y / 10).toFixed(0)} cm)</label>
                <NumericInput
                  min={300}
                  max={2400}
                  step={10}
                  value={params.targetDimensions.y}
                  onCommit={(v) => updateTargetDim('y', v)}
                  ariaLabel="Alto Y en milímetros"
                />
              </div>
              <input
                type="range"
                min={300}
                max={2400}
                step={10}
                value={params.targetDimensions.y}
                onChange={(e) => updateTargetDim('y', Number(e.target.value))}
              />
            </div>

            <div className="slider-row">
              <div className="slider-head">
                <label>Profundidad Z ({(params.targetDimensions.z / 10).toFixed(0)} cm)</label>
                <NumericInput
                  min={200}
                  max={800}
                  step={10}
                  value={params.targetDimensions.z}
                  onCommit={(v) => updateTargetDim('z', v)}
                  ariaLabel="Profundidad Z en milímetros"
                />
              </div>
              <input
                type="range"
                min={200}
                max={800}
                step={10}
                value={params.targetDimensions.z}
                onChange={(e) => updateTargetDim('z', Number(e.target.value))}
              />
              <div className="chip-row">
                {[320, 400, 500, 550].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={params.targetDimensions.z === d ? 'chip-btn active' : 'chip-btn'}
                    onClick={() => updateTargetDim('z', d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="control-group">
            <h3>Estructura Interna y Patas</h3>
            {topology.shelfMode === 'equidistant' && (
              <div className="slider-row">
                <div className="slider-head">
                  <label>Repisas equidistantes (N)</label>
                  <strong>{topology.equalShelfCount}</strong>
                </div>
                <input
                  type="range"
                  min={0}
                  max={8}
                  value={topology.equalShelfCount}
                  onChange={(e) =>
                    setTopology((prev) => ({
                      ...prev,
                      equalShelfCount: Number(e.target.value),
                    }))
                  }
                />
              </div>
            )}

            <button type="button" className="btn-secondary" onClick={handleToggleCenterDivider}>
              {hasCenterDivider ? 'Quitar divisor vertical central' : '+ Agregar divisor vertical central'}
            </button>

            <label className="toggle-label">
              <input
                type="checkbox"
                checked={topology.hasBackPanel}
                onChange={(e) =>
                  setTopology((prev) => ({ ...prev, hasBackPanel: e.target.checked }))
                }
              />
              Fondo Durolac 3 mm (n×3 → n×5)
            </label>

            <label className="toggle-label">
              <input
                type="checkbox"
                checked={Boolean(topology.hasExternalLegs)}
                onChange={(e) => handleToggleExternalLegs(e.target.checked)}
              />
              Patas externas independientes
            </label>
            {topology.hasExternalLegs && (
              <div className="chip-row">
                <label className="small-note inline-num">
                  Alto (mm):
                  <NumericInput
                    min={40}
                    max={400}
                    step={10}
                    value={topology.externalLegHeightMm ?? 150}
                    onCommit={(v) => handleToggleExternalLegs(true, v, topology.externalLegCount)}
                    style={{ width: 62 }}
                    ariaLabel="Alto de patas en milímetros"
                  />
                </label>
                <label className="small-note inline-num">
                  Cant:
                  <NumericInput
                    min={2}
                    max={12}
                    step={2}
                    value={topology.externalLegCount ?? 4}
                    onCommit={(v) => handleToggleExternalLegs(true, topology.externalLegHeightMm, v)}
                    style={{ width: 48 }}
                    ariaLabel="Cantidad de patas"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="control-group">
            <h3>Acabado 3D y Vista Explotada</h3>
            <div className="chip-row">
              {(['blanco', 'roble', 'grafito'] as MelamineMaterial[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={params.material === m ? 'chip-btn swatch-btn active' : 'chip-btn swatch-btn'}
                  onClick={() => setParams((p) => ({ ...p, material: m }))}
                >
                  <i className={`swatch-dot swatch-${m}`} />
                  {m === 'blanco' ? 'Blanco' : m === 'roble' ? 'Roble' : 'Grafito'}
                </button>
              ))}
            </div>
            <div className="slider-row">
              <div className="slider-head">
                <label>Separar piezas (Explotada)</label>
                <strong>{Math.round(explodeFactor * 100)}%</strong>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={explodeFactor}
                onChange={(e) => setExplodeFactor(Number(e.target.value))}
              />
            </div>
          </div>

          <details className="control-group advanced-drawer">
            <summary>Ajustes de Taller y Sierra (Opcional)</summary>
            <div className="advanced-drawer-body">
              <label className="small-note">
                Formato de plancha:
                <select
                  className="select-input"
                  value={sheetStandard}
                  onChange={(e) => handleSheetStandardChange(e.target.value as SheetStandard)}
                >
                  <option value="pauta">Estándar Pauta (2440×1220 mm)</option>
                  <option value="chile">Chile (2500×1830 + Durolac 2440×1520)</option>
                </select>
              </label>

              <label className="small-note">
                Encuentro en esquinas:
                <select
                  className="select-input"
                  value={params.cornerJointType}
                  onChange={(e) =>
                    setParams((p) => ({
                      ...p,
                      cornerJointType: e.target.value as ScaleAndBoardParams['cornerJointType'],
                    }))
                  }
                >
                  <option value="topOverSides">Cubierta sobre laterales (topOverSides)</option>
                  <option value="topBetweenSides">Cubierta entre laterales (topBetweenSides)</option>
                </select>
              </label>

              <label className="small-note">
                Tapacanto:
                <select
                  className="select-input"
                  value={params.edgeBandingMode}
                  onChange={(e) =>
                    setParams((p) => ({
                      ...p,
                      edgeBandingMode: e.target.value as ScaleAndBoardParams['edgeBandingMode'],
                    }))
                  }
                >
                  <option value="visibleEdgesOnly">Solo cantos vistos</option>
                  <option value="fullPerimeter">Perímetro completo</option>
                </select>
              </label>

              <label className="small-note">
                Estrategia de corte 2D:
                <select
                  className="select-input"
                  value={params.packingStrategy ?? 'guillotine'}
                  onChange={(e) =>
                    setParams((p) => ({
                      ...p,
                      packingStrategy: e.target.value as 'guillotine' | 'maxrects',
                    }))
                  }
                >
                  <option value="guillotine">Guillotina 2 etapas (Taller)</option>
                  <option value="maxrects">MaxRects BSSF (CNC)</option>
                </select>
              </label>

              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={params.respectGrain}
                  onChange={(e) => setParams((p) => ({ ...p, respectGrain: e.target.checked }))}
                />
                Respetar sentido de veta (bloquea 90°)
              </label>

              <div className="chip-row">
                <label className="small-note">
                  Kerf (mm):
                  <select
                    value={params.kerf}
                    onChange={(e) => setParams((p) => ({ ...p, kerf: Number(e.target.value) }))}
                    style={{ marginLeft: 4 }}
                  >
                    <option value={3.2}>3.2</option>
                    <option value={3.5}>3.5</option>
                    <option value={4}>4.0</option>
                  </select>
                </label>
                <label className="small-note">
                  Trim (mm):
                  <select
                    value={params.trimMm ?? 0}
                    onChange={(e) => setParams((p) => ({ ...p, trimMm: Number(e.target.value) }))}
                    style={{ marginLeft: 4 }}
                  >
                    <option value={0}>0</option>
                    <option value={10}>10</option>
                    <option value={15}>15</option>
                  </select>
                </label>
              </div>
            </div>
          </details>
        </aside>

        {/* ESCENARIO CENTRAL (siempre arriba en móvil; VectorCanvas permanece montado) */}
        <main className="main-stage">
          <div className={activeStep === 'split' ? 'split-stage' : ''}>
            <div className={activeStep === '3d' || activeStep === 'blueprint' ? 'hidden-panel' : ''}>
              <VectorCanvas
                topology={topology}
                params={params}
                despiece={despiece}
                externalPhotoUrl={externalPhotoUrl}
                externalPhotoLabel={externalPhotoLabel}
                onUpdateTopology={(next) => {
                  setActivePreset(null);
                  setModelApproved(false);
                  setTopology(next);
                }}
                onUpdateFrontZones={handleUpdateFrontZones}
                onApplyCalibratedDims={(dims) => {
                  if (dims.y > 0) {
                    setLockedRatioXY(dims.x / dims.y);
                  }
                  setModelApproved(false);
                  setParams((p) => ({
                    ...p,
                    referenceDimensions: { ...dims },
                    targetDimensions: { ...dims },
                  }));
                }}
                onAutoPhotoReconstructed={handleAutoPhotoReconstructed}
                onToggleExternalLegs={handleToggleExternalLegs}
                onSelectDepthMm={(z) => updateTargetDim('z', z)}
              />
            </div>

            {(activeStep === 'split' || activeStep === '3d') && (
              <Viewer3D
                despiece={despiece}
                topology={topology}
                params={params}
                explodeFactor={explodeFactor}
                onAddCenterDivider={() => {
                  if (!hasCenterDivider) handleToggleCenterDivider();
                }}
              />
            )}
          </div>

          {activeStep === 'blueprint' && (
            <VectorBlueprintPanel
              topology={topology}
              params={params}
              despiece={despiece}
              cuttingPlan={cuttingPlan}
              modelApproved={modelApproved}
              onUpdateDim={updateTargetDim}
              onUpdateFrontZones={handleUpdateFrontZones}
              onApproveModel={() => {
                setModelApproved(true);
                setActiveStep('3d');
              }}
            />
          )}

          <MathPanel
            despiece={despiece}
            cuttingPlan={cuttingPlan}
            topology={topology}
            params={params}
            onFixReferenceV0={() =>
              setParams((p) => ({
                ...p,
                referenceDimensions: { ...p.targetDimensions },
              }))
            }
            onAddCenterDivider={() => {
              if (!hasCenterDivider) handleToggleCenterDivider();
            }}
            onAddHardwareItem={handleAddHardwareItem}
            onRemoveHardwareItem={handleRemoveHardwareItem}
          />
        </main>
      </div>
    </div>
  );
}
