#!/usr/bin/env node
/**
 * Oracle MCP Server - Main entry point
 *
 * This module implements the MCP (Model Context Protocol) server for Oracle
 * database connectivity, enabling AI tools to interact with Oracle databases.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { ConnectionManager, getConfig, parseConfig } from './connection-manager.js';
import { QueryExecutor } from './query-executor.js';
import { SchemaBrowser } from './schema-browser.js';
import {
  formatQueryResultMarkdown,
  formatQueryResultJson,
  formatTableInfoMarkdown,
  formatTableInfoJson,
  formatConnectionsList,
  formatTablesList,
  formatProceduresList,
  formatExplainPlan,
  formatProcedureParams,
} from './formatters.js';

// ============================================================================
// Global Instances
// ============================================================================

let connectionManager: ConnectionManager | null = null;
let queryExecutor: QueryExecutor | null = null;
let schemaBrowser: SchemaBrowser | null = null;

function initializeFromConfig(mcpConfig?: Record<string, unknown>): void {
  let config;
  if (mcpConfig) {
    config = parseConfig(mcpConfig);
  } else {
    config = getConfig();
  }

  connectionManager = new ConnectionManager(config);
  queryExecutor = new QueryExecutor(connectionManager);
  schemaBrowser = new SchemaBrowser(connectionManager);

  console.error(`Initialized with ${config.connections.length} connection(s)`);
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS: Tool[] = [
  {
    name: 'list_connections',
    description:
      'List all configured Oracle database connections with their status (connected/disconnected) and mode (readonly/readwrite).',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'test_connection',
    description:
      'Test connectivity to a named Oracle database connection. Returns database version and schema information if successful.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the database connection to test',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'connect',
    description: 'Establish a connection to a named Oracle database.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the database connection',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'disconnect',
    description: 'Close a connection to a named Oracle database.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the database connection to close',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'execute_query',
    description:
      'Execute a SELECT query on an Oracle database. Returns results as a formatted table. Only SELECT statements are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        sql: {
          type: 'string',
          description: 'SQL SELECT query to execute',
        },
        max_rows: {
          type: 'integer',
          description: 'Maximum number of rows to return (default: 100)',
          default: 100,
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output format (default: markdown)',
          default: 'markdown',
        },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'execute_dml',
    description:
      'Execute a DML statement (INSERT, UPDATE, DELETE) on an Oracle database. Only works on connections with readwrite mode.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        sql: {
          type: 'string',
          description: 'SQL DML statement to execute',
        },
        commit: {
          type: 'boolean',
          description: 'Whether to commit the transaction (default: true)',
          default: true,
        },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'execute_plsql',
    description:
      'Execute a PL/SQL block or DDL statement (CREATE FUNCTION, CREATE PROCEDURE, etc.). Only works on connections with readwrite mode.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        plsql: {
          type: 'string',
          description: 'PL/SQL block or DDL statement to execute',
        },
        commit: {
          type: 'boolean',
          description: 'Whether to commit after execution (default: true)',
          default: true,
        },
      },
      required: ['connection', 'plsql'],
    },
  },
  {
    name: 'execute_procedure',
    description: 'Execute a stored procedure with input and output parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        procedure: {
          type: 'string',
          description: 'Name of the stored procedure (can include schema: SCHEMA.PROCEDURE_NAME)',
        },
        params: {
          type: 'object',
          description: 'Input parameters as key-value pairs',
          additionalProperties: true,
        },
        out_params: {
          type: 'object',
          description:
            'Output parameters with their types (e.g., {"result": "string", "count": "int"})',
          additionalProperties: {
            type: 'string',
            enum: ['string', 'int', 'float'],
          },
        },
      },
      required: ['connection', 'procedure'],
    },
  },
  {
    name: 'list_tables',
    description: 'List tables and views in a database schema.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        schema: {
          type: 'string',
          description: "Schema name (defaults to current user's schema)",
        },
        filter: {
          type: 'string',
          description: "LIKE pattern to filter table names (e.g., 'MTX%')",
        },
        include_views: {
          type: 'boolean',
          description: 'Whether to include views (default: true)',
          default: true,
        },
      },
      required: ['connection'],
    },
  },
  {
    name: 'describe_table',
    description:
      'Get detailed information about a table including columns, constraints, and indexes.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        table: {
          type: 'string',
          description: 'Name of the table or view to describe',
        },
        schema: {
          type: 'string',
          description: "Schema name (defaults to current user's schema)",
        },
        include_row_count: {
          type: 'boolean',
          description: 'Whether to get the row count (can be slow for large tables)',
          default: false,
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output format (default: markdown)',
          default: 'markdown',
        },
      },
      required: ['connection', 'table'],
    },
  },
  {
    name: 'list_procedures',
    description: 'List stored procedures, functions, and packages in a schema.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        schema: {
          type: 'string',
          description: "Schema name (defaults to current user's schema)",
        },
        filter: {
          type: 'string',
          description: 'LIKE pattern to filter object names',
        },
        type: {
          type: 'string',
          enum: ['PROCEDURE', 'FUNCTION', 'PACKAGE'],
          description: 'Filter by object type',
        },
      },
      required: ['connection'],
    },
  },
  {
    name: 'get_procedure_source',
    description: 'Get the source code of a stored procedure, function, or package.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        name: {
          type: 'string',
          description: 'Name of the procedure/function/package',
        },
        type: {
          type: 'string',
          enum: ['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY', 'TRIGGER'],
          description: 'Type of the object (default: PROCEDURE)',
          default: 'PROCEDURE',
        },
        schema: {
          type: 'string',
          description: "Schema name (defaults to current user's schema)",
        },
      },
      required: ['connection', 'name'],
    },
  },
  {
    name: 'get_procedure_params',
    description: 'Get the parameters of a stored procedure or function.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        procedure: {
          type: 'string',
          description: 'Name of the procedure or function',
        },
        schema: {
          type: 'string',
          description: "Schema name (defaults to current user's schema)",
        },
      },
      required: ['connection', 'procedure'],
    },
  },
  {
    name: 'explain_query',
    description: 'Get the execution plan for a SQL query.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection to use',
        },
        sql: {
          type: 'string',
          description: 'SQL query to explain',
        },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'commit',
    description: 'Commit the current transaction on a connection.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection',
        },
      },
      required: ['connection'],
    },
  },
  {
    name: 'rollback',
    description: 'Rollback the current transaction on a connection.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: {
          type: 'string',
          description: 'Name of the database connection',
        },
      },
      required: ['connection'],
    },
  },
];

// ============================================================================
// Tool Execution
// ============================================================================

async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!connectionManager || !queryExecutor || !schemaBrowser) {
    initializeFromConfig();
  }

  // Connection management tools
  if (name === 'list_connections') {
    const connections = await connectionManager!.listConnections();
    return formatConnectionsList(connections);
  }

  if (name === 'test_connection') {
    const connName = args.name as string;
    const result = await connectionManager!.testConnection(connName);
    if (result.success) {
      return (
        `✅ **Connection test successful for '${connName}'**\n\n` +
        `- **Database:** ${result.database || 'N/A'}\n` +
        `- **Schema:** ${result.schema || 'N/A'}\n` +
        `- **Mode:** ${result.mode || 'N/A'}\n` +
        `- **Version:** ${result.version || 'N/A'}`
      );
    } else {
      return `❌ **Connection test failed for '${connName}'**\n\n${result.error || 'Unknown error'}`;
    }
  }

  if (name === 'connect') {
    const connName = args.name as string;
    await connectionManager!.connect(connName);
    const config = connectionManager!.getConnectionConfig(connName);
    return `✅ Connected to '${connName}' (mode: ${config.mode})`;
  }

  if (name === 'disconnect') {
    const connName = args.name as string;
    if (await connectionManager!.disconnect(connName)) {
      return `✅ Disconnected from '${connName}'`;
    } else {
      return `ℹ️ Connection '${connName}' was not active`;
    }
  }

  // Query execution tools
  if (name === 'execute_query') {
    const connName = args.connection as string;
    const sql = args.sql as string;
    const maxRows = (args.max_rows as number) || 100;
    const outputFormat = (args.format as string) || 'markdown';

    const result = await queryExecutor!.executeQuery(connName, sql, maxRows);

    if (outputFormat === 'json') {
      return formatQueryResultJson(result);
    }
    return formatQueryResultMarkdown(result);
  }

  if (name === 'execute_dml') {
    const connName = args.connection as string;
    const sql = args.sql as string;
    const commit = args.commit !== false;

    const result = await queryExecutor!.executeDml(connName, sql, undefined, commit);
    return formatQueryResultMarkdown(result);
  }

  if (name === 'execute_plsql') {
    const connName = args.connection as string;
    const plsql = args.plsql as string;
    const commit = args.commit !== false;

    const result = await queryExecutor!.executePlsql(connName, plsql, undefined, commit);
    return formatQueryResultMarkdown(result);
  }

  if (name === 'execute_procedure') {
    const connName = args.connection as string;
    const procedure = args.procedure as string;
    const params = args.params as Record<string, unknown> | undefined;
    const outParamsSpec = args.out_params as Record<string, 'string' | 'int' | 'float'> | undefined;

    const result = await queryExecutor!.executeProcedure(connName, procedure, params, outParamsSpec);
    return formatQueryResultMarkdown(result);
  }

  // Schema browsing tools
  if (name === 'list_tables') {
    const connName = args.connection as string;
    const schema = args.schema as string | undefined;
    const filterPattern = args.filter as string | undefined;
    const includeViews = args.include_views !== false;

    const tables = await schemaBrowser!.listTables(connName, schema, filterPattern, includeViews);
    return formatTablesList(tables, schema);
  }

  if (name === 'describe_table') {
    const connName = args.connection as string;
    const table = args.table as string;
    const schema = args.schema as string | undefined;
    const includeRowCount = (args.include_row_count as boolean) || false;
    const outputFormat = (args.format as string) || 'markdown';

    const tableInfo = await schemaBrowser!.describeTable(
      connName,
      table,
      schema,
      true,
      true,
      includeRowCount
    );

    if (outputFormat === 'json') {
      return formatTableInfoJson(tableInfo);
    }
    return formatTableInfoMarkdown(tableInfo);
  }

  if (name === 'list_procedures') {
    const connName = args.connection as string;
    const schema = args.schema as string | undefined;
    const filterPattern = args.filter as string | undefined;
    const objType = args.type as string | undefined;

    const procedures = await schemaBrowser!.listProcedures(connName, schema, filterPattern, objType);
    return formatProceduresList(procedures, schema);
  }

  if (name === 'get_procedure_source') {
    const connName = args.connection as string;
    const objName = args.name as string;
    const objType = (args.type as string) || 'PROCEDURE';
    const schema = args.schema as string | undefined;

    const source = await schemaBrowser!.getObjectSource(connName, objName, objType, schema);

    if (source) {
      return `## Source: \`${objName}\` (${objType})\n\n\`\`\`sql\n${source}\n\`\`\``;
    } else {
      return `❌ Source not found for ${objType} '${objName}'`;
    }
  }

  if (name === 'get_procedure_params') {
    const connName = args.connection as string;
    const procedure = args.procedure as string;
    const schema = args.schema as string | undefined;

    const params = await schemaBrowser!.getProcedureParams(connName, procedure, schema);
    return formatProcedureParams(params, procedure);
  }

  if (name === 'explain_query') {
    const connName = args.connection as string;
    const sql = args.sql as string;

    const plan = await schemaBrowser!.explainPlan(connName, sql);
    return formatExplainPlan(plan);
  }

  // Transaction tools
  if (name === 'commit') {
    const connName = args.connection as string;
    const result = await queryExecutor!.commit(connName);
    return formatQueryResultMarkdown(result);
  }

  if (name === 'rollback') {
    const connName = args.connection as string;
    const result = await queryExecutor!.rollback(connName);
    return formatQueryResultMarkdown(result);
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ============================================================================
// MCP Server Setup
// ============================================================================

async function main(): Promise<void> {
  const server = new Server(
    {
      name: 'oracle-db-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;

    try {
      const result = await executeTool(name, (args || {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`Error executing tool '${name}':`, error);
      return {
        content: [{ type: 'text', text: `❌ Error: ${error}` }],
        isError: true,
      };
    }
  });

  // List resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    if (!connectionManager) {
      initializeFromConfig();
    }

    const connections = await connectionManager!.listConnections();
    return {
      resources: connections.map(conn => ({
        uri: `oracle://connection/${conn.name}`,
        name: `Connection: ${conn.name}`,
        description: `Oracle database connection '${conn.name}' (${conn.mode})`,
        mimeType: 'application/json',
      })),
    };
  });

  // List resource templates
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'oracle://connection/{name}',
          name: 'Database Connection',
          description: 'Get information about a specific database connection',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'oracle://table/{connection}/{schema}/{table}',
          name: 'Table Information',
          description: 'Get schema information for a specific table',
          mimeType: 'application/json',
        },
      ],
    };
  });

  // Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const { uri } = request.params;

    if (!connectionManager || !schemaBrowser) {
      initializeFromConfig();
    }

    // Parse URI
    if (uri.startsWith('oracle://connection/')) {
      const connName = uri.replace('oracle://connection/', '');
      const result = await connectionManager!.testConnection(connName);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (uri.startsWith('oracle://table/')) {
      const parts = uri.replace('oracle://table/', '').split('/');
      if (parts.length === 3) {
        const [connName, schema, table] = parts;
        const tableInfo = await schemaBrowser!.describeTable(connName, table, schema);
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: formatTableInfoJson(tableInfo),
            },
          ],
        };
      }
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ error: `Unknown resource: ${uri}` }),
        },
      ],
    };
  });

  // Start server
  console.error('Starting Oracle MCP Server...');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Oracle MCP Server running on stdio');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.error('Shutting down...');
    if (connectionManager) {
      await connectionManager.disconnectAll();
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('Shutting down...');
    if (connectionManager) {
      await connectionManager.disconnectAll();
    }
    process.exit(0);
  });
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

