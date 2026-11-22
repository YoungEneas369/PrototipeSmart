/**
 * SMARTFURNITURE v8.0 — BARRAS DE HERRAMIENTAS DE VECTORCANVAS (`CanvasToolbars`)
 * Encapsula estrictamente las 2 barras sobre la foto + avisos contextuales + barra de métricas:
 *  - `CanvasTopBars`: Barra 1 (Stepper 3 pasos + Undo/Redo + Zoom/Pan + Subir foto) +
 *                     Barra 2 (únicamente herramientas del paso activo o banner de subherramienta).
 *  - `CanvasMetricsStrip`: Contorno %, 3D vs Foto %, capas visuales y vista previa Rectificada.
 */
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BoxSelect,
  Camera,
  CheckCircle2,
  Contrast,
  Crop,
  Eye,
  GitBranch,
  Hand,
  LayoutGrid,
  Magnet,
  Maximize2,
  MousePointer2,
  PenTool,
  Pipette,
  Redo2,
  RotateCcw,
  Scan,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Point2D } from '../../types/contracts';
import type {
  CameraPoseEstimate,
  MarginEvaluationResult,
  UserStrokeMode,
  Visual3DSimilarityResult,
} from '../../core/vision';
import {
  CORNER_STEP_NAMES,
  scoreToneClass,
  type FrameMode,
  type LinesSubMode,
  type SelectedSubRegion,
  type SubTool,
  type TraceStep,
  type VisualLayerMode,
} from './geometryHelpers';

export interface CanvasTopBarsProps {
  hasPhoto: boolean;
  viewTab: 'frontal' | 'lateral';
  traceStep: TraceStep;
  frameMode: FrameMode;
  pickingCorners: Point2D[] | null;
  linesSubMode: LinesSubMode;
  strokeMode: UserStrokeMode;
  subTool: SubTool;
  magneticSnap: boolean;
  calibRefMm: number;
  calibPtsCount: number;
  internalLineCount: number;
  zonesCount: number;
  hasSelectedLine: boolean;
  subRegions: SelectedSubRegion[];
  xIntMm: number;
  yIntMm: number;
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
  zoom: number;
  panToolActive: boolean;
  isSpacePan: boolean;
  legHintDetected: boolean;
  hasExternalLegs: boolean;
  isCatalogReference: boolean;
  ranRealVisionOnCatalog: boolean;
  externalPhotoLabel?: string | null;
  onSelectStep: (step: TraceStep) => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onTogglePanTool: () => void;
  onUploadFrontPhoto: () => void;
  onUploadSidePhoto: () => void;
  onReturnToFrontal: () => void;
  onApplyCalibA4: () => void;
  onExitSubTool: () => void;
  onToggleSubTool: (tool: SubTool) => void;
  onToggleFrameMode: (mode: FrameMode) => void;
  onStartPickCorners: () => void;
  onUndoPickCorner: () => void;
  onCancelPickCorners: () => void;
  onToggleMagneticSnap: () => void;
  onAutoContour: () => void;
  onClearLines: () => void;
  onDeleteSelectedLine: () => void;
  onChangeLinesSubMode: (mode: LinesSubMode) => void;
  onOpenRegionsMode: () => void;
  onRemoveSubRegion: (id: string) => void;
  onClearSubRegions: () => void;
  onDetectSubRegions: () => void;
  onChangeStrokeMode: (mode: UserStrokeMode) => void;
  onAutoSuggestLines: () => void;
  onActivateExternalLegs?: () => void;
  onRunRealVisionOnCatalog: () => void;
}

export function CanvasTopBars({
  hasPhoto,
  viewTab,
  traceStep,
  frameMode,
  pickingCorners,
  linesSubMode,
  strokeMode,
  subTool,
  magneticSnap,
  calibRefMm,
  calibPtsCount,
  internalLineCount,
  zonesCount,
  hasSelectedLine,
  subRegions,
  xIntMm,
  yIntMm,
  canUndo,
  canRedo,
  undoCount,
  redoCount,
  zoom,
  panToolActive,
  isSpacePan,
  legHintDetected,
  hasExternalLegs,
  isCatalogReference,
  ranRealVisionOnCatalog,
  externalPhotoLabel,
  onSelectStep,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onTogglePanTool,
  onUploadFrontPhoto,
  onUploadSidePhoto,
  onReturnToFrontal,
  onApplyCalibA4,
  onExitSubTool,
  onToggleSubTool,
  onToggleFrameMode,
  onStartPickCorners,
  onUndoPickCorner,
  onCancelPickCorners,
  onToggleMagneticSnap,
  onAutoContour,
  onClearLines,
  onDeleteSelectedLine,
  onChangeLinesSubMode,
  onOpenRegionsMode,
  onRemoveSubRegion,
  onClearSubRegions,
  onDetectSubRegions,
  onChangeStrokeMode,
  onAutoSuggestLines,
  onActivateExternalLegs,
  onRunRealVisionOnCatalog,
}: CanvasTopBarsProps) {
  const effectiveUndoCount =
    pickingCorners && pickingCorners.length > 0 ? pickingCorners.length : undoCount;
  const canTriggerUndo = canUndo || Boolean(pickingCorners && pickingCorners.length > 0);

  return (
    <>
      {/* BARRA 1 (PRINCIPAL): Stepper 3 pasos + Deshacer/Rehacer claros + Zoom/Pan + Subir foto */}
      <div className="vc-bar vc-bar-primary">
        <div className="vc-stepper" role="tablist" aria-label="Pasos de trazado 2D">
          <button
            type="button"
            role="tab"
            aria-selected={traceStep === 'frame' && subTool === 'none' && viewTab === 'frontal'}
            className={
              traceStep === 'frame' && subTool === 'none' && viewTab === 'frontal'
                ? 'vc-step-btn active'
                : 'vc-step-btn'
            }
            onClick={() => onSelectStep('frame')}
          >
            <Crop size={13} /> <span>1. Contorno</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={traceStep === 'lines' && subTool === 'none' && viewTab === 'frontal'}
            className={
              traceStep === 'lines' && subTool === 'none' && viewTab === 'frontal'
                ? 'vc-step-btn active'
                : 'vc-step-btn'
            }
            onClick={() => onSelectStep('lines')}
          >
            <PenTool size={13} /> <span>2. Líneas ({internalLineCount})</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={traceStep === 'zones' && subTool === 'none' && viewTab === 'frontal'}
            className={
              traceStep === 'zones' && subTool === 'none' && viewTab === 'frontal'
                ? 'vc-step-btn active'
                : 'vc-step-btn'
            }
            onClick={() => onSelectStep('zones')}
          >
            <LayoutGrid size={13} /> <span>3. Partes ({zonesCount})</span>
          </button>
        </div>

        <div className="vc-bar-right">
          <div className="vc-history-group" role="group" aria-label="Historial Deshacer y Rehacer">
            <button
              type="button"
              className={`vc-history-btn vc-undo-btn${canTriggerUndo ? ' is-ready' : ''}`}
              onClick={onUndo}
              disabled={!canTriggerUndo}
              title="Deshacer última acción (Ctrl+Z)"
              aria-label="Deshacer"
            >
              <Undo2 size={13} />
              <span>
                Deshacer{effectiveUndoCount > 0 ? ` (${effectiveUndoCount})` : ''}
              </span>
            </button>
            <button
              type="button"
              className={`vc-history-btn vc-redo-btn${canRedo ? ' is-ready' : ''}`}
              onClick={onRedo}
              disabled={!canRedo}
              title="Rehacer (Ctrl+Y / Ctrl+Shift+Z)"
              aria-label="Rehacer"
            >
              <Redo2 size={13} />
              <span>Rehacer{redoCount > 0 ? ` (${redoCount})` : ''}</span>
            </button>
          </div>

          {hasPhoto && (
            <div className="vc-btn-group" role="group" aria-label="Zoom y desplazamiento">
              <button
                type="button"
                className="vc-icon-text-btn"
                onClick={onZoomOut}
                disabled={zoom <= 0.76}
                title="Alejar (Ctrl+Rueda)"
                aria-label="Alejar"
              >
                <ZoomOut size={13} />
              </button>
              <button
                type="button"
                className="vc-zoom-readout"
                onClick={onZoomReset}
                title="Restablecer zoom al 100%"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="vc-icon-text-btn"
                onClick={onZoomIn}
                disabled={zoom >= 3.99}
                title="Acercar (Ctrl+Rueda)"
                aria-label="Acercar"
              >
                <ZoomIn size={13} />
              </button>
              <button
                type="button"
                className="vc-icon-text-btn"
                onClick={onZoomReset}
                title="Ajustar foto al viewport"
                aria-label="Ajustar vista"
              >
                <Maximize2 size={12} />
              </button>
              <button
                type="button"
                className={panToolActive || isSpacePan ? 'vc-icon-text-btn active' : 'vc-icon-text-btn'}
                onClick={onTogglePanTool}
                title="Herramienta Mano para mover la foto (o mantén Espacio)"
                aria-label="Mover vista (Pan)"
              >
                <Hand size={12} />
              </button>
            </div>
          )}

          <button
            type="button"
            className="vc-btn vc-btn-primary vc-btn-xs"
            onClick={onUploadFrontPhoto}
          >
            <Camera size={13} /> {hasPhoto ? 'Foto' : 'Subir foto'}
          </button>
        </div>
      </div>

      {/* BARRA 2 (CONTEXTUAL ÚNICA AL PASO ACTIVO O BANNER EXPLÍCITO DE SUBHERRAMIENTA) */}
      {hasPhoto && (
        <div
          className={`vc-bar vc-bar-context${
            subTool !== 'none'
              ? ' is-subtool'
              : viewTab === 'lateral'
                ? ' is-lateral'
                : ` step-${traceStep}`
          }`}
        >
          {subTool === 'calibA4' ? (
            <>
              <span className="vc-context-banner-text">
                <span className="vc-pill vc-pill-accent">CALIBRAR A4</span>
                Haz clic en los 2 extremos de tu referencia ({calibRefMm} mm) sobre la foto (
                <strong>{calibPtsCount}/2</strong>).
              </span>
              <div className="vc-context-actions">
                <button
                  type="button"
                  className="vc-btn vc-btn-primary vc-btn-sm"
                  disabled={calibPtsCount !== 2}
                  onClick={onApplyCalibA4}
                >
                  Aplicar A4
                </button>
                <button
                  type="button"
                  className="vc-btn vc-btn-secondary vc-btn-sm"
                  onClick={onExitSubTool}
                >
                  <X size={13} /> Salir (Esc)
                </button>
              </div>
            </>
          ) : subTool === 'eyedropper' ? (
            <>
              <span className="vc-context-banner-text">
                <span className="vc-pill vc-pill-accent">GOTERO COLOR</span>
                Haz clic sobre la superficie de melamina para detectar su acabado sin modificar
                medidas ni trazos.
              </span>
              <div className="vc-context-actions">
                <button
                  type="button"
                  className="vc-btn vc-btn-secondary vc-btn-sm"
                  onClick={onExitSubTool}
                >
                  <X size={13} /> Salir (Esc)
                </button>
              </div>
            </>
          ) : viewTab === 'lateral' ? (
            <>
              <span className="vc-context-banner-text">
                <span className="vc-pill">VISTA LATERAL ZY</span>
                Ajusta el contorno sobre el perfil lateral para estimar profundidad Z.
              </span>
              <div className="vc-context-actions">
                <button type="button" className="vc-chip" onClick={onUploadSidePhoto}>
                  <Camera size={12} /> Cargar foto lateral
                </button>
                <button
                  type="button"
                  className="vc-btn vc-btn-primary vc-btn-sm"
                  onClick={onReturnToFrontal}
                >
                  <ArrowLeft size={13} /> Volver a Frontal XY
                </button>
              </div>
            </>
          ) : traceStep === 'frame' ? (
            pickingCorners !== null ? (
              <>
                <span className="vc-context-banner-text">
                  <span className="vc-pill vc-pill-warn">TOQUE {pickingCorners.length + 1}/4</span>
                  {CORNER_STEP_NAMES[Math.min(3, pickingCorners.length)]} (frente de melamina, sin
                  patas)
                </span>
                <div className="vc-context-actions">
                  <button
                    type="button"
                    className="vc-chip"
                    disabled={pickingCorners.length === 0}
                    onClick={onUndoPickCorner}
                  >
                    <RotateCcw size={12} /> Deshacer toque
                  </button>
                  <button type="button" className="vc-chip" onClick={onCancelPickCorners}>
                    <X size={12} /> Cancelar
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="vc-context-actions">
                  <div className="vc-segmented" role="group" aria-label="Modo de contorno">
                    <button
                      type="button"
                      className={frameMode === 'quad' ? 'active' : ''}
                      onClick={() => onToggleFrameMode('quad')}
                      title="4 esquinas libres con homografía proyectiva H 3×3"
                    >
                      4 Esquinas (3/4)
                    </button>
                    <button
                      type="button"
                      className={frameMode === 'box' ? 'active' : ''}
                      onClick={() => onToggleFrameMode('box')}
                      title="Rectángulo rápido para fotos frontales"
                    >
                      Marco recto
                    </button>
                  </div>
                  <button type="button" className="vc-chip" onClick={onStartPickCorners}>
                    Tocar 4 esquinas (1→4)
                  </button>
                  <button
                    type="button"
                    className={magneticSnap ? 'vc-chip active' : 'vc-chip'}
                    onClick={onToggleMagneticSnap}
                    title="Imán Sobel a bordes reales (mantén Alt para soltar temporalmente)"
                  >
                    <Magnet size={12} /> Imán {magneticSnap ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    className="vc-chip"
                    onClick={onAutoContour}
                    title="Re-detectar el contorno exterior desde la foto completa conservando tus líneas internas"
                  >
                    <Scan size={12} /> Auto-contorno exterior
                  </button>
                  <button
                    type="button"
                    className="vc-chip"
                    disabled={internalLineCount === 0}
                    onClick={onClearLines}
                    title="Limpia solo las líneas internas para comenzar de cero (con Undo)"
                  >
                    <Trash2 size={12} /> Limpiar líneas
                  </button>
                </div>
                <button
                  type="button"
                  className="vc-btn vc-btn-primary vc-btn-xs"
                  onClick={() => onSelectStep('lines')}
                >
                  2. Líneas <ArrowRight size={12} />
                </button>
              </>
            )
          ) : traceStep === 'lines' ? (
            <>
              <div className="vc-context-actions">
                <div className="vc-segmented" role="group" aria-label="Modo de edición y trazado">
                  <button
                    type="button"
                    className={linesSubMode === 'smart' ? 'active' : ''}
                    onClick={() => onChangeLinesSubMode('smart')}
                    title="Haz clic o arrastra una línea existente para moverla/ajustarla; arrastra en espacio libre para trazar una nueva"
                  >
                    <MousePointer2 size={11} /> Editar / Trazar
                  </button>
                  <button
                    type="button"
                    className={linesSubMode === 'draw_only' ? 'active' : ''}
                    onClick={() => onChangeLinesSubMode('draw_only')}
                    title="Fuerza trazado de línea nueva incluso sobre zonas muy apretadas"
                  >
                    <PenTool size={11} /> + Solo trazar
                  </button>
                  <button
                    type="button"
                    className={linesSubMode === 'regions' ? 'active vc-tab-regions' : ''}
                    onClick={() => onChangeLinesSubMode('regions')}
                    title="Marca 1 o varias secciones dentro del contorno para auto-detectar líneas solo en ellas"
                  >
                    <BoxSelect size={11} /> Secciones auto
                    {subRegions.length > 0 ? ` (${subRegions.length})` : ''}
                  </button>
                </div>

                {linesSubMode !== 'regions' && (
                  <div className="vc-segmented vc-segmented-soft" role="group" aria-label="Tipo de trazo">
                    <button
                      type="button"
                      className={strokeMode === 'auto' ? 'active' : ''}
                      onClick={() => onChangeStrokeMode('auto')}
                      title="Guía recta suave ≤ 7° o diagonal limpia > 18°"
                    >
                      Auto
                    </button>
                    <button
                      type="button"
                      className={strokeMode === 'ortho' ? 'active' : ''}
                      onClick={() => onChangeStrokeMode('ortho')}
                      title="Solo divisores verticales y repisas horizontales"
                    >
                      Recta
                    </button>
                    <button
                      type="button"
                      className={strokeMode === 'diagonal' ? 'active' : ''}
                      onClick={() => onChangeStrokeMode('diagonal')}
                      title="Solo divisiones diagonales / oblicuas"
                    >
                      Diagonal
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  className={magneticSnap ? 'vc-chip active' : 'vc-chip'}
                  onClick={onToggleMagneticSnap}
                  title="Imán suave (≤ 5 px) a bordes de alto contraste (apagado por defecto para trazo 100% fluido)"
                >
                  <Magnet size={11} /> Imán {magneticSnap ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  className="vc-chip"
                  onClick={onAutoSuggestLines}
                  title="Sugiere líneas internas respetando siempre tu contorno actual"
                >
                  <Wand2 size={11} /> Sugerir en contorno
                </button>
                <button
                  type="button"
                  className="vc-chip"
                  onClick={() => onToggleSubTool('eyedropper')}
                  title="Muestrear color de melamina con 1 clic"
                >
                  <Pipette size={11} /> Gotero
                </button>
                {hasSelectedLine && (
                  <button
                    type="button"
                    className="vc-chip vc-chip-danger-soft"
                    onClick={onDeleteSelectedLine}
                    title="Eliminar la línea seleccionada (Supr)"
                  >
                    <X size={11} /> Borrar línea
                  </button>
                )}
                <button
                  type="button"
                  className="vc-chip"
                  disabled={internalLineCount === 0}
                  onClick={onClearLines}
                  title="Limpiar todas las líneas internas (con Undo)"
                >
                  <Trash2 size={11} /> Limpiar
                </button>
              </div>
              <button
                type="button"
                className="vc-btn vc-btn-primary vc-btn-xs"
                onClick={() => onSelectStep('zones')}
              >
                3. Partes <ArrowRight size={12} />
              </button>
            </>
          ) : (
            <>
              <span className="vc-context-banner-text">
                <span className="vc-pill vc-pill-success">PASO 3</span>
                Haz clic en cualquier celda para definir puertas, cajones o bicolor.
              </span>
              <div className="vc-context-actions">
                <button
                  type="button"
                  className="vc-chip vc-chip-regions"
                  onClick={onOpenRegionsMode}
                  title="Marca 1 o varias secciones dentro del contorno para auto-detectar líneas adicionales"
                >
                  <BoxSelect size={11} /> Secciones auto
                </button>
                <button
                  type="button"
                  className="vc-chip"
                  onClick={() => onToggleSubTool('eyedropper')}
                >
                  <Pipette size={11} /> Gotero
                </button>
                <button
                  type="button"
                  className="vc-btn vc-btn-secondary vc-btn-xs"
                  onClick={() => onSelectStep('lines')}
                >
                  <ArrowLeft size={12} /> Líneas
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Barra compacta Multi-Sección (solo visible cuando el modo Secciones está activo o hay secciones marcadas) */}
      {hasPhoto &&
        viewTab === 'frontal' &&
        traceStep === 'lines' &&
        subTool === 'none' &&
        (linesSubMode === 'regions' || subRegions.length > 0) && (
          <div className="vc-regions-bar" role="region" aria-label="Auto-detección multi-sección">
            <div className="vc-regions-list">
              <span className="vc-pill vc-pill-regions">SECCIONES</span>
              {subRegions.length === 0 ? (
                <span className="vc-regions-hint">
                  Arrastra rectángulos sobre las zonas del mueble (o haz clic en celdas) para marcar{' '}
                  <strong>S1, S2, S3…</strong>
                </span>
              ) : (
                subRegions.map((reg, idx) => {
                  const wCm = Math.round(((reg.uEnd - reg.uStart) * xIntMm) / 10);
                  const hCm = Math.round(((reg.vEnd - reg.vStart) * yIntMm) / 10);
                  return (
                    <span key={reg.id} className="vc-region-chip">
                      <strong>S{idx + 1}</strong>
                      <span className="vc-region-dims">
                        {wCm}×{hCm}cm
                      </span>
                      <button
                        type="button"
                        className="vc-region-remove"
                        onClick={() => onRemoveSubRegion(reg.id)}
                        title={`Quitar sección S${idx + 1}`}
                        aria-label={`Quitar sección S${idx + 1}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })
              )}
            </div>
            <div className="vc-regions-actions">
              <button
                type="button"
                className="vc-btn vc-btn-regions vc-btn-xs"
                disabled={subRegions.length === 0}
                onClick={onDetectSubRegions}
                title="Detecta divisores, repisas y diagonales solo dentro de las secciones marcadas"
              >
                <Sparkles size={12} /> Auto-detectar líneas en {subRegions.length}{' '}
                {subRegions.length === 1 ? 'sección' : 'secciones'}
              </button>
              {subRegions.length > 0 && (
                <button
                  type="button"
                  className="vc-chip"
                  onClick={onClearSubRegions}
                  title="Borrar todas las secciones marcadas"
                >
                  Limpiar secciones
                </button>
              )}
              {linesSubMode === 'regions' && (
                <button
                  type="button"
                  className="vc-chip"
                  onClick={() => onChangeLinesSubMode('smart')}
                  title="Volver al modo normal Editar / Trazar"
                >
                  Listo
                </button>
              )}
            </div>
          </div>
        )}

      {/* Aviso de patas detectadas */}
      {legHintDetected && !hasExternalLegs && onActivateExternalLegs && (
        <div className="vc-inline-alert">
          <span>
            <AlertTriangle size={13} /> Posibles patas externas detectadas debajo del cuerpo de
            melamina.
          </span>
          <button type="button" className="vc-chip active" onClick={onActivateExternalLegs}>
            Activar patas (150 mm)
          </button>
        </div>
      )}

      {/* Insignia ultra-compacta de 1 línea para Catálogo QA + Visión Real dentro de tu contorno */}
      {hasPhoto && isCatalogReference && viewTab === 'frontal' && (
        <div className="vc-catalog-bar">
          <span className="vc-catalog-badge">
            {ranRealVisionOnCatalog ? (
              <>
                <CheckCircle2 size={13} /> Visión real ejecutada en contorno ·{' '}
                <strong>{externalPhotoLabel ?? 'Catálogo QA'}</strong>
              </>
            ) : (
              <>
                <Sparkles size={13} /> Catálogo QA
                {externalPhotoLabel ? ` · ${externalPhotoLabel}` : ''}
              </>
            )}
          </span>
          <button
            type="button"
            className="vc-btn vc-btn-secondary vc-btn-xs vc-catalog-action"
            onClick={onRunRealVisionOnCatalog}
            title="Analiza la foto con el motor offline respetando siempre tu contorno actual"
          >
            <Wand2 size={12} />{' '}
            {ranRealVisionOnCatalog
              ? 'Re-ejecutar visión real en contorno'
              : 'Ejecutar visión real en contorno'}
          </button>
        </div>
      )}
    </>
  );
}

export interface CanvasMetricsStripProps {
  marginEval: MarginEvaluationResult | null;
  live3DSimilarity: Visual3DSimilarityResult | null;
  vCount: number;
  hCount: number;
  dCount: number;
  cameraPose: CameraPoseEstimate | null;
  visualLayer: VisualLayerMode;
  showRectPreview: boolean;
  estimatedAspectXY: number;
  rectPreviewRef: React.RefObject<HTMLCanvasElement>;
  onChangeVisualLayer: (layer: VisualLayerMode) => void;
  onToggleRectPreview: () => void;
}

export function CanvasMetricsStrip({
  marginEval,
  live3DSimilarity,
  vCount,
  hCount,
  dCount,
  cameraPose,
  visualLayer,
  showRectPreview,
  estimatedAspectXY,
  rectPreviewRef,
  onChangeVisualLayer,
  onToggleRectPreview,
}: CanvasMetricsStripProps) {
  return (
    <>
      <div className="vc-metrics-bar">
        <div className="vc-metrics-left">
          {marginEval && (
            <span className="vc-meter-pill">
              <span>Contorno</span>
              <span className="vc-mini-track">
                <i
                  className={`vc-mini-fill ${scoreToneClass(marginEval.overallScore)}`}
                  style={{ width: `${marginEval.overallScore}%` }}
                />
              </span>
              <strong className={scoreToneClass(marginEval.overallScore)}>
                {marginEval.overallScore}%
              </strong>
            </span>
          )}
          {live3DSimilarity && (
            <span className="vc-meter-pill">
              <span>3D vs Foto</span>
              <span className="vc-mini-track">
                <i
                  className={`vc-mini-fill ${scoreToneClass(live3DSimilarity.overallScore)}`}
                  style={{ width: `${live3DSimilarity.overallScore}%` }}
                />
              </span>
              <strong className={scoreToneClass(live3DSimilarity.overallScore)}>
                {live3DSimilarity.overallScore}%
              </strong>
            </span>
          )}
          <span className="vc-mono-note">
            {vCount}V · {hCount}H{dCount > 0 ? ` · ${dCount}D` : ''}
            {cameraPose ? ` · ~${cameraPose.distanceMeters.toFixed(1)} m` : ''}
          </span>
        </div>

        <div className="vc-metrics-right">
          <div className="vc-segmented vc-segmented-soft" role="group" aria-label="Capas visuales">
            <button
              type="button"
              className={visualLayer === 'traced_zones' ? 'active' : ''}
              onClick={() => onChangeVisualLayer('traced_zones')}
            >
              Zonas
            </button>
            <button
              type="button"
              className={visualLayer === 'vectors_only' ? 'active' : ''}
              onClick={() => onChangeVisualLayer('vectors_only')}
            >
              <GitBranch size={11} /> Bordes
            </button>
            <button
              type="button"
              className={visualLayer === 'photo' ? 'active' : ''}
              onClick={() => onChangeVisualLayer('photo')}
            >
              Foto
            </button>
            <button
              type="button"
              className={visualLayer === 'edges' ? 'active' : ''}
              onClick={() => onChangeVisualLayer('edges')}
            >
              <Contrast size={11} /> Sobel
            </button>
          </div>
          <button
            type="button"
            className={showRectPreview ? 'vc-chip active' : 'vc-chip'}
            onClick={onToggleRectPreview}
          >
            <Eye size={12} /> Rectificado
          </button>
        </div>
      </div>

      {showRectPreview && (
        <div className="vc-rect-preview">
          <canvas ref={rectPreviewRef} className="vc-rect-canvas" />
          <div className="vc-rect-info">
            <strong>Frente rectificado por Homografía H 3×3</strong>
            <p>
              Relación W/H = <code>{estimatedAspectXY.toFixed(2)}</code>
              {live3DSimilarity && (
                <>
                  {' '}
                  · Silueta <strong>{Math.round(live3DSimilarity.silhouetteMatch * 100)}%</strong> ·
                  Bordes <strong>{Math.round(live3DSimilarity.edgeStructureMatch * 100)}%</strong> ·
                  Color <strong>{Math.round(live3DSimilarity.colorPaletteMatch * 100)}%</strong>
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
