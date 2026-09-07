import * as Effect from "../../Effect.ts"
import type * as SchemaAST from "../../SchemaAST.ts"
import type * as SchemaCompiler from "../../unstable/schema/SchemaCompiler.ts"
import * as Interpreter from "./interpreter.ts"
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
  (ast: SchemaAST.AST, resolve: ResolveEntry): CompiledDecoder | undefined
}

/** @internal */
export interface ResolveEntry {
  (ast: SchemaAST.AST): Entry
}

/** @internal */
export class Entry implements CompiledDecoder {
  private readonly source: CompiledDecoder | undefined
  private readonly ast: SchemaAST.AST
  private readonly resolve: ResolveEntry

  constructor(ast: SchemaAST.AST, source: CompiledDecoder | undefined, resolve: ResolveEntry) {
    this.ast = ast
    this.resolve = resolve
    this.source = source
  }

  get origin(): "interpreted" | "installed" {
    return this.source === undefined ? "interpreted" : "installed"
  }

  get parseEffect(): Parser {
    let parser: Parser | undefined
    const parse: Parser = (input, options) => (parser ??= makeParser(this))(input, options)
    Object.defineProperty(this, "parseEffect", { value: parse })
    return parse
  }

  get is(): Is | undefined {
    const is = this.source?.is
    Object.defineProperty(this, "is", { value: is })
    return is
  }

  get validate(): Validate | undefined {
    const validate = this.source?.validate
    Object.defineProperty(this, "validate", { value: validate })
    return validate
  }

  get decodeEffect(): Decode {
    const decode = this.source === undefined
      ? Interpreter.compile(this.ast, (ast) => this.resolve(ast).parseEffect)
      : this.source.decodeEffect
    Object.defineProperty(this, "decodeEffect", { value: decode })
    return decode
  }

  get makeEffect(): Decode {
    const make = this.source?.makeEffect ?? Interpreter.compileConstructor(this.ast, constructorResolver(this.resolve))
    Object.defineProperty(this, "makeEffect", { value: make })
    return make
  }
}

const makeParser = (entry: CompiledDecoder): Parser => {
  const validate = entry.validate
  if (validate === undefined) return entry.decodeEffect
  return (input, options) => {
    if (input !== InternalParser.missing) {
      try {
        const output = validate(input, options)
        if (output !== invalid) return InternalParser.succeed(output)
      } catch (error) {
        return Effect.die(error)
      }
    }
    return entry.decodeEffect(input, options)
  }
}

/** @internal */
export const prepareDecode = (decoder: CompiledDecoder): Parser => {
  let parser: Parser | undefined
  let decode: Decode | undefined
  const source: CompiledDecoder = {
    get validate() {
      return decoder.validate
    },
    get decodeEffect() {
      return decode ??= decoder.decodeEffect
    }
  }
  return (input, options) => (parser ??= makeParser(source))(input, options)
}

/** @internal */
export const prepareIs = (entry: Entry, options: SchemaAST.ParseOptions): ((input: unknown) => boolean) | undefined => {
  const is = entry.is
  if (is !== undefined) return (input) => is(input, options)
  const validate = entry.validate
  if (validate !== undefined) return (input) => validate(input, options) !== invalid
}

const cache = new WeakMap<SchemaAST.AST, Entry>()

/** @internal */
export const set = (ast: SchemaAST.AST, decoder: CompiledDecoder, resolveChild: ResolveEntry = resolve): Entry => {
  const entry = new Entry(ast, decoder, resolveChild)
  cache.set(ast, entry)
  return entry
}

const setInterpreted = (ast: SchemaAST.AST, resolve: ResolveEntry): Entry => {
  const entry = new Entry(ast, undefined, resolve)
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
  const compiled = installedCompiler?.(ast, resolve)
  return compiled !== undefined ? set(ast, compiled) : setInterpreted(ast, resolve)
}

/** @internal */
export const resolveParser: ResolveParser = (ast) => resolve(ast).parseEffect

/** @internal */
export const resolveConstructor: ResolveParser = (ast) => resolve(ast).makeEffect

/** @internal */
export const constructorResolver = (resolve: ResolveEntry): ResolveParser => (ast) => {
  // Declaration callbacks can use public decoders for these ASTs before invoking
  // this constructor. Register the entry now, but leave its operations lazy.
  const entry = resolve(ast)
  return (input, options) => {
    const parser = entry.makeEffect
    return parser(input, options)
  }
}

/** @internal */
export const makeScopedCompiler = (compiler: Compiler): (ast: SchemaAST.AST) => void => {
  const resolveScoped: ResolveEntry = (ast) => {
    const cached = cache.get(ast)
    return cached?.origin === "installed" ? cached : compileAndSet(ast, cached)
  }

  const compileAndSet = (ast: SchemaAST.AST, cached: Entry | undefined): Entry => {
    // Operation factories resolve children only after this entry is installed.
    const compiled = compiler(ast, resolveScoped)
    return compiled !== undefined
      ? set(ast, compiled, resolveScoped)
      : cached?.origin === "installed"
      ? cached
      : setInterpreted(ast, resolveScoped)
  }

  return (ast) => {
    compileAndSet(ast, cache.get(ast))
  }
}
