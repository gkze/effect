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
import { compile as compileInterpreted } from "./interpreter.ts"

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

const withCompilationFallback = (
  decoder: CompiledDecoder,
  makeFallback: () => Parser
): CompiledDecoder => {
  let failed = false
  const getOperation = <K extends keyof CompiledDecoder>(key: K): CompiledDecoder[K] => {
    if (!failed) {
      try {
        return decoder[key]
      } catch {
        // Only initialize operations here; never run a parser inside this catch.
        failed = true
        decoder = Runtime.fromDecode(makeFallback)
      }
    }
    return decoder[key]
  }
  return {
    get is() {
      return getOperation("is")
    },
    get validate() {
      return getOperation("validate")
    },
    get decode() {
      return getOperation("decode")
    }
  }
}

const makeValidate = (ast: SchemaAST.AST, needsValue: boolean): Validate => {
  const emitted = Codegen.emitValidate(ast, needsValue)
  const factory = globalThis.Function("C", "R", emitted.source)
  return factory(emitted.bindings.map((binding) => binding.value), Runtime)
}

const makeTypeDecoder = (ast: SchemaAST.AST, emitIs: boolean): CompiledDecoder =>
  Runtime.makeTypeDecoder(ast, () => makeValidate(ast, true), emitIs ? () => makeValidate(ast, false) : undefined)

const makeComposedObjectDecode = (ast: SchemaAST.Objects, resolve: ResolveParser): Parser | undefined => {
  if (ast.propertySignatures.length > Codegen.maxGeneratedNodes) return undefined
  const context = Runtime.makeComposedObjectContext(ast, resolve)
  const factory = globalThis.Function("context", "R", Codegen.emitComposedObject(ast))
  return factory(context, Runtime)
}

const makeLocalParser = (ast: SchemaAST.AST, resolve: ResolveParser): Parser => {
  const selection = Codegen.select(ast, true)
  if (selection._tag === "Type") {
    return prepareDecode(withCompilationFallback(
      makeTypeDecoder(ast, selection.outputFree),
      // This checkpoint has already run the outer encoding. Do not run it again.
      () => Runtime.makeLocalParser(ast, resolve)
    ))
  }
  return Runtime.applyChecks(
    ast,
    selection._tag === "Object"
      ? makeComposedObjectDecode(selection.ast, resolve) ?? ast.getParser(resolve)
      : ast.getParser(resolve)
  )
}

/** @internal */
export const compile = (ast: SchemaAST.AST, resolve: ResolveParser): CompiledDecoder | undefined => {
  try {
    const selection = Codegen.select(ast)
    if (selection._tag === "Fallback" || !supportsDynamicFunction()) return undefined
    let decoder: CompiledDecoder
    switch (selection._tag) {
      case "Type":
        decoder = makeTypeDecoder(ast, selection.outputFree)
        break
      case "Encoding":
        decoder = Runtime.makeEncodingDecoder(ast, resolve, () => makeLocalParser(ast, resolve))
        break
      case "Object":
        decoder = Runtime.fromDecode(() =>
          makeComposedObjectDecode(selection.ast, resolve) ?? Runtime.makeComposedObjectFallback(selection.ast, resolve)
        )
        break
    }
    return withCompilationFallback(decoder, () => compileInterpreted(ast, resolve))
  } catch {
    // The registry caches the interpreter when compilation fails before installation.
    return undefined
  }
}
