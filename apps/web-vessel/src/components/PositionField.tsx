'use client';

import { Controller, type Control } from 'react-hook-form';

// Ports ovl/web/vessel/src/design/components/maritime/PositionField.jsx:
// a compound degree/minutes/hemisphere control instead of three
// unrelated plain <input type="number"> boxes. Masks/clamps input as
// the officer types rather than relying on native number-input min/max
// (which only affects the spinner and a validity flag — it never
// actually stops an out-of-range value like "1232" from being typed
// and committed). Bounds mirror pkg/validation/plausibility.go's
// evaluatePositionRequired exactly (latitude 0-90°, longitude 0-180°,
// minutes 0-<60') — the same physical bounds the server-side
// plausibility check uses, not a new business rule invented here.
const MAX_DEGREE = { lat: 90, lon: 180 };
const MAX_MINUTES = 59.999;

function maskDegreeInput(raw: string, max: number): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits === '') return '';
  const n = Number(digits);
  return n > max ? String(max) : String(Number.parseInt(digits, 10));
}

function maskMinutesInput(raw: string): string {
  let cleaned = raw.replace(/[^0-9.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  if (cleaned === '' || cleaned === '.') return cleaned;
  const n = Number(cleaned);
  if (Number.isNaN(n)) return cleaned;
  if (n > MAX_MINUTES) return String(MAX_MINUTES);
  if (n < 0) return '0';
  return cleaned;
}

interface PositionFieldProps {
  axis: 'lat' | 'lon';
  label: string;
  control: Control<any>;
  degreeName: string;
  minutesName: string;
  hemisphereName: string;
  required?: boolean;
}

export function PositionField({ axis, label, control, degreeName, minutesName, hemisphereName, required }: PositionFieldProps) {
  const options = axis === 'lat' ? ['N', 'S'] : ['E', 'W'];
  const maxDegree = MAX_DEGREE[axis];
  const degreePlaceholder = '0'.repeat(axis === 'lat' ? 2 : 3);

  return (
    <div className="flex items-center gap-1.5 bg-card border border-input rounded-sm px-3 min-h-12 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      <Controller
        name={degreeName}
        control={control}
        rules={{ required }}
        render={({ field }) => (
          <input
            type="text"
            inputMode="numeric"
            placeholder={degreePlaceholder}
            value={field.value ?? ''}
            onChange={(e) => field.onChange(maskDegreeInput(e.target.value, maxDegree))}
            onBlur={field.onBlur}
            aria-label={`${label} degrees (0-${maxDegree})`}
            className="w-8 bg-transparent border-none outline-none text-right font-mono tabular-nums text-sm text-foreground"
          />
        )}
      />
      <span className="text-muted-foreground text-sm">°</span>
      <Controller
        name={minutesName}
        control={control}
        rules={{ required }}
        render={({ field }) => (
          <input
            type="text"
            inputMode="decimal"
            placeholder="00.000"
            value={field.value ?? ''}
            onChange={(e) => field.onChange(maskMinutesInput(e.target.value))}
            onBlur={field.onBlur}
            aria-label={`${label} minutes (0-${MAX_MINUTES})`}
            className="w-16 bg-transparent border-none outline-none text-right font-mono tabular-nums text-sm text-foreground"
          />
        )}
      />
      <span className="text-muted-foreground text-sm mr-1">&rsquo;</span>
      <Controller
        name={hemisphereName}
        control={control}
        rules={{ required }}
        render={({ field }) => (
          <div className="flex ml-auto rounded-sm border border-border overflow-hidden shrink-0">
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => field.onChange(opt)}
                aria-pressed={field.value === opt}
                className={`w-7 h-7 text-xs font-semibold transition-colors ${
                  field.value === opt ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      />
    </div>
  );
}
