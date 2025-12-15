/**
 * Connection Manager for Oracle MCP Server
 *
 * Handles database connection lifecycle, configuration loading,
 * and connection pooling for multiple Oracle database instances.
 */

import oracledb from 'oracledb';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  ConnectionConfig,
  ServerConfig,
  ConnectionMode,
  OracleClientMode,
  ConnectionInfo,
  ConnectionTestResult,
} from './types.js';

// ============================================================================
// Configuration Loading
// ============================================================================

function getPassword(config: ConnectionConfig): string {
  if (config.password) {
    return config.password;
  }
  if (config.passwordEnv) {
    const pwd = process.env[config.passwordEnv];
    if (pwd) {
      return pwd;
    }
    throw new Error(
      `Environment variable '${config.passwordEnv}' not set for connection '${config.name}'`
    );
  }
  throw new Error(`No password configured for connection '${config.name}'`);
}

function getDsn(config: ConnectionConfig): string {
  if (config.connectionString) {
    return config.connectionString;
  }

  if (config.host && config.serviceName) {
    return `${config.host}:${config.port || 1521}/${config.serviceName}`;
  } else if (config.host && config.sid) {
    // SID format using Easy Connect
    return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${config.host})(PORT=${config.port || 1521}))(CONNECT_DATA=(SID=${config.sid})))`;
  }

  throw new Error(
    `Connection '${config.name}' requires either connectionString, or host with serviceName/sid`
  );
}

export function loadConfigFromFile(configPath: string): ServerConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const rawConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  return parseConfig(rawConfig);
}

export function loadConfigFromEnv(): ServerConfig {
  // Check for config file path first
  const configFile = process.env.ORACLE_MCP_CONFIG;
  if (configFile && existsSync(configFile)) {
    return loadConfigFromFile(configFile);
  }

  // Build config from individual env vars
  const clientMode = (process.env.ORACLE_CLIENT_MODE || 'thin').toLowerCase();

  const config: ServerConfig = {
    oracleClientMode: clientMode === 'thick' ? OracleClientMode.THICK : OracleClientMode.THIN,
    oracleClientPath: process.env.ORACLE_CLIENT_PATH,
    defaultMaxRows: parseInt(process.env.DEFAULT_MAX_ROWS || '100', 10),
    queryTimeout: parseInt(process.env.QUERY_TIMEOUT || '30', 10),
    connections: [],
  };

  // Check for single connection from env vars
  const connName = process.env.ORACLE_CONNECTION_NAME;
  if (connName) {
    const modeStr = (process.env.ORACLE_MODE || 'readonly').toLowerCase();
    config.connections.push({
      name: connName,
      host: process.env.ORACLE_HOST,
      port: parseInt(process.env.ORACLE_PORT || '1521', 10),
      serviceName: process.env.ORACLE_SERVICE,
      username: process.env.ORACLE_USER || '',
      password: process.env.ORACLE_PASSWORD,
      mode: modeStr === 'readwrite' ? ConnectionMode.READWRITE : ConnectionMode.READONLY,
    });
  }

  return config;
}

export function parseConfig(rawConfig: Record<string, unknown>): ServerConfig {
  const oracleClient = (rawConfig.oracle_client || rawConfig.oracleClient || {}) as Record<
    string,
    unknown
  >;
  const settings = (rawConfig.settings || {}) as Record<string, unknown>;

  const clientModeStr = ((oracleClient.mode as string) || 'thin').toLowerCase();

  const config: ServerConfig = {
    oracleClientMode:
      clientModeStr === 'thick' ? OracleClientMode.THICK : OracleClientMode.THIN,
    oracleClientPath: oracleClient.path as string | undefined,
    defaultMaxRows: (settings.default_max_rows as number) || (settings.defaultMaxRows as number) || 100,
    queryTimeout: (settings.query_timeout as number) || (settings.queryTimeout as number) || 30,
    connections: [],
  };

  // Parse connections
  const connections = (rawConfig.connections || []) as Record<string, unknown>[];
  for (const connData of connections) {
    const modeStr = ((connData.mode as string) || 'readonly').toLowerCase();

    config.connections.push({
      name: connData.name as string,
      host: connData.host as string | undefined,
      port: (connData.port as number) || 1521,
      serviceName: (connData.service_name || connData.serviceName) as string | undefined,
      sid: connData.sid as string | undefined,
      connectionString: (connData.connection_string || connData.connectionString) as string | undefined,
      username: (connData.username as string) || '',
      password: connData.password as string | undefined,
      passwordEnv: (connData.password_env || connData.passwordEnv) as string | undefined,
      mode: modeStr === 'readwrite' ? ConnectionMode.READWRITE : ConnectionMode.READONLY,
    });
  }

  return config;
}

export function getConfig(): ServerConfig {
  // Check for config file in various locations
  const configPaths = [
    process.env.ORACLE_MCP_CONFIG,
    join(process.cwd(), 'config', 'connections.json'),
    join(process.cwd(), 'connections.json'),
    join(homedir(), '.oracle-mcp', 'connections.json'),
  ].filter(Boolean) as string[];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      console.error(`Loading configuration from: ${configPath}`);
      return loadConfigFromFile(configPath);
    }
  }

  // Fall back to environment variables
  console.error('Loading configuration from environment variables');
  return loadConfigFromEnv();
}

// ============================================================================
// Connection Manager Class
// ============================================================================

export class ConnectionManager {
  private config: ServerConfig;
  private connections: Map<string, oracledb.Connection> = new Map();
  private connectionConfigs: Map<string, ConnectionConfig> = new Map();
  private initialized = false;

  constructor(config?: ServerConfig) {
    this.config = config || { 
      oracleClientMode: OracleClientMode.THIN,
      defaultMaxRows: 100,
      queryTimeout: 30,
      connections: []
    };

    // Index connections by name
    for (const connConfig of this.config.connections) {
      this.connectionConfigs.set(connConfig.name, connConfig);
    }
  }

  getServerConfig(): ServerConfig {
    return this.config;
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }

    if (this.config.oracleClientMode === OracleClientMode.THICK) {
      const libDir = this.config.oracleClientPath;
      if (libDir) {
        console.error(`Initializing Oracle client from: ${libDir}`);
        oracledb.initOracleClient({ libDir });
      } else {
        console.error('Initializing Oracle client from default location');
        oracledb.initOracleClient();
      }
    } else {
      console.error('Using thin mode (no Oracle client required)');
    }

    this.initialized = true;
  }

  getConnectionConfig(name: string): ConnectionConfig {
    const config = this.connectionConfigs.get(name);
    if (!config) {
      const available = Array.from(this.connectionConfigs.keys()).join(', ') || 'none';
      throw new Error(`Connection '${name}' not found. Available connections: ${available}`);
    }
    return config;
  }

  async connect(name: string): Promise<oracledb.Connection> {
    this.initialize();

    // Return existing connection if still valid
    const existing = this.connections.get(name);
    if (existing) {
      try {
        await existing.ping();
        console.error(`Reusing existing connection to '${name}'`);
        return existing;
      } catch {
        console.error(`Existing connection to '${name}' is stale, reconnecting`);
        this.connections.delete(name);
      }
    }

    const config = this.getConnectionConfig(name);

    console.error(`Connecting to '${name}' (${getDsn(config)})`);

    const connection = await oracledb.getConnection({
      user: config.username,
      password: getPassword(config),
      connectString: getDsn(config),
    });

    // Set session to read-only if configured
    if (config.mode === ConnectionMode.READONLY) {
      await connection.execute('SET TRANSACTION READ ONLY');
      console.error(`Connection '${name}' set to READ ONLY mode`);
    }

    this.connections.set(name, connection);
    console.error(`Successfully connected to '${name}'`);

    return connection;
  }

  async disconnect(name: string): Promise<boolean> {
    const connection = this.connections.get(name);
    if (connection) {
      try {
        await connection.close();
        console.error(`Disconnected from '${name}'`);
      } catch (e) {
        console.error(`Error closing connection '${name}':`, e);
      } finally {
        this.connections.delete(name);
      }
      return true;
    }
    return false;
  }

  async disconnectAll(): Promise<number> {
    let count = 0;
    for (const name of Array.from(this.connections.keys())) {
      if (await this.disconnect(name)) {
        count++;
      }
    }
    return count;
  }

  async isConnected(name: string): Promise<boolean> {
    const connection = this.connections.get(name);
    if (!connection) {
      return false;
    }
    try {
      await connection.ping();
      return true;
    } catch {
      this.connections.delete(name);
      return false;
    }
  }

  async getConnection(name: string): Promise<oracledb.Connection> {
    if (await this.isConnected(name)) {
      return this.connections.get(name)!;
    }
    return this.connect(name);
  }

  async listConnections(): Promise<ConnectionInfo[]> {
    const result: ConnectionInfo[] = [];
    for (const [name, config] of this.connectionConfigs) {
      result.push({
        name,
        host: config.host || '(connection string)',
        port: config.host ? config.port : undefined,
        service: config.serviceName || config.sid || '(in connection string)',
        username: config.username,
        mode: config.mode,
        connected: await this.isConnected(name),
      });
    }
    return result;
  }

  async testConnection(name: string): Promise<ConnectionTestResult> {
    const config = this.getConnectionConfig(name);

    try {
      const connection = await this.connect(name);

      // Get database info
      let version = 'Unknown';
      let dbName = 'Unknown';
      let schema = 'Unknown';

      try {
        const versionResult = await connection.execute<[string]>(
          'SELECT banner FROM v$version WHERE ROWNUM = 1'
        );
        if (versionResult.rows && versionResult.rows.length > 0) {
          version = versionResult.rows[0][0];
        }
      } catch {
        // May not have access to v$version
      }

      const dbNameResult = await connection.execute<[string]>(
        "SELECT SYS_CONTEXT('USERENV', 'DB_NAME') FROM DUAL"
      );
      if (dbNameResult.rows && dbNameResult.rows.length > 0) {
        dbName = dbNameResult.rows[0][0];
      }

      const schemaResult = await connection.execute<[string]>(
        "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL"
      );
      if (schemaResult.rows && schemaResult.rows.length > 0) {
        schema = schemaResult.rows[0][0];
      }

      return {
        success: true,
        name,
        database: dbName,
        schema,
        version,
        mode: config.mode,
        message: `Successfully connected to '${name}'`,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        name,
        error,
        message: `Failed to connect to '${name}': ${error}`,
      };
    }
  }
}

