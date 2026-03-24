import { parseInputMask, maskPlaceholder } from '@/lib/utils';
import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
  field: string | null;
  value: unknown;
  onChange: (field: string, value: unknown) => void;
  allowEdits: boolean;
  autoFocus?: boolean;
  isNew?: boolean;
  tabIdx?: number;
}

function isHtmlContent(s: unknown): boolean {
  return typeof s === 'string' && /<[a-zA-Z][^>]*>/.test(s);
}

export default function TextBoxControl({ ctrl, field, value, onChange, allowEdits, autoFocus, isNew, tabIdx }: Props) {
  const mask = parseInputMask(ctrl['input-mask'] as string | undefined);
  const password = (ctrl['input-mask'] as string || '').toLowerCase().trim() === 'password';
  const placeholder = mask ? maskPlaceholder(mask.pattern, mask.placeholderChar) : undefined;
  const maxLen = placeholder ? placeholder.length : undefined;
  const rich = ctrl['text-format'] === 1 || isHtmlContent(String(value ?? ''));
  const multiLine = ((ctrl.height ?? 0) > 40) || (typeof value === 'string' && value.includes('\n'));

  const strVal = value == null ? '' : String(value);

  if (rich) {
    return <div className="view-input view-rich-text" dangerouslySetInnerHTML={{ __html: strVal }} />;
  }

  if (multiLine) {
    return (
      <textarea
        className="view-input view-textarea"
        value={strVal}
        readOnly={!allowEdits}
        autoFocus={isNew && autoFocus}
        placeholder={placeholder}
        tabIndex={tabIdx}
        onChange={e => { if (field && allowEdits) onChange(field, e.target.value); }}
      />
    );
  }

  return (
    <input
      className="view-input"
      type={password ? 'password' : 'text'}
      value={strVal}
      readOnly={!allowEdits}
      autoFocus={isNew && autoFocus}
      placeholder={placeholder}
      maxLength={maxLen}
      tabIndex={tabIdx}
      onChange={e => { if (field && allowEdits) onChange(field, e.target.value); }}
    />
  );
}
