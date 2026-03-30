import type { FormDefinition } from '@/api/types';

/**
 * Props interface for LLM-generated form components.
 * This is the bridge between the Zustand store state and the generated component.
 * Generated components are pure rendering — no store access.
 */
export interface GeneratedFormProps {
  definition: FormDefinition;
  records: Record<string, unknown>[];
  currentRecord: Record<string, unknown> | null;
  position: { current: number; total: number };
  recordDirty: boolean;
  isNewRecord: boolean;
  onFieldChange: (field: string, value: unknown) => void;
  onNavigate: (target: 'first' | 'prev' | 'next' | 'last' | 'new') => void;
  onSave: () => void;
  onDelete: () => void;
  controlState: Record<string, { visible?: boolean; enabled?: boolean; caption?: string }>;
  rowSources: Record<string, { columns: string[]; rows: unknown[][] }>;
  subformData: Record<string, { definition: any; records: unknown[]; columns: string[] }>;
  fireEvent: (controlName: string, eventKey: string) => void;
}
