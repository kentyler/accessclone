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
  {
    name: 'query_potential',
    description: 'Find potentials a structure serves, or structures serving a potential. Use this to understand the purpose of database objects or find objects related to a business goal.',
    input_schema: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          enum: ['potentials_for_structure', 'structures_for_potential'],
          description: 'What to query: potentials for a structure, or structures for a potential'
        },
        node_name: {
          type: 'string',
          description: 'Name of the structure or potential to query'
        },
        node_type: {
          type: 'string',
          enum: ['table', 'column', 'form', 'control', 'potential'],
          description: 'Type of node (required for structure queries)'
        }
      },
      required: ['query_type', 'node_name']
    }
  },
  {
    name: 'propose_potential',
    description: 'Create a new potential or link structures to a potential. Use this when the user describes what a table or form is for, or when documenting business purposes.',
    input_schema: {
      type: 'object',
      properties: {
        potential_name: {
          type: 'string',
          description: 'Short name for the potential (e.g., "Track Inventory Costs")'
        },
        description: {
          type: 'string',
          description: 'Longer description of what this potential means'
        },
        structures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              node_type: { type: 'string', enum: ['table', 'column', 'form', 'control'] },
              name: { type: 'string' }
            }
          },
          description: 'List of structures that serve this potential'
        }
      },
      required: ['potential_name']
    }
  }
];

// Module translation tools — available when viewing a module
const moduleTools = [
  {
    name: 'update_translation',
    description: 'Update the ClojureScript translation with revised code. Use this when the user asks you to fix issues, apply suggestions, or make changes to the translation. Always return the COMPLETE updated source, not just the changed parts.',
    input_schema: {
      type: 'object',
      properties: {
        cljs_source: {
          type: 'string',
          description: 'The complete updated ClojureScript source code'
        },
        summary: {
          type: 'string',
          description: 'Brief summary of what was changed'
        }
      },
      required: ['cljs_source', 'summary']
    }
  }
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

module.exports = { dataTools, graphTools, moduleTools, queryTools };
