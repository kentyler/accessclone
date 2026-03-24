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

export default function ToggleButtonControl({ ctrl, field, value, onChange, allowEdits, tabIdx }: Props) {
  const pressed = Boolean(value);
  const caption = (ctrl as Record<string, unknown>).text as string || ctrl.caption || 'Toggle';

  return (
    <button
      className={`view-toggle-button${pressed ? ' pressed' : ''}`}
      disabled={!allowEdits}
      tabIndex={tabIdx}
      onClick={() => { if (field && allowEdits) onChange(field, !pressed); }}
    >
      {parseHotkeyText(caption).map((seg, i) =>
        typeof seg === 'string' ? <span key={i}>{seg}</span> : <u key={i}>{seg.char}</u>
      )}
    </button>
  );
}
