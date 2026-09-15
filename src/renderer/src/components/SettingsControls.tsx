import type { ReactNode } from 'react'

/** A titled group of settings, rendered as a card. */
export function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="card overflow-hidden">
      <h3
        className="border-b px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wider"
        style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
      >
        {title}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

export interface FieldProps {
  label: string
  hint?: string
  children: ReactNode
  /** Stacks the control under the label instead of beside it. */
  stacked?: boolean
}

export function Field({ label, hint, children, stacked = false }: FieldProps): ReactNode {
  return (
    <div
      className={`border-b px-4 py-3 last:border-b-0 ${
        stacked ? 'flex flex-col gap-2' : 'flex items-start justify-between gap-6'
      }`}
      style={{ borderColor: 'var(--border)' }}
    >
      <div className={stacked ? '' : 'min-w-0 flex-1 pt-1'}>
        <p className="text-[12.5px] font-medium">{label}</p>
        {hint ? <p className="mt-0.5 text-[11.5px] leading-relaxed faint">{hint}</p> : null}
      </div>
      <div className={stacked ? '' : 'shrink-0'}>{children}</div>
    </div>
  )
}

// Toggle geometry, in pixels. Track 40x22 with an 18px knob and 2px padding
// leaves exactly 2px of clearance on either side in both states.
const TRACK_W = 40
const TRACK_H = 22
const KNOB = 18
const KNOB_PAD = 2

export interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

export function Toggle({ checked, onChange, label, hint, disabled = false }: ToggleProps): ReactNode {
  return (
    <Field label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative shrink-0 rounded-full transition-colors disabled:opacity-40"
        style={{
          width: TRACK_W,
          height: TRACK_H,
          background: checked ? 'var(--accent)' : 'var(--border-strong)'
        }}
      >
        {/* Explicit left offset + translate, so the knob position never depends
            on static-position quirks: OFF sits KNOB_PAD from the left edge,
            ON sits KNOB_PAD from the right edge. */}
        <span
          className="absolute rounded-full bg-white transition-transform"
          style={{
            top: KNOB_PAD,
            left: KNOB_PAD,
            width: KNOB,
            height: KNOB,
            transform: checked ? `translateX(${TRACK_W - KNOB - KNOB_PAD * 2}px)` : 'translateX(0)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.35)'
          }}
        />
      </button>
    </Field>
  )
}

export interface TextInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
  className?: string
  disabled?: boolean
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
  className = 'w-[280px]',
  disabled = false
}: TextInputProps): ReactNode {
  return (
    <input
      className={`input ${mono ? 'input-mono' : ''} ${className}`}
      value={value}
      type={type}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export interface NumberInputProps {
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step?: number
}

export function NumberInput({ value, onChange, min, max, step = 1 }: NumberInputProps): ReactNode {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="btn btn-icon h-[26px] w-[26px]"
        onClick={() => onChange(Math.max(min, value - step))}
        disabled={value <= min}
        aria-label="Decrease"
      >
        −
      </button>
      <input
        className="input input-mono h-[26px] w-[52px] text-center"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))))
        }}
      />
      <button
        type="button"
        className="btn btn-icon h-[26px] w-[26px]"
        onClick={() => onChange(Math.min(max, value + step))}
        disabled={value >= max}
        aria-label="Increase"
      >
        +
      </button>
    </div>
  )
}

export interface Option<T extends string | number> {
  value: T
  label: string
}

export function Choice<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
}): ReactNode {
  return (
    <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--panel-2)' }}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            className="h-[24px] rounded-md px-2.5 text-[11.5px] font-medium transition-colors"
            style={{
              background: active ? 'var(--bg-elev)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-dim)',
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.18)' : 'none'
            }}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
