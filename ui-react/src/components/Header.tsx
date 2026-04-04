import { useState, useRef, useEffect } from 'react';
import { useUiStore } from '@/store/ui';
import type { AppMode } from '@/api/types';

export default function Header() {
  const {
    availableDatabases, currentDatabase, loadingObjects,
    appMode, setAppMode, switchDatabase, loadDatabases,
    optionsDialogOpen, openOptionsDialog,
  } = useUiStore();

  const [newDbOpen, setNewDbOpen] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [newDbDesc, setNewDbDesc] = useState('');

  const handleDbChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === '__new__') {
      setNewDbOpen(true);
      return;
    }
    switchDatabase(val);
  };

  const handleCreateDb = async () => {
    if (!newDbName.trim()) return;
    const { post } = await import('@/api/client');
    const res = await post('/api/databases', { name: newDbName, description: newDbDesc });
    if (res.ok) {
      setNewDbOpen(false);
      setNewDbName('');
      setNewDbDesc('');
      const slug = newDbName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      await loadDatabases();
      await switchDatabase(slug);
    }
  };

  const modes: { key: AppMode; label: string }[] = [
    { key: 'import', label: 'Import' },
    { key: 'run', label: 'Run' },
    { key: 'logs', label: 'Logs' },
  ];

  return (
    <div className="header">
      <div className="header-content">
        <div className="database-selector">
          <select
            className="database-dropdown"
            value={currentDatabase?.database_id ?? ''}
            onChange={handleDbChange}
            disabled={loadingObjects}
          >
            {availableDatabases.map(db => (
              <option key={db.database_id} value={db.database_id}>{db.name}</option>
            ))}
            <option value="__new__">+ New Database...</option>
          </select>
          {loadingObjects && <span className="loading-indicator">Loading...</span>}
        </div>

        <div className="mode-toggle">
          {modes.map(m => (
            <label key={m.key} className={`mode-option${appMode === m.key ? ' active' : ''}`}>
              <input
                type="radio"
                name="app-mode"
                value={m.key}
                checked={appMode === m.key}
                onChange={() => setAppMode(m.key)}
              />
              {m.label}
            </label>
          ))}
        </div>

        <div className="header-nav">
          <div className="menu-bar">
            <ToolsMenu onOptions={openOptionsDialog} />
          </div>
        </div>
      </div>

      {newDbOpen && (
        <div className="dialog-overlay" onClick={e => { if (e.target === e.currentTarget) setNewDbOpen(false); }}>
          <div className="dialog">
            <div className="dialog-header">
              <span>New Database</span>
              <button className="dialog-close" onClick={() => setNewDbOpen(false)}>&times;</button>
            </div>
            <div className="dialog-body">
              <div className="option-row">
                <label>Name</label>
                <input className="text-input" value={newDbName} onChange={e => setNewDbName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateDb(); }} autoFocus />
              </div>
              <div className="option-row">
                <label>Description</label>
                <input className="text-input" value={newDbDesc} onChange={e => setNewDbDesc(e.target.value)} />
              </div>
            </div>
            <div className="dialog-footer">
              <button className="secondary-btn" onClick={() => setNewDbOpen(false)}>Cancel</button>
              <button className="primary-btn" onClick={handleCreateDb}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolsMenu({ onOptions }: { onOptions: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="menu-item" ref={ref}>
      <span onClick={() => setOpen(!open)}>Tools</span>
      {open && (
        <div className="menu-dropdown">
          <div className="menu-option" onClick={() => { onOptions(); setOpen(false); }}>Options...</div>
        </div>
      )}
    </div>
  );
}
