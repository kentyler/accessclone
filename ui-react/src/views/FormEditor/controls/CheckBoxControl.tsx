import { parseHotkeyText } from '@/lib/utils';
import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
  field: string | null;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
  allowEdits: boolean;
  tabIdx?: number;
}

export default function CheckBoxControl({ ctrl, field, value, onChange, allowEdits, tabIdx }: Props) {
  const caption = (ctrl as Record<string, unknown>).text as string || ctrl.caption || '';
  return (
    <label className="view-checkbox">
      <input
        type="checkbox"
        checked={Boolean(value)}
        disabled={!allowEdits}
        tabIndex={tabIdx}
        onChange={e => { if (field && allowEdits) onChange(field, e.target.checked); }}
      />
      {parseHotkeyText(caption).map((seg, i) =>
        typeof seg === 'string' ? <span key={i}>{seg}</span> : <u key={i}>{seg.char}</u>
      )}
    </label>
  );
}
