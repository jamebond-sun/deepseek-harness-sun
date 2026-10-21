/**
 * 本桥接所服务的每一次 mods API 调用的引擎行为，被映射到宿主服务之上：
 * 命令与工具落在 agent 的作用域化注册表上，`ui.ask` 落在用户问答器上，
 * 文件落在 `ctx.fs` 上，进程落在 `ctx.subprocess` 上，存储落在某个存储域上，
 * 会话事实落在 agent 的 Session 与投影上。某个部署未组合的
 * 服务会以该服务名称让调用失败。
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 仅类型：激活 `ctx.get('subprocess')` 与 `ctx.get('sessionProjections')` 的 Context 声明。
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
// 仅类型：将 token-meter 投影状态并入 SessionProjectionStateMap。
import type {} from '@deepseek-ai/dsh-token-meter'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { record, requireString, stringify } from './values.ts'
import { z as zod } from 'zod'
import type { LoadedMod } from './chain.ts'
import type { ModsEngine, OpContext, OpTable } from './engine.ts'
import type { ToolNameAliases } from './tool-names.ts'
import type {
  CommandInfo, CommandRunInput, CommandRunResult, FsEntry, FsStat, HttpResponse, ProcessRunResult, SessionMessage,
  SessionUsage, SessionVersion, ToolCallResult, ToolInfo,
} from './types.ts'

/** 本桥接的每一个事件所携带的绑定：它所归属的 agent，当存在时。 */
export interface AgentBinding {
  readonly agent: Agent | undefined
}

/** `$.session.version()` 所报告的 mods API 版本字符串。 */
export const MODS_API_VERSION: SessionVersion = Object.freeze({ version: 'claude-code-mods/0.1', engine: 'deepseek-harness' })

/** `$.fs.read` 返回与 `$.fs.write` 接受的文件最大尺寸，即 Claude Code 自身上限。 */
export const FS_MAX_BYTES = 4 * 1024 * 1024

/** 某个插件的 `$.store` 整体所能持有的、最大的 JSON 体量，即 Claude Code 自身上限。 */
export const STORE_MAX_BYTES = 4 * 1024 * 1024

/** `$.process.run` 所保留的、最大的 stdout 或 stderr 体量。 */
const PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024

/** `$.http.fetch` 所返回的最大响应体体量。 */
export const HTTP_MAX_BYTES = 4 * 1024 * 1024

/**
 * 模型所看到的、某个 mod 注册工具的全名：即 Claude Code 的 MCP 风格拼写。
 * @param plugin - 注册该工具的插件名称。
 * @param tool - 该 mod 注册的名称。
 * @returns `mcp__<plugin>__<tool>`。
 */
export function modToolName(plugin: string, tool: string): string {
  return `mcp__${plugin}__${tool}`
}

/** 工具局部名称保持简短且对 id 安全，即 Claude Code 自身的规则。 */
const REGISTERED_NAME = /^[A-Za-z0-9_-]{1,64}$/u

/** 每个插件的 `$.store` 记录：每个插件对应一个 JSON 键对象。 */
const storeDomainSpec = defineDomain({
  name: 'claude_code_mods',
  version: 1,
  tables: { store: domainTable<string, Record<string, JsonValue>>(zod.record(zod.string(), zod.json())) },
})

/** 构建宿主操作表所依据的选项。 */
export interface HostOpsOptions {
  readonly ctx: Context
  readonly aliases: ToolNameAliases
  /** `$.process.run` 的默认超时（毫秒）。 */
  readonly processTimeoutMs: number
  /**
   * mods 所做出的注册项的处置器，按它们所作用域化的会话为键
   * （全局的用 `''`），以便桥接处置时撤销它们，并丢弃已处置 agent 的条目。
   */
  readonly registrations: Map<string, Set<() => void>>
  /** 每一个在途 `$.tool.call` 所引发的 mod，按调用 id 索引，以便流水线从它那里抛出 `tool.call`。 */
  readonly callOrigins: Map<string, LoadedMod>
  /** mods 所注册命令的名称，供 `$.command.list` 的来源使用。 */
  readonly modCommands: Set<string>
  /** mods 所注册工具的全名，其调用可被某个 `tool.call` 钩子以成功结果应答。 */
  readonly modTools: Set<string>
  /** 在某次改变了所显示内容的 `$.ui` 调用之后，重绘某个会话的 band；当没有绘制任何画面时为缺失。 */
  readonly redraw?: (sessionId: string) => void
  /** 记录某个 mod 所提交的提示，以便它抛出的 `prompt.submit` 以该 mod 作为来源。 */
  readonly submitted?: (messageId: string, mod: string) => void
}

function requireAgent(context: OpContext<AgentBinding>, op: string): Agent {
  const agent = context.binding.agent
  if (agent === undefined) throw new Error(`$.${op} needs a session, and this event has none`)
  return agent
}

function textOf(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
}

/**
 * 将一次工具结果投影到 Claude Code 的 `tool.call` 结果上。
 * @param result - 宿主工具的结果。
 * @returns 其文本作为 `result`，失败时附带 `isError`。
 */
export function toolCallResultOf(result: ToolExecutionResult): ToolCallResult {
  return result.isError ? { result: textOf(result.content), isError: true } : { result: textOf(result.content) }
}

/** 模型原始的 JSON 参数作为一个对象；无法解析的字符串视为空输入。 */
function argumentsOf(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw))
  } catch {
    // 一个被截断或格式错误的工具调用会保留其 id 与名称；其输入未知。
    return {}
  }
}

function sessionMessages(messages: readonly Message[], aliases: ToolNameAliases): SessionMessage[] {
  const out: SessionMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const toolUses = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
      .map(block => ({ tool_use_id: block.id, tool: aliases.toMod(block.name), input: argumentsOf(block.arguments) }))
    out.push({ role: message.role, text: textOf(message.content), toolUses })
  }
  return out
}

/** Claude Code 词汇表中的条目类型。 */
function kindOf(type: 'file' | 'directory' | 'symlink' | 'other'): FsEntry['kind'] {
  return type === 'file' ? 'file' : type === 'directory' ? 'dir' : 'other'
}

function readOutput(reader: { readFrom(fromByte: number): { text: string } } | undefined): string {
  /* v8 ignore next -- 两个流都会以“已收集”方式派生，因此它们的读取器必然存在 */
  return reader === undefined ? '' : reader.readFrom(0).text
}

/** 条目的大小；当提供方未报告时为 0。 */
function sizeOf(info: { size?: number } | undefined): number {
  return info?.size ?? 0
}

/**
 * 在已组合的宿主服务之上构建操作表。
 * @param options - 上下文、别名、上限，以及注册追踪。
 * @returns 按事件名索引的引擎行为。
 */
export function createHostOps(options: HostOpsOptions): OpTable<AgentBinding> {
  const { ctx, aliases } = options
  let storeDomain: Promise<Domain<typeof storeDomainSpec>> | undefined

  function store(): Promise<Domain<typeof storeDomainSpec>> {
    if (storeDomain !== undefined) return storeDomain
    const domains = ctx.get('storageDomain')
    if (domains === undefined) throw new Error('$.store needs a storage domain service (dsh-storage-domain), which this deployment did not compose')
    const opened = domains.open(storeDomainSpec)
    storeDomain = opened
    ctx.effect(() => () => opened.then(domain => domain.close()), 'claude-code-mods: close store domain')
    return opened
  }

  async function target(path: string, agent: Agent | undefined, signal: AbortSignal): Promise<FsTarget> {
    const cwd = await currentDirectory(agent, signal)
    return fs().resolve(path, { ...cwd === undefined ? {} : { cwd }, signal })
  }

  function directories(): WorkingDirectoryService {
    const service = ctx.get('workingDirectory')
    if (service === undefined) throw new Error('$.session.cwd and session-owned operations need dsh-working-directory, which this deployment did not compose')
    return service
  }

  function currentDirectory(agent: Agent | undefined, signal: AbortSignal): Promise<string | undefined> {
    return agent === undefined ? Promise.resolve(undefined) : directories().ensure(agent, signal)
  }

  function fs(): FileSystem {
    const service = ctx.get('fs')
    if (service === undefined) throw new Error('$.fs needs a filesystem service (dsh-fs), which this deployment did not compose')
    return service
  }

  function track(dispose: () => void, agent: Agent | undefined): void {
    const key = agent?.session.id ?? ''
    let owned = options.registrations.get(key)
    if (owned === undefined) {
      owned = new Set()
      options.registrations.set(key, owned)
    }
    owned.add(dispose)
  }

  /** 每个插件的写入链：`$.store` 的读—改—写每个插件一次只运行一个。 */
  const storeWrites = new Map<string, Promise<void>>()

  function serializeStore(plugin: string, write: () => Promise<void>): Promise<void> {
    const previous = storeWrites.get(plugin) ?? Promise.resolve()
    const next = previous.then(write, write)
    storeWrites.set(plugin, next.catch(() => undefined))
    return next
  }

  /** 当确实有画面被绘制时，请求该事件所属会话的 band 重绘。 */
  function redraw(agent: Agent | undefined): void {
    if (agent !== undefined) options.redraw?.(agent.session.id)
  }

  /** 某个投影的状态；当注册表或该投影所属的插件未被组合时为 undefined。 */
  function projection<K extends keyof SessionProjectionStateMap>(session: Session, key: K): SessionProjectionStateMap[K] | undefined {
    return ctx.get('sessionProjections')?.stateOf(session, key)
  }

  return {
    // ---- ui：不存在 mod 的绘制画面；日志风格的调用抵达宿主日志 ----
    'ui.log': (input, { mod }) => {
      const { text, to } = record(input)
      const line = `${mod.name}: ${requireString(text, '$.ui.log text')}`
      if (to === 'debug') ctx.logger.debug(line)
      else ctx.logger.info(line)
    },
    'ui.toast': (input, { mod }) => { ctx.logger.info(`${mod.name} (toast): ${requireString(record(input).text, '$.ui.toast text')}`) },
    'ui.status': (input, { mod }) => {
      const { text } = record(input)
      ctx.logger.info(`${mod.name} (status): ${text === undefined ? '(cleared)' : requireString(text, '$.ui.status text')}`)
    },
    'ui.invalidate': (_input, { binding }) => { redraw(binding.agent) },
    // 不放置任何窗格：一个降级到 band 的 mod（其 `isPlaced: false`）会在本调用之后绘制在那里。
    'ui.open': (input, { binding }) => {
      redraw(binding.agent)
      return { id: requireString(record(input).id, '$.ui.open id'), isPlaced: false, reason: 'this host places no panes; draw in AbovePrompt' }
    },
    'ui.close': (_input, { binding }) => { redraw(binding.agent) },
    'ui.panes': () => [],
    'ui.ask': async (input, context) => {
      const agent = requireAgent(context, 'ui.ask')
      const questions = ctx.get('userQuestions')
      if (questions === undefined) throw new Error('$.ui.ask needs a user-questions service (dsh-user-questions), which this deployment did not compose')
      const { question, options: labels, header, multiSelect } = record(input)
      const choices: AskUserQuestionOption[] | undefined = Array.isArray(labels)
        ? labels.map(label => ({ label: requireString(label, '$.ui.ask option') }))
        : undefined
      const answer = await questions.ask({
        questions: [{
          id: 'answer',
          question: requireString(question, '$.ui.ask question'),
          ...typeof header === 'string' ? { header } : {},
          ...choices === undefined ? {} : { options: choices },
          ...multiSelect === true ? { multiSelect: true } : {},
        }],
        agent,
        signal: context.signal,
      })
      const item = answer.answers[0]
      if (item === undefined) throw new Error('$.ui.ask: the user dismissed the question')
      return item.custom ?? item.selected.join(', ')
    },

    // ---- 命令 ----
    'command.register': (input, { mod, binding, engine }) => {
      const spec = record(input)
      const name = requireString(spec.name, '$.command.register name')
      if (!REGISTERED_NAME.test(name)) throw new Error(`"/${name}" refused: command names are letters, digits, "_" and "-", up to 64 characters`)
      const description = requireString(spec.description, '$.command.register description')
      const registry = (binding.agent?.ctx ?? ctx).get('commands')
      if (registry === undefined) throw new Error('$.command.register needs a command registry (dsh-commands), which this deployment did not compose')
      const lowered = name.toLowerCase()
      const definition: CommandDefinition = {
        name: lowered,
        description,
        ...typeof spec.argumentHint === 'string' ? { input: { hint: spec.argumentHint } } : {},
        handler: async (invocation) => {
          const run = await engine.raise<CommandRunInput, CommandRunResult>(
            'command.run',
            { command: lowered, args: invocation.rawInput.trim(), origin: { kind: 'composer' } },
            () => ({ text: `${mod.name} registered /${lowered} but no command.run hook answered it; add on('command.run', { command: '${lowered}' }, hook)` }),
            { binding: { agent: invocation.agent }, signal: invocation.signal },
          )
          return { kind: 'success', ...run.text === undefined ? {} : { text: `${mod.name}: ${run.text}` } }
        },
      }
      const dispose = registry.register(definition)
      options.modCommands.add(lowered)
      track(dispose, binding.agent)
    },
    'command.run': async (input, context) => {
      const agent = requireAgent(context, 'command.run')
      const registry = ctx.get('commands')
      if (registry === undefined) throw new Error('$.command.run needs a command registry (dsh-commands), which this deployment did not compose')
      const { command, args } = record(input)
      const name = requireString(command, '$.command.run command')
      const line = typeof args === 'string' && args.length > 0 ? `/${name} ${args}` : `/${name}`
      const execution = await registry.execute(agent, line, [], context.signal)
      if (execution === undefined) throw new Error(`/${name} is not a command`)
      const { result } = execution
      if (result.kind === 'error') throw new Error(result.text)
      return { ...result.text === undefined ? {} : { text: result.text } } satisfies CommandRunResult
    },
    'command.list': (_input, context) => {
      const agent = requireAgent(context, 'command.list')
      const registry = ctx.get('commands')
      if (registry === undefined) return []
      return registry.list(agent).map((descriptor): CommandInfo => ({
        name: descriptor.name,
        description: descriptor.description,
        source: options.modCommands.has(descriptor.name) ? 'plugin' : 'builtin',
      }))
    },

    // ---- 工具 ----
    'tool.register': (input, { mod, binding }) => {
      const spec = record(input)
      const name = requireString(spec.name, '$.tool.register name')
      if (!REGISTERED_NAME.test(name)) throw new Error(`tool "${name}" refused: tool names are letters, digits, "_" and "-", up to 64 characters`)
      const description = requireString(spec.description, '$.tool.register description')
      const inputSchema = spec.inputSchema === undefined ? { type: 'object', properties: {} } : record(spec.inputSchema)
      // 该 schema 会抵达模型，因此一个不被支持的键会让本调用失败，而非在一次后续请求中。
      assertObjectJsonSchema(inputSchema)
      const registry = (binding.agent?.ctx ?? ctx).get('tools')
      if (registry === undefined) throw new Error('$.tool.register needs a tool registry (dsh-tools), which this deployment did not compose')
      const fullName = modToolName(mod.name, name)
      const definition: ToolDefinition = {
        name: fullName,
        description,
        parameters: inputSchema,
        output: {
          // 应答钩子的结果文本；该 schema 仅接受字符串。
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value as string }],
        },
        execute() {
          return Promise.reject(new Error(`${mod.name} registered ${fullName} but no tool.call hook answered it; add on('tool.call', { tool: '${fullName}' }, hook)`))
        },
      }
      track(registry.register(definition), binding.agent)
      options.modTools.add(fullName)
    },
    'tool.call': async (input, context) => {
      const agent = context.binding.agent
      const registry = ctx.get('tools')
      if (registry === undefined) throw new Error('$.tool.call needs a tool registry (dsh-tools), which this deployment did not compose')
      const { tool, tool_use_id: _ignored, agentId: _agent, ...args } = record(input)
      const callId = ToolCallId(`mod-${randomUUID()}`)
      // 流水线会从发起调用的 mod 处为本调用抛出 `tool.call`，因此只有更早的 mods 才会看到它。
      options.callOrigins.set(callId, context.mod)
      try {
        const result = await registry.execute({
          callId,
          name: aliases.toHarness(requireString(tool, '$.tool.call tool')),
          arguments: args,
          ...agent === undefined ? {} : { agent },
          signal: context.signal,
        })
        // 当调用由某个 mod 发起时，某个工具推迟到下一轮请求的指引仍会抵达模型。
        if (agent !== undefined) for (const context of result.additionalContexts ?? []) agent.inject(context)
        return toolCallResultOf(result)
      } finally {
        options.callOrigins.delete(callId)
      }
    },
    'tool.list': (_input, context) => {
      const registry = ctx.get('tools')
      if (registry === undefined) return []
      const agent = context.binding.agent
      return registry.schemas(agent === undefined ? undefined : scopeOf(agent.ctx))
        .map((schema): ToolInfo => ({ name: aliases.toMod(schema.name), description: schema.description }))
    },

    // ---- 提示 ----
    'prompt.submit': (input, context) => {
      const agent = requireAgent(context, 'prompt.submit')
      const { text, asUser } = record(input)
      const body = requireString(text, '$.prompt.submit text')
      const framed = asUser === true ? body : `Message from the "${context.mod.name}" mod:\n${body}`
      // Claude Code 将提示作为用户自己的输入提交；除非设置了 `asUser`，否则措辞会点明该 mod。
      const message = createUserMessage({ content: [{ type: 'text', text: framed }], source: { kind: 'user' } })
      options.submitted?.(message.id, context.mod.name)
      agent.followup(message)
      return { text: framed }
    },

    // ---- 会话事实 ----
    'session.id': (_input, context) => requireAgent(context, 'session.id').session.id,
    'session.cwd': (_input, context) => {
      const agent = requireAgent(context, 'session.cwd')
      return directories().get(agent.session)
    },
    'session.root': (_input, context) => requireAgent(context, 'session.root').session.header.cwd ?? process.cwd(),
    'session.model': (_input, context) => {
      const agent = requireAgent(context, 'session.model')
      return agent.session.requestHeader()?.config.model ?? agent.options.model ?? ''
    },
    'session.turns': (_input, context) => {
      const agent = requireAgent(context, 'session.turns')
      const boundary = projection(agent.session, 'turnBoundary')
      if (boundary === undefined) throw new Error('$.session.turns needs the turnBoundary projection, which this deployment did not compose')
      return boundary.lastTurn
    },
    'session.messages': (_input, context) => sessionMessages(requireAgent(context, 'session.messages').session.deriveMessages(), aliases),
    'session.usage': (_input, context): SessionUsage => {
      const agent = requireAgent(context, 'session.usage')
      const pressure = projection(agent.session, 'contextPressure')
      const tokens = pressure?.pressureTokens
      const window = pressure?.contextWindow ?? 0
      return {
        startedAt: agent.session.header.createdAt,
        context: {
          ...tokens === undefined ? {} : { tokens },
          window,
          ...tokens === undefined || window === 0 ? {} : { percent: Math.round((tokens / window) * 100) },
        },
        rateLimits: [],
      }
    },
    'session.version': () => MODS_API_VERSION,

    // ---- 存储：每个插件一个持久的 JSON 对象 ----
    'store.get': async (input, { mod }) => (await store()).table('store').get(mod.name)?.[requireString(record(input).key, '$.store.get key')],
    'store.set': async (input, { mod }) => {
      const { key, value } = record(input)
      const name = requireString(key, '$.store.set key')
      await serializeStore(mod.name, async () => {
        const table = (await store()).table('store')
        const next = { ...table.get(mod.name), [name]: value as JsonValue }
        const encoded = stringify(next)
        if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > STORE_MAX_BYTES) {
          throw new Error(`$.store.set: ${mod.name}'s store would exceed ${STORE_MAX_BYTES} bytes of JSON`)
        }
        await table.put(mod.name, JSON.parse(encoded) as Record<string, JsonValue>)
      })
    },
    'store.delete': async (input, { mod }) => {
      const name = requireString(record(input).key, '$.store.delete key')
      await serializeStore(mod.name, async () => {
        const table = (await store()).table('store')
        const current = table.get(mod.name)
        if (current === undefined || !(name in current)) return
        const { [name]: _removed, ...rest } = current
        await table.put(mod.name, rest)
      })
    },
    'store.keys': async (_input, { mod }) => Object.keys((await store()).table('store').get(mod.name) ?? {}),

    // ---- 文件：经由文件系统接缝，相对于会话工作区 ----
    'fs.read': async (input, context) => {
      const path = requireString(record(input).path, '$.fs.read path')
      const resolved = await target(path, context.binding.agent, context.signal)
      const info = await fs().stat(resolved, context.signal)
      if (info?.size !== undefined && info.size > FS_MAX_BYTES) throw new Error(`$.fs.read: ${path} is larger than ${FS_MAX_BYTES} bytes`)
      return fs().readText(resolved, context.signal)
    },
    'fs.write': async (input, context) => {
      const { path, text } = record(input)
      const body = requireString(text, '$.fs.write text')
      if (Buffer.byteLength(body, 'utf8') > FS_MAX_BYTES) throw new Error(`$.fs.write: content is larger than ${FS_MAX_BYTES} bytes`)
      const resolved = await target(requireString(path, '$.fs.write path'), context.binding.agent, context.signal)
      await fs().writeText(resolved, body, undefined, context.signal)
    },
    'fs.list': async (input, context) => {
      const resolved = await target(requireString(record(input).path, '$.fs.list path'), context.binding.agent, context.signal)
      const entries = await fs().listDir(resolved, context.signal)
      return entries.map((entry): FsEntry => ({ name: entry.name, kind: kindOf(entry.type), size: sizeOf(entry), isLink: false }))
    },
    'fs.exists': async (input, context) => {
      const resolved = await target(requireString(record(input).path, '$.fs.exists path'), context.binding.agent, context.signal)
      return await fs().stat(resolved, context.signal) !== undefined
    },
    'fs.stat': async (input, context) => {
      const path = requireString(record(input).path, '$.fs.stat path')
      const cwd = await currentDirectory(context.binding.agent, context.signal)
      const info = await fs().lstat(path, cwd === undefined ? {} : { cwd }, context.signal)
      if (info === undefined) throw new Error(`$.fs.stat: ${path} does not exist`)
      if (info.type !== 'symlink') return { kind: kindOf(info.type), size: sizeOf(info), mtimeMs: 0, isLink: false } satisfies FsStat
      // 一个链接会报告它所指向的内容，如同 Claude Code 的 `resolve: true`；悬空链接则为 `other`。
      const resolved = await fs().resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: context.signal })
      const followed = await fs().stat(resolved, context.signal)
      return { kind: kindOf(followed?.type ?? 'other'), size: sizeOf(followed), mtimeMs: 0, isLink: true } satisfies FsStat
    },

    // ---- 进程：argv、无 shell、收集输出 ----
    'process.run': async (input, context) => {
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) throw new Error('$.process.run needs a subprocess service (dsh-subprocess), which this deployment did not compose')
      const { argv, init } = record(input)
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every(item => typeof item === 'string')) {
        throw new TypeError('$.process.run needs a non-empty argv list of strings')
      }
      const settings = record(init)
      const timeoutMs = typeof settings.timeoutMs === 'number' ? settings.timeoutMs : options.processTimeoutMs
      const cwd = typeof settings.cwd === 'string' ? settings.cwd : await currentDirectory(context.binding.agent, context.signal) ?? process.cwd()
      const env = typeof settings.env === 'object' && settings.env !== null ? settings.env as Record<string, string> : undefined
      const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
      const handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: PROCESS_OUTPUT_MAX_BYTES }, stderr: { maxBytes: PROCESS_OUTPUT_MAX_BYTES } },
        graceMs: 1000,
        signal: deadline,
        ...env === undefined ? {} : { env },
      })
      const outcome = await handle.done
      if (deadline.aborted) throw new Error(`$.process.run: ${argv[0]} did not exit within ${timeoutMs} ms`)
      /* v8 ignore next -- Windows 子进程即便被终止也会报告退出码；POSIX 覆盖负责此分支 */
      if (outcome.exitCode === null) throw new Error(`$.process.run: ${argv[0]} was terminated by signal ${String(outcome.signal)}`)
      return {
        exitCode: outcome.exitCode,
        stdout: readOutput(handle.collected.stdout),
        stderr: readOutput(handle.collected.stderr),
      } satisfies ProcessRunResult
    },

    // ---- 网络 ----
    'http.fetch': async (input, context) => {
      const { url, init } = record(input)
      const settings = record(init)
      const timeoutMs = typeof settings.timeoutMs === 'number' ? settings.timeoutMs : options.processTimeoutMs
      const response = await fetch(requireString(url, '$.http.fetch url'), {
        ...typeof settings.method === 'string' ? { method: settings.method } : {},
        ...typeof settings.headers === 'object' && settings.headers !== null ? { headers: settings.headers as Record<string, string> } : {},
        ...typeof settings.body === 'string' ? { body: settings.body } : {},
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        headers[name] = value
      })
      const body = await readBounded(response, HTTP_MAX_BYTES)
      return { status: response.status, ok: response.ok, headers, text: body } satisfies HttpResponse
    },

    // ---- 本进程的环境 ----
    'env.get': input => process.env[requireString(record(input).name, '$.env.get name')],
    'env.set': (input) => {
      const { name, value } = record(input)
      const key = requireString(name, '$.env.set name')
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = requireString(value, '$.env.set value')
    },
  }
}

export type { ModsEngine }

/** 读取响应体直到上限为止，并在越过上限的第一个字节处取消流。 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`$.http.fetch: the response body is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
