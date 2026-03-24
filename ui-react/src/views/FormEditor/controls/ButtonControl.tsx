import { parseHotkeyText } from '@/lib/utils';
import { useFormStore } from '@/store/form';
import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
  tabIdx?: number;
}

function runJsHandler(jsCode: string, contextLabel: string) {
  try {
    const f = new Function(jsCode);
    f.call(null);
  } catch (e: unknown) {
    console.warn('Error in event handler', contextLabel, ':', (e as Error).message);
  }
}

export default function ButtonControl({ ctrl, tabIdx }: Props) {
  const ctrlName = ctrl.name || '';
  const caption = (ctrl as Record<string, unknown>).text as string || ctrl.caption || 'Button';

  const handleClick = () => {
    // Read projection at click time (not render time) to avoid closure-capture bug
    const projection = useFormStore.getState().projection;
    if (!projection) return;
    const handlers = projection.eventHandlers || {};
    const key = `${ctrlName}::on-click`;
    const handler = handlers[key];
    if (handler?.js) {
      runJsHandler(handler.js, ctrlName);
    } else {
      console.warn('No handler found for button:', ctrlName);
    }
  };

  return (
    <button className="view-button" onClick={handleClick} tabIndex={tabIdx}>
      {parseHotkeyText(caption).map((seg, i) =>
        typeof seg === 'string' ? <span key={i}>{seg}</span> : <u key={i}>{seg.char}</u>
      )}
    </button>
  );
}
