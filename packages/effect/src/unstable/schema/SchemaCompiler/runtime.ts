/**
 * Runtime support for generated Schema decoders. This version-coupled module
 * contains no source emitter or dynamic Function construction.
 *
 * @since 4.0.0
 */
import * as Effect from "../../../Effect.ts"
import * as Exit from "../../../Exit.ts"
import { effectIsExit } from "../../../internal/effect.ts"
import { assignProperty } from "../../../internal/record.ts"
import * as InternalSchemaCause from "../../../internal/schema/cause.ts"
import { checkOutput, getEncodingChecks } from "../../../internal/schema/checks.ts"
import {
  type CompiledDecoder,
  invalid,
  type Is,
  type Parser,
  prepareDecode,
  type ResolveParser,
  resolveParser as resolve,
  set,
  type Validate
} from "../../../internal/schema/compilerRegistry.ts"
import * as Diagnostics from "../../../internal/schema/diagnostics.ts"
import { applyChecks } from "../../../internal/schema/interpreter.ts"
import { hasDefaultObjectOptions, type ParsedProperty, resumeProperties } from "../../../internal/schema/objects.ts"
import * as InternalParser from "../../../internal/schema/parser.ts"
import { makeEncoding } from "../../../internal/schema/transformation.ts"
import * as SchemaAST from "../../../SchemaAST.ts"
import * as SchemaIssue from "../../../SchemaIssue.ts"

/** @internal */
const die = Effect.die
/** @internal */
const defaultParseOptions = SchemaAST.defaultParseOptions
/** @internal */
const getCandidates = SchemaAST.getCandidates
/** @internal */
const getIndexSignatureKeys = SchemaAST.getIndexSignatureKeys
/** @internal */
const parameterFromPropertyKey = SchemaAST.parameterFromPropertyKey

const isOptional = (ast: SchemaAST.AST): boolean => ast.context?.isOptional ?? false

/** @internal */
const hasExcessProperties = (
  ast: SchemaAST.Objects,
  input: Record<PropertyKey, unknown>,
  options: SchemaAST.ParseOptions
): boolean => {
  const covered = Diagnostics.getCoveredKeys(
    new Set(Diagnostics.getExpectedKeys(ast)),
    ast.indexSignatures.map((index) => SchemaAST.getIndexSignatureKeys(input, index.parameter, options))
  )
  return Reflect.ownKeys(input).some((key) => !covered.has(key))
}

/** @internal */
const failsChecks = (
  ast: SchemaAST.AST,
  value: unknown,
  encoded: boolean,
  options: SchemaAST.ParseOptions
): boolean => {
  const checks = encoded ? getEncodingChecks(ast) : ast.checks
  return !options.disableChecks && checks !== undefined &&
    SchemaAST.collectIssues(checks, value, undefined, ast, options) !== undefined
}

/** @internal */
const matchesTemplateLiteral = (
  ast: SchemaAST.TemplateLiteral,
  value: unknown,
  options: SchemaAST.ParseOptions
): boolean => typeof value === "string" && ast.matchPart(value, options) !== undefined

class Failure {
  readonly issue: SchemaIssue.Issue

  constructor(issue: SchemaIssue.Issue) {
    this.issue = issue
  }
}

type DetailedDecoder = (
  input: unknown,
  options: SchemaAST.ParseOptions
) => unknown | Failure

const fail = (issue: SchemaIssue.Issue): Failure => new Failure(issue)

const isFailure = (value: unknown): value is Failure => value instanceof Failure

const invalidType = (
  ast: SchemaAST.AST,
  input: unknown,
  options: SchemaAST.ParseOptions
): Failure => fail(new SchemaIssue.InvalidType(ast, input, options))

const composite = (
  ast: SchemaAST.AST,
  issue: SchemaIssue.Issue,
  input: unknown,
  options: SchemaAST.ParseOptions
): Failure => fail(new SchemaIssue.Composite(ast, [issue], input, options))

const pointer = (key: PropertyKey, failure: Failure): SchemaIssue.Pointer =>
  new SchemaIssue.Pointer([key], failure.issue)

function compileDetailed(ast: SchemaAST.AST): DetailedDecoder {
  const base = compileDetailedBase(ast)
  if (getEncodingChecks(ast) === undefined && ast.checks === undefined) return base
  return (input, options) => {
    const output = base(input, options)
    if (isFailure(output)) return output
    const issue = checkOutput(ast, input, output, options)
    return issue === undefined ? output : fail(issue)
  }
}

function compileDetailedBase(ast: SchemaAST.AST): DetailedDecoder {
  switch (ast._tag) {
    case "Null":
      return (input, options) =>
        input === InternalParser.missing || input === null ? input : invalidType(ast, input, options)
    case "Undefined":
      return (input, options) =>
        input === InternalParser.missing || input === undefined ? input : invalidType(ast, input, options)
    case "Void":
      return (input) => input === InternalParser.missing ? input : undefined
    case "Never":
      return (input, options) => input === InternalParser.missing ? input : invalidType(ast, input, options)
    case "Any":
    case "Unknown":
      return (input) => input
    case "ObjectKeyword":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return (input !== null && typeof input === "object") || typeof input === "function"
          ? input
          : invalidType(ast, input, options)
      }
    case "Enum": {
      const values = new Set<unknown>(ast.enums.map((entry) => entry[1]))
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return values.has(input) ? input : invalidType(ast, input, options)
      }
    }
    case "UniqueSymbol":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return input === ast.symbol ? input : invalidType(ast, input, options)
      }
    case "Literal":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return input === ast.literal ? input : invalidType(ast, input, options)
      }
    case "String":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return typeof input === "string" ? input : invalidType(ast, input, options)
      }
    case "Number":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return typeof input === "number" ? input : invalidType(ast, input, options)
      }
    case "Boolean":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return typeof input === "boolean" ? input : invalidType(ast, input, options)
      }
    case "Symbol":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return typeof input === "symbol" ? input : invalidType(ast, input, options)
      }
    case "BigInt":
      return (input, options) => {
        if (input === InternalParser.missing) return input
        return typeof input === "bigint" ? input : invalidType(ast, input, options)
      }
    case "TemplateLiteral": {
      const parserAst = ast.asTemplateLiteralParser()
      return (input, options) => {
        if (input === InternalParser.missing) return input
        if (typeof input !== "string") return invalidType(ast, input, options)
        return matchesTemplateLiteral(ast, input, options)
          ? input
          : fail(
            new SchemaIssue.Composite(
              ast,
              [
                new SchemaIssue.Encoding(
                  parserAst,
                  new SchemaIssue.InvalidValue(
                    { expected: "a string matching template literal parts" },
                    input,
                    options
                  ),
                  input,
                  options
                )
              ],
              input,
              options
            )
          )
      }
    }
    case "Arrays":
      return compileDetailedArrays(ast)
    case "Objects":
      return compileDetailedObjects(ast)
    case "Union":
      return compileDetailedUnion(ast)
    default:
      throw new Error(`Unsupported Schema AST: ${ast._tag}`)
  }
}

function compileDetailedArrays(ast: SchemaAST.Arrays): DetailedDecoder {
  const elements = ast.elements.map((ast) => ({ ast, decode: compileDetailed(ast) }))
  const rest = ast.rest.map((ast) => ({ ast, decode: compileDetailed(ast) }))
  const elementLength = elements.length
  const tailLength = Math.max(0, rest.length - 1)
  return (input, options) => {
    if (input === InternalParser.missing) return input
    if (!Array.isArray(input)) return invalidType(ast, input, options)
    const length = input.length
    const output = new Array<unknown>(length)
    let issues: [SchemaIssue.Issue, ...Array<SchemaIssue.Issue>] | undefined
    const errorsAll = options.errors === "all"
    const end = rest.length === 0 ? elementLength : Math.max(length, elementLength + tailLength)
    const tailThreshold = Math.max(elementLength, length - tailLength)
    for (let index = 0; index < end; index++) {
      const element = Diagnostics.getTupleElement(elements, rest, tailThreshold, index)
      const value = index < length ? input[index] : InternalParser.missing
      const decoded = element.decode(value, options)
      if (isFailure(decoded)) {
        const issue = pointer(index, decoded)
        if (!errorsAll) return composite(ast, issue, input, options)
        if (issues === undefined) issues = [issue]
        else issues.push(issue)
      } else if (decoded !== InternalParser.missing) {
        output[index] = decoded
      } else if (!isOptional(element.ast)) {
        const issue = Diagnostics.missingKey(index, element.ast)
        if (!errorsAll) return composite(ast, issue, input, options)
        if (issues === undefined) issues = [issue]
        else issues.push(issue)
      }
    }
    if (rest.length === 0 && length > elementLength) {
      for (let index = elementLength; index < length; index++) {
        const issue = Diagnostics.unexpectedKey(ast, index, input[index], options)
        if (!errorsAll) return composite(ast, issue, input, options)
        if (issues === undefined) issues = [issue]
        else issues.push(issue)
      }
    }
    return issues === undefined ? output : fail(new SchemaIssue.Composite(ast, issues, input, options))
  }
}

function compileDetailedObjects(ast: SchemaAST.Objects): DetailedDecoder {
  if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
    return (input, options) => {
      if (input === InternalParser.missing) return input
      return input !== null && input !== undefined ? input : invalidType(ast, input, options)
    }
  }
  const properties = ast.propertySignatures.map((property) => ({
    ast: property.type,
    decode: compileDetailed(property.type),
    name: property.name,
    optional: isOptional(property.type),
    valueFirst: property.name !== "__proto__" && !isOptional(property.type)
  }))
  const indexes = ast.indexSignatures.map((signature) => ({
    signature,
    decodeKey: compileDetailed(SchemaAST.parameterFromPropertyKey(signature.parameter)),
    decodeValue: compileDetailed(signature.type)
  }))
  const expectedKeys = Diagnostics.getExpectedKeys(ast)
  const expectedKeysSet = new Set<PropertyKey>(expectedKeys)
  return (input, options) => {
    if (input === InternalParser.missing) return input
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return invalidType(ast, input, options)
    }
    const record = input as Record<PropertyKey, unknown>
    const output: Record<PropertyKey, unknown> = {}
    const errorsAll = options.errors === "all"
    let issues: [SchemaIssue.Issue, ...Array<SchemaIssue.Issue>] | undefined
    const indexKeys = indexes.length > 0 && options.onExcessProperty === "error"
      ? indexes.map((index) => SchemaAST.getIndexSignatureKeys(record, index.signature.parameter, options))
      : undefined
    if (options.onExcessProperty === "error") {
      const coveredKeys = Diagnostics.getCoveredKeys(expectedKeysSet, indexKeys)
      for (const key of Reflect.ownKeys(record)) {
        if (coveredKeys.has(key)) continue
        const issue = Diagnostics.unexpectedKey(ast, key, record[key], options)
        if (!errorsAll) return composite(ast, issue, input, options)
        if (issues === undefined) issues = [issue]
        else issues.push(issue)
      }
    }
    for (const property of properties) {
      const name = property.name
      let value: unknown
      if (property.valueFirst) {
        value = record[name]
        if (value === undefined && !(name in record)) value = InternalParser.missing
      } else {
        const present = name === "__proto__" ? Object.hasOwn(record, name) : name in record
        value = present ? record[name] : InternalParser.missing
      }
      const decoded = property.decode(value, options)
      if (isFailure(decoded)) {
        const issue = pointer(name, decoded)
        if (!errorsAll) return composite(ast, issue, input, options)
        if (issues === undefined) issues = [issue]
        else issues.push(issue)
      } else if (decoded !== InternalParser.missing) {
        assignProperty(output, name, decoded)
      } else if (!property.optional) {
        const issue = Diagnostics.missingKey(name, property.ast)
        if (!errorsAll) return composite(ast, issue, input, options)
        if (issues === undefined) issues = [issue]
        else issues.push(issue)
      }
    }
    for (let i = 0; i < indexes.length; i++) {
      const index = indexes[i]
      const parameter = index.signature.parameter
      const keys = indexKeys?.[i] ?? (parameter === SchemaAST.string
        ? Object.keys(record)
        : SchemaAST.getIndexSignatureKeys(record, parameter, options))
      for (const key of keys) {
        let decodedKey: unknown = key
        if (parameter !== SchemaAST.string) {
          decodedKey = index.decodeKey(key, options)
          if (isFailure(decodedKey)) {
            const issue = pointer(key, decodedKey)
            if (!errorsAll) return composite(ast, issue, input, options)
            if (issues === undefined) issues = [issue]
            else issues.push(issue)
            continue
          }
        }
        const inputValue = record[key]
        const decodedValue = index.decodeValue(inputValue, options)
        if (isFailure(decodedValue)) {
          const issue = pointer(key, decodedValue)
          if (!errorsAll) return composite(ast, issue, input, options)
          if (issues === undefined) issues = [issue]
          else issues.push(issue)
          continue
        }
        if (decodedKey === InternalParser.missing || decodedValue === InternalParser.missing) continue
        const outputKey = decodedKey as PropertyKey
        if (properties.length > 0 && (expectedKeysSet.has(key) || expectedKeysSet.has(outputKey))) continue
        assignProperty(output, outputKey, decodedValue)
      }
    }
    if (issues !== undefined) return fail(new SchemaIssue.Composite(ast, issues, input, options))
    return output
  }
}

function compileDetailedUnion(ast: SchemaAST.Union): DetailedDecoder {
  const decoders = new Map(ast.types.map((type) => [type, compileDetailed(type)]))
  return (input, options) => {
    if (input === InternalParser.missing) return input
    const candidates = SchemaAST.getCandidates(input, ast.types)
    const issues: Array<SchemaIssue.Issue> = []
    const successes: Array<SchemaAST.AST> | undefined = ast.options?.mode === "oneOf" ? [] : undefined
    let output: unknown = invalid
    for (const candidate of candidates) {
      const decoded = decoders.get(candidate)!(input, options)
      if (isFailure(decoded)) {
        issues.push(decoded.issue)
      } else if (successes === undefined) {
        return decoded
      } else {
        successes.push(candidate)
        output = decoded
        if (successes.length > 1) {
          return fail(new SchemaIssue.OneOf(ast, successes, input, options))
        }
      }
    }
    return successes !== undefined && successes.length === 1
      ? output
      : fail(new SchemaIssue.AnyOf(ast, issues, input, options))
  }
}

const makeDetailed = (decode: DetailedDecoder): CompiledDecoder["decode"] => {
  return (input, options) => {
    try {
      const output = decode(input, options)
      if (isFailure(output)) return Effect.fail(output.issue)
      if (output === InternalParser.missing) return InternalParser.missingExit
      return InternalParser.succeed(output)
    } catch (error) {
      return Effect.die(error)
    }
  }
}

/** @internal */
const makeComposedObjectFallback = (
  ast: SchemaAST.Objects,
  resolve: ResolveParser
): Parser => {
  let parser: Parser | undefined
  return (input, options) => {
    try {
      return (parser ??= ast.getParser(resolve))(input, options)
    } catch (error) {
      return Effect.die(error)
    }
  }
}

/** @internal */
const resumeComposedObject = (
  ast: SchemaAST.Objects,
  properties: ReadonlyArray<ParsedProperty>,
  input: Record<PropertyKey, unknown>,
  output: Record<PropertyKey, unknown>,
  index: number,
  pending: Effect.Effect<unknown, SchemaIssue.Issue, any>,
  options: SchemaAST.ParseOptions
): Effect.Effect<unknown, SchemaIssue.Issue, any> =>
  resumeProperties({ ast, input, options, out: output, issues: undefined }, properties, index, pending)

/** @internal */
const failComposedObjectProperty = (
  ast: SchemaAST.Objects,
  input: Record<PropertyKey, unknown>,
  options: SchemaAST.ParseOptions,
  key: PropertyKey,
  exit: Exit.Failure<unknown, SchemaIssue.Issue>
): Exit.Exit<void, SchemaIssue.Issue> =>
  InternalSchemaCause.wrapPropertyKeyIssue(
    { input, options, issues: undefined },
    ast,
    key,
    exit
  )!

/** @internal */
const failMissingComposedObjectProperty = (
  ast: SchemaAST.Objects,
  input: Record<PropertyKey, unknown>,
  options: SchemaAST.ParseOptions,
  property: ParsedProperty
): Exit.Exit<never, SchemaIssue.Issue> =>
  Exit.fail(
    new SchemaIssue.Composite(
      ast,
      [Diagnostics.missingKey(property.name, property.type)],
      input,
      options
    )
  )

/** @internal */
const invalidTypeIssue = (ast: SchemaAST.AST, input: unknown, options: SchemaAST.ParseOptions) =>
  Effect.fail(new SchemaIssue.InvalidType(ast, input, options))

/** @internal */
interface ComposedObjectContext {
  readonly ast: SchemaAST.Objects
  readonly properties: ReadonlyArray<ParsedProperty>
  readonly fallback: Parser
}

/** @internal */
const makeComposedObjectContext = (ast: SchemaAST.Objects, resolve: ResolveParser): ComposedObjectContext => ({
  ast,
  properties: ast.propertySignatures.map((property): ParsedProperty => {
    const out: ParsedProperty = {
      type: property.type,
      name: property.name,
      parser(input, options) {
        const parser = resolve(property.type)
        out.parser = parser
        return parser(input, options)
      },
      valueFirst: property.name !== "__proto__" && !isOptional(property.type)
    }
    return out
  }),
  fallback: makeComposedObjectFallback(ast, resolve)
})

/** @internal */
const makeTypeDecoder = (
  ast: SchemaAST.AST,
  makeValidate: () => Validate | undefined,
  makeIs?: () => Validate | undefined
): CompiledDecoder => ({
  get is(): Is | undefined {
    const generated = makeIs?.()
    return generated === undefined ? undefined : (input, options) => generated(input, options) !== invalid
  },
  get validate() {
    return makeValidate()
  },
  get decode() {
    return makeDetailed(compileDetailed(ast))
  }
})

/** @internal */
const fromDecode = (makeDecode: () => CompiledDecoder["decode"]): CompiledDecoder => ({
  get decode() {
    return makeDecode()
  }
})

/** @internal */
const makeLocalParser = (ast: SchemaAST.AST, resolve: ResolveParser): Parser => applyChecks(ast, ast.getParser(resolve))

/** @internal */
const makeEncodingDecoder = (
  ast: SchemaAST.AST,
  resolve: ResolveParser,
  makeLocal: () => Parser
): CompiledDecoder =>
  fromDecode(() => {
    const links = ast.encoding!
    const parsers = links.map((link) => resolve(link.to))
    const decode = makeEncoding(ast, links, parsers, makeLocal())
    return (input, options) => {
      try {
        return decode(input, options)
      } catch (error) {
        return Effect.die(error)
      }
    }
  })

/** @internal */
export const runtime = {
  effectIsExit,
  hasDefaultObjectOptions,
  invalid,
  resolve,
  set,
  prepareDecode,
  args: InternalParser.args,
  missing: InternalParser.missing,
  missingExit: InternalParser.missingExit,
  succeed: InternalParser.succeed,
  die,
  defaultParseOptions,
  getCandidates,
  getIndexSignatureKeys,
  parameterFromPropertyKey,
  hasExcessProperties,
  failsChecks,
  matchesTemplateLiteral,
  assignDecodedProperty: assignProperty,
  getExpectedKeys: Diagnostics.getExpectedKeys,
  resumeComposedObject,
  failComposedObjectProperty,
  failMissingComposedObjectProperty,
  invalidTypeIssue,
  makeComposedObjectContext,
  makeComposedObjectFallback,
  makeTypeDecoder,
  fromDecode,
  makeLocalParser,
  makeEncodingDecoder,
  applyChecks
}
