import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
}

export default function RectangleControl({ ctrl }: Props) {
  const style: React.CSSProperties = {};
  const c = ctrl as Record<string, unknown>;
  if (c['back-color']) style.backgroundColor = c['back-color'] as string;
  if (c['border-color']) style.borderColor = c['border-color'] as string;
  if (c['border-width']) style.borderWidth = c['border-width'] as number;
  return <div className="view-rectangle" style={style} />;
}
