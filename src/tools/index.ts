import type { ToolDefinition } from './types.js';
import { searchTools } from './search.js';
import { reindexTools } from './reindex.js';
import { deleteTools } from './delete.js';
import { coreTools } from './core.js';
import { docTools } from './doc.js';
import { timesheetTools } from './timesheet.js';

export const allTools: ToolDefinition[] = [
  ...searchTools,
  ...reindexTools,
  ...deleteTools,
  ...coreTools,
  ...docTools,
  ...timesheetTools,
];
