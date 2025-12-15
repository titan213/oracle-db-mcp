/**
 * Schema Browser for Oracle MCP Server
 *
 * Provides functionality to explore database schema objects including
 * tables, views, procedures, functions, and their structures.
 */

import { ConnectionManager } from './connection-manager.js';
import {
  TableInfo,
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  SchemaObject,
  ProcedureParam,
  ExplainPlanStep,
} from './types.js';

export class SchemaBrowser {
  private connectionManager: ConnectionManager;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;
  }

  async listTables(
    connectionName: string,
    schema?: string,
    filterPattern?: string,
    includeViews = true
  ): Promise<SchemaObject[]> {
    const connection = await this.connectionManager.getConnection(connectionName);

    // Determine schema
    if (!schema) {
      const schemaResult = await connection.execute<[string]>(
        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"
      );
      schema = schemaResult.rows?.[0]?.[0];
    }

    schema = schema?.toUpperCase();

    // Build query
    const objectTypes = includeViews ? "('TABLE', 'VIEW')" : "('TABLE')";

    let sql = `
      SELECT 
        object_name,
        object_type,
        owner,
        status,
        TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') as created,
        TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI:SS') as last_ddl
      FROM all_objects
      WHERE owner = :schema
        AND object_type IN ${objectTypes}
    `;

    const params: Record<string, unknown> = { schema };

    if (filterPattern) {
      sql += ' AND object_name LIKE :pattern';
      params.pattern = filterPattern.toUpperCase();
    }

    sql += ' ORDER BY object_type, object_name';

    const result = await connection.execute<[string, string, string, string, string, string]>(
      sql,
      params
    );

    type TableRow = [string, string, string, string, string, string];
    return (result.rows || []).map((row: TableRow) => ({
      name: row[0],
      type: row[1],
      owner: row[2],
      status: row[3],
      created: row[4],
      lastModified: row[5],
    }));
  }

  async describeTable(
    connectionName: string,
    tableName: string,
    schema?: string,
    includeConstraints = true,
    includeIndexes = true,
    includeRowCount = false
  ): Promise<TableInfo> {
    const connection = await this.connectionManager.getConnection(connectionName);

    // Determine schema
    if (!schema) {
      const schemaResult = await connection.execute<[string]>(
        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"
      );
      schema = schemaResult.rows?.[0]?.[0];
    }

    schema = schema?.toUpperCase();
    tableName = tableName.toUpperCase();

    // Get table comments
    const commentResult = await connection.execute<[string]>(
      `SELECT comments FROM all_tab_comments
       WHERE owner = :schema AND table_name = :tableName`,
      { schema, tableName }
    );
    const tableComments = commentResult.rows?.[0]?.[0];

    // Get column information
    const columnsResult = await connection.execute<
      [string, string, string, number, number, number, string, number, string]
    >(
      `SELECT 
        c.column_name,
        c.data_type,
        c.nullable,
        c.data_length,
        c.data_precision,
        c.data_scale,
        c.data_default,
        c.column_id,
        cc.comments
      FROM all_tab_columns c
      LEFT JOIN all_col_comments cc 
        ON c.owner = cc.owner 
        AND c.table_name = cc.table_name 
        AND c.column_name = cc.column_name
      WHERE c.owner = :schema AND c.table_name = :tableName
      ORDER BY c.column_id`,
      { schema, tableName }
    );

    const columns: ColumnInfo[] = (columnsResult.rows || []).map((row: [string, string, string, number, number, number, string, number, string]) => ({
      name: row[0],
      dataType: row[1],
      nullable: row[2] === 'Y',
      dataLength: row[3],
      dataPrecision: row[4],
      dataScale: row[5],
      defaultValue: row[6]?.trim(),
      columnId: row[7] || 0,
      comments: row[8],
    }));

    // Get constraints
    const constraints: ConstraintInfo[] = [];
    if (includeConstraints) {
      const constraintsResult = await connection.execute<
        [string, string, string, string, string]
      >(
        `SELECT 
          c.constraint_name,
          c.constraint_type,
          c.status,
          c.search_condition,
          c.r_constraint_name
        FROM all_constraints c
        WHERE c.owner = :schema AND c.table_name = :tableName
        ORDER BY 
          CASE c.constraint_type 
            WHEN 'P' THEN 1 
            WHEN 'U' THEN 2 
            WHEN 'R' THEN 3 
            WHEN 'C' THEN 4 
            ELSE 5 
          END`,
        { schema, tableName }
      );

      for (const row of constraintsResult.rows || []) {
        // Get columns for this constraint
        const colsResult = await connection.execute<[string]>(
          `SELECT column_name FROM all_cons_columns
           WHERE owner = :schema 
             AND constraint_name = :constraintName
           ORDER BY position`,
          { schema, constraintName: row[0] }
        );

        const cols = (colsResult.rows || []).map((r: [string]) => r[0]);

        const constraintTypeMap: Record<string, string> = {
          P: 'PRIMARY KEY',
          U: 'UNIQUE',
          R: 'FOREIGN KEY',
          C: 'CHECK',
        };

        constraints.push({
          name: row[0],
          constraintType: constraintTypeMap[row[1]] || row[1],
          status: row[2],
          searchCondition: row[3],
          rConstraintName: row[4],
          columns: cols,
        });
      }
    }

    // Get indexes
    const indexes: IndexInfo[] = [];
    if (includeIndexes) {
      const indexesResult = await connection.execute<[string, string, string, string]>(
        `SELECT 
          i.index_name,
          i.index_type,
          i.uniqueness,
          i.status
        FROM all_indexes i
        WHERE i.owner = :schema AND i.table_name = :tableName
        ORDER BY i.index_name`,
        { schema, tableName }
      );

      for (const row of indexesResult.rows || []) {
        // Get columns for this index
        const colsResult = await connection.execute<[string]>(
          `SELECT column_name FROM all_ind_columns
           WHERE index_owner = :schema 
             AND index_name = :indexName
           ORDER BY column_position`,
          { schema, indexName: row[0] }
        );

        const cols = (colsResult.rows || []).map((r: [string]) => r[0]);

        indexes.push({
          name: row[0],
          indexType: row[1],
          uniqueness: row[2],
          status: row[3],
          columns: cols,
        });
      }
    }

    // Get row count if requested
    let rowCount: number | undefined;
    if (includeRowCount) {
      try {
        const countResult = await connection.execute<[number]>(
          `SELECT COUNT(*) FROM "${schema}"."${tableName}"`
        );
        rowCount = countResult.rows?.[0]?.[0];
      } catch {
        // Might fail for views with errors or restricted tables
      }
    }

    return {
      name: tableName,
      owner: schema || '',
      columns,
      constraints,
      indexes,
      rowCount,
      comments: tableComments,
    };
  }

  async listProcedures(
    connectionName: string,
    schema?: string,
    filterPattern?: string,
    objectType?: string
  ): Promise<SchemaObject[]> {
    const connection = await this.connectionManager.getConnection(connectionName);

    // Determine schema
    if (!schema) {
      const schemaResult = await connection.execute<[string]>(
        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"
      );
      schema = schemaResult.rows?.[0]?.[0];
    }

    schema = schema?.toUpperCase();

    // Build query
    let sql = `
      SELECT 
        object_name,
        object_type,
        owner,
        status,
        TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') as created,
        TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI:SS') as last_ddl
      FROM all_objects
      WHERE owner = :schema
    `;

    const params: Record<string, unknown> = { schema };

    if (objectType) {
      sql += ' AND object_type = :objType';
      params.objType = objectType.toUpperCase();
    } else {
      sql += " AND object_type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY')";
    }

    if (filterPattern) {
      sql += ' AND object_name LIKE :pattern';
      params.pattern = filterPattern.toUpperCase();
    }

    sql += ' ORDER BY object_type, object_name';

    const result = await connection.execute<[string, string, string, string, string, string]>(
      sql,
      params
    );

    type ProcRow = [string, string, string, string, string, string];
    return (result.rows || []).map((row: ProcRow) => ({
      name: row[0],
      type: row[1],
      owner: row[2],
      status: row[3],
      created: row[4],
      lastModified: row[5],
    }));
  }

  async getObjectSource(
    connectionName: string,
    objectName: string,
    objectType = 'PROCEDURE',
    schema?: string
  ): Promise<string | null> {
    const connection = await this.connectionManager.getConnection(connectionName);

    // Determine schema
    if (!schema) {
      const schemaResult = await connection.execute<[string]>(
        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"
      );
      schema = schemaResult.rows?.[0]?.[0];
    }

    schema = schema?.toUpperCase();
    objectName = objectName.toUpperCase();
    objectType = objectType.toUpperCase();

    const result = await connection.execute<[string]>(
      `SELECT text FROM all_source
       WHERE owner = :schema 
         AND name = :objName 
         AND type = :objType
       ORDER BY line`,
      { schema, objName: objectName, objType: objectType }
    );

    const lines = (result.rows || []).map((row: [string]) => row[0]);

    if (lines.length > 0) {
      return lines.join('');
    }
    return null;
  }

  async getProcedureParams(
    connectionName: string,
    procedureName: string,
    schema?: string
  ): Promise<ProcedureParam[]> {
    const connection = await this.connectionManager.getConnection(connectionName);

    // Determine schema
    if (!schema) {
      const schemaResult = await connection.execute<[string]>(
        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"
      );
      schema = schemaResult.rows?.[0]?.[0];
    }

    schema = schema?.toUpperCase();
    procedureName = procedureName.toUpperCase();

    const result = await connection.execute<
      [string, number, string, string, number, number, number, string]
    >(
      `SELECT 
        argument_name,
        position,
        data_type,
        in_out,
        data_length,
        data_precision,
        data_scale,
        defaulted
      FROM all_arguments
      WHERE owner = :schema 
        AND object_name = :procName
        AND argument_name IS NOT NULL
      ORDER BY position`,
      { schema, procName: procedureName }
    );

    type ParamRow = [string, number, string, string, number, number, number, string];
    return (result.rows || []).map((row: ParamRow) => ({
      name: row[0],
      position: row[1],
      dataType: row[2],
      direction: row[3], // IN, OUT, IN/OUT
      length: row[4],
      precision: row[5],
      scale: row[6],
      hasDefault: row[7] === 'Y',
    }));
  }

  async explainPlan(connectionName: string, sql: string): Promise<ExplainPlanStep[]> {
    const connection = await this.connectionManager.getConnection(connectionName);

    // Generate unique statement ID
    const stmtId = 'MCP_' + Math.random().toString(36).substring(2, 12).toUpperCase();

    try {
      // Explain the query
      await connection.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${stmtId}' FOR ${sql}`);

      // Get the plan
      const result = await connection.execute<
        [number, number, string, string, number, number, number, string, string]
      >(
        `SELECT 
          id,
          parent_id,
          LPAD(' ', 2 * (LEVEL - 1)) || operation || 
            CASE WHEN options IS NOT NULL THEN ' (' || options || ')' ELSE '' END as operation,
          object_name,
          cost,
          cardinality,
          bytes,
          access_predicates,
          filter_predicates
        FROM plan_table
        WHERE statement_id = '${stmtId}'
        START WITH parent_id IS NULL
        CONNECT BY PRIOR id = parent_id
        ORDER SIBLINGS BY id`
      );

      type PlanRow = [number, number, string, string, number, number, number, string, string];
      const plan: ExplainPlanStep[] = (result.rows || []).map((row: PlanRow) => ({
        id: row[0],
        parentId: row[1],
        operation: row[2],
        object: row[3],
        cost: row[4],
        rows: row[5],
        bytes: row[6],
        accessPredicates: row[7],
        filterPredicates: row[8],
      }));

      // Clean up plan table
      await connection.execute(`DELETE FROM plan_table WHERE statement_id = '${stmtId}'`);
      await connection.commit();

      return plan;
    } catch (e) {
      // Clean up on error
      try {
        await connection.execute(`DELETE FROM plan_table WHERE statement_id = '${stmtId}'`);
        await connection.commit();
      } catch {
        // Ignore cleanup errors
      }
      throw e;
    }
  }
}

