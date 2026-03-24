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

function parseColumnWidths(s: string | undefined): number[] | null {
  if (!s || !s.trim()) return null;
  return s.split(';').map(p => {
    const n = parseFloat(p.replace(/[a-zA-Z]+/g, '').trim());
    return isNaN(n) ? 1 : n;
  });
}

function buildOptionDisplay(
  row: Record<string, unknown>,
  fields: Array<{ name: string }>,
  boundCol: number | undefined,
  colWidths: number[] | null
): [string, string] {
  const fieldNames = fields.map(f => f.name);
  const boundIdx = Math.max(0, (boundCol ?? 1) - 1);
  const boundKey = boundIdx < fieldNames.length ? fieldNames[boundIdx] : fieldNames[0];
  const boundVal = String(row[boundKey] ?? '');
  const visibleTexts = fieldNames
    .map((fname, i) => {
      const w = colWidths ? colWidths[i] : undefined;
      if (w !== undefined && w <= 0) return null;
      return String(row[fname] ?? '');
    })
    .filter(Boolean) as string[];
  return [boundVal, visibleTexts.length > 0 ? visibleTexts.join(' - ') : boundVal];
}

export default function ComboBoxControl({ ctrl, field, value, onChange, allowEdits, tabIdx }: Props) {
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
  const colWidths = parseColumnWidths(ctrl['column-widths'] as string | undefined);

  return (
    <select
      className="view-select"
      value={String(value ?? '')}
      disabled={!allowEdits}
      tabIndex={tabIdx}
      onChange={e => { if (field && allowEdits) onChange(field, e.target.value); }}
    >
      <option value=""></option>
      {rows.map((row, idx) => {
        const [bv, display] = buildOptionDisplay(row, fields, boundCol, colWidths);
        return <option key={idx} value={bv}>{display}</option>;
      })}
    </select>
  );
}
