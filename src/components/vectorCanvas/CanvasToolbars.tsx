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
  Move,
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
  canUndo: boolean;
  canRedo: boolean;
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
  onChangeLinesSubMode: (mode: LinesSubMode) => void;
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
  canUndo,
  canRedo,
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
  onChangeLinesSubMode,
  onChangeStrokeMode,
  onAutoSuggestLines,
  onActivateExternalLegs,
  onRunRealVisionOnCatalog,
}: CanvasTopBarsProps) {
  return (
    <>
      {/* BARRA 1 (PRINCIPAL): Stepper 3 pasos + Undo/Redo + Zoom/Pan + Subir foto */}
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
            <Crop size={14} /> <span>1. Contorno</span>
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
            <PenTool size={14} /> <span>2. Líneas ({internalLineCount})</span>
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
            <LayoutGrid size={14} /> <span>3. Partes ({zonesCount})</span>
          </button>
        </div>

        <div className="vc-bar-right">
          <div className="vc-btn-group" role="group" aria-label="Historial">
            <button
              type="button"
              className="vc-icon-text-btn"
              onClick={onUndo}
              disabled={!canUndo && !(pickingCorners && pickingCorners.length > 0)}
              title="Deshacer (Ctrl+Z)"
              aria-label="Deshacer"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              className="vc-icon-text-btn"
              onClick={onRedo}
              disabled={!canRedo}
              title="Rehacer (Ctrl+Y / Ctrl+Shift+Z)"
              aria-label="Rehacer"
            >
              <Redo2 size={14} />
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
                <ZoomOut size={14} />
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
                <ZoomIn size={14} />
              </button>
              <button
                type="button"
                className="vc-icon-text-btn"
                onClick={onZoomReset}
                title="Ajustar foto al viewport"
                aria-label="Ajustar vista"
              >
                <Maximize2 size={13} />
              </button>
              <button
                type="button"
                className={panToolActive || isSpacePan ? 'vc-icon-text-btn active' : 'vc-icon-text-btn'}
                onClick={onTogglePanTool}
                title="Herramienta Mano para mover la foto (o mantén Espacio)"
                aria-label="Mover vista (Pan)"
              >
                <Hand size={13} />
              </button>
            </div>
          )}

          <button
            type="button"
            className="vc-btn vc-btn-primary vc-btn-sm"
            onClick={onUploadFrontPhoto}
          >
            <Camera size={14} /> {hasPhoto ? 'Cambiar foto' : 'Subir foto'}
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
                    title="Detectar contorno exterior automáticamente conservando tus líneas internas"
                  >
                    <Scan size={12} /> Auto-contorno
                  </button>
                  <button
                    type="button"
                    className="vc-chip"
                    disabled={internalLineCount === 0}
                    onClick={onClearLines}
                    title="Limpia solo las líneas internas para comenzar de cero (con Undo)"
                  >
                    <Trash2 size={12} /> Limpiar líneas internas
                  </button>
                </div>
                <button
                  type="button"
                  className="vc-btn vc-btn-primary vc-btn-sm"
                  onClick={() => onSelectStep('lines')}
                >
                  Paso 2: Líneas <ArrowRight size={13} />
                </button>
              </>
            )
          ) : traceStep === 'lines' ? (
            <>
              <div className="vc-context-actions">
                <div className="vc-segmented" role="group" aria-label="Herramienta de líneas">
                  <button
                    type="button"
                    className={linesSubMode === 'draw' ? 'active' : ''}
                    onClick={() => onChangeLinesSubMode('draw')}
                    title="Arrastra para crear líneas (iniciar sobre otra línea ancla una Unión T sin moverla)"
                  >
                    <PenTool size={12} /> Trazar línea
                  </button>
                  <button
                    type="button"
                    className={linesSubMode === 'move' ? 'active' : ''}
                    onClick={() => onChangeLinesSubMode('move')}
                    title="Selecciona y arrastra líneas completas o sus extremos"
                  >
                    <Move size={12} /> Mover / Editar
                  </button>
                </div>

                {linesSubMode === 'draw' && (
                  <div className="vc-segmented vc-segmented-soft" role="group" aria-label="Tipo de trazo">
                    <button
                      type="button"
                      className={strokeMode === 'auto' ? 'active' : ''}
                      onClick={() => onChangeStrokeMode('auto')}
                      title="Auto-orienta H/V en perspectiva o crea diagonal real entre 18° y 72°"
                    >
                      Auto H/V/Diag
                    </button>
                    <button
                      type="button"
                      className={strokeMode === 'ortho' ? 'active' : ''}
                      onClick={() => onChangeStrokeMode('ortho')}
                      title="Solo divisores verticales y repisas horizontales"
                    >
                      Solo Recta
                    </button>
                    <button
                      type="button"
                      className={strokeMode === 'diagonal' ? 'active' : ''}
                      onClick={() => onChangeStrokeMode('diagonal')}
                      title="Solo divisiones diagonales / oblicuas"
                    >
                      Solo Diagonal
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  className={magneticSnap ? 'vc-chip active' : 'vc-chip'}
                  onClick={onToggleMagneticSnap}
                  title="Imán a bordes y uniones T (mantén Alt para desactivar temporalmente)"
                >
                  <Magnet size={12} /> Imán {magneticSnap ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  className="vc-chip"
                  onClick={onAutoSuggestLines}
                  title="Sugiere líneas internas automáticamente dentro del contorno actual"
                >
                  <Wand2 size={12} /> Sugerir auto
                </button>
                <button
                  type="button"
                  className="vc-chip"
                  onClick={() => onToggleSubTool('eyedropper')}
                  title="Muestrear color de melamina con 1 clic"
                >
                  <Pipette size={12} /> Gotero
                </button>
                <button
                  type="button"
                  className="vc-chip"
                  disabled={internalLineCount === 0}
                  onClick={onClearLines}
                >
                  <Trash2 size={12} /> Limpiar
                </button>
              </div>
              <button
                type="button"
                className="vc-btn vc-btn-primary vc-btn-sm"
                onClick={() => onSelectStep('zones')}
              >
                Paso 3: Partes <ArrowRight size={13} />
              </button>
            </>
          ) : (
            <>
              <span className="vc-context-banner-text">
                <span className="vc-pill vc-pill-success">PASO 3</span>
                Haz clic sobre cualquier celda para editar su tipo abajo y verla resaltada en el 3D.
              </span>
              <div className="vc-context-actions">
                <button
                  type="button"
                  className="vc-chip"
                  onClick={() => onToggleSubTool('eyedropper')}
                >
                  <Pipette size={12} /> Gotero color
                </button>
                <button
                  type="button"
                  className="vc-btn vc-btn-secondary vc-btn-sm"
                  onClick={() => onSelectStep('lines')}
                >
                  <ArrowLeft size={13} /> Volver a Líneas
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Aviso de patas detectadas */}
      {legHintDetected && !hasExternalLegs && onActivateExternalLegs && (
        <div className="vc-inline-alert">
          <span>
            <AlertTriangle size={14} /> Posibles patas externas detectadas debajo del cuerpo de
            melamina.
          </span>
          <button type="button" className="vc-chip active" onClick={onActivateExternalLegs}>
            Activar patas (150 mm)
          </button>
        </div>
      )}

      {/* Insignia honesta para Catálogo QA (14 fotos reales) + botón explícito de Visión Real */}
      {hasPhoto && isCatalogReference && viewTab === 'frontal' && (
        <div className="vc-catalog-bar">
          <span className="vc-catalog-badge">
            {ranRealVisionOnCatalog ? (
              <>
                <CheckCircle2 size={14} /> Visión real offline ejecutada sobre{' '}
                <strong>{externalPhotoLabel ?? 'foto del catálogo'}</strong>
              </>
            ) : (
              <>
                <Sparkles size={14} /> Topología de referencia (Catálogo QA)
                {externalPhotoLabel ? ` · ${externalPhotoLabel}` : ''}
              </>
            )}
          </span>
          <button
            type="button"
            className="vc-btn vc-btn-secondary vc-btn-sm"
            onClick={onRunRealVisionOnCatalog}
          >
            <Wand2 size={13} />{' '}
            {ranRealVisionOnCatalog
              ? 'Re-ejecutar visión real'
              : 'Ejecutar visión real sobre esta foto'}
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
