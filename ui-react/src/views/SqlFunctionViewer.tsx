import { useEffect, useState } from 'react';
import * as api from '@/api/client';
import { useUiStore } from '@/store/ui';
import { filenameToDisplayName } from '@/lib/utils';
import type { SqlFunctionInfo } from '@/api/types';

interface Props {
  functionName: string;
}

export default function SqlFunctionViewer({ functionName }: Props) {
  const functions = useUiStore(s => s.objects.sqlFunctions);
  const [info, setInfo] = useState<SqlFunctionInfo | null>(null);
  const [source, setSource] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fn = functions.find(f => f.name === functionName);
    if (fn) {
      setInfo(fn);
      // Load source
      api.get<{ source: string }>(`/api/functions/${encodeURIComponent(functionName)}`).then(res => {
        setLoading(false);
        if (res.ok) setSource(res.data.source || '');
      });
    } else {
      setLoading(false);
    }
  }, [functionName]);

  if (loading) return <div className="loading-indicator">Loading function...</div>;
  if (!info) return <div className="empty-viewer">Function not found</div>;

  return (
    <div className="sql-function-viewer">
      <div className="viewer-toolbar">
        <h3>{filenameToDisplayName(functionName)}</h3>
      </div>

      <div className="function-info">
        <div className="info-row">
          <strong>Arguments:</strong> {info.arguments || '(none)'}
        </div>
        <div className="info-row">
          <strong>Returns:</strong> {info.return_type || 'void'}
        </div>
        {info.description && (
          <div className="info-row">
            <strong>Description:</strong> {info.description}
          </div>
        )}
      </div>

      <div className="panel-header">Source</div>
      <pre className="function-source">{source || '(no source available)'}</pre>
    </div>
  );
}
