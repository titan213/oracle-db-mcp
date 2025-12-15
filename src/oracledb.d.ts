/**
 * Type declarations for oracledb module
 * 
 * The oracledb package includes its own types, but they may not be
 * properly detected in all TypeScript configurations.
 */

declare module 'oracledb' {
  export interface Connection {
    ping(): Promise<void>;
    execute<T = unknown[]>(
      sql: string,
      bindParams?: Record<string, unknown> | unknown[],
      options?: ExecuteOptions
    ): Promise<Result<T>>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
  }

  export interface Result<T = unknown[]> {
    rows?: T[];
    rowsAffected?: number;
    metaData?: MetaData[];
    outBinds?: Record<string, unknown>;
  }

  export interface MetaData {
    name: string;
  }

  export interface ExecuteOptions {
    autoCommit?: boolean;
    maxRows?: number;
    outFormat?: number;
  }

  export interface BindParameter {
    val?: unknown;
    dir?: number;
    type?: number;
    maxSize?: number;
  }

  export interface InitOracleClientOptions {
    libDir?: string;
  }

  export interface ConnectionOptions {
    user: string;
    password: string;
    connectString: string;
  }

  export function getConnection(options: ConnectionOptions): Promise<Connection>;
  export function initOracleClient(options?: InitOracleClientOptions): void;

  export const OUT_FORMAT_ARRAY: number;
  export const OUT_FORMAT_OBJECT: number;
  export const BIND_IN: number;
  export const BIND_OUT: number;
  export const BIND_INOUT: number;
  export const STRING: number;
  export const NUMBER: number;
  export const DATE: number;
  export const CURSOR: number;
  export const BUFFER: number;
  export const CLOB: number;
  export const BLOB: number;
}

