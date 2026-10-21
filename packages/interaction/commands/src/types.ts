/**
 * 持久化命令事件的词汇表与注册表的 Cordis 事件声明，供纯类型消费方共用。
 * Client 安全：这里不触及任何仅 Host 可见的符号，因此 Client 编译面读到的
 * `commands/change` 签名与 Host 发出的完全一致。
 *
 * @module @deepseek-ai/dsh-commands/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { CommandDefinitionId, CommandId } from './brand.ts'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'

/** 浏览器提交的一个命令附件：编码后的图片输入或已暂存的文件回执。 */
export type CommandSubmitAttachment =
  | ({ readonly type: 'image' } & EncodedImageAttachment)
  | { readonly type: 'file'; readonly receiptId: string }

/** 命令可选的非结构化输入的不可变元数据。 */
export interface CommandInputDescriptor {
  /** 用户提供自由文本输入前展示的占位提示。 */
  readonly hint: string
  /**
   * 调用是否可以附带编辑器附件。缺省或 false 表示执行器拒绝携带附件的调用，
   * 且支持附件的编辑器会在派发前拒收该提交。声明了该能力的命令，其处理器
   * 收到准入的持久化块，并自行掌握后续所有语法层面的判断，包括拒绝那些
   * 无法在当前调用里使用附件的子命令。
   */
  readonly attachments?: boolean
}

/** 由派发 UI 直接渲染的命令预期结果。 */
export type CommandResult =
  | {
    readonly kind: 'success'
    readonly text?: string
    /** 更早的、拥有更丰富呈现方式的权威领域事件。 */
    readonly sourceEventSeq?: SessionSeq
  }
  | { readonly kind: 'error'; readonly text: string }

/**
 * 一次已终结的命令执行：处理器的归一化结果，加上为其 `command/run`/
 * `command/done` 记录铸造的生命周期配对 id，使派发端能够把 Remote 的确认
 * 与这些事件产生的流程节点关联起来。
 */
export interface CommandExecution {
  /** 本次执行生命周期事件携带的配对 id。 */
  readonly commandId: CommandId
  /** 处理器的归一化结果。 */
  readonly result: CommandResult
}

/** 返回给 UI 适配器的、不含处理器的命令不可变视图。 */
export interface CommandDescriptor {
  /** 插件持有的稳定身份；没有基于身份的 Client 行为的定义缺省该字段。 */
  readonly definitionId?: CommandDefinitionId
  /** 不含前导斜杠的小写命令名。 */
  readonly name: string
  /** 发现 UI 使用的易读简介。 */
  readonly description: string
  /** 向支持该能力的客户端广播的可选自由文本输入提示。 */
  readonly input?: CommandInputDescriptor
}

/**
 * 一次命令调用的生产者记录（`command/run` 事件的 source 槽位）。
 * 这是一个可合并扩展的和类型，形状镜像 `MessageSourceMap`；之所以精简，
 * 是因为执行器的每个调用方都是派发人工输入行的、面向人的 UI 界面，
 * 因此唯一的变体就是 `user`。
 */
export interface CommandSourceMap {
  user: { kind: 'user' }
}

/** 对 {@link CommandSourceMap} 取联合 —— 谁发出了这一命令行。 */
export type CommandSource = CommandSourceMap[keyof CommandSourceMap]

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 有命令被注册或注销。这是一条未加过滤的注册表通知，因为全局或作用域
     * 内的变动都可能影响任何 UI 视图。观察者自身的失败被就地隔离，
     * 无法否决注册表变更。
     * @mode emit
     */
    'commands/change'(): void
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 一条已解析的斜杠命令进入了处理器。仅落日志（永不进入模型可见面）；
     * 通过 `commandId` 与 `command/done` 配对，镜像 `tool/call`↔`tool/result`
     * 的配对关系。载荷是结构化的 —— `name` 与 `args` 就是 `parseCommand`
     * 自己的切分结果（命令名与逐字的 rawInput，含分隔符空白），因此消费方
     * （折叠自身命令记录的投影单元、富命令卡片）无需再次解析命令行。当定义
     * 设置了 `recordInput: false` 时 `args` 缺省，因为此时输入载荷由某条
     * 权威领域事件持有。
     */
    'command/run': { commandId: CommandId; name: string; args?: string; source: CommandSource }
    /**
     * 配对的命令已终结。`kind`/`text` 承载处理器逐字的结果（抛出或被中止的
     * 处理器以 `kind: 'error'` 加渲染后的失败信息终结）。执行成功的命令可以
     * 指回更早的那条权威领域事件，以获得更丰富的、由 Client 计算得出的呈现。
     */
    'command/done': {
      commandId: CommandId
      kind: 'success' | 'error'
      text?: string
      sourceEventSeq?: import('@deepseek-ai/dsh-session/types').SessionSeq
    }
  }
}
