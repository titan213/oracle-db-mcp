/**
 * Query Executor for Oracle MCP Server
 *
 * Handles SQL query execution with safety checks, transaction management,
 * and result formatting.
 */

import oracledb from 'oracledb';
import { ConnectionManager } from './connection-manager.js';
import {
  QueryResult,
  QueryType,
  DangerLevel,
  ConnectionMode,
} from './types.js';

// ============================================================================
// Query Type Detection
// ============================================================================

const DANGEROUS_PATTERNS = {
  drop: /\bDROP\s+(TABLE|INDEX|VIEW|SEQUENCE|PROCEDURE|FUNCTION|PACKAGE|TRIGGER|SYNONYM|DATABASE|USER|TABLESPACE)\b/i,
  truncate: /\bTRUNCATE\s+TABLE\b/i,
  alterSystem: /\bALTER\s+SYSTEM\b/i,
  grant: /\bGRANT\s+/i,
  revoke: /\bREVOKE\s+/i,
};

export function detectQueryType(sql: string): QueryType {
  const sqlStripped = sql.trim().toUpperCase();

  if (sqlStripped.startsWith('SELECT')) {
    return QueryType.SELECT;
  } else if (sqlStripped.startsWith('INSERT')) {
    return QueryType.INSERT;
  } else if (sqlStripped.startsWith('UPDATE')) {
    return QueryType.UPDATE;
  } else if (sqlStripped.startsWith('DELETE')) {
    return QueryType.DELETE;
  } else if (['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE'].some(kw => sqlStripped.startsWith(kw))) {
    return QueryType.DDL;
  } else if (['BEGIN', 'DECLARE'].some(kw => sqlStripped.startsWith(kw)) || sqlStripped.includes('CREATE OR REPLACE')) {
    return QueryType.PLSQL;
  }
  return QueryType.OTHER;
}

export function assessDangerLevel(sql: string, queryType: QueryType): { level: DangerLevel; warnings: string[] } {
  const warnings: string[] = [];

  if (queryType === QueryType.SELECT) {
    return { level: DangerLevel.SAFE, warnings };
  }

  // Check for dangerous patterns
  if (DANGEROUS_PATTERNS.drop.test(sql)) {
    warnings.push('⚠️ DROP statement detected - this will permanently remove objects');
    return { level: DangerLevel.CRITICAL, warnings };
  }

  if (DANGEROUS_PATTERNS.truncate.test(sql)) {
    warnings.push('⚠️ TRUNCATE statement detected - this will remove all data from the table');
    return { level: DangerLevel.CRITICAL, warnings };
  }

  if (DANGEROUS_PATTERNS.alterSystem.test(sql)) {
    warnings.push('⚠️ ALTER SYSTEM detected - this modifies database configuration');
    return { level: DangerLevel.CRITICAL, warnings };
  }

  // Check for UPDATE/DELETE without WHERE
  if (queryType === QueryType.DELETE) {
    if (!sql.toUpperCase().includes('WHERE')) {
      warnings.push('⚠️ DELETE without WHERE clause - this will delete ALL rows in the table');
      return { level: DangerLevel.HIGH, warnings };
    }
  }

  if (queryType === QueryType.UPDATE) {
    if (!sql.toUpperCase().includes('WHERE')) {
      warnings.push('⚠️ UPDATE without WHERE clause - this will update ALL rows in the table');
      return { level: DangerLevel.HIGH, warnings };
    }
  }

  if (queryType === QueryType.DDL) {
    warnings.push('ℹ️ DDL statement - schema changes will be made');
    return { level: DangerLevel.HIGH, warnings };
  }

  if ([QueryType.INSERT, QueryType.UPDATE, QueryType.DELETE].includes(queryType)) {
    return { level: DangerLevel.MODERATE, warnings };
  }

  return { level: DangerLevel.SAFE, warnings };
}

// ============================================================================
// Query Executor Class
// ============================================================================

export class QueryExecutor {
  private connectionManager: ConnectionManager;
  private defaultMaxRows: number;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
    this.defaultMaxRows = connectionManager.getServerConfig().defaultMaxRows;
  }

  async executeQuery(
    connectionName: string,
    sql: string,
    maxRows?: number,
    params?: Record<string, unknown>
  ): Promise<QueryResult> {
    const queryType = detectQueryType(sql);

    if (queryType !== QueryType.SELECT) {
      return {
        success: false,
        queryType,
        message: 'execute_query only supports SELECT statements. Use execute_dml for other operations.',
        error: 'Invalid query type',
      };
    }

    maxRows = maxRows || this.defaultMaxRows;

    try {
      const connection = await this.connectionManager.getConnection(connectionName);

      const startTime = Date.now();

      const result = await connection.execute<unknown[]>(sql, params || {}, {
        maxRows: maxRows + 1,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
      });

      const executionTime = (Date.now() - startTime) / 1000;

      // Get column names
      const columns = result.metaData?.map((col: { name: string }) => col.name) || [];

      // Check if there are more rows
      const rows = result.rows || [];
      const hasMore = rows.length > maxRows;
      const resultRows = hasMore ? rows.slice(0, maxRows) : rows;

      const warnings: string[] = [];
      if (hasMore) {
        warnings.push(`ℹ️ Results limited to ${maxRows} rows. More rows available.`);
      }

      return {
        success: true,
        queryType,
        message: `Query executed successfully. Found ${resultRows.length} row(s).`,
        columns,
        rows: resultRows,
        rowCount: resultRows.length,
        executionTime,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`Query execution failed: ${error}`);

      return {
        success: false,
        queryType,
        message: `Query failed: ${error}`,
        error,
      };
    }
  }

  async executeDml(
    connectionName: string,
    sql: string,
    params?: Record<string, unknown>,
    commit = true
  ): Promise<QueryResult> {
    const queryType = detectQueryType(sql);

    // Check connection mode
    const config = this.connectionManager.getConnectionConfig(connectionName);
    if (config.mode === ConnectionMode.READONLY) {
      return {
        success: false,
        queryType,
        message: `Connection '${connectionName}' is configured as READ ONLY. DML operations are not allowed.`,
        error: 'Connection is read-only',
      };
    }

    // Assess danger level
    const { level: dangerLevel, warnings } = assessDangerLevel(sql, queryType);

    if (dangerLevel === DangerLevel.CRITICAL) {
      return {
        success: false,
        queryType,
        message: 'This operation is blocked for safety. ' + warnings.join(' '),
        error: 'Dangerous operation blocked',
        warnings,
      };
    }

    try {
      const connection = await this.connectionManager.getConnection(connectionName);

      const startTime = Date.now();

      const result = await connection.execute(sql, params || {}, {
        autoCommit: false,
      });

      const affectedRows = result.rowsAffected || 0;
      const executionTime = (Date.now() - startTime) / 1000;

      let commitMsg: string;
      if (commit) {
        await connection.commit();
        commitMsg = 'Changes committed.';
      } else {
        commitMsg = 'Changes NOT committed (auto-commit disabled).';
      }

      return {
        success: true,
        queryType,
        message: `Statement executed successfully. ${affectedRows} row(s) affected. ${commitMsg}`,
        affectedRows,
        executionTime,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`DML execution failed: ${error}`);

      // Rollback on error
      try {
        const connection = await this.connectionManager.getConnection(connectionName);
        await connection.rollback();
      } catch {
        // Ignore rollback errors
      }

      return {
        success: false,
        queryType,
        message: `Statement failed: ${error}`,
        error,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  }

  async executePlsql(
    connectionName: string,
    plsql: string,
    params?: Record<string, unknown>,
    commit = true
  ): Promise<QueryResult> {
    const queryType = detectQueryType(plsql);

    // Check connection mode
    const config = this.connectionManager.getConnectionConfig(connectionName);
    if (config.mode === ConnectionMode.READONLY) {
      return {
        success: false,
        queryType,
        message: `Connection '${connectionName}' is configured as READ ONLY. PL/SQL execution is not allowed.`,
        error: 'Connection is read-only',
      };
    }

    // Assess danger level
    const { level: dangerLevel, warnings } = assessDangerLevel(plsql, queryType);

    if (dangerLevel === DangerLevel.CRITICAL) {
      // Check if it's a CREATE/ALTER for procedures/functions (allow these)
      const allowedCreate = /\bCREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|VIEW)\b/i;
      if (!allowedCreate.test(plsql)) {
        return {
          success: false,
          queryType,
          message: 'This operation is blocked for safety. ' + warnings.join(' '),
          error: 'Dangerous operation blocked',
          warnings,
        };
      }
    }

    try {
      const connection = await this.connectionManager.getConnection(connectionName);

      const startTime = Date.now();

      await connection.execute(plsql, params || {}, {
        autoCommit: false,
      });

      const executionTime = (Date.now() - startTime) / 1000;

      if (commit) {
        await connection.commit();
      }

      // Check for compilation errors (for CREATE statements)
      let compilationStatus: string | undefined;
      if (plsql.toUpperCase().includes('CREATE')) {
        const match = plsql.match(
          /CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\s+(\w+)/i
        );
        if (match) {
          const objType = match[2].toUpperCase();
          const objName = match[3].toUpperCase();

          const statusResult = await connection.execute<[string]>(
            'SELECT status FROM user_objects WHERE object_name = :name AND object_type = :type',
            { name: objName, type: objType }
          );

          if (statusResult.rows && statusResult.rows.length > 0) {
            compilationStatus = statusResult.rows[0][0];
            if (compilationStatus !== 'VALID') {
              // Get compilation errors
              const errorsResult = await connection.execute<[number, number, string]>(
                `SELECT line, position, text FROM user_errors 
                 WHERE name = :name AND type = :type 
                 ORDER BY sequence`,
                { name: objName, type: objType }
              );

              if (errorsResult.rows && errorsResult.rows.length > 0) {
                const errorDetails = errorsResult.rows
                  .map((row: [number, number, string]) => `  Line ${row[0]}, Col ${row[1]}: ${row[2]}`)
                  .join('\n');

                return {
                  success: false,
                  queryType,
                  message: `PL/SQL compiled with errors:\n${errorDetails}`,
                  error: `Compilation failed for ${objType} ${objName}`,
                  executionTime,
                };
              }
            }
          }
        }
      }

      const statusMsg = compilationStatus ? ` Object status: ${compilationStatus}.` : '';

      return {
        success: true,
        queryType,
        message: `PL/SQL executed successfully.${statusMsg}`,
        executionTime,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`PL/SQL execution failed: ${error}`);

      return {
        success: false,
        queryType,
        message: `PL/SQL execution failed: ${error}`,
        error,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  }

  async executeProcedure(
    connectionName: string,
    procedureName: string,
    params?: Record<string, unknown>,
    outParams?: Record<string, 'string' | 'int' | 'float'>
  ): Promise<QueryResult> {
    const config = this.connectionManager.getConnectionConfig(connectionName);

    const warnings: string[] = [];
    if (config.mode === ConnectionMode.READONLY) {
      warnings.push(
        "ℹ️ Connection is READ ONLY. Procedure will fail if it attempts to modify data."
      );
    }

    try {
      const connection = await this.connectionManager.getConnection(connectionName);

      // Build bind parameters
      const bindParams: Record<string, oracledb.BindParameter> = {};

      // Add input parameters
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          bindParams[name] = { val: value, dir: oracledb.BIND_IN };
        }
      }

      // Add output parameters
      if (outParams) {
        for (const [name, typeStr] of Object.entries(outParams)) {
          let type: number;
          let maxSize: number | undefined;

          switch (typeStr) {
            case 'string':
              type = oracledb.STRING;
              maxSize = 4000;
              break;
            case 'int':
            case 'float':
              type = oracledb.NUMBER;
              break;
            default:
              type = oracledb.STRING;
              maxSize = 4000;
          }

          bindParams[name] = {
            dir: oracledb.BIND_OUT,
            type,
            maxSize,
          };
        }
      }

      const startTime = Date.now();

      // Build the PL/SQL call
      const paramNames = Object.keys(bindParams);
      const paramList = paramNames.map(name => `${name} => :${name}`).join(', ');
      const plsqlCall = `BEGIN ${procedureName}(${paramList}); END;`;

      const result = await connection.execute(plsqlCall, bindParams);

      const executionTime = (Date.now() - startTime) / 1000;

      // Get output values
      const outputValues: Record<string, unknown> = {};
      if (outParams) {
        for (const name of Object.keys(outParams)) {
          outputValues[name] = (result.outBinds as Record<string, unknown>)?.[name];
        }
      }

      await connection.commit();

      return {
        success: true,
        queryType: QueryType.PLSQL,
        message: `Procedure '${procedureName}' executed successfully.`,
        executionTime,
        outputParams: Object.keys(outputValues).length > 0 ? outputValues : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`Procedure execution failed: ${error}`);

      return {
        success: false,
        queryType: QueryType.PLSQL,
        message: `Procedure '${procedureName}' failed: ${error}`,
        error,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  }

  async rollback(connectionName: string): Promise<QueryResult> {
    try {
      const connection = await this.connectionManager.getConnection(connectionName);
      await connection.rollback();

      return {
        success: true,
        queryType: QueryType.OTHER,
        message: `Transaction rolled back on '${connectionName}'.`,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);

      return {
        success: false,
        queryType: QueryType.OTHER,
        message: `Rollback failed: ${error}`,
        error,
      };
    }
  }

  async commit(connectionName: string): Promise<QueryResult> {
    const config = this.connectionManager.getConnectionConfig(connectionName);
    if (config.mode === ConnectionMode.READONLY) {
      return {
        success: false,
        queryType: QueryType.OTHER,
        message: `Connection '${connectionName}' is READ ONLY. Cannot commit.`,
        error: 'Connection is read-only',
      };
    }

    try {
      const connection = await this.connectionManager.getConnection(connectionName);
      await connection.commit();

      return {
        success: true,
        queryType: QueryType.OTHER,
        message: `Transaction committed on '${connectionName}'.`,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);

      return {
        success: false,
        queryType: QueryType.OTHER,
        message: `Commit failed: ${error}`,
        error,
      };
    }
  }
}

