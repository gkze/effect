import * as Effect from "../../Effect.ts"
import type * as SchemaAST from "../../SchemaAST.ts"
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
  (ast: SchemaAST.AST, resolve: ResolveParser): CompiledDecoder | undefined
}

const CompiledDecoderTypeId = Symbol()
const DirectParserTypeId = Symbol()

type CompiledParser = Parser & {
  readonly [CompiledDecoderTypeId]: CompiledDecoder
  readonly [DirectParserTypeId]: () => Parser
}

/** @internal */
export const getCompiledDecoder = (parser: Parser): CompiledDecoder | undefined =>
  (parser as Partial<CompiledParser>)[CompiledDecoderTypeId]

/** @internal */
export const prepareIs = (
  parser: Parser,
  options: SchemaAST.ParseOptions
): ((input: unknown) => boolean) | undefined => {
  const compiled = getCompiledDecoder(parser)
  const is = compiled?.is
  if (is !== undefined) {
    return (input) => is(input, options)
  }
  const validate = compiled?.validate
  if (validate !== undefined) {
    return (input) => validate(input, options) !== invalid
  }
}

/** @internal */
export class PreparedSyncDecoder {
  readonly validate: Validate | undefined
  readonly compiled: CompiledDecoder

  constructor(compiled: CompiledDecoder) {
    this.compiled = compiled
    this.validate = compiled.validate
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
export const prepareDecode = (compiled: CompiledDecoder): Parser => {
  const validate = compiled.validate
  if (validate === undefined) return compiled.decode
  return (input, options) => {
    if (input !== InternalParser.missing) {
      try {
        const output = validate(input, options)
        if (output !== invalid) {
          return InternalParser.succeed(output)
        }
      } catch (error) {
        return Effect.die(error)
      }
    }
    return compiled.decode(input, options)
  }
}

const makeCompiledParser = (compiled: CompiledDecoder): CompiledParser => {
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

class NormalizedDecoder implements CompiledDecoder {
  readonly compiled: CompiledDecoder

  constructor(compiled: CompiledDecoder) {
    this.compiled = compiled
  }
  get is() {
    const is = this.compiled.is
    Object.defineProperty(this, "is", { value: is })
    return is
  }
  get validate() {
    const validate = this.compiled.validate
    Object.defineProperty(this, "validate", { value: validate })
    return validate
  }
  get decode() {
    const decode = this.compiled.decode
    Object.defineProperty(this, "decode", { value: decode })
    return decode
  }
}

/** @internal */
export const set = (ast: SchemaAST.AST, compiled: CompiledDecoder): Parser => {
  const parser = makeCompiledParser(new NormalizedDecoder(compiled))
  cache.set(ast, parser)
  return parser
}

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
