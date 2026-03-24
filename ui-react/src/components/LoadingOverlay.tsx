import { useUiStore } from '@/store/ui';

export default function LoadingOverlay() {
  const loading = useUiStore(s => s.loading);

  if (!loading) return null;

  return (
    <div className="loading-overlay">
      <div className="spinner" />
    </div>
  );
}
