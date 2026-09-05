import * as Effect from "../../Effect.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import type * as SchemaIssue from "../../SchemaIssue.ts"
import { compile as compileInterpreted } from "./interpreter.ts"
import * as InternalParser from "./parser.ts"

/** @internal */
export const invalid = Symbol()

/** @internal */
export interface Is {
  (input: unknown, options: SchemaAST.ParseOptions): boolean
}

/** @internal */
export interface Validate {
  (input: unknown, options: SchemaAST.ParseOptions): unknown | typeof invalid
}

/** @internal */
export interface Decode {
  (
    input: unknown,
    options: SchemaAST.ParseOptions
  ): Effect.Effect<unknown, SchemaIssue.Issue, any>
}

/** @internal */
export interface CompiledDecoder {
  readonly is?: Is | undefined
  readonly validate?: Validate | undefined
  readonly decode: Decode
}

/** @internal */
export interface OptimizedIs extends Is {
  readonly default: (input: unknown) => boolean
}

/** @internal */
export interface OptimizedValidate extends Validate {
  readonly default: (input: unknown) => unknown | typeof invalid
}

/** @internal */
export interface OptimizedCompiledDecoder {
  readonly is?: OptimizedIs | undefined
  readonly validate?: OptimizedValidate | undefined
  readonly decode: Decode
}

/** @internal */
export interface Parser {
  (
    input: unknown,
    options: SchemaAST.ParseOptions
  ): Effect.Effect<unknown, SchemaIssue.Issue, any>
}

/** @internal */
export interface ResolveParser {
  (ast: SchemaAST.AST): Parser
}

/** @internal */
export interface Compiler {
  (ast: SchemaAST.AST, resolve: ResolveParser): OptimizedCompiledDecoder | undefined
}

const CompiledDecoderTypeId = Symbol()
const DirectParserTypeId = Symbol()

type CompiledParser = Parser & {
  readonly [CompiledDecoderTypeId]: OptimizedCompiledDecoder
  readonly [DirectParserTypeId]: () => Parser
}

/** @internal */
export const getCompiledDecoder = (parser: Parser): OptimizedCompiledDecoder | undefined =>
  (parser as Partial<CompiledParser>)[CompiledDecoderTypeId]

/** @internal */
export const prepareIs = (
  parser: Parser,
  options: SchemaAST.ParseOptions
): ((input: unknown) => boolean) | undefined => {
  const compiled = getCompiledDecoder(parser)
  const is = compiled?.is
  if (is !== undefined) {
    return options === SchemaAST.defaultParseOptions ? is.default : (input) => is(input, options)
  }
  const validate = compiled?.validate
  if (validate !== undefined) {
    return options === SchemaAST.defaultParseOptions
      ? (input) => validate.default(input) !== invalid
      : (input) => validate(input, options) !== invalid
  }
}

/** @internal */
export class PreparedSyncDecoder {
  readonly validate: ((input: unknown) => unknown | typeof invalid) | undefined
  readonly compiled: OptimizedCompiledDecoder

  constructor(compiled: OptimizedCompiledDecoder) {
    this.compiled = compiled
    this.validate = compiled.validate?.default
  }

  get decode(): Parser {
    return this.compiled.decode
  }
}

/** @internal */
export const prepareSync = (parser: Parser): PreparedSyncDecoder | undefined => {
  const compiled = getCompiledDecoder(parser)
  if (compiled === undefined) return undefined
  return new PreparedSyncDecoder(compiled)
}

/** @internal */
export const prepareDecode = (compiled: OptimizedCompiledDecoder): Parser => {
  const validate = compiled.validate
  if (validate === undefined) return compiled.decode
  return (input, options) => {
    if (input !== InternalParser.missing) {
      try {
        const output = options === SchemaAST.defaultParseOptions
          ? validate.default(input)
          : validate(input, options)
        if (output !== invalid) {
          return output === input ? InternalParser.sameExit : InternalParser.succeed(output)
        }
      } catch (error) {
        return Effect.die(error)
      }
    }
    return compiled.decode(input, options)
  }
}

const makeCompiledParser = (compiled: OptimizedCompiledDecoder): CompiledParser => {
  let direct: Parser | undefined
  const getDirect = (): Parser => direct ??= prepareDecode(compiled)
  const parser: Parser = (input, options) => getDirect()(input, options)
  return Object.assign(parser, {
    [CompiledDecoderTypeId]: compiled,
    [DirectParserTypeId]: getDirect
  })
}

/** @internal */
export const getDirectParser = (parser: Parser): Parser =>
  (parser as Partial<CompiledParser>)[DirectParserTypeId]?.() ?? parser

const cache = new WeakMap<SchemaAST.AST, Parser>()

const optimizeIs = (is: Is): OptimizedIs => {
  const optimized = (is as Partial<OptimizedIs>).default
  return optimized === undefined
    ? Object.assign(
      (input: unknown, options: SchemaAST.ParseOptions) => is(input, options),
      { default: (input: unknown) => is(input, SchemaAST.defaultParseOptions) }
    )
    : is as OptimizedIs
}

const optimizeValidate = (validate: Validate): OptimizedValidate => {
  const optimized = (validate as Partial<OptimizedValidate>).default
  return optimized === undefined
    ? Object.assign(
      (input: unknown, options: SchemaAST.ParseOptions) => validate(input, options),
      { default: (input: unknown) => validate(input, SchemaAST.defaultParseOptions) }
    )
    : validate as OptimizedValidate
}

class NormalizedDecoder implements OptimizedCompiledDecoder {
  readonly compiled: CompiledDecoder

  constructor(compiled: CompiledDecoder) {
    this.compiled = compiled
  }
  get is() {
    const operation = this.compiled.is
    const is = operation === undefined ? undefined : optimizeIs(operation)
    Object.defineProperty(this, "is", { value: is })
    return is
  }
  get validate() {
    const operation = this.compiled.validate
    const validate = operation === undefined ? undefined : optimizeValidate(operation)
    Object.defineProperty(this, "validate", { value: validate })
    return validate
  }
  get decode() {
    const decode = this.compiled.decode
    Object.defineProperty(this, "decode", { value: decode })
    return decode
  }
}

const setOptimized = (ast: SchemaAST.AST, compiled: OptimizedCompiledDecoder): Parser => {
  const parser = makeCompiledParser(compiled)
  cache.set(ast, parser)
  return parser
}

/** @internal */
export const set = (ast: SchemaAST.AST, compiled: CompiledDecoder): Parser =>
  setOptimized(ast, new NormalizedDecoder(compiled))

let installedCompiler: Compiler | undefined

/** @internal */
export const install = (compiler: Compiler): void => {
  installedCompiler = compiler
}

/** @internal */
export const resolve: ResolveParser = (ast) => {
  const cached = cache.get(ast)
  if (cached !== undefined) return cached
  const compiled = installedCompiler?.(ast, resolve)
  if (compiled !== undefined) return set(ast, compiled)
  const parser = compileInterpreted(ast, resolve)
  cache.set(ast, parser)
  return parser
}

/** @internal */
export const makeScopedCompiler = (compiler: Compiler): (ast: SchemaAST.AST) => void => {
  const pending = new WeakMap<SchemaAST.AST, Parser>()

  const resolveScoped: ResolveParser = (ast) => {
    const recursive = pending.get(ast)
    if (recursive !== undefined) return recursive
    const cached = cache.get(ast)
    if (cached !== undefined && getCompiledDecoder(cached) !== undefined) {
      return cached
    }
    return compileAndSet(ast, cached)
  }

  const compileAndSet = (ast: SchemaAST.AST, cached: Parser | undefined): Parser => {
    let parser: Parser | undefined
    const recursive: Parser = (input, options) => parser!(input, options)
    pending.set(ast, recursive)
    try {
      const compiled = compiler(ast, resolveScoped)
      if (compiled !== undefined) {
        parser = set(ast, compiled)
        return parser
      }
      if (cached !== undefined && getCompiledDecoder(cached) !== undefined) {
        parser = cached
        return parser
      }
      parser = compileInterpreted(ast, resolveScoped)
      cache.set(ast, parser)
      return parser
    } finally {
      pending.delete(ast)
    }
  }

  return (ast) => {
    compileAndSet(ast, cache.get(ast))
  }
}
