import { displayText } from '@/lib/utils';
import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
}

export default function LabelControl({ ctrl }: Props) {
  return <span className="view-label">{displayText(ctrl)}</span>;
}
