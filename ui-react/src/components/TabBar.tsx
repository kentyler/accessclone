import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';

export default function TabBar() {
  const { openTabs, activeTab, setActiveTab, closeTab } = useUiStore();

  if (openTabs.length === 0) {
    return <div className="no-tabs" />;
  }

  return (
    <div className="tab-bar">
      {openTabs.map(tab => {
        const isActive = activeTab?.type === tab.type && activeTab?.id === tab.id;
        return (
          <div
            key={`${tab.type}-${tab.id}`}
            className={`tab${isActive ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className="tab-name">{filenameToDisplayName(tab.name)}</span>
            <button
              className="tab-close"
              onClick={e => { e.stopPropagation(); closeTab(tab.type, tab.id); }}
            >
              &times;
            </button>
          </div>
        );
      })}
    </div>
  );
}
