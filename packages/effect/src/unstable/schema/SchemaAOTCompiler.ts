/**
 * Generates static JavaScript modules that install Schema decoders in the shared
 * registry. Generated modules use the same runtime support as the JIT compiler,
 * without importing source generation or constructing functions dynamically.
 *
 * @since 4.0.0
 */
import * as Codegen from "../../internal/schema/codegen.ts"
import * as SchemaAST from "../../SchemaAST.ts"

const helper = Codegen.runtimeReference

const validator = (ast: SchemaAST.AST, needsValue: boolean): string => {
  const emitted = Codegen.emitValidate(ast, needsValue)
  return `(function(C,R){${emitted.source}})([${emitted.bindings.map((binding) => binding.reference).join(",")}],R)`
}

const typeDecoder = (ast: SchemaAST.AST, emitIs: boolean): string =>
  `${helper("makeTypeDecoder")}(ast,()=>${validator(ast, true)}${emitIs ? `,()=>${validator(ast, false)}` : ""})`

const composedObject = (ast: SchemaAST.Objects): string =>
  `(function(context,R){${Codegen.emitComposedObject(ast)}})(${helper("makeComposedObjectContext")}(ast,${
    helper("resolve")
  }),R)`

const localParser = (ast: SchemaAST.AST): string => {
  const selection = Codegen.select(ast, true)
  if (selection._tag === "Type") return `${helper("prepareDecode")}(${typeDecoder(ast, selection.outputFree)})`
  if (selection._tag === "Object" && selection.ast.propertySignatures.length <= Codegen.maxGeneratedNodes) {
    return `${helper("applyChecks")}(ast,${composedObject(selection.ast)})`
  }
  return `${helper("makeLocalParser")}(ast,${helper("resolve")})`
}

const decodeSource = (ast: SchemaAST.AST): string | undefined => {
  const selection = Codegen.select(ast)
  switch (selection._tag) {
    case "Fallback":
      return undefined
    case "Type":
      return typeDecoder(ast, selection.outputFree)
    case "Encoding":
      return `${helper("makeEncodingDecoder")}(ast,${helper("resolve")},()=>${localParser(ast)})`
    case "Object":
      return `${helper("fromDecode")}(()=>${helper("applyChecks")}(ast,${
        selection.ast.propertySignatures.length <= Codegen.maxGeneratedNodes
          ? composedObject(selection.ast)
          : `${helper("makeComposedObjectFallback")}(ast,${helper("resolve")})`
      }))`
  }
}

const decoder = (ast: SchemaAST.AST): string | undefined => {
  const decode = decodeSource(ast)
  const selection = Codegen.selectConstructor(ast)
  let make: string
  switch (selection) {
    case "Class":
      make = `${helper("makeClassConstructor")}(ast,${helper("resolveEntry")})`
      break
    case "Leaf":
      make = `${helper("makeLeafConstructor")}(ast)`
      break
    case "Objects":
    case "Arrays":
    case "Union": {
      const name = selection === "Objects"
        ? "makeObjectConstructor"
        : selection === "Arrays"
        ? "makeArrayConstructor"
        : "makeUnionConstructor"
      make = `${helper("applyChecks")}(ast,${helper(name)}(ast,${helper("resolveEntry")}))`
      break
    }
    case "Object":
      make = `${helper("applyChecks")}(ast,(function(context,R){${
        Codegen.emitComposedObject(ast as SchemaAST.Objects)
      }})(${helper("makeConstructionContext")}(ast,${helper("resolveEntry")}),R))`
      break
    default:
      return decode
  }
  return `${helper("withConstructor")}(${
    decode ?? `${helper("interpretedDecoder")}(ast,${helper("resolveEntry")})`
  },()=>${make})`
}

/**
 * Generates a JavaScript ES module exporting `install(asts): void` for an
 * ordered array of ASTs and their statically reachable parsing and construction dependencies.
 *
 * **When to use**
 *
 * Use to prepare decoders at build time for environments that disallow dynamic
 * function construction. Save the returned source as a JavaScript module, then
 * call its `install` export with the corresponding runtime ASTs in the same
 * order before using parsers. Use a one-element array for a single schema.
 *
 * **Details**
 *
 * Generation does not install decoders or execute checks and transformations.
 * Installation uses the same registry as `SchemaCompiler.set`; normal
 * `SchemaParser` functions consume those entries. Generated validators and
 * composed Struct decoders are static functions. Detailed diagnostic closures
 * and transformation orchestration still initialize lazily in shared runtime
 * support. Transformations and middleware are not replayed.
 * Repeated ASTs and shared dependencies are installed once by identity. Fast
 * paths can still inline dependency code into multiple parent decoders.
 * An empty array generates a module whose installation does nothing.
 * Construction uses independently lazy `makeEffect` operations. Struct loops
 * are emitted as static functions; Array, Record, Union, leaf, and Class
 * constructors are specialized lazily in the shared runtime. Constructor defaults
 * and Class source schemas are read from the supplied ASTs, not serialized or
 * executed during generation. Construction never runs a validation-and-replay pass.
 *
 * **Gotchas**
 *
 * Regenerate the module whenever the schema definition or Effect version
 * changes. Installation trusts that the runtime array has the same length and
 * root order, and its ASTs have the same definitions and sharing as at build
 * time. Functions and symbols are read from those ASTs, not serialized.
 * Suspend thunks are not evaluated during generation; their contents and other
 * unsupported nodes use the interpreter.
 * Installation replaces generated entries, but parsers that already captured
 * older entries keep them. Type-side and flipped ASTs are separate registry
 * keys; generate and install them separately when needed. Importing the
 * generated module alone does not install anything.
 * In particular, include `SchemaAST.toType(schema.ast)` to prepare construction
 * when it differs from the encoded root. Unsupported constructors use the
 * interpreter while statically installed children remain available.
 *
 * @category compilation
 * @since 4.0.0
 */
export const compile = (asts: ReadonlyArray<SchemaAST.AST>): string => {
  const seen = new Map<SchemaAST.AST, string>()
  const bindings: Array<string> = []
  const factories: Array<string> = []
  const installations: Array<string> = []

  const visit = (node: SchemaAST.AST, reference: string): void => {
    if (seen.has(node)) return
    const index = seen.size
    const name = `a${index}`
    seen.set(node, name)
    bindings.push(`const ${name}=${reference};`)

    switch (node._tag) {
      case "Declaration":
        node.typeParameters.forEach((child, index) => visit(child, `${name}.typeParameters[${index}]`))
        break
      case "TemplateLiteral":
        node.parts.forEach((child, index) => visit(child, `${name}.parts[${index}]`))
        break
      case "Arrays":
        node.elements.forEach((child, index) => visit(child, `${name}.elements[${index}]`))
        node.rest.forEach((child, index) => visit(child, `${name}.rest[${index}]`))
        break
      case "Objects":
        node.propertySignatures.forEach((property, index) =>
          visit(property.type, `${name}.propertySignatures[${index}].type`)
        )
        node.indexSignatures.forEach((signature, index) => {
          visit(
            SchemaAST.parameterFromPropertyKey(signature.parameter),
            `${helper("parameterFromPropertyKey")}(${name}.indexSignatures[${index}].parameter)`
          )
          visit(signature.type, `${name}.indexSignatures[${index}].type`)
        })
        break
      case "Union":
        node.types.forEach((child, index) => visit(child, `${name}.types[${index}]`))
        break
    }
    node.encoding?.forEach((link, index) => visit(link.to, `${name}.encoding[${index}].to`))
    if (node.context?.constructorDefault !== undefined) {
      visit(node.context.constructorDefault.to, `${name}.context.constructorDefault.to`)
    }
    const descriptor = SchemaAST.getConstructorDescriptor(node)
    if (descriptor !== undefined) {
      visit(descriptor.link.to, `${helper("getConstructorDescriptor")}(${name}).link.to`)
    }

    const source = decoder(node)
    if (source !== undefined) {
      factories.push(`function d${index}(ast){return ${source}}`)
      installations.push(`${helper("set")}(${name},d${index}(${name}));`)
    }
  }
  asts.forEach((ast, index) => visit(ast, `asts[${index}]`))
  return [
    "// Generated by SchemaAOTCompiler. Regenerate after schema or Effect changes.",
    "import { runtime as R } from \"effect/unstable/schema/SchemaCompiler/runtime\";",
    ...factories,
    "/** @param {ReadonlyArray<import(\"effect/SchemaAST\").AST>} asts */",
    "export function install(asts){",
    ...bindings,
    ...installations,
    "}",
    ""
  ].join("\n")
}
