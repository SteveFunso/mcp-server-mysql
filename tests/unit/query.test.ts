import { vi, describe, it, expect, beforeEach } from "vitest";

// Set DEBUG env var for testing to get detailed error messages
vi.stubEnv("DEBUG", "true");

// Mock db/utils
vi.mock("../../src/db/utils.js", () => ({
  getAST: vi.fn((sql) => ({ type: sql.toLowerCase().split(" ")[0] })), // Simple AST mock
  calculateComplexity: vi.fn().mockReturnValue(10), // Mock complexity score
  getQueryTypes: vi.fn().mockImplementation(async (ast) => {
    if (!ast || !ast.type) return ["unknown"];
    return [ast.type];
  }),
  getAllSchemasFromQuery: vi.fn().mockReturnValue(["test_schema"]),
}));

// Mock mysql2/promise
const mockConnection = {
  query: vi.fn(),
  beginTransaction: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  release: vi.fn(),
};

vi.mock("mysql2/promise", () => ({
  createPool: vi.fn(() => ({
    getConnection: vi.fn(() => Promise.resolve(mockConnection)),
  })),
}));

import { executeVerifiedQuery } from "../../src/db/index.js";
import * as Permissions from "../../src/db/permissions.js";

describe("Database Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("executeVerifiedQuery", () => {
    it("should execute a SELECT query and return results", async () => {
      const mockResults = [{ id: 1, name: "Test" }];
      mockConnection.query.mockResolvedValue([mockResults]);

      const result = await executeVerifiedQuery("SELECT * FROM test WHERE id = ?", [1]);

      expect(mockConnection.beginTransaction).toHaveBeenCalled();
      expect(mockConnection.query).toHaveBeenCalledWith("SELECT * FROM test WHERE id = ?", [1]);
      expect(mockConnection.commit).toHaveBeenCalled();
      expect(mockConnection.release).toHaveBeenCalled();

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe(JSON.stringify(mockResults, null, 2));
    });

    it("should block an INSERT query when not allowed", async () => {
      vi.spyOn(Permissions, 'isInsertAllowedForSchema').mockReturnValue(false);
      const result = await executeVerifiedQuery('INSERT INTO test (name) VALUES (?)', ['test']);

      expect(mockConnection.beginTransaction).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("INSERT operations are not allowed for schema 'test_schema'");

      vi.mocked(Permissions.isInsertAllowedForSchema).mockRestore();
    });

    it("should allow an INSERT query when permission is granted", async () => {
        vi.spyOn(Permissions, 'isInsertAllowedForSchema').mockReturnValue(true);
        const resultHeader = { affectedRows: 1, insertId: 123 };
        mockConnection.query.mockResolvedValue([resultHeader]);

        const result = await executeVerifiedQuery('INSERT INTO test (name) VALUES (?)', ['test']);

        expect(mockConnection.beginTransaction).toHaveBeenCalled();
        expect(mockConnection.query).toHaveBeenCalledWith('INSERT INTO test (name) VALUES (?)', ['test']);
        expect(mockConnection.commit).toHaveBeenCalled();
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("Insert successful");

        vi.mocked(Permissions.isInsertAllowedForSchema).mockRestore();
    });

    it("should rollback transaction and return error if query fails", async () => {
        vi.spyOn(Permissions, 'isInsertAllowedForSchema').mockReturnValue(true);
        mockConnection.query.mockRejectedValue(new Error("DB Error"));

        const result = await executeVerifiedQuery('INSERT INTO test (name) VALUES (?)', ['test']);

        expect(mockConnection.beginTransaction).toHaveBeenCalled();
        expect(mockConnection.commit).not.toHaveBeenCalled();
        expect(mockConnection.rollback).toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Error: DB Error");

        vi.mocked(Permissions.isInsertAllowedForSchema).mockRestore();
    });
  });
});
