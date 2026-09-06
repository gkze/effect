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
  return factory?.(emitted.bindings.map((binding) => binding.value), Runtime)
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
  const selection = Codegen.select(ast, true)
  if (selection._tag === "Type") return prepareDecode(makeTypeDecoder(ast, selection.outputFree))
  return Runtime.applyChecks(
    ast,
    selection._tag === "Object"
      ? makeComposedObjectDecode(selection.ast, resolve) ?? ast.getParser(resolve)
      : ast.getParser(resolve)
  )
}

/** @internal */
export const compile = (ast: SchemaAST.AST, resolve: ResolveParser): CompiledDecoder | undefined => {
  const selection = Codegen.select(ast)
  if (selection._tag === "Fallback" || !supportsDynamicFunction()) return undefined
  switch (selection._tag) {
    case "Type":
      return makeTypeDecoder(ast, selection.outputFree)
    case "Encoding":
      return Runtime.makeEncodingDecoder(ast, resolve, () => makeLocalParser(ast, resolve))
    case "Object":
      return Runtime.fromDecode(() =>
        makeComposedObjectDecode(selection.ast, resolve) ?? Runtime.makeComposedObjectFallback(selection.ast, resolve)
      )
  }
}
