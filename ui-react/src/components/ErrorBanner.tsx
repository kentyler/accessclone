import { useUiStore } from '@/store/ui';

export default function ErrorBanner() {
  const { error, clearError } = useUiStore();

  if (!error) return null;

  return (
    <div className="error-banner">
      <span>{error}</span>
      <button onClick={clearError}>Dismiss</button>
    </div>
  );
}
