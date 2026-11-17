// Checks src/sqlite.js inlineIntegers: whole numbers are written into the SQL (a Durable Object's SQLite would store
// them as decimals), everything else stays bound and renumbered, and anything that only looks like a placeholder
// (in quotes, names in brackets, comments) is left alone.
//   node test/sqlite.mjs
import { inlineIntegers } from "../src/sqlite.js";

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const cases = [
  ["a whole number is written in; text stays bound", "SELECT * FROM t WHERE a = ? AND b = ?", [5, "x"], "SELECT * FROM t WHERE a = 5 AND b = ?1", ["x"]],
  ["numbered placeholders, one used twice", "SELECT ?1, ?2, ?1", [7, "y"], "SELECT 7, ?1, 7", ["y"]],
  ["question marks in quotes, names and comments aren't placeholders", "SELECT ? , '?', \"?\", [?], -- ?\n ?", [1, 2],
    "SELECT 1 , '?', \"?\", [?], -- ?\n 2", []],
  ["a doubled quote doesn't end the text", "SELECT 'it''s ?', ?", [3], "SELECT 'it''s ?', 3", []],
  ["a negative number goes in brackets", "SELECT /* ? */ ?", [-4], "SELECT /* ? */ (-4)", []],
  ["…so a minus before it can't make a comment", "SELECT a -?", [-4], "SELECT a -(-4)", []],
  ["a decimal stays bound", "SELECT ?, ?", [1.5, 2], "SELECT ?1, 2", [1.5]],
  ["numbers out of order", "SELECT ?3, ?1, ?2", [10, "b", 30], "SELECT 30, 10, ?1", ["b"]],
  ["named parameters are left alone", "SELECT :name", [5], "SELECT :name", [5]],
  ["a count that doesn't match is left for SQLite to refuse", "SELECT ?", [1, 2], "SELECT ?", [1, 2]],
  ["no whole numbers: unchanged", "SELECT ?", ["only text"], "SELECT ?", ["only text"]],
  ["null stays bound; 0 and 1 go in", "INSERT INTO t VALUES (?, ?, ?)", [null, 0, 1], "INSERT INTO t VALUES (?1, 0, 1)", [null]],
  ["an unused value is dropped", "SELECT ?2 + ?2", ["a", 9], "SELECT 9 + 9", []],
  ["a number never runs into a word", "SELECT * FROM t LIMIT?", [5], "SELECT * FROM t LIMIT 5", []],
  ["…on either side", "SELECT ?e5", [5], "SELECT 5 e5", []],
  ["past 2^53, exactly what the number is", "SELECT ?", [2 ** 60], "SELECT 1152921504606846976", []],
  ["not a number: bound", "SELECT ?, ?", [Number.NaN, Number.POSITIVE_INFINITY], "SELECT ?, ?", [Number.NaN, Number.POSITIVE_INFINITY]],
];
for (const [name, sql, params, wantSql, wantParams] of cases) {
  const got = inlineIntegers(sql, params);
  check(name, got.sql === wantSql && JSON.stringify(got.params) === JSON.stringify(wantParams), JSON.stringify(got));
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
