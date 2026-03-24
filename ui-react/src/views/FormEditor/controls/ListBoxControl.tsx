import { useEffect } from 'react';
import { useFormStore } from '@/store/form';
import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
  field: string | null;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
  allowEdits: boolean;
  tabIdx?: number;
}

export default function ListBoxControl({ ctrl, field, value, onChange, allowEdits, tabIdx }: Props) {
  const fetchRowSource = useFormStore(s => s.fetchRowSource);
  const getRowSourceOptions = useFormStore(s => s.getRowSourceOptions);
  const rs = ctrl['row-source'] as string | undefined;

  useEffect(() => {
    if (rs) fetchRowSource(rs);
  }, [rs]);

  const cached = rs ? getRowSourceOptions(rs) : null;
  const rows = (cached && typeof cached !== 'string') ? (cached.rows as unknown as Record<string, unknown>[]) ?? [] : [];
  const fields = (cached && typeof cached !== 'string') ? cached.fields ?? [] : [];
  const boundCol = ctrl['bound-column'] as number | undefined;

  return (
    <select
      className="view-listbox"
      multiple
      size={(ctrl as Record<string, unknown>)['list-rows'] as number ?? 5}
      value={value != null ? [String(value)] : []}
      disabled={!allowEdits}
      tabIndex={tabIdx}
      onChange={e => { if (field && allowEdits) onChange(field, e.target.value); }}
    >
      <option value=""></option>
      {rows.map((row, idx) => {
        const fieldNames = fields.map(f => f.name);
        const boundIdx = Math.max(0, (boundCol ?? 1) - 1);
        const boundKey = boundIdx < fieldNames.length ? fieldNames[boundIdx] : fieldNames[0];
        const bv = String(row[boundKey] ?? '');
        return <option key={idx} value={bv}>{bv}</option>;
      })}
    </select>
  );
}
