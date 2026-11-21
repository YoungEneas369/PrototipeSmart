/**
 * SMARTFURNITURE — PANEL MATEMÁTICO (UNIDAD 3), HERRAJES Y PLANO DE CORTE 2D (v3.1 UX)
 * - Tipografía matemática con subíndices reales para grabación de video.
 * - Badge visual destacado en pestaña Alertas, toast de confirmación en descargas/acciones
 *   y zoom + leyenda de colores en plano de corte SVG.
 */
import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Grid,
  Layers,
  Sigma,
  Wrench,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  CuttingPlanResult,
  DespieceResult,
  FurnitureTopology,
  HardwareCategory,
  HardwareItem,
  ScaleAndBoardParams,
} from '../../types/contracts';
import {
  ETAPA2_BASE_MATRIX_M0,
  analyzeShelvesDeflectionDIN,
  compareShapeAspect,
  computeUnitDirectionVector,
  scaleBaseMatrix,
} from '../../core/mathEngine';
import {
  estimateProjectBomAndCost,
  formatClp,
  generateDespieceCsv,
  generateExcelSpreadsheetML,
} from '../../core/cuttingStock';
import { NumericInput } from '../NumericInput';

interface MathPanelProps {
  despiece: DespieceResult;
  cuttingPlan: CuttingPlanResult;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  onFixReferenceV0: () => void;
  onAddCenterDivider: () => void;
  onAddHardwareItem: (item: HardwareItem) => void;
  onRemoveHardwareItem: (id: string) => void;
}

type PanelTab = 'unidad3' | 'alertas' | 'matrices' | 'herrajes' | 'corte';

function triggerDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function MathPanel({
  despiece,
  cuttingPlan,
  topology,
  params,
  onFixReferenceV0,
  onAddCenterDivider,
  onAddHardwareItem,
  onRemoveHardwareItem,
}: MathPanelProps) {
  const [tab, setTab] = useState<PanelTab>('unidad3');
  const [matrixOverride, setMatrixOverride] = useState<'auto' | 'nx3' | 'nx5'>('auto');
  const [svgZoom, setSvgZoom] = useState<number>(100);
  const [toast, setToast] = useState<string | null>(null);
  const [hwCategory, setHwCategory] = useState<HardwareCategory>('tiradores');
  const [hwDesc, setHwDesc] = useState('Tirador metálico 128 mm');
  const [hwQty, setHwQty] = useState(2);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (msg: string) => setToast(msg);

  const etapa2Demo = scaleBaseMatrix(ETAPA2_BASE_MATRIX_M0, 1.2, 1.2);
  const { kx, ky, kz } = despiece.scaleFactors;
  const prog = despiece.shelfProgression;
  const unitVec = computeUnitDirectionVector(params.targetDimensions);
  const shapeComp = compareShapeAspect(
    topology.aspectRatioXY,
    params.targetDimensions.x,
    params.targetDimensions.y,
  );
  const dinReports = analyzeShelvesDeflectionDIN(despiece.matrizDespiece, 25);
  const bomCost = estimateProjectBomAndCost(despiece, cuttingPlan, params);
  const melamineAreaM2 = Math.max(0, despiece.totalNetAreaM2 - despiece.backPanelAreaM2);
  const hasThinPanels =
    topology.hasBackPanel || despiece.matrizDespiece.some((p) => p.espesor < 10);
  const activeMatrixView: 'nx3' | 'nx5' =
    matrixOverride === 'auto' ? (hasThinPanels ? 'nx5' : 'nx3') : matrixOverride;
  const hasCriticalAlert = despiece.alerts.some((a) => a.severidad === 'critical');

  const handleFixV0 = () => {
    onFixReferenceV0();
    showToast(
      `V₀ fijado en (${params.targetDimensions.x}, ${params.targetDimensions.y}, ${params.targetDimensions.z}) mm — mueve X/Y/Z para ver k.`,
    );
  };

  const handleExportExcel = () => {
    const xls = generateExcelSpreadsheetML(despiece, cuttingPlan, params);
    const filename = `smartfurniture_despiece_${params.targetDimensions.x}x${params.targetDimensions.y}.xls`;
    triggerDownload(filename, xls, 'application/vnd.ms-excel;charset=utf-8');
    showToast(`Descargado ${filename} (3 hojas offline)`);
  };

  const handleExportCsv = () => {
    const csv = generateDespieceCsv(despiece, ';');
    const filename = `smartfurniture_despiece_${params.targetDimensions.x}x${params.targetDimensions.y}.csv`;
    triggerDownload(filename, csv, 'text/csv;charset=utf-8');
    showToast(`Descargado ${filename} (BOM UTF-8 + ;)`);
  };

  const handleExportSvg = () => {
    const filename = `smartfurniture_corte_${params.targetDimensions.x}x${params.targetDimensions.y}.svg`;
    triggerDownload(filename, cuttingPlan.svgMarkup, 'image/svg+xml;charset=utf-8');
    showToast(`Descargado plano vectorial ${filename}`);
  };

  const handleAddHw = () => {
    if (!hwDesc.trim()) return;
    onAddHardwareItem({
      id: `hw_manual_${Date.now()}`,
      categoria: hwCategory,
      descripcion: hwDesc.trim(),
      cantidad: Math.max(1, hwQty),
      notaCompra: 'Accesorio ajeno a melamina — adquirir en ferretería aparte.',
      origen: 'manual',
    });
    showToast(`Herraje agregado: ${hwDesc.trim()} × ${hwQty}`);
    setHwDesc('');
  };

  return (
    <div className="math-panel">
      {toast && (
        <div className="toast-banner" role="status" aria-live="polite">
          <CheckCircle2 size={15} /> {toast}
        </div>
      )}

      <div className="panel-tabs">
        <button
          type="button"
          className={tab === 'unidad3' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('unidad3')}
        >
          <Sigma size={15} /> Unidad 3
        </button>
        <button
          type="button"
          className={[
            'tab-btn',
            tab === 'alertas' ? 'active' : '',
            despiece.alerts.length > 0
              ? hasCriticalAlert
                ? 'tab-alert-critical'
                : 'tab-alert-warning'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setTab('alertas')}
        >
          <AlertTriangle size={15} /> Alertas
          {despiece.alerts.length > 0 && (
            <span className="tab-count-pill">{despiece.alerts.length}</span>
          )}
        </button>
        <button
          type="button"
          className={tab === 'matrices' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('matrices')}
        >
          <Grid size={15} /> Matrices n×3/n×5
        </button>
        <button
          type="button"
          className={tab === 'herrajes' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('herrajes')}
        >
          <Wrench size={15} /> Herrajes ({despiece.hardwareSummary.length})
        </button>
        <button
          type="button"
          className={tab === 'corte' ? 'tab-btn active' : 'tab-btn'}
          onClick={() => setTab('corte')}
        >
          <Layers size={15} /> Corte 2D ({cuttingPlan.totalSheetsCount})
        </button>
      </div>

      <div className="panel-body">
        {tab === 'unidad3' && (
          <div className="tab-section">
            <div className="metric-card">
              <div className="card-header-row">
                <h4>1. Vectores en ℝ³ y Escalamiento (e = {params.boardThickness} mm invariante)</h4>
                <button type="button" className="btn-small" onClick={handleFixV0}>
                  Fijar V<sub>0</sub> actual
                </button>
              </div>
              <p className="math-eq">
                V<sub>0</sub> = ({params.referenceDimensions.x}, {params.referenceDimensions.y},{' '}
                {params.referenceDimensions.z}) mm
              </p>
              <p className="math-eq">
                V<sub>f</sub> = ({params.targetDimensions.x}, {params.targetDimensions.y},{' '}
                {params.targetDimensions.z}) mm
              </p>
              <p className="math-eq accent">
                k = (k<sub>x</sub> = {kx.toFixed(3)}, k<sub>y</sub> = {ky.toFixed(3)}, k
                <sub>z</sub> = {kz.toFixed(3)}) · Espesor e = {params.boardThickness} mm constante
              </p>
              <p className="math-eq">
                û<sub>V</sub> = V<sub>f</sub> / ‖V<sub>f</sub>‖ = (
                {unitVec.unit3D.map((v) => v.toFixed(4)).join(', ')}) · ‖V<sub>f</sub>‖ ={' '}
                {unitVec.magnitudeMm.toFixed(1)} mm · ‖û<sub>V</sub>‖ = 1.000
              </p>
              <p className="muted small-note">
                Invarianza de forma: escalar por k·V conserva û<sub>V</sub> y r = W/H ={' '}
                {unitVec.aspectRatioXY.toFixed(3)}, mientras las piezas interiores usan
                transformación afín (W<sub>int</sub> = k·W<sub>0</sub> − 2e) por e ={' '}
                {params.boardThickness} mm constante.
                {shapeComp?.warn && (
                  <>
                    {' '}
                    <strong>
                      Deformación vs foto: {(shapeComp.deformationFactor * 100).toFixed(0)}%.
                    </strong>
                  </>
                )}
              </p>
            </div>

            <div className="metric-card">
              <h4>2. Progresión Aritmética de Repisas ({topology.shelfMode})</h4>
              {topology.shelfMode === 'equidistant' && prog.count > 0 ? (
                <>
                  <p className="math-eq">
                    H<sub>int</sub> = {prog.hInteriorMm.toFixed(1)} mm · s<sub>libre</sub> ={' '}
                    {prog.clearSpanMm.toFixed(2)} mm
                  </p>
                  <p className="math-eq">
                    a<sub>1</sub> = {prog.a1.toFixed(2)} mm · d = {prog.d.toFixed(2)} mm
                  </p>
                  <p className="math-eq">
                    a<sub>n</sub> = [{prog.terms.map((t) => t.toFixed(1)).join(', ')}] mm
                  </p>
                </>
              ) : (
                <p className="muted small-note">
                  Modo personalizado (<code>custom</code>): {topology.hShelves.length} repisas definidas en espacio interior [0, 1]².
                </p>
              )}
            </div>

            <div className="metric-card">
              <h4>3. Sumatorias de Materiales y Validación Etapa 2</h4>
              <div className="kpi-grid">
                <div>
                  <span className="kpi-label">Melamina 18 mm</span>
                  <strong>{melamineAreaM2.toFixed(4)} m²</strong>
                </div>
                <div>
                  <span className="kpi-label">Fondo 3 mm</span>
                  <strong>{despiece.backPanelAreaM2.toFixed(4)} m²</strong>
                </div>
                <div>
                  <span className="kpi-label">Área Neta Total</span>
                  <strong>{despiece.totalNetAreaM2.toFixed(4)} m²</strong>
                </div>
                <div>
                  <span className="kpi-label">
                    Tapacanto ({params.edgeBandingMode === 'fullPerimeter' ? 'Perímetro' : 'Vistos'})
                  </span>
                  <strong>{despiece.totalEdgeBandingMeters.toFixed(2)} m</strong>
                </div>
              </div>
              <p className="muted small-note">
                Validación matricial Etapa 2 (M = M<sub>0</sub> · diag(1.2, 1.2, 1)):{' '}
                {etapa2Demo.originalAreaM2.toFixed(4)} → {etapa2Demo.scaledAreaM2.toFixed(4)} m² · Tapacanto{' '}
                {etapa2Demo.originalEdgeBandingMeters.toFixed(2)} →{' '}
                {etapa2Demo.scaledEdgeBandingMeters.toFixed(2)} m.
              </p>
            </div>

            {topology.homographyMatrix && (
              <div className="metric-card">
                <h4>4. Matriz de Homografía Proyectiva H (3×3)</h4>
                <pre className="matrix-pre">
                  {topology.homographyMatrix
                    .map((row) => `[ ${row.map((v) => v.toFixed(4).padStart(9)).join('  ')} ]`)
                    .join('\n')}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === 'alertas' && (
          <div className="tab-section">
            {despiece.alerts.length === 0 ? (
              <div className="ok-box">
                Todas las piezas cumplen luz libre estructural (≤ 850 mm) y dimensiones válidas.
              </div>
            ) : (
              <>
                {despiece.alerts.map((al) => (
                  <div
                    key={al.id}
                    className={al.severidad === 'critical' ? 'alert-box critical' : 'alert-box warning'}
                  >
                    <strong>
                      [{al.severidad.toUpperCase()}] {al.tipo}
                    </strong>
                    <p>{al.mensaje}</p>
                  </div>
                ))}
                {despiece.alerts.some((a) => a.tipo === 'pandeo') && (
                  <button type="button" className="btn-primary" onClick={onAddCenterDivider}>
                    Solucionar ahora: Agregar divisor vertical central (u = 0.5)
                  </button>
                )}
              </>
            )}

            <div className="metric-card">
              <h4>Rigidez Estructural de Repisas — Norma DIN 68874-1 (Euler-Bernoulli, 25 kg)</h4>
              <p className="math-eq small-note">
                δ = (5 · P · L³) / (384 · E · I) · E = 2700 N/mm² (MDP) · Límite admisible L / 200
              </p>
              {dinReports.length === 0 ? (
                <p className="muted small-note">Este mueble no tiene repisas horizontales suspendidas.</p>
              ) : (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Repisa</th>
                        <th>Luz L (mm)</th>
                        <th>Flecha δ (mm)</th>
                        <th>Límite L/200</th>
                        <th>Carga Máx.</th>
                        <th>Estado DIN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dinReports.map((r) => (
                        <tr key={r.id}>
                          <td>{r.nombre}</td>
                          <td className="num">{r.spanMm.toFixed(1)}</td>
                          <td className="num">{r.deflectionMm.toFixed(2)}</td>
                          <td className="num">{r.allowableMm.toFixed(2)}</td>
                          <td className="num">{r.maxLoadKg.toFixed(1)} kg</td>
                          <td>
                            <span
                              className={
                                r.status === 'Pandeo Severo'
                                  ? 'din-pill bad'
                                  : r.status === 'Al Límite'
                                    ? 'din-pill warn'
                                    : 'din-pill ok'
                              }
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'matrices' && (
          <div className="tab-section">
            <div className="export-bar">
              <button type="button" className="btn-primary" onClick={handleExportExcel}>
                <FileSpreadsheet size={15} /> Exportar Excel (.xls · 3 Hojas)
              </button>
              <button type="button" className="btn-secondary" onClick={handleExportCsv}>
                <Download size={15} /> Exportar CSV (Excel Chile)
              </button>
            </div>
            <div className="card-header-row">
              <p className="muted small-note">
                Matriz activa:{' '}
                <strong>
                  {activeMatrixView === 'nx5'
                    ? `Extendida n × 5 (${despiece.consolidatedRows.length} × 5 · incluye Cantidad y Material)`
                    : `Base n × 3 (${despiece.matrixNx3.length} × 3 · Melamina 18 mm)`}
                </strong>
              </p>
              <div className="chip-row">
                <button
                  type="button"
                  className={matrixOverride === 'auto' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setMatrixOverride('auto')}
                >
                  Auto ({topology.hasBackPanel ? 'n×5' : 'n×3'})
                </button>
                <button
                  type="button"
                  className={matrixOverride === 'nx3' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setMatrixOverride('nx3')}
                >
                  Ver n×3
                </button>
                <button
                  type="button"
                  className={matrixOverride === 'nx5' ? 'chip-btn active' : 'chip-btn'}
                  onClick={() => setMatrixOverride('nx5')}
                >
                  Ver n×5
                </button>
              </div>
            </div>
            <div className="table-scroll">
              {activeMatrixView === 'nx3' ? (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Placa física (18 mm)</th>
                      <th>Ancho Veta (mm)</th>
                      <th>Alto / Prof (mm)</th>
                      <th>Espesor (mm)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {despiece.matrizDespiece
                      .filter((p) => p.tipo !== 'fondo' && p.tipo !== 'fondo_cajon')
                      .map((p) => (
                        <tr key={p.id}>
                          <td>{p.nombre}</td>
                          <td className="num">{p.ancho.toFixed(1)}</td>
                          <td className="num">{p.alto.toFixed(1)}</td>
                          <td className="num">{p.espesor}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Pieza consolidada</th>
                      <th>Ancho Veta (mm)</th>
                      <th>Alto / Prof (mm)</th>
                      <th>Esp.</th>
                      <th>Cant.</th>
                      <th>Material</th>
                    </tr>
                  </thead>
                  <tbody>
                    {despiece.consolidatedRows.map((row, idx) => (
                      <tr key={`${row.nombre}_${idx}`}>
                        <td>{row.nombre}</td>
                        <td className="num">{row.ancho.toFixed(1)}</td>
                        <td className="num">{row.alto.toFixed(1)}</td>
                        <td className="num">{row.espesor}</td>
                        <td className="num">{row.cantidad}</td>
                        <td>{row.material}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {tab === 'herrajes' && (
          <div className="tab-section">
            <p className="muted small-note">
              Elementos distintos a la melamina (patas independientes, tiradores, bisagras). Se aíslan del cálculo estructural del cuerpo y se exportan en su propia hoja de Excel.
            </p>
            {despiece.hardwareSummary.length === 0 ? (
              <div className="empty-box">No hay patas externas ni tiradores registrados para este mueble.</div>
            ) : (
              <div className="hw-list">
                {despiece.hardwareSummary.map((hw) => (
                  <div key={hw.id} className="hw-card">
                    <div>
                      <strong>
                        [{hw.categoria.toUpperCase()}] {hw.descripcion} × {hw.cantidad}
                      </strong>
                      <p className="muted small-note">{hw.notaCompra}</p>
                    </div>
                    {hw.id !== 'hw_patas_externas' &&
                      hw.id !== 'hw_ruedas_externas' &&
                      !hw.id.endsWith('_calc') && (
                      <button
                        type="button"
                        className="btn-danger-sm"
                        onClick={() => onRemoveHardwareItem(hw.id)}
                      >
                        Quitar
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="hw-form">
              <select
                value={hwCategory}
                onChange={(e) => setHwCategory(e.target.value as HardwareCategory)}
              >
                <option value="tiradores">Tiradores / Manillas</option>
                <option value="patas">Patas adicionales</option>
                <option value="bisagras">Bisagras</option>
                <option value="correderas">Correderas</option>
                <option value="otro">Otro herraje</option>
              </select>
              <input
                type="text"
                value={hwDesc}
                onChange={(e) => setHwDesc(e.target.value)}
                placeholder="Ej. Tirador metálico 128 mm"
              />
              <NumericInput
                min={1}
                max={50}
                value={hwQty}
                onCommit={setHwQty}
                style={{ width: 64 }}
                ariaLabel="Cantidad de herraje"
              />
              <button type="button" className="btn-small" onClick={handleAddHw} disabled={!hwDesc.trim()}>
                + Agregar
              </button>
            </div>

            <div className="metric-card">
              <div className="card-header-row">
                <h4>Quincallería Automática (BOM) &amp; Presupuesto Referencial CLP</h4>
                <span className="bom-total-pill">{formatClp(bomCost.totalClp)}</span>
              </div>
              <div className="kpi-grid">
                <div>
                  <span className="kpi-label">Melamina ({cuttingPlan.melamineSheetsCount} pl.)</span>
                  <strong>{formatClp(bomCost.melamineSheetsClp)}</strong>
                </div>
                <div>
                  <span className="kpi-label">Fondo 3 mm ({cuttingPlan.backPanelSheetsCount} pl.)</span>
                  <strong>{formatClp(bomCost.backPanelSheetsClp)}</strong>
                </div>
                <div>
                  <span className="kpi-label">Tapacanto ({bomCost.edgeBandingMetersWithAllowance} m)</span>
                  <strong>{formatClp(bomCost.edgeBandingClp)}</strong>
                </div>
                <div>
                  <span className="kpi-label">Fijaciones + Herrajes</span>
                  <strong>{formatClp(bomCost.fastenersClp + bomCost.externalHardwareClp)}</strong>
                </div>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Insumo calculado (BOM)</th>
                      <th>Cant.</th>
                      <th>Precio Ref.</th>
                      <th>Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bomCost.fasteners.map((it) => (
                      <tr key={it.id}>
                        <td>{it.nombre}</td>
                        <td className="num">
                          {it.cantidad} {it.unidad}
                        </td>
                        <td className="num">{formatClp(it.costoUnitarioClp)}</td>
                        <td className="num">{formatClp(it.subtotalClp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small-note">
                Estimación 100 % offline basada en precios referenciales de mercado chileno (plancha, tapacanto +10 % holgura y fijaciones).
              </p>
            </div>
          </div>
        )}

        {tab === 'corte' && (
          <div className="tab-section">
            <div className="kpi-grid">
              <div>
                <span className="kpi-label">Melamina 18 mm</span>
                <strong>{cuttingPlan.melamineSheetsCount} plancha(s)</strong>
              </div>
              <div>
                <span className="kpi-label">Fondo 3 mm</span>
                <strong>{cuttingPlan.backPanelSheetsCount} plancha(s)</strong>
              </div>
              <div>
                <span className="kpi-label">Aprovechamiento</span>
                <strong>{cuttingPlan.usagePercentage.toFixed(1)}%</strong>
              </div>
              <div>
                <span className="kpi-label">Desperdicio</span>
                <strong>{cuttingPlan.wastePercentage.toFixed(1)}%</strong>
              </div>
            </div>

            {cuttingPlan.unplacedPieces.length > 0 && (
              <div className="alert-box critical">
                <strong>Piezas sobredimensionadas ({cuttingPlan.unplacedPieces.length}):</strong>{' '}
                {cuttingPlan.unplacedPieces.map((p) => `${p.nombre} (${p.ancho}×${p.alto})`).join(', ')}
              </div>
            )}

            <div className="card-header-row">
              <div className="export-bar">
                <button type="button" className="btn-primary" onClick={handleExportSvg}>
                  <Download size={15} /> Descargar Plano SVG
                </button>
                <button type="button" className="btn-secondary" onClick={handleExportExcel}>
                  <FileSpreadsheet size={15} /> Exportar Excel (.xls)
                </button>
              </div>
              <div className="chip-row">
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setSvgZoom((z) => Math.max(60, z - 20))}
                  title="Alejar plano"
                >
                  <ZoomOut size={13} />
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setSvgZoom(100)}
                  title="Restablecer zoom"
                >
                  {svgZoom}%
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  onClick={() => setSvgZoom((z) => Math.min(200, z + 20))}
                  title="Acercar plano"
                >
                  <ZoomIn size={13} />
                </button>
              </div>
            </div>

            <div className="svg-legend">
              <span><i style={{ background: '#dcfce7', borderColor: '#15803d' }} /> Cubierta / Base</span>
              <span><i style={{ background: '#dbeafe', borderColor: '#1d4ed8' }} /> Laterales</span>
              <span><i style={{ background: '#ede9fe', borderColor: '#6d28d9' }} /> Divisores</span>
              <span><i style={{ background: '#e0f2fe', borderColor: '#0369a1' }} /> Repisas</span>
              <span><i style={{ background: '#fce7f3', borderColor: '#be185d' }} /> Puertas</span>
              <span><i style={{ background: '#ffedd5', borderColor: '#c2410c' }} /> Cajones</span>
              <span><i style={{ background: '#fef3c7', borderColor: '#b45309' }} /> Fondo 3 mm</span>
            </div>

            <div className="svg-preview">
              <div
                style={{ width: `${svgZoom}%`, minWidth: '100%' }}
                dangerouslySetInnerHTML={{ __html: cuttingPlan.svgMarkup }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
