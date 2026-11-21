/**
 * Input numérico ergonómico: permite escribir/borrar libremente sin forzar clamping
 * tecla por tecla, validando y acotando al rango [min, max] solo en onBlur o Enter.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

interface NumericInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (next: number) => void;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

export function NumericInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
  className,
  style,
  ariaLabel,
}: NumericInputProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const [focused, setFocused] = useState<boolean>(false);

  useEffect(() => {
    if (!focused) {
      setDraft(String(value));
    }
  }, [value, focused]);

  const commit = () => {
    const parsed = Number(draft.replace(',', '.'));
    if (Number.isFinite(parsed)) {
      const clamped = Math.max(min, Math.min(max, Math.round(parsed)));
      onCommit(clamped);
      setDraft(String(clamped));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      className={className}
      style={style}
      value={draft}
      onFocus={(e) => {
        setFocused(true);
        e.target.select();
      }}
      onChange={(e) => {
        const raw = e.target.value;
        if (/^-?\d*[.,]?\d*$/.test(raw)) {
          setDraft(raw);
        }
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(String(value));
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const next = Math.min(max, value + step);
          onCommit(next);
          setDraft(String(next));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = Math.max(min, value - step);
          onCommit(next);
          setDraft(String(next));
        }
      }}
    />
  );
}
