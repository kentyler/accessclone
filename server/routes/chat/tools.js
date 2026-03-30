/**
 * Tool schema definitions for the LLM chat.
 */

// Data tools — available when a form has a record source
const dataTools = [
  {
    name: 'search_records',
    description: 'Search for specific records in the current form\'s data source. Use this when the user asks to find, search for, locate, or go to specific records by name or value.',
    input_schema: {
      type: 'object',
      properties: {
        search_term: {
          type: 'string',
          description: 'The text to search for across all text fields'
        },
        field_name: {
          type: 'string',
          description: 'Optional: specific field/column to search in'
        }
      },
      required: ['search_term']
    }
  },
  {
    name: 'analyze_data',
    description: 'Analyze data in the current form\'s data source. Use this when the user asks questions about aggregates, totals, counts, averages, maximums, minimums, comparisons, or wants insights about the data as a whole rather than finding specific records.',
    input_schema: {
      type: 'object',
      properties: {
        analysis_type: {
          type: 'string',
          enum: ['count', 'sum', 'avg', 'min', 'max', 'group_count', 'custom'],
          description: 'Type of analysis: count (total records), sum/avg/min/max (for numeric fields), group_count (count by category), custom (for complex queries)'
        },
        field_name: {
          type: 'string',
          description: 'The field to analyze (required for sum, avg, min, max, group_count)'
        },
        group_by_field: {
          type: 'string',
          description: 'Field to group by (for group_count analysis)'
        },
        filter_condition: {
          type: 'string',
          description: 'Optional WHERE clause condition, e.g., "amount > 100" or "status = \'active\'"'
        }
      },
      required: ['analysis_type']
    }
  },
  {
    name: 'navigate_to_record',
    description: 'Navigate to a specific record by its ID. Use this after finding a record to take the user directly to it.',
    input_schema: {
      type: 'object',
      properties: {
        record_id: {
          type: 'integer',
          description: 'The primary key ID of the record to navigate to'
        }
      },
      required: ['record_id']
    }
  }
];

// Graph/dependency tools — always available
const graphTools = [
  {
    name: 'query_dependencies',
    description: 'Find what depends on or uses a database object (table, column, form, control). Use this when the user asks about dependencies, impact analysis, or what would be affected by changes.',
    input_schema: {
      type: 'object',
      properties: {
        node_type: {
          type: 'string',
          enum: ['table', 'column', 'form', 'control'],
          description: 'Type of database object to query'
        },
        node_name: {
          type: 'string',
          description: 'Name of the object (e.g., table name, column name)'
        },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream'],
          description: 'upstream = what this depends on, downstream = what depends on this'
        },
        depth: {
          type: 'integer',
          description: 'How many levels deep to traverse (default 3, max 5)'
        }
      },
      required: ['node_type', 'node_name']
    }
  },
];

// Query/function DDL tools — available when viewing a query or SQL function
const queryTools = [
  {
    name: 'update_query',
    description: 'Create or replace a PostgreSQL view or function by executing DDL. Use this when the user asks to save, create, or update a query or function. For views: wrap the SELECT in CREATE OR REPLACE VIEW. For functions: use CREATE OR REPLACE FUNCTION with full body.',
    input_schema: {
      type: 'object',
      properties: {
        query_name: {
          type: 'string',
          description: 'Name of the view or function to create/replace'
        },
        sql: {
          type: 'string',
          description: 'The full DDL statement (CREATE OR REPLACE VIEW/FUNCTION ...)'
        },
        ddl_type: {
          type: 'string',
          enum: ['view', 'function'],
          description: 'Whether this is a view or function'
        }
      },
      required: ['query_name', 'sql', 'ddl_type']
    }
  }
];

// Design check tool — always available
const designCheckTools = [
  {
    name: 'run_design_check',
    description: 'Run design checks against the current database to find structural issues, naming problems, or UX improvements. Use this when you encounter naming confusion, structural problems, or the user asks about design quality.',
    input_schema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Optional scope: "full" (default), "form:formName", "table:tableName" — limits checks to a specific object'
        }
      },
      required: []
    }
  }
];

module.exports = { dataTools, graphTools, queryTools, designCheckTools };
