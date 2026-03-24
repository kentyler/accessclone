import type { TabDescriptor } from '@/api/types';
import TableViewer from './TableViewer';
import QueryViewer from './QueryViewer';
import ModuleViewer from './ModuleViewer';
import MacroViewer from './MacroViewer';
import SqlFunctionViewer from './SqlFunctionViewer';
import LogsViewer from './LogsViewer';
import FormEditor from './FormEditor/FormEditor';
import ReportEditor from './ReportEditor/ReportEditor';

interface Props {
  tab: TabDescriptor;
}

export default function ObjectEditor({ tab }: Props) {
  switch (tab.type) {
    case 'tables':
      return <TableViewer tableName={tab.name} />;
    case 'queries':
      return <QueryViewer queryName={tab.name} />;
    case 'forms':
      return <FormEditor formName={tab.name} />;
    case 'reports':
      return <ReportEditor reportName={tab.name} />;
    case 'modules':
      return <ModuleViewer moduleName={tab.name} />;
    case 'macros':
      return <MacroViewer macroName={tab.name} />;
    case 'sql-functions':
      return <SqlFunctionViewer functionName={tab.name} />;
    default:
      return <div>Unknown object type: {tab.type}</div>;
  }
}

