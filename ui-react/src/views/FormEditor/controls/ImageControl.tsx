import type { Control } from '@/api/types';

interface Props {
  ctrl: Control;
}

export default function ImageControl({ ctrl }: Props) {
  const src = (ctrl as Record<string, unknown>).picture as string | undefined;
  const sizeMode = (ctrl as Record<string, unknown>)['size-mode'] as string | undefined;
  const alignment = (ctrl as Record<string, unknown>)['picture-alignment'] as string | undefined;
  const altText = (ctrl as Record<string, unknown>).text as string || 'Image';

  if (src) {
    const cls = `view-image${sizeMode === 'cover' ? ' cover' : ''}${alignment ? ` ${alignment}` : ''}`;
    return <img className={cls} src={src} alt={altText} />;
  }
  return <div className="view-image-placeholder">No Image</div>;
}
