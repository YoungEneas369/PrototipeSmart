/**
 * SMARTFURNITURE v8.0 — BARRA CONTEXTUAL DE PRECISIÓN PARA LÍNEAS (PASO 2)
 * Edita en milímetros divisores verticales, repisas horizontales y divisiones diagonales,
 * con centrado rápido, ajuste 0–100%, micro-desplazamiento (±1 / ±10 mm), inversión de
 * diagonal (`/` ↔ `\`) y botón único `Borrar línea` (sin duplicar `Deshacer`).
 */
import {
  FlipHorizontal2,
  Maximize2,
  Slash,
  Spline,
  StretchHorizontal,
  StretchVertical,
  X,
} from 'lucide-react';
import type {
  CurvedCutSpec,
  DiagonalSegment,
  FurnitureTopology,
  NormalizedSegment,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { buildCornerFilletCutSpec, evaluateBezierDifferential } from '../../core/mathEngine';
import { NumericInput } from '../NumericInput';
import { clampNum, round4, type LineRef } from './geometryHelpers';

export interface LineSelectionBarProps {
  selectedLine: LineRef | null;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  onUpdateVDivider: (id: string, next: NormalizedSegment) => void;
  onUpdateHShelf: (id: string, next: NormalizedSegment) => void;
  onUpdateDiagonal: (id: string, next: DiagonalSegment) => void;
  onDeleteSelected: () => void;
  onDeselect: () => void;
  selectedPlaneLine?: { plane: 'xz' | 'zy'; line: DiagonalSegment } | null;
  onUpdatePlaneLine?: (plane: 'xz' | 'zy', next: DiagonalSegment) => void;
  onDeletePlaneLine?: (plane: 'xz' | 'zy', id: string) => void;
  onDeselectPlaneLine?: () => void;
  selectedCurve?: CurvedCutSpec | null;
  onUpdateCurve?: (next: CurvedCutSpec) => void;
  onDeleteCurve?: (id: string) => void;
  onDeselectCurve?: () => void;
}

const NUDGE_STEPS = [-10, -1, 1, 10] as const;

export function LineSelectionBar({
  selectedLine,
  topology,
  params,
  onUpdateVDivider,
  onUpdateHShelf,
  onUpdateDiagonal,
  onDeleteSelected,
  onDeselect,
  selectedPlaneLine = null,
  onUpdatePlaneLine,
  onDeletePlaneLine,
  onDeselectPlaneLine,
  selectedCurve = null,
  onUpdateCurve,
  onDeleteCurve,
  onDeselectCurve,
}: LineSelectionBarProps) {
  const e = params.boardThickness;
  const xf = params.targetDimensions.x;
  const yf = params.targetDimensions.y;
  const zf = params.targetDimensions.z;
  const xInt = Math.max(1, xf - 2 * e);
  const yInt = Math.max(1, yf - 2 * e);
  const minInnerMm = Math.max(20, Math.round(e * 1.2));

  if (!selectedLine && !selectedPlaneLine && selectedCurve) {
    const planeLabel =
      selectedCurve.plane === 'xy'
        ? 'Frente (XY)'
        : selectedCurve.plane === 'xz'
          ? 'Arriba (XZ)'
          : 'Lado (ZY)';
    const planeW =
      selectedCurve.plane === 'xy' ? xInt : selectedCurve.plane === 'xz' ? xf : zf;
    const planeH =
      selectedCurve.plane === 'xy' ? yInt : selectedCurve.plane === 'xz' ? zf : yf;
    const computedDiff =
      selectedCurve.arcLengthMm !== undefined && selectedCurve.minRadiusMm !== undefined
        ? null
        : evaluateBezierDifferential(
            selectedCurve.controlPoints.map((pt) => ({
              x: pt.x * planeW,
              y: pt.y * planeH,
            })) as [
              { x: number; y: number },
              { x: number; y: number },
              { x: number; y: number },
              { x: number; y: number },
            ],
          );
    const arcMm = Math.round(selectedCurve.arcLengthMm ?? computedDiff?.arcLengthMm ?? 0);
    const rawMinR = selectedCurve.minRadiusMm ?? computedDiff?.minRadiusMm ?? 10000;
    const minRadiusDisplay = rawMinR < 9999 ? `${Math.round(rawMinR)} mm` : '∞';
    const currentFilletR = Math.round(selectedCurve.radiusMm ?? 120);

    const handleCommitFilletRadius = (nextRadiusMm: number) => {
      if (!onUpdateCurve) return;
      const rClamped = Math.round(clampNum(nextRadiusMm, 15, 450));
      if (selectedCurve.cornerTarget && selectedCurve.cornerTarget !== 'top_arch') {
        const rebuilt = buildCornerFilletCutSpec({
          id: selectedCurve.id,
          cornerTarget: selectedCurve.cornerTarget,
          radiusMm: rClamped,
        });
        onUpdateCurve({
          ...selectedCurve,
          ...rebuilt,
          label: rebuilt.label,
        });
      } else {
        onUpdateCurve({ ...selectedCurve, radiusMm: rClamped });
      }
    };

    return (
      <div
        className="vc-line-bar"
        role="region"
        aria-label={`Propiedades de curva en plano ${selectedCurve.plane.toUpperCase()}`}
      >
        <div className="vc-line-bar-head">
          <span className="vc-line-tag vc-line-tag-c">
            <Spline size={13} /> Curva {planeLabel}
          </span>
          <span className="vc-line-meta">
            Arco s=<strong>{arcMm} mm</strong> · Radio mín R_min=<strong>{minRadiusDisplay}</strong>
          </span>
          <span className="vc-line-hint">
            {selectedCurve.kind === 'corner_fillet'
              ? 'Ajusta el radio de empalme o arrastra los nodos P0–P3 · Supr borrar'
              : 'Arrastra los nodos P0–P3 sobre el lienzo para moldear la curva · Supr borrar'}
          </span>
          {onDeselectCurve && (
            <button
              type="button"
              className="vc-icon-btn"
              onClick={onDeselectCurve}
              title="Deseleccionar (Esc)"
              aria-label="Cerrar barra de curva"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="vc-line-bar-body">
          {selectedCurve.kind === 'corner_fillet' && onUpdateCurve && (
            <label className="vc-mm-field">
              <span>Radio:</span>
              <NumericInput
                value={currentFilletR}
                min={15}
                max={450}
                step={5}
                onCommit={handleCommitFilletRadius}
                className="vc-mm-input vc-mm-input-sm"
                ariaLabel="Radio de empalme curvo en mm"
              />
              <span>mm</span>
            </label>
          )}
          <div className="vc-line-actions">
            {onDeleteCurve && (
              <button
                type="button"
                className="vc-chip vc-chip-danger-soft"
                onClick={() => onDeleteCurve(selectedCurve.id)}
                title="Eliminar esta curva (Supr)"
              >
                <X size={12} /> Borrar curva
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!selectedLine && selectedPlaneLine && onUpdatePlaneLine && onDeletePlaneLine) {
    const { plane, line } = selectedPlaneLine;
    const isXZ = plane === 'xz';
    const planeW = isXZ ? xf : zf;
    const planeH = isXZ ? zf : yf;
    const a1Mm = Math.round(line.u1 * planeW);
    const b1Mm = isXZ ? Math.round((1 - line.v1) * zf) : Math.round(line.v1 * yf);
    const a2Mm = Math.round(line.u2 * planeW);
    const b2Mm = isXZ ? Math.round((1 - line.v2) * zf) : Math.round(line.v2 * yf);
    const daMm = a2Mm - a1Mm;
    const dbMm = b2Mm - b1Mm;
    const lenMm = Math.round(Math.hypot(daMm, dbMm));
    const angleDeg = Math.round(Math.abs((Math.atan2(dbMm, daMm) * 180) / Math.PI));

    const commitPlaneCoords = (na1: number, nb1: number, na2: number, nb2: number) => {
      const ca1 = clampNum(na1, 0, planeW);
      const cb1 = clampNum(nb1, 0, planeH);
      const ca2 = clampNum(na2, 0, planeW);
      const cb2 = clampNum(nb2, 0, planeH);
      if (Math.hypot(ca2 - ca1, cb2 - cb1) < 20) return;
      onUpdatePlaneLine(plane, {
        ...line,
        u1: round4(ca1 / planeW),
        v1: round4(isXZ ? 1 - cb1 / zf : cb1 / yf),
        u2: round4(ca2 / planeW),
        v2: round4(isXZ ? 1 - cb2 / zf : cb2 / yf),
      });
    };

    const resizePlaneLength = (deltaMm: number) => {
      const p1X = line.u1 * planeW;
      const p1Y = line.v1 * planeH;
      const p2X = line.u2 * planeW;
      const p2Y = line.v2 * planeH;
      const dx = p2X - p1X;
      const dy = p2Y - p1Y;
      const curLen = Math.hypot(dx, dy);
      if (curLen < 1) return;
      const nextLen = clampNum(curLen + deltaMm, 30, Math.hypot(planeW, planeH));
      const scale = nextLen / curLen;
      const nx2 = clampNum(p1X + dx * scale, 0, planeW);
      const ny2 = clampNum(p1Y + dy * scale, 0, planeH);
      onUpdatePlaneLine(plane, {
        ...line,
        u2: round4(nx2 / planeW),
        v2: round4(ny2 / planeH),
      });
    };

    const labelA = isXZ ? 'X' : 'Z';
    const labelB = isXZ ? 'Z' : 'Y';

    return (
      <div
        className="vc-line-bar"
        role="region"
        aria-label={`Propiedades de línea en vista ${plane.toUpperCase()}`}
      >
        <div className="vc-line-bar-head">
          <span className="vc-line-tag vc-line-tag-v">
            Línea {isXZ ? 'Arriba (XZ)' : 'Lado (ZY)'}
          </span>
          <span className="vc-line-meta">
            Largo: <strong>{lenMm} mm</strong> · Ángulo: <strong>{angleDeg}°</strong>
          </span>
          <span className="vc-line-hint">
            Arrastra los círculos azules en las puntas para achicar o alargar · Supr borrar
          </span>
          {onDeselectPlaneLine && (
            <button
              type="button"
              className="vc-icon-btn"
              onClick={onDeselectPlaneLine}
              title="Deseleccionar (Esc)"
              aria-label="Cerrar barra de línea"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="vc-line-bar-body">
          <label className="vc-mm-field">
            <span>{labelA}1:</span>
            <NumericInput
              value={a1Mm}
              min={0}
              max={planeW}
              step={5}
              onCommit={(val) => commitPlaneCoords(val, b1Mm, a2Mm, b2Mm)}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={`Coordenada ${labelA}1 en mm`}
            />
          </label>
          <label className="vc-mm-field">
            <span>{labelB}1:</span>
            <NumericInput
              value={b1Mm}
              min={0}
              max={planeH}
              step={5}
              onCommit={(val) => commitPlaneCoords(a1Mm, val, a2Mm, b2Mm)}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={`Coordenada ${labelB}1 en mm`}
            />
          </label>
          <label className="vc-mm-field">
            <span>{labelA}2:</span>
            <NumericInput
              value={a2Mm}
              min={0}
              max={planeW}
              step={5}
              onCommit={(val) => commitPlaneCoords(a1Mm, b1Mm, val, b2Mm)}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={`Coordenada ${labelA}2 en mm`}
            />
          </label>
          <label className="vc-mm-field">
            <span>{labelB}2:</span>
            <NumericInput
              value={b2Mm}
              min={0}
              max={planeH}
              step={5}
              onCommit={(val) => commitPlaneCoords(a1Mm, b1Mm, a2Mm, val)}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={`Coordenada ${labelB}2 en mm`}
            />
            <span>mm</span>
          </label>

          <div className="vc-nudge-group" role="group" aria-label="Achicar o alargar línea">
            <button
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => resizePlaneLength(-20)}
              title="Achicar línea 20 mm"
            >
              −20 largo
            </button>
            <button
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => resizePlaneLength(-10)}
              title="Achicar línea 10 mm"
            >
              −10 largo
            </button>
            <button
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => resizePlaneLength(10)}
              title="Alargar línea 10 mm"
            >
              +10 largo
            </button>
            <button
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => resizePlaneLength(20)}
              title="Alargar línea 20 mm"
            >
              +20 largo
            </button>
          </div>
          <div className="vc-line-actions">
            <button
              type="button"
              className="vc-chip vc-chip-danger-soft"
              onClick={() => onDeletePlaneLine(plane, line.id)}
              title="Eliminar esta línea (Supr)"
            >
              <X size={12} /> Borrar línea
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!selectedLine) return null;

  // Divisores verticales y repisas horizontales comparten el mismo editor parametrizado
  if (selectedLine.kind === 'vDivider' || selectedLine.kind === 'hShelf') {
    const isV = selectedLine.kind === 'vDivider';
    const seg = isV
      ? topology.vDividers.find((d) => d.id === selectedLine.id)
      : topology.hShelves.find((s) => s.id === selectedLine.id);
    if (!seg) return null;

    const posAxisOuter = isV ? xf : yf;
    const posAxisInt = isV ? xInt : yInt;
    const spanAxisInt = isV ? yInt : xInt;
    const onCommitSeg = isV ? onUpdateVDivider : onUpdateHShelf;

    const posMm = Math.round(e + seg.position * posAxisInt);
    const startMm = Math.round(seg.start * spanAxisInt);
    const endMm = Math.round(seg.end * spanAxisInt);
    const lengthMm = Math.max(0, endMm - startMm);
    const minPosMm = Math.round(e + minInnerMm);
    const maxPosMm = Math.max(minPosMm, Math.round(posAxisOuter - e - minInnerMm));

    const commitPosMm = (nextMm: number) => {
      const clampedMm = clampNum(nextMm, minPosMm, maxPosMm);
      const nextNorm = round4(clampNum((clampedMm - e) / posAxisInt, 0.03, 0.97));
      onCommitSeg(seg.id, { ...seg, position: nextNorm });
    };

    const commitStartMm = (nextStartMm: number) => {
      const clampedStart = clampNum(nextStartMm, 0, Math.max(0, endMm - 25));
      onCommitSeg(seg.id, { ...seg, start: round4(clampedStart / spanAxisInt) });
    };

    const commitEndMm = (nextEndMm: number) => {
      const clampedEnd = clampNum(nextEndMm, Math.min(spanAxisInt, startMm + 25), spanAxisInt);
      onCommitSeg(seg.id, { ...seg, end: round4(clampedEnd / spanAxisInt) });
    };

    const resizeLengthMm = (deltaMm: number) => {
      if (deltaMm < 0) {
        const nextEnd = Math.max(startMm + 25, endMm + deltaMm);
        const shrunk = endMm - nextEnd;
        const rem = -deltaMm - shrunk;
        const nextStart = rem > 0 ? Math.min(nextEnd - 25, startMm + rem) : startMm;
        onCommitSeg(seg.id, {
          ...seg,
          start: round4(clampNum(nextStart, 0, spanAxisInt - 25) / spanAxisInt),
          end: round4(clampNum(nextEnd, 25, spanAxisInt) / spanAxisInt),
        });
        return;
      }
      const addEnd = Math.min(deltaMm, spanAxisInt - endMm);
      const rem = deltaMm - addEnd;
      const nextEnd = endMm + addEnd;
      const nextStart = Math.max(0, startMm - rem);
      onCommitSeg(seg.id, {
        ...seg,
        start: round4(nextStart / spanAxisInt),
        end: round4(nextEnd / spanAxisInt),
      });
    };

    return (
      <div
        className="vc-line-bar"
        role="region"
        aria-label={isV ? 'Propiedades del divisor vertical' : 'Propiedades de la repisa horizontal'}
      >
        <div className="vc-line-bar-head">
          <span className={`vc-line-tag ${isV ? 'vc-line-tag-v' : 'vc-line-tag-h'}`}>
            {isV ? (
              <>
                <StretchVertical size={13} /> Divisor vertical
              </>
            ) : (
              <>
                <StretchHorizontal size={13} /> Repisa horizontal
              </>
            )}
          </span>
          <span className="vc-line-meta">
            {isV ? 'Largo real:' : 'Luz real:'} <strong>{lengthMm} mm</strong>
          </span>
          <span className="vc-line-hint">
            Arrastra los círculos en las puntas para achicar o alargar · Supr borrar
          </span>
          <button
            type="button"
            className="vc-icon-btn"
            onClick={onDeselect}
            title="Deseleccionar (Esc)"
            aria-label="Cerrar barra de línea"
          >
            <X size={14} />
          </button>
        </div>

        <div className="vc-line-bar-body">
          <label className="vc-mm-field">
            <span>{isV ? 'Desde izq.:' : 'Desde base:'}</span>
            <NumericInput
              value={posMm}
              min={minPosMm}
              max={maxPosMm}
              step={1}
              onCommit={commitPosMm}
              className="vc-mm-input"
              ariaLabel={
                isV
                  ? 'Posición del divisor desde el borde izquierdo en mm'
                  : 'Altura de la repisa desde la base en mm'
              }
            />
            <span>mm</span>
          </label>

          <div
            className="vc-nudge-group"
            role="group"
            aria-label={isV ? 'Ajuste fino posición' : 'Ajuste fino altura'}
          >
            {NUDGE_STEPS.map((delta) => (
              <button
                key={delta}
                type="button"
                className="vc-chip vc-chip-mini"
                onClick={() => commitPosMm(posMm + delta)}
              >
                {delta > 0 ? `+${delta}` : delta}
              </button>
            ))}
          </div>

          <label className="vc-mm-field">
            <span>{isV ? 'Inicio Y:' : 'Inicio X:'}</span>
            <NumericInput
              value={startMm}
              min={0}
              max={Math.max(0, endMm - 25)}
              step={5}
              onCommit={commitStartMm}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={
                isV
                  ? 'Inicio vertical del divisor en mm'
                  : 'Inicio horizontal de la repisa en mm'
              }
            />
          </label>
          <label className="vc-mm-field">
            <span>{isV ? 'Fin Y:' : 'Fin X:'}</span>
            <NumericInput
              value={endMm}
              min={Math.min(spanAxisInt, startMm + 25)}
              max={spanAxisInt}
              step={5}
              onCommit={commitEndMm}
              className="vc-mm-input vc-mm-input-sm"
              ariaLabel={
                isV ? 'Fin vertical del divisor en mm' : 'Fin horizontal de la repisa en mm'
              }
            />
            <span>mm</span>
          </label>

          <div className="vc-nudge-group" role="group" aria-label="Achicar o alargar línea">
            <button
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => resizeLengthMm(-10)}
              title="Achicar línea 10 mm"
            >
              −10 largo
            </button>
            <button
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => resizeLengthMm(10)}
              title="Alargar línea 10 mm"
            >
              +10 largo
            </button>
          </div>

          <div className="vc-line-actions">
            <button
              type="button"
              className="vc-chip"
              onClick={() => onCommitSeg(seg.id, { ...seg, position: 0.5 })}
              title={
                isV
                  ? 'Centrar exactamente al 50% del ancho interior'
                  : 'Centrar exactamente al 50% de la altura interior'
              }
            >
              Centrar
            </button>
            <button
              type="button"
              className="vc-chip"
              onClick={() => onCommitSeg(seg.id, { ...seg, start: 0, end: 1 })}
              title={
                isV
                  ? 'Extender desde base (0%) hasta cubierta (100%)'
                  : 'Extender desde lateral izq. (0%) hasta derecho (100%)'
              }
            >
              <Maximize2 size={12} /> 0–100%
            </button>
            <button
              type="button"
              className="vc-chip vc-chip-danger-soft"
              onClick={onDeleteSelected}
              title={isV ? 'Eliminar este divisor (Supr)' : 'Eliminar esta repisa (Supr)'}
            >
              <X size={12} /> Borrar línea
            </button>
          </div>
        </div>
      </div>
    );
  }

  // División diagonal
  const diag = (topology.diagonalDividers ?? []).find((dg) => dg.id === selectedLine.id);
  if (!diag) return null;

  const x1Mm = Math.round(diag.u1 * xInt);
  const y1Mm = Math.round(diag.v1 * yInt);
  const x2Mm = Math.round(diag.u2 * xInt);
  const y2Mm = Math.round(diag.v2 * yInt);
  const dxMm = x2Mm - x1Mm;
  const dyMm = y2Mm - y1Mm;
  const lengthMm = Math.round(Math.hypot(dxMm, dyMm));
  const angleDeg = Math.round(Math.abs((Math.atan2(dyMm, dxMm) * 180) / Math.PI));

  const updateDiagMm = (nx1: number, ny1: number, nx2: number, ny2: number) => {
    const cx1 = clampNum(nx1, 0, xInt);
    const cy1 = clampNum(ny1, 0, yInt);
    const cx2 = clampNum(nx2, 0, xInt);
    const cy2 = clampNum(ny2, 0, yInt);
    if (Math.hypot(cx2 - cx1, cy2 - cy1) < Math.max(25, e * 1.5)) return;
    onUpdateDiagonal(diag.id, {
      ...diag,
      u1: round4(cx1 / xInt),
      v1: round4(cy1 / yInt),
      u2: round4(cx2 / xInt),
      v2: round4(cy2 / yInt),
    });
  };

  const nudgeDiagX = (deltaMm: number) => {
    const minShift = -Math.min(x1Mm, x2Mm);
    const maxShift = xInt - Math.max(x1Mm, x2Mm);
    const eff = clampNum(deltaMm, minShift, maxShift);
    updateDiagMm(x1Mm + eff, y1Mm, x2Mm + eff, y2Mm);
  };

  const resizeDiagLength = (deltaMm: number) => {
    const curLen = Math.hypot(dxMm, dyMm);
    if (curLen < 1) return;
    const nextLen = clampNum(curLen + deltaMm, Math.max(25, e * 1.5), Math.hypot(xInt, yInt));
    const scale = nextLen / curLen;
    updateDiagMm(x1Mm, y1Mm, x1Mm + dxMm * scale, y1Mm + dyMm * scale);
  };

  return (
    <div className="vc-line-bar" role="region" aria-label="Propiedades de la división diagonal">
      <div className="vc-line-bar-head">
        <span className="vc-line-tag vc-line-tag-d">
          <Slash size={13} /> División diagonal
        </span>
        <span className="vc-line-meta">
          Largo: <strong>{lengthMm} mm</strong> · Ángulo: <strong>{angleDeg}°</strong>
        </span>
        <span className="vc-line-hint">
          Arrastra los círculos en las puntas para achicar o alargar · Supr borrar
        </span>
        <button
          type="button"
          className="vc-icon-btn"
          onClick={onDeselect}
          title="Deseleccionar (Esc)"
          aria-label="Cerrar barra de línea"
        >
          <X size={14} />
        </button>
      </div>

      <div className="vc-line-bar-body">
        <label className="vc-mm-field">
          <span>X1:</span>
          <NumericInput
            value={x1Mm}
            min={0}
            max={xInt}
            step={5}
            onCommit={(val) => updateDiagMm(val, y1Mm, x2Mm, y2Mm)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada X1 de diagonal en mm"
          />
        </label>
        <label className="vc-mm-field">
          <span>Y1:</span>
          <NumericInput
            value={y1Mm}
            min={0}
            max={yInt}
            step={5}
            onCommit={(val) => updateDiagMm(x1Mm, val, x2Mm, y2Mm)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada Y1 de diagonal en mm"
          />
        </label>
        <label className="vc-mm-field">
          <span>X2:</span>
          <NumericInput
            value={x2Mm}
            min={0}
            max={xInt}
            step={5}
            onCommit={(val) => updateDiagMm(x1Mm, y1Mm, val, y2Mm)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada X2 de diagonal en mm"
          />
        </label>
        <label className="vc-mm-field">
          <span>Y2:</span>
          <NumericInput
            value={y2Mm}
            min={0}
            max={yInt}
            step={5}
            onCommit={(val) => updateDiagMm(x1Mm, y1Mm, x2Mm, val)}
            className="vc-mm-input vc-mm-input-sm"
            ariaLabel="Coordenada Y2 de diagonal en mm"
          />
          <span>mm</span>
        </label>

        <div className="vc-nudge-group" role="group" aria-label="Desplazar diagonal en X">
          {NUDGE_STEPS.map((delta) => (
            <button
              key={delta}
              type="button"
              className="vc-chip vc-chip-mini"
              onClick={() => nudgeDiagX(delta)}
              title={`Desplazar horizontalmente ${delta > 0 ? '+' : ''}${delta} mm`}
            >
              {delta > 0 ? `+${delta}` : delta}
            </button>
          ))}
        </div>

        <div className="vc-nudge-group" role="group" aria-label="Achicar o alargar diagonal">
          <button
            type="button"
            className="vc-chip vc-chip-mini"
            onClick={() => resizeDiagLength(-10)}
            title="Achicar diagonal 10 mm"
          >
            −10 largo
          </button>
          <button
            type="button"
            className="vc-chip vc-chip-mini"
            onClick={() => resizeDiagLength(10)}
            title="Alargar diagonal 10 mm"
          >
            +10 largo
          </button>
        </div>

        <div className="vc-line-actions">
          <button
            type="button"
            className="vc-chip"
            onClick={() =>
              onUpdateDiagonal(diag.id, {
                ...diag,
                v1: diag.v2,
                v2: diag.v1,
              })
            }
            title="Invertir inclinación de la diagonal (/ ↔ \)"
          >
            <FlipHorizontal2 size={12} /> Invertir / ↔ \
          </button>
          <button
            type="button"
            className="vc-chip vc-chip-danger-soft"
            onClick={onDeleteSelected}
            title="Eliminar esta diagonal (Supr)"
          >
            <X size={12} /> Borrar línea
          </button>
        </div>
      </div>
    </div>
  );
}
