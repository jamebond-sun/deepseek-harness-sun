/**
 * 由插件持有的人工命令注册表，供各交互式 UI 适配器共用。
 * @module @deepseek-ai/dsh-commands
 */

import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentError, admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { EncodedImageAttachment, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { NamedEntries, ScopedLayers } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { CommandId } from './brand.ts'
import type { CommandDefinitionId } from './brand.ts'
import type {
  CommandDescriptor,
  CommandExecution,
  CommandInputDescriptor,
  CommandResult,
  CommandSubmitAttachment,
} from './types.ts'

export { CommandDefinitionId, CommandId } from './brand.ts'
export type * from './types.ts'

export const name = 'commands'

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** 无附件调用共用的冻结 attachments 值。 */
const NO_ATTACHMENTS: readonly (ImageBlock | FileBlock)[] = Object.freeze([])

/** Session 作用域内已暂存文件上传回执的 Host 解析器。 */
export type CommandFileReceiptResolver = (agent: Agent, receiptId: string) => FileAttachmentRef | undefined

/** 传给某个已注册命令处理器的一次调用。 */
export interface CommandInvocation {
  /** 已写入本次调用 `command/run` 事件的配对 id。 */
  readonly commandId: CommandId
  /** 其 UI 收到该命令的那个确切 agent。 */
  readonly agent: Agent
  /** 紧跟在已注册命令名之后的逐字文本，含分隔符空白。 */
  readonly rawInput: string
  /**
   * 本次调用附带的、已持久准入的图片与文件块，按提交顺序排列；除非定义声明了
   * `input.attachments`，否则为空。其模型可见的用法由处理器自行掌握 ——
   * 注册表从不代为编排 —— 面对本次调用里语法上无法使用它们的处理器，
   * 应当返回错误，以便派发的编辑器保留原始附件。
   */
  readonly attachments: readonly (ImageBlock | FileBlock)[]
  /** 由派发该命令的 UI 请求持有的取消信号。 */
  readonly signal: AbortSignal
}

/** 由插件持有的一次命令注册。 */
export interface CommandDefinition {
  /** 插件持有的稳定身份；没有基于身份的 Client 行为的定义缺省该字段。 */
  readonly definitionId?: CommandDefinitionId
  /** 不含前导斜杠的小写命令名。 */
  readonly name: string
  /** 发现 UI 使用的易读简介。 */
  readonly description: string
  /** 向支持该能力的客户端广播的可选自由文本输入提示。 */
  readonly input?: CommandInputDescriptor
  /**
   * `command/run` 是否记录 `rawInput`。默认为 true。当某条领域事件已经持有
   * 该载荷时，命令把本项设为 false，以免在 Session 日志里重复一份。
   */
  readonly recordInput?: boolean
  /** 针对接收该命令的 agent 执行，不把命令发送给模型。 */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** 经注册表解析之前的、语法合法的斜杠命令。 */
export interface ParsedCommand {
  /** 不含前导斜杠的小写命令名。 */
  readonly name: string
  /** 紧跟在命令名之后的逐字文本。 */
  readonly rawInput: string
}

interface RegisteredCommand {
  readonly definition: CommandDefinition
  readonly descriptor: CommandDescriptor
}

/** 某个全局层或作用域层持有的全部命令注册。 */
class CommandLayer implements ScopeLayer {
  readonly commands: NamedEntries<RegisteredCommand>

  /**
   * 创建一个命令层，并携带其所属作用域特有的诊断信息。
   * @param scope - 作用域持有者；全局注册为 `undefined`。
   */
  constructor(scope: ScopeKey | undefined) {
    this.commands = new NamedEntries(name => new Error(scope === undefined
      ? `command "${name}" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's \`agent.ctx\`)`
      : `command "${name}" is already registered in this scope`))
  }

  /** @returns 本层是否不持有任何命令注册。 */
  isEmpty(): boolean {
    return this.commands.isEmpty()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: CommandRuntime
  }
}

/**
 * 解析一条精确的斜杠命令，且不规整其尾部输入。
 *
 * @param line - 完整的候选命令行。
 * @returns 解析出的命令；当该行不是命令时为 `undefined`。
 */
export function parseCommand(line: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  const name = match[1]
  /* v8 ignore next -- 只要正则匹配成功，第一个捕获组必然存在 */
  if (name === undefined) return undefined
  return Object.freeze({ name, rawInput: line.slice(match[0].length) })
}

/** 把任意 abort 原因收敛为同一个稳定的 rejected Error。 */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'command aborted')
}

/** 信号处于已中止状态时，返回其归一化的中止错误。 */
function cancellationOf(signal: AbortSignal): Error | undefined {
  return signal.aborted ? abortError(signal) : undefined
}

/** 渲染任意抛出的值，且不信任其字符串强制转换结果。 */
function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

/** 一旦持有该处理器的 UI 请求中止，就不再等待这个不配合的处理器。 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error
          ? error
          : new Error(`command handler rejected with a non-Error value: ${renderThrown(error)}`, { cause: error }))
      },
    )
  })
}

/** 在无效的命令元数据进入 UI 协议之前予以拒绝。 */
function normalizeDefinition(definition: CommandDefinition): RegisteredCommand {
  if (!COMMAND_NAME.test(definition.name)) {
    throw new TypeError(`command name "${definition.name}" must match ${String(COMMAND_NAME)}`)
  }
  if (typeof definition.description !== 'string') {
    throw new TypeError(`command "${definition.name}" description must be a string`)
  }
  if (definition.description.trim().length === 0) {
    throw new TypeError(`command "${definition.name}" description must not be empty`)
  }
  if (typeof definition.handler !== 'function') {
    throw new TypeError(`command "${definition.name}" handler must be a function`)
  }
  const rawInput: unknown = definition.input
  let input: CommandInputDescriptor | undefined
  if (rawInput !== undefined) {
    if (typeof rawInput !== 'object' || rawInput === null || !('hint' in rawInput)
      || typeof rawInput.hint !== 'string') {
      throw new TypeError(`command "${definition.name}" input hint must be a string`)
    }
    if (rawInput.hint.trim().length === 0) {
      throw new TypeError(`command "${definition.name}" input hint must not be empty`)
    }
    if ('attachments' in rawInput && rawInput.attachments !== undefined && typeof rawInput.attachments !== 'boolean') {
      throw new TypeError(`command "${definition.name}" input attachments flag must be a boolean`)
    }
    input = Object.freeze({
      hint: rawInput.hint,
      ...('attachments' in rawInput && rawInput.attachments === true) ? { attachments: true } : {},
    })
  }
  const normalized = Object.freeze({
    ...definition.definitionId === undefined ? {} : { definitionId: definition.definitionId },
    name: definition.name,
    description: definition.description,
    ...input === undefined ? {} : { input },
    ...definition.recordInput === undefined ? {} : { recordInput: definition.recordInput },
    handler: definition.handler,
  })
  const descriptor = Object.freeze({
    ...normalized.definitionId === undefined ? {} : { definitionId: normalized.definitionId },
    name: normalized.name,
    description: normalized.description,
    ...normalized.input === undefined ? {} : { input: normalized.input },
  })
  return { definition: normalized, descriptor }
}

/** 在注册表边界上校验并脱离一份不可信的处理器返回值。 */
function normalizeResult(command: string, value: unknown): CommandResult {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new TypeError(`command "${command}" handler must return a CommandResult`)
  }
  const result = value as { kind?: unknown; text?: unknown; sourceEventSeq?: unknown }
  if (result.kind === 'success') {
    if (result.text !== undefined && typeof result.text !== 'string') {
      throw new TypeError(`command "${command}" success text must be a string when supplied`)
    }
    if (result.sourceEventSeq !== undefined
      && (!Number.isSafeInteger(result.sourceEventSeq)
        || (result.sourceEventSeq as number) < 0
        || Object.is(result.sourceEventSeq, -0))) {
      throw new TypeError(`command "${command}" success sourceEventSeq must be a non-negative safe integer when supplied`)
    }
    return Object.freeze({
      kind: 'success',
      ...result.text === undefined ? {} : { text: result.text },
      ...result.sourceEventSeq === undefined ? {} : { sourceEventSeq: SessionSeq(result.sourceEventSeq as number) },
    })
  }
  if (result.kind === 'error') {
    if (typeof result.text !== 'string' || result.text.trim().length === 0) {
      throw new TypeError(`command "${command}" error text must be a non-empty string`)
    }
    return Object.freeze({ kind: 'error', text: result.text })
  }
  throw new TypeError(`command "${command}" returned unknown result kind "${String(result.kind)}"`)
}

/**
 * 人工命令注册表。在普通 context 上注册的定义是全局的；通过某个 agent context
 * 的命令注入子 context 注册的定义，则在该 agent 上遮蔽同名全局定义。
 */
export class CommandRuntime extends TypertRemoteService {
  private readonly layers = new ScopedLayers(
    scope => new CommandLayer(scope),
    () => { this.notifyChange() },
  )

  /** {@link mintCommandId} 背后的按实例单调计数器。 */
  private commandSeq = 0
  /** 实例令牌：在同一份续跑日志上即使跨进程重启，铸造出的 id 也不重复。 */
  private readonly instanceToken = randomUUID().slice(0, 8)
  /** 由 Session 上传能力的持有者安装的可选提供者。 */
  private readonly fileReceipts: { resolver: CommandFileReceiptResolver | undefined } = { resolver: undefined }

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  /**
   * 注册一条全局命令或一条作用域为发起 agent 的命令。
   * @param definition - 发现所需的元数据，以及面向 UI 的直接处理器。
   * @returns 注销该定义的那个确切 effect 回收函数。
   */
  register(definition: CommandDefinition): () => void {
    const registered = normalizeDefinition(definition)
    return this.layers.effect(
      this.ctx,
      layer => layer.commands.insert(registered.definition.name, registered),
      { label: 'commands.register()' },
    )
  }

  /**
   * 注册唯一的权威方，用于解析命令提交里的已暂存文件回执。
   * @param resolver - 感知 Session 的回执解析器。
   * @returns 移除该解析器本身的回收函数。
   */
  registerFileReceiptResolver(resolver: CommandFileReceiptResolver): () => void {
    if (this.fileReceipts.resolver !== undefined) {
      throw new Error('commands: a file receipt resolver is already registered')
    }
    this.fileReceipts.resolver = resolver
    return () => {
      if (this.fileReceipts.resolver === resolver) this.fileReceipts.resolver = undefined
    }
  }

  /**
   * 列出某个 agent 生效的命令不可变描述符。
   * @param agent - 确切的接收 agent，同时也是作用域层的键。
   * @returns 经过作用域遮蔽后、按名称排序的描述符。
   */
  @Remote
  list(agent: Agent): readonly CommandDescriptor[] {
    return Object.freeze([...this.view(agent).values()]
      .map(command => command.descriptor)
      // 生效视图里名称唯一，因此不可能出现相等的情况。
      .sort((left, right) => left.name < right.name ? -1 : 1))
  }

  /**
   * 解析出一条生效的命令定义。
   * @param agent - 确切的接收 agent，同时也是作用域层的键。
   * @param name - 不含斜杠的命令名。
   * @returns 作用域内的遮蔽定义，或全局定义。
   */
  find(agent: Agent, name: string): CommandDefinition | undefined {
    return this.view(agent).get(name)?.definition
  }

  /**
   * 解析并执行一条已知命令，不把它发送给模型。
   *
   * 一条已解析命令的生命周期会被记录：调用处理器之前追加 `command/run`，
   * 终结之后追加 `command/done`（抛出或被中止的处理器以 `kind: 'error'`
   * 终结）。两者都是直接的、仅落日志的追加 —— 没有 turn 包裹它们，持久化
   * 在常规检查点把它们排出。准入失败（语法不合法或名称未知）不记录任何事件 ——
   * 它们从未进入处理器。`command/run` 追加失败会让本次执行响亮地失败；而在
   * 处理器失败的路径上，`command/done` 追加失败被就地隔离，以保证对外报告的
   * 失败仍然是处理器自身的那个错误。
   *
   * 附件准入在这里强制执行，而不是在编辑器里：把附件发给未声明
   * `input.attachments` 的命令、缺失附件存储、以及超出图片数量上限，都会在
   * 处理器运行之前以错误结果终结。被校验拒绝时不会产生任何附件写入；存储失败
   * 可能只留下若干个不可达的内容寻址对象，交由延迟回收处理。
   *
   * @param agent - 确切的接收 agent。
   * @param line - 完整的斜杠命令行。
   * @param submittedAttachments - 伴随该命令行提交的编码图片与已暂存文件回执，
   *   按提交顺序排列；普通调用为空。
   * @param signal - 由 UI 请求持有的取消信号。
   * @returns 已终结的执行结果（结果体 + 生命周期配对 id）；当语法或命令名
   *   无法解析时为 `undefined`。
   */
  @Remote
  async execute(
    agent: Agent,
    line: string,
    submittedAttachments: readonly CommandSubmitAttachment[],
    signal: AbortSignal,
  ): Promise<CommandExecution | undefined> {
    const parsed = parseCommand(line)
    if (parsed === undefined) return undefined
    const command = this.view(agent).get(parsed.name)
    if (command === undefined) return undefined
    if (signal.aborted) throw abortError(signal)
    const commandId = this.mintCommandId()
    this.appendLifecycle(agent.session, 'command/run', {
      commandId,
      name: parsed.name,
      ...command.definition.recordInput === false ? {} : { args: parsed.rawInput },
      source: { kind: 'user' },
    })
    const settle = (result: CommandResult): CommandExecution => {
      this.appendLifecycle(agent.session, 'command/done', {
        commandId, kind: result.kind,
        ...result.text === undefined ? {} : { text: result.text },
        ...result.kind === 'success' && result.sourceEventSeq !== undefined
          ? { sourceEventSeq: result.sourceEventSeq }
          : {},
      })
      return Object.freeze({ commandId, result: Object.freeze(result) })
    }
    let attachments: readonly (ImageBlock | FileBlock)[] = NO_ATTACHMENTS
    if (submittedAttachments.length > 0) {
      if (command.definition.input?.attachments !== true) {
        return settle({ kind: 'error', text: `/${parsed.name} does not accept attachments` })
      }
      const store = this.ctx.get('attachments')
      if (store === undefined) {
        return settle({ kind: 'error', text: `/${parsed.name}: attachments are unavailable because no attachment store is composed` })
      }
      try {
        attachments = await admitCommandAttachments(
          store,
          submittedAttachments,
          receiptId => this.fileReceipts.resolver?.(agent, receiptId),
        )
      } catch (error: unknown) {
        if (error instanceof AttachmentError) {
          return settle({ kind: 'error', text: error.message })
        }
        this.settleThrown(agent.session, parsed.name, commandId, error)
        throw error
      }
      // 取消必须在处理器运行之前兑现：准入过程可能等待较慢的存储，而调用方
      // 取消之后才进入的处理器会改动状态，重试的调用方再执行一次就会重复。
      // （已提交的图片对象保持无引用状态，属于延迟 GC 的范畴。）
      const cancelledDuringAdmission = cancellationOf(signal)
      if (cancelledDuringAdmission !== undefined) {
        this.settleThrown(agent.session, parsed.name, commandId, cancelledDuringAdmission)
        throw cancelledDuringAdmission
      }
    }
    const invocation = Object.freeze({ commandId, agent, rawInput: parsed.rawInput, attachments, signal })
    let result: CommandResult
    try {
      const output = command.definition.handler(invocation)
      result = normalizeResult(parsed.name, await withAbort(Promise.resolve(output), signal))
    } catch (error: unknown) {
      this.settleThrown(agent.session, parsed.name, commandId, error)
      throw error
    }
    return settle(result)
  }

  /** 为抛出或被准入失败打断的处理器追加一条被隔离的 `command/done` 错误。 */
  private settleThrown(session: Session, command: string, commandId: CommandId, error: unknown): void {
    try {
      this.appendLifecycle(session, 'command/done', {
        commandId, kind: 'error',
        text: error instanceof Error ? error.message : renderThrown(error),
      })
    } catch (appendError: unknown) {
      this.ctx.logger.warn(`command "${command}": command/done append failed: ${renderThrown(appendError)}`)
    }
  }

  /** 铸造下一个配对 id（单调递增；带实例令牌前缀，因此续跑日志上永不重复）。 */
  private mintCommandId(): CommandId {
    this.commandSeq += 1
    return CommandId(`cmd-${this.instanceToken}-${this.commandSeq}`)
  }

  /**
   * 直接追加一条仅落日志的生命周期事件：不为它开启 turn，也不强制 flush ——
   * 持久化经由既有的 `session/event` 路径观察到它，并在常规检查点与关闭时把它
   * 排出，与所有其他独立插件事件一致。
   */
  private appendLifecycle<T extends 'command/run' | 'command/done'>(
    session: Session,
    type: T,
    data: SessionEventMap[T],
  ): SessionEvent<T> {
    // 两个被准入的事件类型都是仅落日志（非可见面）的，但 TypeScript 无法在
    // 泛型类型参数下化简 Session.append 的条件化剩余参数。保留已验证有效的
    // 两参数调用形态。
    const appendLogOnly = session.append.bind(session) as (eventType: T, eventData: SessionEventMap[T]) => SessionEvent<T>
    return appendLogOnly(type, data)
  }

  /** 先解析全局定义，再叠加该作用域的精确遮蔽。 */
  private view(agent: Agent): Map<string, RegisteredCommand> {
    return this.layers.merge(agent, layer => layer.commands)
  }

  /** 通知所有注册表观察者，同时不让 UI 刷新成为承载逻辑的一环。 */
  private notifyChange(): void {
    // Cordis 的 emit 使用 Array.map：一次同步抛出会饿死后续监听器，而返回的
    // promise 会被丢弃。注册表通知不具否决权，因此逐个隔离回调。
    for (const callback of this.ctx.events.dispatch('emit', ['commands/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`commands/change listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`commands/change listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

/** 准入一批混合命令附件，并还原其原始的图片/文件顺序。 */
async function admitCommandAttachments(
  store: Parameters<typeof admitEncodedImages>[0],
  attachments: readonly CommandSubmitAttachment[],
  resolveFileReceipt: (receiptId: string) => FileAttachmentRef | undefined,
): Promise<readonly (ImageBlock | FileBlock)[]> {
  const files = new Map<string, FileAttachmentRef>()
  for (const attachment of attachments) {
    if (attachment.type !== 'file' || files.has(attachment.receiptId)) continue
    const file = resolveFileReceipt(attachment.receiptId)
    if (file === undefined) {
      throw new AttachmentError('File upload receipt is unknown for this session.', 'ATTACHMENT_NOT_FOUND')
    }
    files.set(attachment.receiptId, file)
  }
  const images: EncodedImageAttachment[] = []
  for (const attachment of attachments) {
    if (attachment.type !== 'image') continue
    images.push({
      mediaType: attachment.mediaType,
      data: attachment.data,
      ...(attachment.name === undefined ? {} : { name: attachment.name }),
    })
  }
  const imageRefs = images.length === 0 ? [] : await admitEncodedImages(store, images)
  let imageIndex = 0
  const blocks: Array<ImageBlock | FileBlock> = []
  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      const ref = imageRefs[imageIndex] as ImageAttachmentRef
      imageIndex += 1
      blocks.push(Object.freeze({ type: 'image', attachment: ref }))
      continue
    }
    blocks.push(Object.freeze({
      type: 'file', attachment: files.get(attachment.receiptId) as FileAttachmentRef,
    }))
  }
  return Object.freeze(blocks)
}

export default CommandRuntime
