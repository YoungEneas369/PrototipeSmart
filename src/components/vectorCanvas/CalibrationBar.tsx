/**
 * SMARTFURNITURE v8.0 — PANEL COMPACTO DE CALIBRACIÓN Y ESCALA (`CalibrationBar`)
 * Unifica:
 *  1) Medida conocida (aplica en 1 clic o al presionar Enter con clamp seguro [300, 2400] mm).
 *  2) Calibración proyectiva con hoja A4 (297 mm) que limpia puntos y sale automáticamente.
 *  3) Vista Lateral ZY opcional con guía clara y retorno inmediato a Vista Frontal XY.
 */
import { ArrowLeft, Camera, CheckCircle2, Ruler, Scan } from 'lucide-react';
import { NumericInput } from '../NumericInput';

export interface CalibrationBarProps {
  viewTab: 'frontal' | 'lateral';
  hasFrontPhoto: boolean;
  hasSidePhoto: boolean;
  knownAxis: 'x' | 'y';
  knownMeasureMm: number;
  focal35mm: 26 | 52;
  estimatedAspectXY: number;
  isCalibA4Active: boolean;
  calibRefMm: number;
  calibPtsCount: number;
  feedbackMsg: string | null;
  onChangeKnownAxis: (axis: 'x' | 'y') => void;
  onChangeKnownMeasureMm: (val: number) => void;
  onApplySingleMeasure: (axis: 'x' | 'y', valueMm: number) => void;
  onChangeFocal35mm: (focal: 26 | 52) => void;
  onToggleCalibA4: () => void;
  onChangeCalibRefMm: (mm: number) => void;
  onApplyCalibA4: () => void;
  onSwitchViewTab: (tab: 'frontal' | 'lateral') => void;
  onTriggerSidePhotoUpload: () => void;
}

export function CalibrationBar({
  viewTab,
  hasFrontPhoto,
  hasSidePhoto,
  knownAxis,
  knownMeasureMm,
  focal35mm,
  estimatedAspectXY,
  isCalibA4Active,
  calibRefMm,
  calibPtsCount,
  feedbackMsg,
  onChangeKnownAxis,
  onChangeKnownMeasureMm,
  onApplySingleMeasure,
  onChangeFocal35mm,
  onToggleCalibA4,
  onChangeCalibRefMm,
  onApplyCalibA4,
  onSwitchViewTab,
  onTriggerSidePhotoUpload,
}: CalibrationBarProps) {
  if (!hasFrontPhoto && viewTab === 'frontal') {
    return null;
  }

  return (
    <div className="vc-calib-card" role="region" aria-label="Calibración y escala real">
      {viewTab === 'lateral' ? (
        <div className="vc-calib-lateral-row">
          <div className="vc-calib-lateral-info">
            <span className="vc-calib-title">
              <Scan size={14} /> Vista Lateral ZY (Profundidad)
            </span>
            <p className="vc-calib-hint">
              {hasSidePhoto
                ? 'Ajusta las 4 esquinas sobre el costado del mueble para recalcular la profundidad Z automáticamente.'
                : 'Opcional: sube una foto de perfil lateral para calcular la profundidad Z proporcional al alto Y.'}
            </p>
          </div>
          <div className="vc-calib-actions">
            <button
              type="button"
              className="vc-btn vc-btn-secondary"
              onClick={onTriggerSidePhotoUpload}
            >
              <Camera size={14} /> {hasSidePhoto ? 'Cambiar foto lateral' : 'Cargar foto lateral'}
            </button>
            <button
              type="button"
              className="vc-btn vc-btn-primary"
              onClick={() => onSwitchViewTab('frontal')}
            >
              <ArrowLeft size={14} /> Volver a Vista Frontal XY
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="vc-calib-main-row">
            <div className="vc-calib-group">
              <span className="vc-calib-title">
                <Ruler size={14} /> Escala real
              </span>
              <select
                className="vc-select"
                value={knownAxis}
                onChange={(e) => onChangeKnownAxis(e.target.value as 'x' | 'y')}
                aria-label="Eje de medida conocida"
              >
                <option value="x">Ancho total (X)</option>
                <option value="y">Alto cuerpo (Y)</option>
              </select>
              <NumericInput
                min={300}
                max={2400}
                step={10}
                value={knownMeasureMm}
                onCommit={(val) => {
                  onChangeKnownMeasureMm(val);
                  if (val !== knownMeasureMm) {
                    onApplySingleMeasure(knownAxis, val);
                  }
                }}
                className="vc-mm-input"
                ariaLabel="Medida conocida en milímetros (300 a 2400 mm)"
              />
              <span className="vc-unit-text">mm</span>
              <button
                type="button"
                className="vc-btn vc-btn-primary vc-btn-sm"
                onClick={() => onApplySingleMeasure(knownAxis, knownMeasureMm)}
                title={`Extrapolación proporcional con W/H = ${estimatedAspectXY.toFixed(2)} (acotado a 300–2400 mm)`}
              >
                Aplicar escala
              </button>
            </div>

            <div className="vc-calib-group vc-calib-tools">
              <button
                type="button"
                className={isCalibA4Active ? 'vc-chip active' : 'vc-chip'}
                onClick={onToggleCalibA4}
                title="Marca 2 extremos de una hoja A4 (297 mm) o referencia sobre la foto para calcular escala proyectiva"
              >
                <Ruler size={12} /> Calibrar hoja A4 (297 mm)
              </button>
              <button
                type="button"
                className="vc-chip"
                onClick={() => onSwitchViewTab('lateral')}
                title="Cargar foto lateral opcional para estimar profundidad Z"
              >
                <Scan size={12} /> Vista Lateral ZY
              </button>
              <select
                className="vc-select vc-select-compact"
                value={focal35mm}
                onChange={(e) => onChangeFocal35mm(Number(e.target.value) as 26 | 52)}
                aria-label="Lente de cámara"
                title="Distancia focal aproximada de la cámara (1× normal o 2× teleobjetivo)"
              >
                <option value={26}>Lente 1× (26 mm)</option>
                <option value={52}>Lente 2× (52 mm)</option>
              </select>
            </div>
          </div>

          {isCalibA4Active && (
            <div className="vc-calib-a4-row">
              <span className="vc-calib-a4-badge">Hoja A4 / Referencia:</span>
              <NumericInput
                min={50}
                max={2400}
                step={1}
                value={calibRefMm}
                onCommit={onChangeCalibRefMm}
                className="vc-mm-input vc-mm-input-sm"
                ariaLabel="Medida de referencia en milímetros"
              />
              <span className="vc-unit-text">mm</span>
              <button
                type="button"
                className={calibRefMm === 297 ? 'vc-chip active' : 'vc-chip'}
                onClick={() => onChangeCalibRefMm(297)}
              >
                A4 largo (297)
              </button>
              <button
                type="button"
                className={calibRefMm === 210 ? 'vc-chip active' : 'vc-chip'}
                onClick={() => onChangeCalibRefMm(210)}
              >
                A4 ancho (210)
              </button>
              <button
                type="button"
                className="vc-btn vc-btn-primary vc-btn-sm"
                disabled={calibPtsCount !== 2}
                onClick={onApplyCalibA4}
              >
                Aplicar A4 ({calibPtsCount}/2 pts)
              </button>
              <button type="button" className="vc-chip" onClick={onToggleCalibA4}>
                Salir
              </button>
            </div>
          )}

          {feedbackMsg && (
            <div className="vc-calib-feedback" role="status">
              <CheckCircle2 size={13} /> {feedbackMsg}
            </div>
          )}
        </>
      )}
    </div>
  );
}
