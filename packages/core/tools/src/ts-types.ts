/**
 * PTC 模式代码生成：从已注册工具模式到模型编程所针对的 TypeScript SDK
 * 文本（`tools:sdk` 提示词章节）的纯投影。`json-schema.ts` 的兄弟模块——
 * `schemas()`（原生函数调用）与本模块（生成的 `declare const tools` API）
 * 是同一存储的两个投影。
 * @module @deepseek-ai/dsh-tools/src/ts-types
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema } from './json-schema.ts'
import type { JsonSchemaNode, JsonSchemaScalar } from './json-schema.ts'
/** 内部 PTC 模式投影：面向模型的模式加上规范输出模式。 */
export interface ToolSdkSchema extends ToolSchema {
  /** 工具绑定返回的已验证规范值。 */
  output: JsonSchemaNode
}

/** 可作为裸 TS 标识符的属性名；其余一律加引号。 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 渲染对象键：有效标识符时裸写，否则加引号（每个名称都保持可达，无别名）。 */
function renderKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** 深度为 `indent` 的行前缀（每级两个空格）。 */
function pad(indent: number): string {
  return '  '.repeat(indent)
}

/** 为模式 `description` 生成单行 JSDoc 块；没有描述则不产生行。 */
function docLines(description: unknown, indent: number): string[] {
  if (typeof description !== 'string' || description.length === 0) return []
  // 将散文折叠为稳定的单行文档，并转义注释结束符，使模式描述无法终止
  // 生成的 JSDoc。
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}

/** 渲染一个已被统一模式校验方验证过的标量。 */
function renderScalar(value: JsonSchemaScalar): string {
  return JSON.stringify(value)
}

/** 渲染已验证的标量 `const`/`enum`，否则回退到宽泛类型。 */
function renderConstrainedScalar(node: Record<string, unknown>, type: string): string {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const')) return renderScalar(node.const as JsonSchemaScalar)
  if (Object.hasOwn(node, 'enum')) {
    return (node.enum as JsonSchemaScalar[]).map(renderScalar).join(' | ')
  }
  return broad
}

/** 可组合的类型文档，无需递归字符串拼接即可扁平化。 */
interface TypeDocument {
  readonly parts: readonly (string | TypeDocument)[]
  readonly containsUnionOrIntersection: boolean
}

/** 从捕获的部分构建文档，同时保留旧有的数组加括号判定。 */
function typeDocumentFrom(parts: readonly (string | TypeDocument)[]): TypeDocument {
  return {
    parts,
    containsUnionOrIntersection: parts.some(part => typeof part === 'string'
      ? part.includes('|') || part.includes('&')
      : part.containsUnionOrIntersection),
  }
}

/** 构建小型文档，每个调用点不经中间数组。 */
function typeDocument(...parts: (string | TypeDocument)[]): TypeDocument {
  return typeDocumentFrom(parts)
}

/** 用显式工作栈扁平化嵌套文档。 */
function flattenTypeDocument(document: TypeDocument): string {
  const chunks: string[] = []
  const tasks: (string | TypeDocument)[] = [document]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (typeof task === 'string') {
      chunks.push(task)
      continue
    }
    for (let index = task.parts.length - 1; index >= 0; index--) {
      const part = task.parts[index]
      /* v8 ignore next -- the loop is bounded by the captured part count. */
      if (part !== undefined) tasks.push(part)
    }
  }
  return chunks.join('')
}

/** 栈安全的模式到 TypeScript 渲染的一个显式调用帧。 */
interface SchemaRenderFrame {
  readonly node: JsonSchemaNode
  readonly indent: number
  phase: 'start' | 'children'
  kind?: 'oneOf' | 'array' | 'object'
  children: { node: JsonSchemaNode; indent: number }[]
  childIndex: number
  childDocuments: TypeDocument[]
  entries: [string, JsonSchemaNode][]
}

/** 以空聚合状态初始化一个模式渲染帧。 */
function schemaRenderFrame(node: JsonSchemaNode, indent: number): SchemaRenderFrame {
  return { node, indent, phase: 'start', children: [], childIndex: 0, childDocuments: [], entries: [] }
}

/** 将已断言的模式渲染为可组合文档。 */
function renderSupportedSchema(schema: JsonSchemaNode, indent: number): TypeDocument {
  const frames: SchemaRenderFrame[] = [schemaRenderFrame(schema, indent)]
  let rootDocument: TypeDocument | undefined
  const finish = (document: TypeDocument): void => {
    frames.pop()
    const parent = frames.at(-1)
    if (parent === undefined) rootDocument = document
    else parent.childDocuments.push(document)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    if (frame.phase === 'children') {
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex]
        /* v8 ignore next -- childIndex is bounded by children.length. */
        if (child === undefined) throw new Error('missing schema render child')
        frame.childIndex++
        frames.push(schemaRenderFrame(child.node, child.indent))
        continue
      }
      if (frame.kind === 'oneOf') {
        const parts: (string | TypeDocument)[] = []
        for (let index = 0; index < frame.childDocuments.length; index++) {
          if (index > 0) parts.push(' | ')
          const child = frame.childDocuments[index]
          /* v8 ignore next -- child documents correspond one-to-one with children. */
          if (child !== undefined) parts.push(child)
        }
        finish(typeDocumentFrom(parts))
        continue
      }
      if (frame.kind === 'array') {
        const child = frame.childDocuments[0]
        /* v8 ignore next -- array frames always schedule exactly one child. */
        if (child === undefined) throw new Error('missing array item type')
        finish(child.containsUnionOrIntersection
          ? typeDocument('(', child, ')[]')
          : typeDocument(child, '[]'))
        continue
      }

      const required = new Set(frame.node.required)
      const parts: (string | TypeDocument)[] = ['{']
      for (let index = 0; index < frame.entries.length; index++) {
        const entry = frame.entries[index]
        const child = frame.childDocuments[index]
        /* v8 ignore next -- object entries and child documents have the same length. */
        if (entry === undefined || child === undefined) throw new Error('missing object property type')
        const [name, prop] = entry
        for (const line of docLines(prop.description, frame.indent + 1)) parts.push('\n', line)
        parts.push('\n', `${pad(frame.indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: `, child, ';')
      }
      parts.push('\n', `${pad(frame.indent)}}`)
      const declared = typeDocumentFrom(parts)
      finish(frame.node.additionalProperties === false
        ? declared
        : typeDocument(declared, ' & Record<string, JsonValue>'))
      continue
    }

    const node = frame.node
    if (node.oneOf !== undefined) {
      frame.kind = 'oneOf'
      frame.children = Array.from(node.oneOf, child => ({ node: child, indent: frame.indent }))
      frame.childIndex = 0
      frame.childDocuments = []
      frame.phase = 'children'
      continue
    }
    if (node.type === undefined) {
      finish(typeDocument('JsonValue'))
      continue
    }
    switch (node.type) {
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        finish(typeDocument(renderConstrainedScalar(node as Record<string, unknown>, node.type)))
        break
      case 'array':
        if (node.items === undefined) {
          finish(typeDocument('JsonValue[]'))
        } else {
          frame.kind = 'array'
          frame.children = [{ node: node.items, indent: frame.indent }]
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      case 'object': {
        const open = node.additionalProperties !== false
        const entries = Object.entries(node.properties ?? {})
        if (entries.length === 0) {
          finish(typeDocument(open ? 'Record<string, JsonValue>' : 'Record<string, never>'))
        } else {
          frame.kind = 'object'
          frame.entries = entries
          frame.children = entries.map(([, child]) => ({ node: child, indent: frame.indent + 1 }))
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      }
      /* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
      default:
        finish(typeDocument('unknown'))
    }
  }

  /* v8 ignore next -- every root frame produces one document. */
  return rootDocument ?? typeDocument('unknown')
}

/**
 * 将一个受强制的 JSON Schema 节点映射为 TypeScript 类型字面量。支持每个
 * 统一模式构造，对畸形或不支持的输入返回 `unknown` 而不抛出。
 * @param schema - JSON Schema 节点（任意形态；恶意输入退化为 unknown）。
 * @param indent - 嵌套对象成员的缩进层级。
 * @returns TS 类型文本（含属性的对象为多行）。
 */
export function jsonSchemaToTs(schema: unknown, indent = 0): string {
  try {
    assertSupportedJsonSchema(schema)
    return flattenTypeDocument(renderSupportedSchema(schema, indent))
  } catch {
    return 'unknown'
  }
}

/** 为所选执行语法渲染参数与调用指令。 */
function renderSdkInstructions(programFormat: 'function-body' | 'repl'): string {
  const programDescription = programFormat === 'function-body'
    ? 'the body of an async TypeScript function (erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped)'
    : 'the program to execute'
  return `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\`, ${programDescription}, and \`description\`, a short summary of what the program does. The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly.`
}

/** 为所选执行语法渲染工具执行与输出指令。 */
function renderSdkProgramInstructions(programFormat: 'function-body' | 'repl'): string {
  const outputInstruction = programFormat === 'function-body'
    ? 'Emit results with `return` and/or `console.log(...)`. Only what you print or return is program output.'
    : 'Only values emitted as program output enter the conversation.'
  return `Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- ${outputInstruction} A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:`
}

/** 某个字符串模式是否接受 bash 示例使用的字面量。 */
function acceptsExampleString(schema: JsonSchemaNode | undefined, value: string): boolean {
  return schema?.type === 'string'
    && (schema.const === undefined || schema.const === value)
    && (schema.enum === undefined || schema.enum.includes(value))
}

/** 仅当字面量参数满足当前参数模式时渲染 bash 示例。 */
function renderBashExample(schemas: ToolSdkSchema[], programFormat: 'function-body' | 'repl'): string {
  const bash = schemas.find(schema => schema.name === 'bash')
  if (bash === undefined) return ''
  const parameters = bash.parameters as JsonSchemaNode
  if (parameters.type !== 'object') return ''
  const required = parameters.required ?? []
  if (required.some(name => name !== 'command' && name !== 'description')) return ''
  if (!acceptsExampleString(parameters.properties?.command, 'pwd')) return ''
  const needsDescription = required.includes('description')
  if (needsDescription && !acceptsExampleString(parameters.properties?.description, 'Show current directory')) return ''
  const description = needsDescription ? "description: 'Show current directory', " : ''
  const program = programFormat === 'function-body'
    ? `return await tools.bash({ ${description}command: 'pwd' })`
    : `console.log(await tools.bash({ ${description}command: 'pwd' }))`
  return ` When no separate \`bash\` schema is supplied, invoke a declared \`bash\` binding inside \`run_code\`:\n\n\`run_code({ code: "${program}", description: "Show current directory" })\``
}

/**
 * 渲染完整的 `tools:sdk` 提示词章节：固定的使用说明，加上覆盖每个给定
 * 工具的一个 `declare const tools` 接口。确定性——工具按名称字典序发出，
 * 因此未变的工具集在多次组装间产生字节相同的文本。该排序在字节相等的
 * 名称上不是全序，因此共享名称的两个模式会按参数顺序渲染；调用方的
 * 可见能力映射以名称为键，输入因此不会携带重复。
 * @param schemas - 要声明的工具模式（调用方排除 `run_code` 本身）。
 * @param programFormat - 运行时语法；函数体支持返回结果，REPL 打印结果。
 * @returns 完整的章节文本。
 */
export function renderToolsSdk(schemas: ToolSdkSchema[], programFormat: 'function-body' | 'repl' = 'function-body'): string {
  const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const argsMembers: string[] = []
  const outputMembers: string[] = []
  for (const schema of sorted) {
    argsMembers.push(...docLines(schema.description, 1))
    argsMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`)
    outputMembers.push(`${pad(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`)
  }
  const argsMap = `interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join('\n')}\n` : ''}}`
  const outputMap = `interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join('\n')}\n` : ''}}`
  const declaration = [
    argsMap,
    outputMap,
    'type ToolName = keyof ToolOutputMap',
    ['declare class ToolCallError extends Error {', '  readonly name: "ToolCallError";', '  readonly toolName: ToolName;', '}'].join('\n'),
    ['declare const tools: {', '  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;', '}'].join('\n'),
  ].join('\n\n')
  const jsonValue = 'type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }'
  const instructions = renderSdkInstructions(programFormat)
  const programInstructions = renderSdkProgramInstructions(programFormat)
  return `${instructions}${renderBashExample(sorted, programFormat)}\n\n${programInstructions}\n\n\`\`\`ts\n${jsonValue}\n\n${declaration}\n\`\`\``
}
