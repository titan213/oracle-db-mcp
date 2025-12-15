# Oracle DB MCP Server

A Model Context Protocol (MCP) server for Oracle Database connectivity. This server enables AI tools like Cursor, Claude Desktop, and other MCP-compatible clients to interact with Oracle databases.

## Features

- **Multiple Database Connections**: Configure and manage multiple named Oracle database connections
- **Thin & Thick Mode Support**: Works with Oracle's thin driver (no client required) or thick mode (with Oracle Instant Client)
- **Query Execution**: Execute SELECT queries with result formatting
- **DML Operations**: Execute INSERT, UPDATE, DELETE with safety checks
- **PL/SQL Support**: Execute PL/SQL blocks, create procedures/functions
- **Schema Browsing**: List tables, views, procedures, describe table structures
- **Stored Procedures**: Execute stored procedures with input/output parameters
- **Transaction Management**: Commit and rollback support
- **Safety Features**: Read-only mode, dangerous query detection, automatic warnings

## Installation

### Using npx (Recommended)

No installation required. Configure your MCP client to run:

```bash
npx -y oracle-db-mcp
```

### Local Installation

```bash
npm install -g oracle-db-mcp
```

Then run:

```bash
oracle-db-mcp
```

## Configuration

### Configuration File (connections.json)

Create a configuration file with your database connections:

```json
{
  "oracleClient": {
    "mode": "thin"
  },
  "settings": {
    "defaultMaxRows": 100,
    "queryTimeout": 30
  },
  "connections": [
    {
      "name": "dev",
      "host": "dev-server.company.com",
      "port": 1521,
      "serviceName": "DEVDB",
      "username": "dev_user",
      "password": "dev_password",
      "mode": "readwrite"
    },
    {
      "name": "prod",
      "host": "prod-server.company.com",
      "port": 1521,
      "serviceName": "PRODDB",
      "username": "report_user",
      "passwordEnv": "PROD_DB_PASSWORD",
      "mode": "readonly"
    }
  ]
}
```

### Connection Options

Each connection supports:

| Option | Description |
|--------|-------------|
| `name` | Unique identifier for the connection |
| `host` | Database server hostname |
| `port` | Port number (default: 1521) |
| `serviceName` | Oracle service name |
| `sid` | Oracle SID (alternative to serviceName) |
| `connectionString` | Full connection string (alternative to host/port/service) |
| `username` | Database username |
| `password` | Database password (direct) |
| `passwordEnv` | Environment variable containing password |
| `mode` | `readonly` or `readwrite` |

### Configuration File Locations

The server searches for configuration in this order:

1. `ORACLE_MCP_CONFIG` environment variable
2. `./config/connections.json`
3. `./connections.json`
4. `~/.oracle-mcp/connections.json`

### Environment Variables

For simple single-connection setup:

```bash
export ORACLE_CONNECTION_NAME=mydb
export ORACLE_HOST=localhost
export ORACLE_PORT=1521
export ORACLE_SERVICE=XEPDB1
export ORACLE_USER=scott
export ORACLE_PASSWORD=tiger
export ORACLE_MODE=readonly
```

## MCP Client Configuration

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "npx",
      "args": ["-y", "oracle-db-mcp"],
      "env": {
        "ORACLE_MCP_CONFIG": "/path/to/connections.json"
      }
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "npx",
      "args": ["-y", "oracle-db-mcp"],
      "env": {
        "ORACLE_MCP_CONFIG": "/path/to/connections.json"
      }
    }
  }
}
```

## Available Tools

### Connection Management

| Tool | Description |
|------|-------------|
| `list_connections` | List all configured connections with status |
| `test_connection` | Test connectivity and get database info |
| `connect` | Establish a connection |
| `disconnect` | Close a connection |

### Query Execution

| Tool | Description |
|------|-------------|
| `execute_query` | Execute SELECT queries |
| `execute_dml` | Execute INSERT/UPDATE/DELETE |
| `execute_plsql` | Execute PL/SQL blocks or DDL |
| `execute_procedure` | Call stored procedures |

### Schema Browsing

| Tool | Description |
|------|-------------|
| `list_tables` | List tables and views |
| `describe_table` | Get column, constraint, index info |
| `list_procedures` | List procedures, functions, packages |
| `get_procedure_source` | Get source code of PL/SQL objects |
| `get_procedure_params` | Get procedure parameters |
| `explain_query` | Get query execution plan |

### Transaction Management

| Tool | Description |
|------|-------------|
| `commit` | Commit current transaction |
| `rollback` | Rollback current transaction |

## Safety Features

### Read-Only Mode

Connections configured as `readonly`:
- Block all DML operations (INSERT, UPDATE, DELETE)
- Block PL/SQL execution
- Allow only SELECT queries

### Dangerous Query Detection

The server warns or blocks:
- DROP statements
- TRUNCATE statements
- UPDATE/DELETE without WHERE clause
- ALTER SYSTEM commands

## Oracle Client Modes

### Thin Mode (Default)

No Oracle client installation required. Works with:
- Oracle Database 12.1 and later
- Oracle Cloud databases

### Thick Mode

Requires Oracle Instant Client. Enable in config:

```json
{
  "oracleClient": {
    "mode": "thick",
    "path": "/path/to/instantclient"
  }
}
```

Required for:
- Oracle Database versions before 12.1
- Advanced features (LDAP, Kerberos, etc.)
- Some data types (BFILE, etc.)

## Development

### Building from Source

```bash
git clone https://github.com/gihan213/oracle-db-mcp
cd oracle-db-mcp
npm install
npm run build
```

### Running in Development

```bash
npm run dev
```

### Testing

```bash
npm test
```

## License

MIT

## Author

Gihan Sundarapperuma <gihan213@gmail.com>

