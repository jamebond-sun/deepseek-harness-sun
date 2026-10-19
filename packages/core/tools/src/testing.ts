/** 供仓库测试使用的规范工具定义夹具。@module dsh-tools/testing */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from './schema.ts'
import type { DefineToolOptions, ParameterSchemaSpec } from './schema.ts'
import type { ToolDefinition, ToolRunContext } from './index.ts'

const CONTENT_VALUE_SCHEMA = { type: 'array', items: { type: 'json' } } as const

/** 规范值为其渲染内容数组的夹具选项。 */
export type ContentToolFixtureOptions<S extends ParameterSchemaSpec> = Omit<
  DefineToolOptions<S, typeof CONTENT_VALUE_SCHEMA>,
  'output' | 'execute'
> & {
  /** 生成夹具的内容块作为其规范测试值。 */
  execute(args: import('./schema.ts').InferArgs<S>, exec: ToolRunContext): Promise<ContentBlock[]>
}

/**
 * 定义一个刻意将其内容块用作规范 JSON 值的测试夹具。产品工具必须改为声明
 * 领域自有的 DTO。
 * @param options - 普通夹具字段加上产生内容的主体。
 * @returns 注册表就绪的工具，带有显式的 JSON 数组输出契约。
 * @internal
 */
export function defineContentToolFixture<const S extends ParameterSchemaSpec>(
  options: ContentToolFixtureOptions<S>,
): ToolDefinition {
  // oxlint-disable-next-line typescript/unbound-method
  const execute = options.execute
  return defineTool({
    ...options,
    output: {
      schema: CONTENT_VALUE_SCHEMA,
      render: (_args, value) => value as unknown as ContentBlock[],
    },
    async execute(args, exec) {
      return await execute(args, exec) as unknown as JsonValue[]
    },
  })
}
