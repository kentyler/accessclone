import { useEffect } from 'react';
import { useUiStore } from '@/store/ui';
import Header from '@/components/Header';
import Sidebar from '@/components/Sidebar';
import TabBar from '@/components/TabBar';
import ChatPanel from '@/components/ChatPanel';
import ErrorBanner from '@/components/ErrorBanner';
import LoadingOverlay from '@/components/LoadingOverlay';
import OptionsDialog from '@/components/OptionsDialog';
import ObjectEditor from '@/views/ObjectEditor';
import ImportViewer from '@/views/ImportViewer/ImportViewer';
import LogsViewer from '@/views/LogsViewer';
import AppViewer from '@/views/AppViewer';

export default function App() {
  const init = useUiStore(s => s.init);
  const appMode = useUiStore(s => s.appMode);
  const activeTab = useUiStore(s => s.activeTab);

  useEffect(() => { init(); }, [init]);

  return (
    <div className="app-shell">
      <div className="app">
        <Header />
        <ErrorBanner />
        <LoadingOverlay />
        <OptionsDialog />

        <div className="app-body">
          <Sidebar />

          <div className="main-area">
            {appMode === 'import' && <ImportViewer />}

            {appMode === 'logs' && <LogsViewer />}

            {appMode === 'run' && (
              <>
                <TabBar />
                <div className="editor-container">
                  {activeTab ? (
                    <ObjectEditor tab={activeTab} />
                  ) : (
                    <WelcomePanel />
                  )}
                </div>
              </>
            )}
          </div>

          <ChatPanel />
        </div>
      </div>
    </div>
  );
}

function WelcomePanel() {
  const currentDb = useUiStore(s => s.currentDatabase);
  // Show AppViewer dashboard when a database is selected
  if (currentDb) return <AppViewer />;

  return (
    <div className="welcome-panel">
      <h2>Welcome to Three Horse</h2>
      <p>Select a database to get started.</p>
    </div>
  );
}
