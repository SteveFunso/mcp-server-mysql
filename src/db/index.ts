import { performance } from "perf_hooks";
import { isMultiDbMode, MYSQL_MAX_QUERY_COMPLEXITY } from "./../config/index.js";

import {
  isDDLAllowedForSchema,
  isInsertAllowedForSchema,
  isUpdateAllowedForSchema,
  isDeleteAllowedForSchema,
} from "./permissions.js";
import { getAllSchemasFromQuery, getQueryTypes, getAST, calculateComplexity } from "./utils.js";

import * as mysql2 from "mysql2/promise";
import { log } from "./../utils/index.js";
import { mcpConfig as config } from "./../config/index.js";

// Force read-only mode in multi-DB mode unless explicitly configured otherwise
if (isMultiDbMode && process.env.MULTI_DB_WRITE_MODE !== "true") {
  log("error", "Multi-DB mode detected - enabling read-only mode for safety");
}

// @INFO: Check if running in test mode
const isTestEnvironment = process.env.NODE_ENV === "test" || process.env.VITEST;

// @INFO: Safe way to exit process (not during tests)
function safeExit(code: number): void {
  if (!isTestEnvironment) {
    process.exit(code);
  } else {
    log("error", `[Test mode] Would have called process.exit(${code})`);
  }
}

// @INFO: Lazy load MySQL pool
let poolPromise: Promise<mysql2.Pool>;

const getPool = (): Promise<mysql2.Pool> => {
  if (!poolPromise) {
    poolPromise = new Promise<mysql2.Pool>((resolve, reject) => {
      try {
        const pool = mysql2.createPool(config.mysql);
        log("info", "MySQL pool created successfully");
        resolve(pool);
      } catch (error) {
        log("error", "Error creating MySQL pool:", error);
        reject(error);
      }
    });
  }
  return poolPromise;
};

async function executeQuery<T>(sql: string, params: string[] = []): Promise<T> {
  let connection;
  try {
    const pool = await getPool();
    connection = await pool.getConnection();
    const result = await connection.query(sql, params);
    return (Array.isArray(result) ? result[0] : result) as T;
  } catch (error) {
    log("error", "Error executing query:", error);
    throw error;
  } finally {
    if (connection) {
      connection.release();
      log("error", "Connection released");
    }
  }
}

async function executeVerifiedQuery<T>(sql: string, params: (string | number)[]): Promise<T> {
  let connection;
  try {
    const pool = await getPool();
    connection = await pool.getConnection();
    log("info", "Connection acquired for verified query");

    // Parse the query once to get the AST
    const ast = getAST(sql);

    // Check query complexity to prevent DoS attacks
    const complexity = calculateComplexity(ast);
    if (complexity > MYSQL_MAX_QUERY_COMPLEXITY) {
        throw new Error(`Query is too complex to execute (complexity: ${complexity}, max: ${MYSQL_MAX_QUERY_COMPLEXITY}). Please simplify the query.`);
    }

    // Check the type of query
    const queryTypes = await getQueryTypes(ast);
    const schemas = getAllSchemasFromQuery(sql, ast);

    const isUpdateOperation = queryTypes.some((type) => ["update"].includes(type));
    const isInsertOperation = queryTypes.some((type) => ["insert"].includes(type));
    const isDeleteOperation = queryTypes.some((type) => ["delete"].includes(type));
    const isDDLOperation = queryTypes.some((type) => ["create", "alter", "drop", "truncate"].includes(type));
    const isWriteOperation = isUpdateOperation || isInsertOperation || isDeleteOperation || isDDLOperation;

    // Check schema-specific permissions for write operations for ALL schemas involved
    for (const schema of schemas) {
      if (isInsertOperation && !isInsertAllowedForSchema(schema)) {
        throw new Error(`INSERT operations are not allowed for schema '${schema || "default"}'.`);
      }
      if (isUpdateOperation && !isUpdateAllowedForSchema(schema)) {
        throw new Error(`UPDATE operations are not allowed for schema '${schema || "default"}'.`);
      }
      if (isDeleteOperation && !isDeleteAllowedForSchema(schema)) {
        throw new Error(`DELETE operations are not allowed for schema '${schema || "default"}'.`);
      }
      if (isDDLOperation && !isDDLAllowedForSchema(schema)) {
        throw new Error(`DDL operations are not allowed for schema '${schema || "default"}'.`);
      }
    }

    await connection.beginTransaction();

    try {
      const startTime = performance.now();
      // ALWAYS use parameterized queries to prevent SQL injection
      const [result] = await connection.query(sql, params);
      const endTime = performance.now();
      const duration = endTime - startTime;

      await connection.commit();

      let responseText = JSON.stringify(result, null, 2);

      if (isWriteOperation) {
        const resultHeader = result as mysql2.ResultSetHeader;
        if (isInsertOperation) {
          responseText = `Insert successful on the relevant schema(s). Affected rows: ${resultHeader.affectedRows}, Last insert ID: ${resultHeader.insertId}`;
        } else if (isUpdateOperation) {
          responseText = `Update successful on the relevant schema(s). Affected rows: ${resultHeader.affectedRows}, Changed rows: ${resultHeader.changedRows || 0}`;
        } else if (isDeleteOperation) {
          responseText = `Delete successful on the relevant schema(s). Affected rows: ${resultHeader.affectedRows}`;
        } else if (isDDLOperation) {
          responseText = `DDL operation successful on the relevant schema(s).`;
        }
      }

      return {
        content: [
          { type: "text", text: responseText },
          { type: "text", text: `Query execution time: ${duration.toFixed(2)} ms` },
        ],
        isError: false,
      } as T;
    } catch (error: unknown) {
      await connection.rollback();
      throw error; // Rethrow to be caught by the outer catch block
    }
  } catch (error: unknown) {
    const isSafeError = error instanceof Error && (
        error.message.includes("not allowed for schema") ||
        error.message.includes("Query is too complex")
    );
    const message = error instanceof Error ? error.message : String(error);
    log("error", "Error in executeVerifiedQuery:", message);

    // In debug mode, or if it's a "safe" permission/complexity error, show the real message.
    // Otherwise, show a generic message.
    const returnedMessage = process.env.DEBUG === 'true' || isSafeError ? message : "An internal server error occurred.";

    return {
      content: [{ type: "text", text: `Error: ${returnedMessage}` }],
      isError: true,
    } as T;
  } finally {
    if (connection) {
      connection.release();
      log("info", "Connection released");
    }
  }
}


export {
  isTestEnvironment,
  safeExit,
  executeQuery,
  getPool,
  executeVerifiedQuery,
  poolPromise,
};
