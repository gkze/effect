import type * as SchemaAST from "../../SchemaAST.ts"
import { runtime as Runtime } from "../../unstable/schema/SchemaCompiler/runtime.ts"
import * as Codegen from "./codegen.ts"
import {
  type CompiledDecoder,
  type Parser,
  prepareDecode,
  type ResolveParser,
  type Validate
} from "./compilerRegistry.ts"

let functionConstructor: FunctionConstructor | undefined
let functionConstructorSupported = false

const supportsDynamicFunction = (): boolean => {
  if (functionConstructor === globalThis.Function) return functionConstructorSupported
  functionConstructor = globalThis.Function
  try {
    functionConstructor("return true")
    return functionConstructorSupported = true
  } catch {
    return functionConstructorSupported = false
  }
}

const makeFunction = (...parameters: Array<string>): Function | undefined => {
  try {
    return globalThis.Function(...parameters)
  } catch (error) {
    // Recheck the capability in case the environment changed after activation.
    // A syntax/emitter defect must not silently select the interpreter.
    functionConstructor = undefined
    if (!supportsDynamicFunction()) return undefined
    throw error
  }
}

const makeValidate = (ast: SchemaAST.AST, needsValue: boolean): Validate | undefined => {
  const emitted = Codegen.emitValidate(ast, needsValue)
  const factory = makeFunction("C", "R", emitted.source)
  return factory?.(emitted.constants, Runtime)
}

const makeTypeDecoder = (ast: SchemaAST.AST, emitIs: boolean): CompiledDecoder =>
  Runtime.makeTypeDecoder(ast, () => makeValidate(ast, true), emitIs ? () => makeValidate(ast, false) : undefined)

const makeComposedObjectDecode = (ast: SchemaAST.Objects, resolve: ResolveParser): Parser | undefined => {
  if (ast.propertySignatures.length > Codegen.maxGeneratedNodes) return undefined
  const context = Runtime.makeComposedObjectContext(ast, resolve)
  const factory = makeFunction("context", "R", Codegen.emitComposedObject(ast))
  return factory?.(context, Runtime)
}

const makeLocalParser = (ast: SchemaAST.AST, resolve: ResolveParser): Parser => {
  const emission = Codegen.shouldCompileParser(ast, true) ? Codegen.getEmission(ast, 0, true) : 0
  if (emission !== 0) return prepareDecode(makeTypeDecoder(ast, emission === 2))
  return Runtime.applyChecks(
    ast,
    ast._tag === "Objects" && ast.indexSignatures.length === 0
      ? makeComposedObjectDecode(ast, resolve) ?? ast.getParser(resolve)
      : ast.getParser(resolve)
  )
}

/** @internal */
export const compile = (ast: SchemaAST.AST, resolve: ResolveParser): CompiledDecoder | undefined => {
  if (!Codegen.shouldCompileParser(ast) || !supportsDynamicFunction()) return undefined
  const emission = Codegen.getEmission(ast)
  if (emission !== 0) return makeTypeDecoder(ast, emission === 2)
  if (ast.encoding !== undefined) {
    return Runtime.makeEncodingDecoder(ast, resolve, () => makeLocalParser(ast, resolve))
  }
  if (ast._tag === "Objects" && Codegen.canCompileComposedObject(ast)) {
    return Runtime.fromDecode(() =>
      makeComposedObjectDecode(ast, resolve) ?? Runtime.makeComposedObjectFallback(ast, resolve)
    )
  }
  return undefined
}
