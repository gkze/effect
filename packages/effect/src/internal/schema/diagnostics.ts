import type * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"

/** @internal */
export const normalizeKey = (key: PropertyKey): string | symbol => typeof key === "number" ? String(key) : key

/** @internal */
export const getExpectedKeys = (ast: SchemaAST.Objects): Array<string | symbol> =>
  ast.propertySignatures.map((property) => normalizeKey(property.name))

/** @internal */
export const getCoveredKeys = (
  expected: ReadonlySet<PropertyKey>,
  indexKeys: ReadonlyArray<ReadonlyArray<PropertyKey>> | undefined
): ReadonlySet<PropertyKey> => {
  if (indexKeys === undefined) return expected
  const covered = new Set(expected)
  for (const keys of indexKeys) {
    for (const key of keys) covered.add(key)
  }
  return covered
}

/** @internal */
export const missingKey = (key: PropertyKey, child: SchemaAST.AST): SchemaIssue.Pointer =>
  new SchemaIssue.Pointer([key], new SchemaIssue.MissingKey(child.context?.annotations))

/** @internal */
export const unexpectedKey = (
  ast: SchemaAST.AST,
  key: PropertyKey,
  value: unknown,
  options: SchemaAST.ParseOptions
): SchemaIssue.Pointer => new SchemaIssue.Pointer([key], new SchemaIssue.UnexpectedKey(ast, value, options))

/** @internal */
export const getTupleElement = <A>(
  elements: ReadonlyArray<A>,
  rest: ReadonlyArray<A>,
  tailThreshold: number,
  index: number
): A => index < elements.length ? elements[index] : index >= tailThreshold ? rest[index - tailThreshold + 1] : rest[0]
