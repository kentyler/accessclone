import { useState } from 'react';
import type { ControlType } from '@/api/types';

interface PaletteItem {
  type: ControlType | null;
  icon: string;
  label: string;
}

const FORM_PALETTE: PaletteItem[][] = [
  [{ type: null, icon: '↖', label: 'Select (Pointer)' }],
  [
    { type: 'label', icon: 'Aa', label: 'Label' },
    { type: 'text-box', icon: 'ab|', label: 'Text Box' },
    { type: 'combo-box', icon: '▾', label: 'Combo Box' },
    { type: 'list-box', icon: '☰', label: 'List Box' },
  ],
  [
    { type: 'button', icon: '⬜', label: 'Button' },
    { type: 'check-box', icon: '☑', label: 'Check Box' },
    { type: 'option-group', icon: '◉', label: 'Option Group' },
    { type: 'option-button', icon: '⊙', label: 'Option Button' },
    { type: 'toggle-button', icon: '⇅', label: 'Toggle Button' },
  ],
  [
    { type: 'tab-control', icon: '⊞', label: 'Tab Control' },
    { type: 'subform', icon: '⧉', label: 'Subform' },
  ],
  [
    { type: 'image', icon: '🖼', label: 'Image' },
    { type: 'line', icon: '─', label: 'Line' },
    { type: 'rectangle', icon: '□', label: 'Rectangle' },
  ],
];

export const CONTROL_DEFAULTS: Record<string, { width: number; height: number; caption?: string }> = {
  'label': { width: 100, height: 18 },
  'text-box': { width: 150, height: 24 },
  'combo-box': { width: 150, height: 24 },
  'list-box': { width: 150, height: 80 },
  'button': { width: 80, height: 28, caption: 'Button' },
  'command-button': { width: 80, height: 28, caption: 'Button' },
  'check-box': { width: 80, height: 20 },
  'option-group': { width: 150, height: 80 },
  'option-button': { width: 80, height: 20 },
  'toggle-button': { width: 80, height: 24 },
  'tab-control': { width: 300, height: 200 },
  'subform': { width: 300, height: 200 },
  'image': { width: 100, height: 100 },
  'line': { width: 150, height: 2 },
  'rectangle': { width: 150, height: 80 },
  'page-break': { width: 150, height: 2 },
};

interface Props {
  activeTool: ControlType | null;
  onToolSelect: (tool: ControlType | null) => void;
}

export default function ControlPalette({ activeTool, onToolSelect }: Props) {
  return (
    <div className="control-palette">
      {FORM_PALETTE.map((group, gi) => (
        <span key={gi}>
          {gi > 0 && <span className="palette-separator" />}
          {group.map((item, ii) => (
            <button
              key={ii}
              className={`palette-btn${activeTool === item.type ? ' active' : ''}`}
              title={item.label}
              draggable={item.type != null}
              onClick={() => onToolSelect(activeTool === item.type ? null : item.type)}
              onDragStart={e => {
                if (item.type) {
                  e.dataTransfer.setData('application/x-palette-type', item.type);
                }
              }}
            >
              <span className="palette-icon">{item.icon}</span>
            </button>
          ))}
        </span>
      ))}
    </div>
  );
}
