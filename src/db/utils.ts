import { isMultiDbMode } from "./../config/index.js";
import { log } from "./../utils/index.js";
import SqlParser, { AST } from "node-sql-parser";

const { Parser } = SqlParser;
const parser = new Parser();

function calculateComplexity(astNode: any): number {
    let complexity = 0;
    if (!astNode || typeof astNode !== 'object') {
        return 0;
    }

    // Add points for specific node types
    switch (astNode.type) {
        case 'select':
            complexity += 1;
            // Penalize for subqueries in FROM clause
            if (astNode.from) {
                astNode.from.forEach((from: any) => {
                    if (from.expr && from.expr.type === 'select') {
                        complexity += 10;
                    }
                });
            }
            break;
        case 'join':
            complexity += 5;
            break;
        case 'union':
            complexity += 10;
            break;
    }

    // Penalize for 'SELECT *'
    if (astNode.columns === '*') {
        complexity += 2;
    }

    // Recursively calculate complexity for child nodes
    for (const key in astNode) {
        if (Array.isArray(astNode[key])) {
            astNode[key].forEach((item: any) => {
                complexity += calculateComplexity(item);
            });
        } else if (typeof astNode[key] === 'object') {
            complexity += calculateComplexity(astNode[key]);
        }
    }

    return complexity;
}


// Recursively extracts all schemas from a query's AST
function extractSchemasFromAST(ast: any, schemas: Set<string>) {
    if (!ast || typeof ast !== 'object') {
        return;
    }

    // Check for a 'db' property on the current node
    if (ast.db && typeof ast.db === 'string') {
        schemas.add(ast.db);
    }

    // Recursively check other parts of the AST
    for (const key in ast) {
        if (Array.isArray(ast[key])) {
            ast[key].forEach((item: any) => extractSchemasFromAST(item, schemas));
        } else if (typeof ast[key] === 'object') {
            extractSchemasFromAST(ast[key], schemas);
        }
    }
}

function getAST(sql: string): AST | AST[] {
    try {
        return parser.astify(sql, { database: "mysql" });
    } catch (err: any) {
        log("error", "Error parsing SQL for AST:", err);
        throw new Error(`Parsing failed: ${err.message}`);
    }
}

// New function to get all schemas from a query
function getAllSchemasFromQuery(sql: string, astOrArray: AST | AST[]): string[] {
    const schemas = new Set<string>();
    const defaultSchema = process.env.MYSQL_DB || null;

    try {
        const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];

        for (const ast of statements) {
            extractSchemasFromAST(ast, schemas);
        }

    } catch (err: any) {
        log("error", "Error parsing SQL for schema extraction:", err);
        // Fallback to old method for safety, though it's not ideal
        const schema = extractSchemaFromQuery(sql);
        if (schema) {
            schemas.add(schema);
        }
    }

    // If no schemas were found in the query and we are not in multi-db mode, add the default schema.
    if (schemas.size === 0 && defaultSchema && !isMultiDbMode) {
        schemas.add(defaultSchema);
    }

    return Array.from(schemas);
}


// Old function, kept for fallback, but should be deprecated.
function extractSchemaFromQuery(sql: string): string | null {
  // Default schema from environment
  const defaultSchema = process.env.MYSQL_DB || null;

  // If we have a default schema and not in multi-DB mode, return it
  if (defaultSchema && !isMultiDbMode) {
    return defaultSchema;
  }

  // Try to extract schema from query

  // Case 1: USE database statement
  const useMatch = sql.match(/USE\s+`?([a-zA-Z0-9_]+)`?/i);
  if (useMatch && useMatch[1]) {
    return useMatch[1];
  }

  // Case 2: database.table notation
  const dbTableMatch = sql.match(/`?([a-zA-Z0-9_]+)`?\.`?[a-zA-Z0-9_]+`?/i);
  if (dbTableMatch && dbTableMatch[1]) {
    return dbTableMatch[1];
  }

  // Return default if we couldn't find a schema in the query
  return defaultSchema;
}

async function getQueryTypes(astOrArray: AST | AST[]): Promise<string[]> {
  try {
    const statements = Array.isArray(astOrArray) ? astOrArray : [astOrArray];
    // Map each statement to its lowercased type (e.g., 'select', 'update', 'insert', 'delete', etc.)
    return statements.map((stmt) => stmt.type?.toLowerCase() ?? "unknown");
  } catch (err: any) {
    log("error", "sqlParser error, ast: ", astOrArray);
    log("error", "Error getting query types from AST:", err);
    throw new Error(`Getting query types failed: ${err.message}`);
  }
}

export { getAllSchemasFromQuery, getQueryTypes, extractSchemaFromQuery, getAST, calculateComplexity };
