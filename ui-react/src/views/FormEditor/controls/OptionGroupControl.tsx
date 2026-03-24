import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
  field: string | null;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
  allowEdits: boolean;
  tabIdx?: number;
}

interface OptionItem {
  value?: unknown;
  label?: string;
}

export default function OptionGroupControl({ ctrl, field, value, onChange, allowEdits, tabIdx }: Props) {
  const options = ((ctrl as Record<string, unknown>).options as OptionItem[] | undefined) ?? [];
  const groupName = ctrl.name || `optgrp-${Math.random().toString(36).slice(2)}`;

  return (
    <div className="view-option-group">
      {options.length > 0 ? (
        options.map((opt, idx) => (
          <label key={idx} className="view-option-item">
            <input
              type="radio"
              name={groupName}
              value={String(opt.value ?? idx)}
              checked={value === (opt.value ?? idx)}
              disabled={!allowEdits}
              tabIndex={tabIdx}
              onChange={() => { if (field && allowEdits) onChange(field, opt.value ?? idx); }}
            />
            {opt.label ?? `Option ${idx + 1}`}
          </label>
        ))
      ) : (
        <span className="view-option-placeholder">(No options defined)</span>
      )}
    </div>
  );
}
