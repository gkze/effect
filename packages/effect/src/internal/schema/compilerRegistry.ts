import * as Effect from "../../Effect.ts"
import type * as SchemaAST from "../../SchemaAST.ts"
import type * as SchemaCompiler from "../../unstable/schema/SchemaCompiler.ts"
import { compile as compileInterpreted } from "./interpreter.ts"
import * as InternalParser from "./parser.ts"

/** @internal */
export const invalid = Symbol()

/** @internal */
export type Is = SchemaCompiler.Is

/** @internal */
export type Validate = SchemaCompiler.Validate

/** @internal */
export type Decode = SchemaCompiler.Decode

/** @internal */
export type CompiledDecoder = SchemaCompiler.CompiledDecoder

/** @internal */
export type Parser = Decode

/** @internal */
export interface ResolveParser {
  (ast: SchemaAST.AST): Parser
}

/** @internal */
export interface Compiler {
  (ast: SchemaAST.AST, resolve: ResolveParser): CompiledDecoder | undefined
}

/** @internal */
export class Entry implements CompiledDecoder {
  readonly origin: "interpreted" | "installed"
  private readonly source: CompiledDecoder
  readonly parser: Parser

  constructor(source: CompiledDecoder, origin: Entry["origin"]) {
    this.source = source
    this.origin = origin
    let parser: Parser | undefined
    this.parser = (input, options) => (parser ??= makeParser(this))(input, options)
  }

  get is(): Is | undefined {
    const is = this.source.is
    Object.defineProperty(this, "is", { value: is })
    return is
  }

  get validate(): Validate | undefined {
    const validate = this.source.validate
    Object.defineProperty(this, "validate", { value: validate })
    return validate
  }

  get decode(): Decode {
    const decode = this.source.decode
    Object.defineProperty(this, "decode", { value: decode })
    return decode
  }
}

const makeParser = (entry: Entry): Parser => {
  const validate = entry.validate
  if (validate === undefined) return entry.decode
  return (input, options) => {
    if (input !== InternalParser.missing) {
      try {
        const output = validate(input, options)
        if (output !== invalid) return InternalParser.succeed(output)
      } catch (error) {
        return Effect.die(error)
      }
    }
    return entry.decode(input, options)
  }
}

/** @internal */
export const prepareDecode = (decoder: CompiledDecoder): Parser => new Entry(decoder, "installed").parser

/** @internal */
export const prepareIs = (entry: Entry, options: SchemaAST.ParseOptions): ((input: unknown) => boolean) | undefined => {
  const is = entry.is
  if (is !== undefined) return (input) => is(input, options)
  const validate = entry.validate
  if (validate !== undefined) return (input) => validate(input, options) !== invalid
}

const cache = new WeakMap<SchemaAST.AST, Entry>()

/** @internal */
export const set = (ast: SchemaAST.AST, decoder: CompiledDecoder): Entry => {
  const entry = new Entry(decoder, "installed")
  cache.set(ast, entry)
  return entry
}

const setInterpreted = (ast: SchemaAST.AST, resolve: ResolveParser): Entry => {
  const entry = new Entry({ decode: compileInterpreted(ast, resolve) }, "interpreted")
  cache.set(ast, entry)
  return entry
}

let installedCompiler: Compiler | undefined

/** @internal */
export const install = (compiler: Compiler): void => {
  installedCompiler = compiler
}

/** @internal */
export const resolve = (ast: SchemaAST.AST): Entry => {
  const cached = cache.get(ast)
  if (cached !== undefined) return cached
  const compiled = installedCompiler?.(ast, resolveParser)
  return compiled !== undefined ? set(ast, compiled) : setInterpreted(ast, resolveParser)
}

/** @internal */
export const resolveParser: ResolveParser = (ast) => resolve(ast).parser

/** @internal */
export const makeScopedCompiler = (compiler: Compiler): (ast: SchemaAST.AST) => void => {
  const pending = new WeakMap<SchemaAST.AST, Parser>()

  const resolveScoped: ResolveParser = (ast) => {
    const recursive = pending.get(ast)
    if (recursive !== undefined) return recursive
    const cached = cache.get(ast)
    return cached?.origin === "installed" ? cached.parser : compileAndSet(ast, cached).parser
  }

  const compileAndSet = (ast: SchemaAST.AST, cached: Entry | undefined): Entry => {
    let entry: Entry
    pending.set(ast, (input, options) => entry.parser(input, options))
    try {
      const compiled = compiler(ast, resolveScoped)
      entry = compiled !== undefined
        ? set(ast, compiled)
        : cached?.origin === "installed"
        ? cached
        : setInterpreted(ast, resolveScoped)
      return entry
    } finally {
      pending.delete(ast)
    }
  }

  return (ast) => {
    compileAndSet(ast, cache.get(ast))
  }
}
