/**
 * Runtime support for generated Schema decoders. This version-coupled module
 * contains no source emitter or dynamic Function construction.
 *
 * @since 4.0.0
 */
import * as Effect from "../../../Effect.ts"
import * as Exit from "../../../Exit.ts"
import { effectIsExit } from "../../../internal/effect.ts"
import * as InternalSchemaCause from "../../../internal/schema/cause.ts"
import {
  type CompiledDecoder,
  getDirectParser,
  invalid,
  type Is,
  type Parser,
  prepareDecode,
  resolve,
  type ResolveParser,
  set,
  type Validate
} from "../../../internal/schema/compilerRegistry.ts"
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

const getEncodingChecks = (ast: SchemaAST.AST): SchemaAST.Checks | undefined => {
  switch (ast._tag) {
    case "Arrays":
    case "Objects":
    case "Union":
      return ast.encodingChecks
    default:
      return undefined
  }
}

/** @internal */
const hasExcessProperties = (
  ast: SchemaAST.Objects,
  input: Record<PropertyKey, unknown>,
  options: SchemaAST.ParseOptions
): boolean => {
  const covered = new Set<PropertyKey>(
    ast.propertySignatures.map((property) => typeof property.name === "number" ? String(property.name) : property.name)
  )
  for (const index of ast.indexSignatures) {
    for (const key of SchemaAST.getIndexSignatureKeys(input, index.parameter, options)) covered.add(key)
  }
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

/** @internal */
const assignDecodedProperty = (
  output: Record<PropertyKey, unknown>,
  key: PropertyKey,
  value: unknown
): void => {
  if (key === "__proto__") {
    Object.defineProperty(output, key, { value, writable: true, enumerable: true, configurable: true })
  } else {
    output[key] = value
  }
}

function compileDetailed(ast: SchemaAST.AST): DetailedDecoder {
  const base = compileDetailedBase(ast)
  const encodingChecks = getEncodingChecks(ast)
  const checks = ast.checks
  if (encodingChecks === undefined && checks === undefined) return base
  return (input, options) => {
    const output = base(input, options)
    if (
      isFailure(output) ||
      input === InternalParser.missing ||
      output === InternalParser.missing ||
      options.disableChecks
    ) {
      return output
    }
    if (encodingChecks !== undefined) {
      const issues = SchemaAST.collectIssues(encodingChecks, input, undefined, ast, options)
      if (issues !== undefined) return fail(new SchemaIssue.Composite(ast, issues, input, options))
    }
    if (checks !== undefined) {
      const issues = SchemaAST.collectIssues(checks, output, undefined, ast, options)
      if (issues !== undefined) return fail(new SchemaIssue.Composite(ast, issues, output, options))
    }
    return output
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
      const element = index < elementLength
        ? elements[index]
        : index >= tailThreshold
        ? rest[index - tailThreshold + 1]
        : rest[0]
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
        const issue = new SchemaIssue.Pointer(
          [index],
          new SchemaIssue.MissingKey(element.ast.context?.annotations)
        )
        if (!errorsAll) return composite(ast, issue, input, options)
        if (issues === undefined) issues = [issue]
        else issues.push(issue)
      }
    }
    if (rest.length === 0 && length > elementLength) {
      for (let index = elementLength; index < length; index++) {
        const issue = new SchemaIssue.Pointer(
          [index],
          new SchemaIssue.UnexpectedKey(ast, input[index], options)
        )
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
  const expectedKeys = ast.propertySignatures.map((property) =>
    typeof property.name === "number" ? String(property.name) : property.name
  )
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
      const coveredKeys = indexKeys ? new Set(expectedKeysSet) : expectedKeysSet
      if (indexKeys) {
        for (const keys of indexKeys) {
          for (const key of keys) coveredKeys.add(key)
        }
      }
      for (const key of Reflect.ownKeys(record)) {
        if (coveredKeys.has(key)) continue
        const issue = new SchemaIssue.Pointer(
          [key],
          new SchemaIssue.UnexpectedKey(ast, record[key], options)
        )
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
        assignDecodedProperty(output, name, decoded)
      } else if (!property.optional) {
        const issue = new SchemaIssue.Pointer(
          [name],
          new SchemaIssue.MissingKey(property.ast.context?.annotations)
        )
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
        assignDecodedProperty(output, outputKey, decodedValue)
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

const resolveDirect = (resolve: ResolveParser, ast: SchemaAST.AST): Parser => {
  return getDirectParser(resolve(ast))
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
      [new SchemaIssue.Pointer([property.name], new SchemaIssue.MissingKey(property.type.context?.annotations))],
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
        const parser = resolveDirect(resolve, property.type)
        out.parser = parser
        return parser(input, options)
      },
      valueFirst: property.name !== "__proto__" && !isOptional(property.type)
    }
    return out
  }),
  fallback: makeComposedObjectFallback(ast, resolve)
})

class TypeDecoder implements CompiledDecoder {
  readonly ast: SchemaAST.AST
  readonly makeValidate: () => Validate | undefined
  readonly makeIs: (() => Validate | undefined) | undefined

  constructor(ast: SchemaAST.AST, makeValidate: () => Validate | undefined, makeIs?: () => Validate | undefined) {
    this.ast = ast
    this.makeValidate = makeValidate
    this.makeIs = makeIs
  }
  get is(): Is | undefined {
    const generated = this.makeIs?.()
    const is: Is | undefined = generated === undefined
      ? undefined
      : (input, options) => generated(input, options) !== invalid
    Object.defineProperty(this, "is", { value: is })
    return is
  }
  get validate(): Validate | undefined {
    const validate = this.makeValidate()
    Object.defineProperty(this, "validate", { value: validate })
    return validate
  }
  get decode(): CompiledDecoder["decode"] {
    const decode = makeDetailed(compileDetailed(this.ast))
    Object.defineProperty(this, "decode", { value: decode })
    return decode
  }
}

/** @internal */
const makeTypeDecoder = (
  ast: SchemaAST.AST,
  makeValidate: () => Validate | undefined,
  makeIs?: () => Validate | undefined
): CompiledDecoder => new TypeDecoder(ast, makeValidate, makeIs)

/** @internal */
const fromDecode = (makeDecode: () => CompiledDecoder["decode"]): CompiledDecoder => ({
  get decode() {
    const decode = makeDecode()
    Object.defineProperty(this, "decode", { value: decode })
    return decode
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
    const parsers = links.map((link) => resolveDirect(resolve, link.to))
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
  assignDecodedProperty,
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
