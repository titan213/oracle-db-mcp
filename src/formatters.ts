/**
 * Result Formatters for Oracle MCP Server
 *
 * Provides formatting utilities for query results and schema information
 * in various formats (Markdown tables, JSON, plain text).
 */

import {
  QueryResult,
  TableInfo,
  ColumnInfo,
  ConnectionInfo,
  SchemaObject,
  ProcedureParam,
  ExplainPlanStep,
} from './types.js';

// ============================================================================
// Value Serialization
// ============================================================================

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (Buffer.isBuffer(value)) {
    return `<BLOB: ${value.length} bytes>`;
  }
  // Handle LOB objects
  if (typeof value === 'object' && value !== null && 'getData' in value) {
    return '<LOB>';
  }
  return value;
}

function padRight(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function padLeft(str: string, len: number): string {
  return ' '.repeat(Math.max(0, len - str.length)) + str;
}

// ============================================================================
// Markdown Table Generator
// ============================================================================

function createMarkdownTable(
  headers: string[],
  rows: string[][],
  alignments?: ('left' | 'right' | 'center')[]
): string {
  if (headers.length === 0) {
    return '';
  }

  // Calculate column widths
  const colWidths = headers.map((h, i) => {
    const maxRowWidth = rows.reduce((max, row) => {
      const cellValue = row[i] ?? '';
      return Math.max(max, String(cellValue).length);
    }, 0);
    return Math.max(h.length, maxRowWidth, 3);
  });

  // Header row
  const headerRow = '| ' + headers.map((h, i) => padRight(h, colWidths[i])).join(' | ') + ' |';

  // Separator row with alignment
  const separatorRow =
    '| ' +
    headers
      .map((_, i) => {
        const align = alignments?.[i] || 'left';
        const dashes = '-'.repeat(colWidths[i]);
        if (align === 'right') {
          return dashes.slice(0, -1) + ':';
        } else if (align === 'center') {
          return ':' + dashes.slice(1, -1) + ':';
        }
        return dashes;
      })
      .join(' | ') +
    ' |';

  // Data rows
  const dataRows = rows.map(row => {
    return (
      '| ' +
      row
        .map((cell, i) => {
          const cellStr = String(cell ?? '');
          const align = alignments?.[i] || 'left';
          if (align === 'right') {
            return padLeft(cellStr, colWidths[i]);
          }
          return padRight(cellStr, colWidths[i]);
        })
        .join(' | ') +
      ' |'
    );
  });

  return [headerRow, separatorRow, ...dataRows].join('\n');
}

// ============================================================================
// Query Result Formatters
// ============================================================================

export function formatQueryResultMarkdown(result: QueryResult): string {
  const lines: string[] = [];

  // Status indicator
  if (result.success) {
    lines.push(`✅ **${result.message}**`);
  } else {
    lines.push(`❌ **${result.message}**`);
  }

  // Add warnings if any
  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    for (const warning of result.warnings) {
      lines.push(warning);
    }
  }

  // Add error details if failed
  if (result.error && !result.success) {
    lines.push('');
    lines.push('```');
    lines.push(result.error);
    lines.push('```');
  }

  // Add results table if we have data
  if (result.columns && result.rows && result.rows.length > 0) {
    lines.push('');

    // Convert rows to string format
    const formattedRows = result.rows.map(row =>
      (row as unknown[]).map(v => String(serializeValue(v) ?? ''))
    );

    const table = createMarkdownTable(result.columns, formattedRows);
    lines.push(table);
  }

  // Add output parameters if present
  if (result.outputParams && Object.keys(result.outputParams).length > 0) {
    lines.push('');
    lines.push('**Output Parameters:**');
    for (const [name, value] of Object.entries(result.outputParams)) {
      lines.push(`- \`${name}\`: ${serializeValue(value)}`);
    }
  }

  // Add execution time
  if (result.executionTime && result.executionTime > 0) {
    lines.push('');
    lines.push(`*Execution time: ${result.executionTime.toFixed(3)}s*`);
  }

  // Add affected rows for DML
  if (result.affectedRows && result.affectedRows > 0) {
    lines.push(`*Rows affected: ${result.affectedRows}*`);
  }

  return lines.join('\n');
}

export function formatQueryResultJson(result: QueryResult): string {
  const data: Record<string, unknown> = {
    success: result.success,
    message: result.message,
    queryType: result.queryType,
  };

  if (result.columns && result.rows && result.rows.length > 0) {
    data.columns = result.columns;
    data.rowCount = result.rowCount;
    data.rows = result.rows.map(row => {
      const obj: Record<string, unknown> = {};
      result.columns!.forEach((col, i) => {
        obj[col] = serializeValue((row as unknown[])[i]);
      });
      return obj;
    });
  }

  if (result.affectedRows && result.affectedRows > 0) {
    data.affectedRows = result.affectedRows;
  }

  if (result.outputParams) {
    data.outputParams = Object.fromEntries(
      Object.entries(result.outputParams).map(([k, v]) => [k, serializeValue(v)])
    );
  }

  if (result.warnings && result.warnings.length > 0) {
    data.warnings = result.warnings;
  }

  if (result.error) {
    data.error = result.error;
  }

  if (result.executionTime && result.executionTime > 0) {
    data.executionTime = `${result.executionTime.toFixed(3)}s`;
  }

  return JSON.stringify(data, null, 2);
}

// ============================================================================
// Table Info Formatters
// ============================================================================

function formatDataType(col: ColumnInfo): string {
  let dataType = col.dataType;

  if (['VARCHAR2', 'CHAR', 'NVARCHAR2', 'NCHAR', 'RAW'].includes(col.dataType)) {
    if (col.dataLength) {
      dataType = `${col.dataType}(${col.dataLength})`;
    }
  } else if (col.dataType === 'NUMBER') {
    if (col.dataPrecision) {
      if (col.dataScale && col.dataScale > 0) {
        dataType = `NUMBER(${col.dataPrecision},${col.dataScale})`;
      } else {
        dataType = `NUMBER(${col.dataPrecision})`;
      }
    }
  } else if (['FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE'].includes(col.dataType)) {
    if (col.dataPrecision) {
      dataType = `${col.dataType}(${col.dataPrecision})`;
    }
  }

  return dataType;
}

export function formatTableInfoMarkdown(tableInfo: TableInfo): string {
  const lines: string[] = [];

  // Header
  lines.push(`## Table: \`${tableInfo.owner}.${tableInfo.name}\``);
  lines.push('');

  // Table comments
  if (tableInfo.comments) {
    lines.push(`*${tableInfo.comments}*`);
    lines.push('');
  }

  // Row count if available
  if (tableInfo.rowCount !== undefined) {
    lines.push(`**Row count:** ${tableInfo.rowCount.toLocaleString()}`);
    lines.push('');
  }

  // Columns
  lines.push('### Columns');
  lines.push('');

  const columnData = tableInfo.columns.map(col => [
    String(col.columnId),
    col.name,
    formatDataType(col),
    col.nullable ? '✓' : '✗',
    col.defaultValue || '',
    col.comments || '',
  ]);

  const columnTable = createMarkdownTable(
    ['#', 'Column', 'Data Type', 'Nullable', 'Default', 'Comments'],
    columnData
  );
  lines.push(columnTable);

  // Constraints
  if (tableInfo.constraints.length > 0) {
    lines.push('');
    lines.push('### Constraints');
    lines.push('');

    const constraintData = tableInfo.constraints.map(con => {
      const cols = con.columns.join(', ');
      let extra = '';
      if (con.searchCondition) {
        extra = `CHECK: ${con.searchCondition}`;
      } else if (con.rConstraintName) {
        extra = `References: ${con.rConstraintName}`;
      }

      return [con.name, con.constraintType, cols, con.status, extra];
    });

    const constraintTable = createMarkdownTable(
      ['Name', 'Type', 'Columns', 'Status', 'Details'],
      constraintData
    );
    lines.push(constraintTable);
  }

  // Indexes
  if (tableInfo.indexes.length > 0) {
    lines.push('');
    lines.push('### Indexes');
    lines.push('');

    const indexData = tableInfo.indexes.map(idx => {
      const cols = idx.columns.join(', ');
      return [idx.name, idx.indexType, idx.uniqueness, cols, idx.status];
    });

    const indexTable = createMarkdownTable(
      ['Name', 'Type', 'Unique', 'Columns', 'Status'],
      indexData
    );
    lines.push(indexTable);
  }

  return lines.join('\n');
}

export function formatTableInfoJson(tableInfo: TableInfo): string {
  const data = {
    name: tableInfo.name,
    owner: tableInfo.owner,
    comments: tableInfo.comments,
    rowCount: tableInfo.rowCount,
    columns: tableInfo.columns.map(col => ({
      name: col.name,
      dataType: formatDataType(col),
      nullable: col.nullable,
      default: col.defaultValue,
      comments: col.comments,
      position: col.columnId,
    })),
    constraints: tableInfo.constraints.map(con => ({
      name: con.name,
      type: con.constraintType,
      columns: con.columns,
      status: con.status,
      searchCondition: con.searchCondition,
      references: con.rConstraintName,
    })),
    indexes: tableInfo.indexes.map(idx => ({
      name: idx.name,
      type: idx.indexType,
      uniqueness: idx.uniqueness,
      columns: idx.columns,
      status: idx.status,
    })),
  };

  return JSON.stringify(data, null, 2);
}

// ============================================================================
// Connection List Formatter
// ============================================================================

export function formatConnectionsList(connections: ConnectionInfo[]): string {
  const lines = ['## Configured Database Connections', ''];

  if (connections.length === 0) {
    lines.push('*No connections configured.*');
    return lines.join('\n');
  }

  const tableData = connections.map(conn => {
    const status = conn.connected ? '🟢 Connected' : '⚪ Not connected';
    const mode = conn.mode === 'readonly' ? '🔒 Read-only' : '🔓 Read-write';

    let hostInfo = conn.host || '';
    if (conn.port) {
      hostInfo += `:${conn.port}`;
    }

    return [conn.name, hostInfo, conn.service || '', conn.username, mode, status];
  });

  const table = createMarkdownTable(
    ['Name', 'Host', 'Service', 'User', 'Mode', 'Status'],
    tableData
  );
  lines.push(table);

  return lines.join('\n');
}

// ============================================================================
// Tables List Formatter
// ============================================================================

export function formatTablesList(tables: SchemaObject[], schema?: string): string {
  const header = schema ? `## Tables in \`${schema}\`` : '## Tables';
  const lines = [header, ''];

  if (tables.length === 0) {
    lines.push('*No tables found.*');
    return lines.join('\n');
  }

  const tableData = tables.map(tbl => {
    const typeIcon = tbl.type === 'TABLE' ? '📊' : '👁️';
    return [typeIcon, tbl.name, tbl.type, tbl.status, tbl.lastModified || ''];
  });

  const table = createMarkdownTable(['', 'Name', 'Type', 'Status', 'Last Modified'], tableData);
  lines.push(table);
  lines.push('');
  lines.push(`*Total: ${tables.length} object(s)*`);

  return lines.join('\n');
}

// ============================================================================
// Procedures List Formatter
// ============================================================================

export function formatProceduresList(procedures: SchemaObject[], schema?: string): string {
  const header = schema
    ? `## Procedures/Functions in \`${schema}\``
    : '## Procedures/Functions';
  const lines = [header, ''];

  if (procedures.length === 0) {
    lines.push('*No procedures or functions found.*');
    return lines.join('\n');
  }

  const typeIconMap: Record<string, string> = {
    PROCEDURE: '⚙️',
    FUNCTION: '𝑓',
    PACKAGE: '📦',
    'PACKAGE BODY': '📦',
  };

  const tableData = procedures.map(proc => {
    const typeIcon = typeIconMap[proc.type] || '';
    const statusIcon = proc.status === 'VALID' ? '✅' : '❌';
    return [typeIcon, proc.name, proc.type, statusIcon, proc.lastModified || ''];
  });

  const table = createMarkdownTable(['', 'Name', 'Type', 'Valid', 'Last Modified'], tableData);
  lines.push(table);
  lines.push('');
  lines.push(`*Total: ${procedures.length} object(s)*`);

  return lines.join('\n');
}

// ============================================================================
// Explain Plan Formatter
// ============================================================================

export function formatExplainPlan(plan: ExplainPlanStep[]): string {
  const lines = ['## Execution Plan', ''];

  if (plan.length === 0) {
    lines.push('*No execution plan available.*');
    return lines.join('\n');
  }

  const tableData = plan.map(step => [
    String(step.id),
    step.operation,
    step.object || '',
    step.cost !== undefined ? String(step.cost) : '',
    step.rows !== undefined ? String(step.rows) : '',
  ]);

  const table = createMarkdownTable(
    ['ID', 'Operation', 'Object', 'Cost', 'Rows'],
    tableData,
    ['right', 'left', 'left', 'right', 'right']
  );
  lines.push(table);

  // Add predicates if any
  const hasPredicates = plan.some(step => step.accessPredicates || step.filterPredicates);

  if (hasPredicates) {
    lines.push('');
    lines.push('### Predicates');
    for (const step of plan) {
      if (step.accessPredicates) {
        lines.push(`- **Step ${step.id} Access:** ${step.accessPredicates}`);
      }
      if (step.filterPredicates) {
        lines.push(`- **Step ${step.id} Filter:** ${step.filterPredicates}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Procedure Parameters Formatter
// ============================================================================

export function formatProcedureParams(params: ProcedureParam[], procName: string): string {
  const lines = [`## Parameters for \`${procName}\``, ''];

  if (params.length === 0) {
    lines.push('*No parameters (procedure takes no arguments).*');
    return lines.join('\n');
  }

  const directionIconMap: Record<string, string> = {
    IN: '➡️',
    OUT: '⬅️',
    'IN/OUT': '↔️',
  };

  const tableData = params.map(param => {
    const directionIcon = directionIconMap[param.direction] || '';

    let dataType = param.dataType;
    if (param.length) {
      dataType += `(${param.length})`;
    } else if (param.precision) {
      if (param.scale) {
        dataType += `(${param.precision},${param.scale})`;
      } else {
        dataType += `(${param.precision})`;
      }
    }

    return [
      String(param.position),
      param.name,
      `${directionIcon} ${param.direction}`,
      dataType,
      param.hasDefault ? 'Yes' : 'No',
    ];
  });

  const table = createMarkdownTable(
    ['#', 'Name', 'Direction', 'Data Type', 'Has Default'],
    tableData
  );
  lines.push(table);

  return lines.join('\n');
}

