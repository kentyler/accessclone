import { useState } from 'react';
import { useUiStore } from '@/store/ui';

export default function OptionsDialog() {
  const { optionsDialogOpen, closeOptionsDialog, config, setGridSize, saveConfig } = useUiStore();
  const [localGridSize, setLocalGridSize] = useState(config.formDesigner.gridSize);

  if (!optionsDialogOpen) return null;

  const handleSave = () => {
    setGridSize(localGridSize);
    saveConfig();
    closeOptionsDialog();
  };

  return (
    <div className="dialog-overlay" onClick={e => { if (e.target === e.currentTarget) closeOptionsDialog(); }}>
      <div className="dialog">
        <div className="dialog-header">
          <span>Options</span>
          <button className="dialog-close" onClick={closeOptionsDialog}>&times;</button>
        </div>
        <div className="dialog-body">
          <div className="options-section">
            <h3>Form Designer</h3>
            <div className="option-row">
              <label>Grid Size (px)</label>
              <input
                className="text-input"
                type="number"
                min={1}
                max={50}
                value={localGridSize}
                onChange={e => setLocalGridSize(parseInt(e.target.value, 10) || 8)}
              />
              <span className="option-hint">Snap-to-grid spacing in design mode</span>
            </div>
          </div>
        </div>
        <div className="dialog-footer">
          <button className="secondary-btn" onClick={closeOptionsDialog}>Cancel</button>
          <button className="primary-btn" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
