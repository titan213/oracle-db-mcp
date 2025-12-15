/**
 * Type definitions for Oracle MCP Server
 */

// ============================================================================
// Enums
// ============================================================================

export enum ConnectionMode {
  READONLY = 'readonly',
  READWRITE = 'readwrite',
}

export enum OracleClientMode {
  THIN = 'thin',
  THICK = 'thick',
}

export enum QueryType {
  SELECT = 'select',
  INSERT = 'insert',
  UPDATE = 'update',
  DELETE = 'delete',
  DDL = 'ddl',
  PLSQL = 'plsql',
  OTHER = 'other',
}

export enum DangerLevel {
  SAFE = 'safe',
  MODERATE = 'moderate',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// ============================================================================
// Configuration Interfaces
// ============================================================================

export interface ConnectionConfig {
  name: string;
  username: string;
  mode: ConnectionMode;
  // Connection details - either use host/port/service or connectionString
  host?: string;
  port?: number;
  serviceName?: string;
  sid?: string;
  connectionString?: string;
  // Password - either direct or from environment variable
  password?: string;
  passwordEnv?: string;
}

export interface ServerConfig {
  oracleClientMode: OracleClientMode;
  oracleClientPath?: string;
  defaultMaxRows: number;
  queryTimeout: number;
  connections: ConnectionConfig[];
}

// ============================================================================
// Query Result Interfaces
// ============================================================================

export interface QueryResult {
  success: boolean;
  queryType: QueryType;
  message: string;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  affectedRows?: number;
  executionTime?: number;
  warnings?: string[];
  error?: string;
  outputParams?: Record<string, unknown>;
}

// ============================================================================
// Schema Browser Interfaces
// ============================================================================

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  dataLength?: number;
  dataPrecision?: number;
  dataScale?: number;
  defaultValue?: string;
  columnId: number;
  comments?: string;
}

export interface ConstraintInfo {
  name: string;
  constraintType: string;
  columns: string[];
  status: string;
  searchCondition?: string;
  rConstraintName?: string;
}

export interface IndexInfo {
  name: string;
  indexType: string;
  columns: string[];
  uniqueness: string;
  status: string;
}

export interface TableInfo {
  name: string;
  owner: string;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
  rowCount?: number;
  comments?: string;
}

export interface SchemaObject {
  name: string;
  type: string;
  owner: string;
  status: string;
  created?: string;
  lastModified?: string;
}

export interface ProcedureParam {
  name: string;
  position: number;
  dataType: string;
  direction: string;
  length?: number;
  precision?: number;
  scale?: number;
  hasDefault: boolean;
}

export interface ExplainPlanStep {
  id: number;
  parentId?: number;
  operation: string;
  object?: string;
  cost?: number;
  rows?: number;
  bytes?: number;
  accessPredicates?: string;
  filterPredicates?: string;
}

// ============================================================================
// Connection Info
// ============================================================================

export interface ConnectionInfo {
  name: string;
  host?: string;
  port?: number;
  service?: string;
  username: string;
  mode: string;
  connected: boolean;
}

export interface ConnectionTestResult {
  success: boolean;
  name: string;
  database?: string;
  schema?: string;
  version?: string;
  mode?: string;
  error?: string;
  message: string;
}

