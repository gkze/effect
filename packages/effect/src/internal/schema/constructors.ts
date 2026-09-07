import { isArrayNonEmpty } from "../../Array.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"
import { effectIsExit } from "../effect.ts"
import { assignProperty } from "../record.ts"
import { makeArrayParser } from "./arrays.ts"
import { wrapPropertyKeyIssue } from "./cause.ts"
import type { Parser, ResolveEntry } from "./compilerRegistry.ts"
import * as Diagnostics from "./diagnostics.ts"
import { withConstructorDefault } from "./interpreter.ts"
import { type ObjectParserState, type ParsedProperty, parseProperties } from "./objects.ts"
import * as InternalParser from "./parser.ts"
import { makeUnionParser } from "./unions.ts"

/** @internal */
export function node(ast: SchemaAST.AST, resolve: ResolveEntry): Parser {
  let parser: Parser | undefined
  return (input, options) => (parser ??= resolve(ast).makeEffect)(input, options)
}

/** @internal */
export function field(ast: SchemaAST.AST, resolve: ResolveEntry): Parser {
  return withConstructorDefault(ast, node(ast, resolve), (ast) => node(ast, resolve))
}

/** @internal */
export function properties(ast: SchemaAST.Objects, resolve: ResolveEntry): ReadonlyArray<ParsedProperty> {
  return ast.propertySignatures.map((property) => ({
    type: property.type,
    name: property.name,
    parser: field(property.type, resolve),
    valueFirst: property.name !== "__proto__" && !property.type.context?.isOptional
  }))
}

/** @internal */
export function objects(
  ast: SchemaAST.Objects,
  resolve: ResolveEntry,
  fields = properties(ast, resolve)
): Parser {
  const expected = new Set<PropertyKey>(Diagnostics.getExpectedKeys(ast))
  const indexes = ast.indexSignatures.map((signature) => ({
    signature,
    key: node(SchemaAST.parameterFromPropertyKey(signature.parameter), resolve),
    value: field(signature.type, resolve)
  }))
  return Effect.fnUntracedEager(function*(input, options) {
    if (input === InternalParser.missing) return input
    if (fields.length === 0 && indexes.length === 0) {
      return input !== null && input !== undefined
        ? input
        : yield* Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return yield* Effect.fail(new SchemaIssue.InvalidType(ast, input, options))
    }
    const record = input as Record<PropertyKey, unknown>
    const state: ObjectParserState = { ast, input: record, options, out: {}, issues: undefined }
    const indexKeys = options.onExcessProperty === "error"
      ? indexes.map(({ signature }) => SchemaAST.getIndexSignatureKeys(record, signature.parameter, options))
      : undefined
    if (options.onExcessProperty === "error") {
      const covered = Diagnostics.getCoveredKeys(expected, indexKeys)
      for (const key of Reflect.ownKeys(record)) {
        if (covered.has(key)) continue
        const issue = Diagnostics.unexpectedKey(ast, key, record[key], options)
        if (options.errors !== "all") return yield* Effect.fail(new SchemaIssue.Composite(ast, [issue], input, options))
        ;(state.issues ??= []).push(issue)
      }
    }
    const pending = parseProperties(state, fields)
    if (pending) yield* pending
    for (let index = 0; index < indexes.length; index++) {
      const member = indexes[index]
      const parameter = member.signature.parameter
      const keys = indexKeys?.[index] ?? (parameter === SchemaAST.string
        ? Object.keys(record)
        : SchemaAST.getIndexSignatureKeys(record, parameter, options))
      for (const key of keys) {
        let outputKey: unknown = key
        if (parameter !== SchemaAST.string) {
          const effect = member.key(key, options)
          const result = effectIsExit(effect) ? effect : yield* Effect.exit(effect)
          if (Exit.isFailure(result)) {
            const terminal = wrapPropertyKeyIssue(state, ast, key, result)
            if (terminal) return yield* terminal
            continue
          }
          outputKey = result.value
        }
        const effect = member.value(record[key], options)
        const result = effectIsExit(effect) ? effect : yield* Effect.exit(effect)
        if (Exit.isFailure(result)) {
          const terminal = wrapPropertyKeyIssue(state, ast, key, result)
          if (terminal) return yield* terminal
          continue
        }
        if (outputKey === InternalParser.missing || result.value === InternalParser.missing) continue
        const name = outputKey as PropertyKey
        if (fields.length > 0 && (expected.has(key) || expected.has(Diagnostics.normalizeKey(name)))) continue
        assignProperty(state.out, name, result.value)
      }
    }
    if (state.issues && isArrayNonEmpty(state.issues)) {
      return yield* Effect.fail(new SchemaIssue.Composite(ast, state.issues, input, options))
    }
    return state.out
  })
}

/** @internal */
export function arrays(ast: SchemaAST.Arrays, resolve: ResolveEntry): Parser {
  return makeArrayParser(ast, (ast) => field(ast, resolve))
}

/** @internal */
export function union(ast: SchemaAST.Union, resolve: ResolveEntry): Parser {
  const members = new Map(ast.types.map((ast) => [ast, node(ast, resolve)]))
  return makeUnionParser(ast, (ast) => members.get(ast)!, true)
}
