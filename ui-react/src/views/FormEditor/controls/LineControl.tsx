import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
}

export default function LineControl({ ctrl }: Props) {
  const style: React.CSSProperties = {};
  const c = ctrl as Record<string, unknown>;
  if (c['border-color']) style.borderColor = c['border-color'] as string;
  if (c['border-width']) style.borderTopWidth = c['border-width'] as number;
  return <hr className="view-line" style={style} />;
}
