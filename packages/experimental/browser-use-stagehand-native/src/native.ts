/** 原生的 Stagehand 操作在一个隔离的浏览器 Worker 内部运行。 */

import { StagehandClientCreateConfigSchema } from '@browserbasehq/stagehand'
import type { ModelConfig, Page, StagehandBrowser } from '@browserbasehq/stagehand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'

/** 由被固定的 Stagehand SDK 所接受的、归属于配置档的模型设置。 */
export interface StagehandModelConfig {
  /** 来自 Stagehand 受支持模型目录、带提供方前缀的模型名称。 */
  modelName: ModelConfig['modelName']
  /** 发送给 Stagehand 浏览器扩展的、显式的 API 密钥。 */
  apiKey: string
  /** 随扩展的模型请求一并发送的额外请求头。 */
  headers?: Record<string, string>
}

/** 被固定的 Stagehand SDK 所支持的某个模型的、显式凭据。 */
export const stagehandModelSchema = z.object({
  modelName: z.string(),
  apiKey: z.string().refine(value => value.trim().length > 0, 'Stagehand requires a nonblank model API key'),
  headers: z.record(z.string(), z.string()).optional(),
}).strict().transform((model): StagehandModelConfig => {
  StagehandClientCreateConfigSchema.parse({ model })
  // 上述仅原生的字段排除了 SDK 的回调式模型替代方案。
  return {
    modelName: model.modelName as ModelConfig['modelName'],
    apiKey: model.apiKey,
    ...model.headers === undefined ? {} : { headers: model.headers },
  }
})

/** 被原生运行时与附加 Worker 所接受的、已解析的浏览器选项。 */
export interface NativeBrowserConfig {
  /** 传递给 Stagehand 浏览器扩展的、显式的模型凭据。 */
  model: StagehandModelConfig
  /** 运行时是拥有 Chromium，还是仅拥有其连接。 */
  mode: 'launch' | 'attach'
  /** 既有浏览器所配置的调试端点。 */
  cdpEndpoint?: string
  /** 可选的、既有的 Stagehand 扩展 id。 */
  extensionId?: string
  /** 为某个被拥有的 Chromium 实例所选的可执行文件。 */
  executablePath?: string
  /** 是否隐藏一个被拥有的浏览器的窗口。 */
  headless: boolean
  /** Chromium 启动、导航与自然语言动作的截止时限。 */
  operationTimeoutMs: number
  /** 在终止附加 Worker 之前，允许其关闭的宽限时间。 */
  shutdownGraceMs: number
}

const pageArgs = { pageId: z.string().min(1).optional() }

/** 模型与 Worker 请求共享同一套经过校验的浏览器参数。 */
export const browserInputs = {
  navigate: z.object({ ...pageArgs, url: z.url() }).strict(),
  tabs: z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('new'), url: z.url().optional() }).strict(),
    z.object({ action: z.enum(['select', 'close']), pageId: z.string().min(1) }).strict(),
  ]),
  screenshot: z.object({ ...pageArgs, fullPage: z.boolean().default(false) }).strict(),
  act: z.object({ ...pageArgs, instruction: z.string().min(1) }).strict(),
  observe: z.object({ ...pageArgs, instruction: z.string().min(1) }).strict(),
  extract: z.object({ ...pageArgs, instruction: z.string().min(1), schema: z.record(z.string(), z.json()).optional() }).strict(),
}

/** 原生浏览器操作的封闭集合。 */
export type BrowserMethod = keyof typeof browserInputs

/** SDK 请求在其连接 Worker 被终止之前尚未排空。 */
export class StagehandDrainError extends Error {}

/** 由某一个实时 Session 所拥有的、原生浏览器操作与 SDK 清理。 */
export interface NativeBrowserRuntime {
  /**
   * 在校验其工具或 Worker 参数之后，执行一次操作。
   * @param method - 受支持的浏览器操作。
   * @param args - 不可信的 JSON 参数。
   * @param signal - 宿主侧的取消信号；提供时会关闭该 Worker 连接。
   * @returns 一个可规范化的、带有文本或截图内容的 MCP 结果。
   */
  execute(method: BrowserMethod, args: unknown, signal?: AbortSignal): Promise<unknown>
  /** 在 Worker 终止断开 CDP 之前，释放 Stagehand 状态。 */
  close(): Promise<void>
}

/**
 * 使用其公开的初始化与原生模型配置，打开被固定的 SDK。
 * 宿主单独拥有已启动的 Chromium；本 Worker 仅拥有其 CDP 连接。
 * @param config - 已解析的、归属于配置档的浏览器选项。
 * @returns 初始化完成之后的原生操作运行时。
 */
export async function openNativeBrowser(config: NativeBrowserConfig): Promise<NativeBrowserRuntime> {
  const { Stagehand, localBrowser } = await import('@browserbasehq/stagehand')
  const browser = await localBrowser.connect({
    cdpUrl: z.string().parse(config.cdpEndpoint),
    ...config.extensionId === undefined ? {} : { extensionId: config.extensionId },
  })
  const stagehand = await Stagehand.create({ browser, model: config.model, logging: { level: 'off' } })
  return {
    close: () => stagehand.close(),
    async execute(method, rawArgs) {
      switch (method) {
        case 'navigate': {
          const args = browserInputs.navigate.parse(rawArgs)
          const page = await selectPage(browser, args.pageId)
          await page.goto(args.url, { timeout: config.operationTimeoutMs })
          return textResult({ pageId: page.pageId, url: await page.url(), title: await page.title() })
        }
        case 'tabs': {
          const args = browserInputs.tabs.parse(rawArgs)
          const context = browser.context
          if (args.action === 'new') await context.newPage(args.url)
          if (args.action === 'select') await context.setActivePage(await selectPage(browser, args.pageId))
          if (args.action === 'close') await (await selectPage(browser, args.pageId)).close()
          const active = await context.activePage()
          return textResult({ tabs: await Promise.all((await context.pages()).map(async page => ({
            pageId: page.pageId, url: await page.url(), title: await page.title(), active: page.pageId === active?.pageId,
          }))) })
        }
        case 'screenshot': {
          const args = browserInputs.screenshot.parse(rawArgs)
          const page = await selectPage(browser, args.pageId)
          const bytes = await page.screenshot({ type: 'png', fullPage: args.fullPage })
          return { content: [
            { type: 'text', text: `Screenshot of tab ${page.pageId}.` },
            { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
          ] }
        }
        case 'act': {
          const args = browserInputs.act.parse(rawArgs)
          const result = await stagehand.act(args.instruction, {
            page: await selectPage(browser, args.pageId), timeout: config.operationTimeoutMs,
          })
          if (!result.data.success) throw new Error(result.data.message)
          return textResult(result)
        }
        case 'observe': {
          const args = browserInputs.observe.parse(rawArgs)
          return textResult(await stagehand.observe(args.instruction, {
            page: await selectPage(browser, args.pageId), timeout: config.operationTimeoutMs,
          }))
        }
        case 'extract': {
          const args = browserInputs.extract.parse(rawArgs)
          const options = { page: await selectPage(browser, args.pageId), timeout: config.operationTimeoutMs }
          const result = args.schema === undefined
            ? await stagehand.extract(args.instruction, options)
            : await stagehand.extract(args.instruction, z.fromJSONSchema(args.schema), options)
          return textResult(result)
        }
        /* v8 ignore next -- 封闭联合的穷尽性守卫；Worker 方法在分发前已被解析。 */
        default: return assertNever(method, 'Stagehand browser operation')
      }
    },
  }
}

async function selectPage(browser: StagehandBrowser, pageId: string | undefined): Promise<Page> {
  const page = pageId === undefined
    ? await browser.context.activePage()
    : (await browser.context.pages()).find(candidate => candidate.pageId === pageId)
  if (page === undefined) throw new Error('Stagehand browser tab is unavailable; list tabs to select a current pageId')
  return page
}

function textResult(value: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}
