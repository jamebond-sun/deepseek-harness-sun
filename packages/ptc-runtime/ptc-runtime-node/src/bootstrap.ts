/**
 * 基于进程通道的程序求值、输出捕获，以及宿主绑定代理。
 * @module @deepseek-ai/dsh-ptc-runtime-node/src/bootstrap
 */

import { inspect } from 'node:util'
import type { DoneMessage, ReplyMessage, ProgramBootData, ProgramToHost } from './protocol.ts'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'
import { decodePtcJsonWire, encodePtcJsonWire, snapshotPtcJsonValue } from './json-wire.ts'

const CapturedError = Error
const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty

/** 定义一个公开的绑定错误字段，不查阅可变全局量或描述符原型。 */
function defineBindingErrorField(error: Error, key: string, value: string): void {
  const attributes = capturedObjectCreate(null) as PropertyDescriptor
  attributes.enumerable = true
  attributes.value = value
  capturedObjectDefineProperty(error, key, attributes)
}

/** 由私有进程通道传输的程序消息与宿主回复。 */
export interface BootstrapPort {
  postMessage(message: ProgramToHost): void
  on(event: 'message', listener: (message: ReplyMessage) => void): void
}

/**
 * 一个可写流的 `write` 槽位，即 bootstrap 所打补丁的那个（见
 * {@link captureStreamWrites}）。这里用方法类型声明，好让真实的
 * `process.stdout`/`process.stderr`（其 chunk 参数更窄）仍然可赋值。
 */
export interface PatchableStream {
  write(chunk: unknown, ...rest: unknown[]): boolean
}

/**
 * 在共用的外层 JSON 字节预算下按序捕获文本，每捕获一项就交付给 sink
 * （真实的 sink 会急切地经端口把文本流传出去，因此捕获到的输出能扛过运行中途的终止）。
 * 它的计量把日志数组语法与字符串转义也算在内。预算一旦耗尽，它发出恰好能放下的前缀，
 * 并只上报一次超限；宿主会把这种状况转成一次显式的 `output-limit` 运行失败。
 */
export class LogBuffer {
  private bytes = 2 // 空日志数组的 JSON 序列化结果：[]
  private entries = 0
  private truncated = false
  // 这里是显式字段，而非构造器参数属性：本模块在 Node 的原生
  // “仅剥离类型”模式下加载，该模式拒绝不可擦除的语法 —— 而参数属性是不可擦除的。
  private readonly sink: (text: string) => void
  private readonly onLimit: () => void
  private readonly maxBytes: number

  constructor(maxBytes: number, sink: (text: string) => void, onLimit: () => void = () => {}) {
    this.maxBytes = maxBytes
    this.sink = sink
    this.onLimit = onLimit
  }

  /**
   * 把文本交付给 sink，并从预算中扣除（预算耗尽后丢弃，并只标记一次）。
   * @param text - 要交付的捕获文本。
   */
  push(text: string): void {
    if (this.truncated) return
    const separatorBytes = this.entries > 0 ? 1 : 0
    const availableBytes = this.maxBytes - this.bytes - separatorBytes
    const stringBytes = jsonStringBytesUpTo(text, availableBytes)
    if (stringBytes === undefined) {
      this.truncated = true
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes 保证返回的前缀放得下。 */
        if (prefixBytes === undefined) throw new CapturedError('program output ledger produced an oversized log prefix')
        this.bytes += prefixBytes + separatorBytes
        this.entries += 1
        this.sink(prefix)
      }
      this.onLimit()
      return
    }
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    this.sink(text)
  }

  /** 留给完成值或失败诊断消息的精确 JSON 字节预算。 */
  remainingOutputBytes(): number {
    return this.maxBytes - this.bytes
  }
}

/** shim 捕获的五个 console 方法，采用 seam 的级别词汇。 */
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * 一个 `console` 替身，其五个分级方法按 `util.inspect` 的风格渲染参数
 * （与真实 console 的格式化足够接近，让模型能认出自己的输出）并写入缓冲区。
 * 只存在这五个 —— 程序拿到的是一个刻意精简的 console，而非 Node 的完整 console API。
 * @param logs - 每一行渲染结果所要写入的缓冲区。
 * @returns 交给程序的那个五方法 console 对象。
 */
export function makeConsoleShim(logs: Pick<LogBuffer, 'push'>): Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void> {
  const render = (args: unknown[]): string =>
    args.map(arg => typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS)).join(' ')
  const shim = Object.create(null) as Record<(typeof CONSOLE_LEVELS)[number], (...args: unknown[]) => void>
  for (const level of CONSOLE_LEVELS) {
    shim[level] = (...args: unknown[]) => { logs.push(render(args)) }
  }
  return shim
}

/**
 * 把某个流的 `write` 重定向进日志缓冲区（在 Node 子进程中即程序可见的
 * `process.stdout`/`process.stderr`），这样原始写入会按发送顺序与 console 输出排在一起，
 * 而不是顺着管道互相竞速。它保留 Node 的可选回调约定：回调在被接纳之后异步执行，
 * 即使日志预算把这次写入丢弃了也一样。
 *
 * @param logs - 捕获到的写入所要写入的缓冲区。
 * @param stream - 其 `write` 槽位被打补丁的那个流。
 * @returns 还原函数（进程内测试会用它解除补丁；真实的子进程永远用不到）。
 */
export function captureStreamWrites(logs: Pick<LogBuffer, 'push'>, stream: PatchableStream): () => void {
  // 保存的是该槽位的“值”，用于还原并重新赋值 —— 从不脱离对象单独调用，
  // 因此不存在未绑定方法的问题。
  // oxlint-disable-next-line typescript/unbound-method
  const original = stream.write
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    logs.push(typeof chunk === 'string' ? chunk : String(chunk))
    // Node 的“可选编码”形态：回调是后续两个位置中持有函数的那一个
    // （那位置上若不是函数，它就是编码）。
    const callback = [rest[0], rest[1]].find(
      (arg): arg is (error?: Error | null) => void => typeof arg === 'function',
    )
    if (callback) queueMicrotask(() => { callback(null) })
    return true
  }
  return () => { stream.write = original }
}

/** 有界的 inspect 选项：深度足够实用，且有上界，好让病态值不会把渲染炸开。 */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

/**
 * 为 done 消息准备程序的完成值。只有无损 JSON 能跨过去，放不进剩余合并外层预算的值
 * 会上报 `output-limit`；宿主会重新校验敌意流量，并且对程序 shim 观察不到的
 * 原生管道写入保持最终权威。
 *
 * @param value - 程序的完成值。
 * @param remainingOutputBytes - 扣除已捕获日志后精确剩余的字节数。
 * @param maxOutputBytes - 配置上限，会出现在超限诊断文本中。
 * @returns done 消息片段：`undefined` 时为 `{}`，否则是扁平 wire 形式的 `{ value }`。
 */
export function prepareCompletion(
  value: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): Omit<DoneMessage, 'type'> {
  if (value === undefined) return {}
  let snapshot: ReturnType<typeof snapshotPtcJsonValue>
  try {
    snapshot = snapshotPtcJsonValue(value)
  } catch {
    snapshot = undefined
  }
  if (snapshot === undefined) {
    return prepareFailure(
      'invalid-output',
      'program completion must be lossless JSON',
      remainingOutputBytes,
      maxOutputBytes,
    )
  }
  if (jsonValueBytesUpTo(snapshot, remainingOutputBytes) === undefined) {
    return outputLimit(maxOutputBytes)
  }
  return { value: encodePtcJsonWire(snapshot) }
}

/** 构造固定的超限片段，不携带被拒绝的可变字节数。 */
function outputLimit(maxOutputBytes: number): Omit<DoneMessage, 'type'> {
  return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } }
}

/** 接纳一条有界的失败消息，或在放不下时替换为固定的超限诊断。 */
function prepareFailure(
  kind: 'exception' | 'invalid-output',
  message: string,
  remainingOutputBytes: number,
  maxOutputBytes: number,
): Omit<DoneMessage, 'type'> {
  if (jsonStringBytesUpTo(message, remainingOutputBytes) === undefined) return outputLimit(maxOutputBytes)
  return { error: { kind, message } }
}

/**
 * 准备程序抛出的值，不把无界的栈或字符串经进程通道发送出去。
 * @param error - 程序抛出的值。
 * @param remainingOutputBytes - 扣除已捕获日志后精确剩余的字节数。
 * @param maxOutputBytes - 配置上限，会出现在超限诊断文本中。
 * @returns 一条有界的 exception 片段，或固定的 output-limit 片段。
 */
export function prepareException(
  error: unknown,
  remainingOutputBytes: number,
  maxOutputBytes: number = remainingOutputBytes,
): Omit<DoneMessage, 'type'> {
  let message: string
  try {
    const detail: unknown = error instanceof CapturedError ? error.stack ?? error.message : error
    message = typeof detail === 'string' ? detail : String(detail)
  } catch {
    message = 'program threw an unrenderable value'
  }
  return prepareFailure('exception', message, remainingOutputBytes, maxOutputBytes)
}

/** 一次待 await 的绑定调用的结算句柄，在 pending 表中以调用 id 为键。 */
export interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** 单个程序可见的绑定拒绝类的构造器类型。 */
export type BindingErrorConstructor = new (memberName: string, message: string) => Error

/**
 * 具现化某个命名空间所声明的真实错误构造器。
 * @param descriptor - 程序全局类名与成员名属性。
 * @returns 注入程序并用于拒绝的构造器。
 */
export function makeBindingErrorClass(
  descriptor: { name: string; memberNameProperty: string },
): BindingErrorConstructor {
  return class BindingCallError extends CapturedError {
    constructor(memberName: string, message: string) {
      super(message)
      defineBindingErrorField(this, 'name', descriptor.name)
      defineBindingErrorField(this, descriptor.memberNameProperty, memberName)
    }
  }
}

/** 为一次失败的绑定调用创建该命名空间专属的拒绝对象。 */
function bindingFailure(errorClass: BindingErrorConstructor | undefined, memberName: string, message: string): Error {
  return errorClass ? new errorClass(memberName, message) : new CapturedError(message)
}

/**
 * 每个声明的错误类只构造一次，好让调用与 `instanceof` 共享同一构造器标识。
 * @param data - 来自 boot 载荷的绑定命名空间声明。
 * @returns 以各自所属命名空间全局名为键的构造器。
 */
export function makeBindingErrorClasses(
  data: Pick<ProgramBootData, 'namespaces'>,
): Map<string, BindingErrorConstructor> {
  const classes = new Map<string, BindingErrorConstructor>()
  for (const namespace of data.namespaces) {
    if (namespace.errorClass) classes.set(namespace.global, makeBindingErrorClass(namespace.errorClass))
  }
  return classes
}

/**
 * 把宿主回复路由进待处理调用表：每条回复至多结算一次对应调用，
 * 而指向未知 id 的回复（游离回复，或对已结算 id 的重复应答）会被忽略。
 * 这是 {@link runProgram} 与单独测试 {@link makeNamespaces} 的测试之间共用的接线。
 * @param port - 其 `message` 事件承载回复的那个端口。
 * @param pending - 以 id 为键的未结算绑定调用表。
 */
export function wireReplies(port: BootstrapPort, pending: Map<number, PendingCall>): void {
  port.on('message', (message: ReplyMessage) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) {
      const value = decodePtcJsonWire(message.value)
      if (value === undefined) entry.reject(new CapturedError('binding resolution must be lossless JSON'))
      else entry.resolve(value)
    } else {
      entry.reject(new CapturedError(message.message))
    }
  })
}

/**
 * 构造程序看到的绑定命名空间对象：每个命名空间一个 null 原型全局对象，
 * 每个声明的名字都是一个自有的可枚举异步函数，经端口桥接过去
 * （`__proto__`/`constructor`/`toString` 都是普通键，绝不是原型冲突）。
 * 有损参数在投递之前就拒绝；克隆失败与宿主失败回复只拒绝对应的那一次调用。
 *
 * @param data - boot 载荷中的命名空间声明（全局名 + 函数名）。
 * @param port - 绑定调用投递到的端口。
 * @param pending - 以 id 为键的表，每次已投递的调用把句柄寄存在这里。
 * @param nextId - 共享的可变 id 计数器（程序发出的关联 id）。
 * @param errorClasses - 与程序全局共享的命名空间构造器，每次调用时解析。
 * @returns 每个声明对应一个命名空间对象，顺序与声明顺序一致。
 */
export function makeNamespaces(
  data: Pick<ProgramBootData, 'namespaces'>,
  port: BootstrapPort,
  pending: Map<number, PendingCall>,
  nextId: { value: number },
  errorClasses: Pick<ReadonlyMap<string, BindingErrorConstructor>, 'get'> = makeBindingErrorClasses(data),
): Record<string, unknown>[] {
  return data.namespaces.map(({ global, names }) => {
    const namespace = Object.create(null) as Record<string, unknown>
    for (const name of names) {
      Object.defineProperty(namespace, name, {
        enumerable: true,
        value: (args: unknown): Promise<unknown> => {
          const errorClass = errorClasses.get(global)
          let detached: ReturnType<typeof snapshotPtcJsonValue>
          try {
            detached = snapshotPtcJsonValue(args)
          } catch {
            detached = undefined
          }
          if (detached === undefined) {
            return Promise.reject(bindingFailure(errorClass, name, 'binding arguments must be lossless JSON'))
          }
          return new Promise((resolve, reject) => {
            const id = nextId.value
            pending.set(id, {
              resolve,
              reject: (error) => {
                reject(bindingFailure(errorClass, name, error.message))
              },
            })
            try {
              port.postMessage({ type: 'call', id, global, name, args: encodePtcJsonWire(detached) })
              nextId.value += 1
            } catch (error: unknown) {
              pending.delete(id)
              const message = `binding call could not be sent: ${error instanceof CapturedError ? error.message : String(error)}`
              reject(bindingFailure(errorClass, name, message))
            }
          })
        },
      })
    }
    return namespace
  })
}

/**
 * 运行一段严格模式的 async 函数体，允许顶层 `await` 与 `return`，并恰好投递
 * 一条终结性的 {@link DoneMessage}；程序抛出的错误成为它的 `error` 字段。
 * @param port - 宿主消息端口或测试替身。
 * @param data - 宿主发来的 boot 载荷。
 * @param streams - 作为程序日志被捕获的 stdout/stderr 对象。
 * @returns 在投递完 done 消息之后返回。
 */
export async function runProgram(
  port: BootstrapPort,
  data: ProgramBootData,
  streams: { stdout: PatchableStream; stderr: PatchableStream },
): Promise<void> {
  const logs = new LogBuffer(
    data.maxOutputBytes,
    (text) => { port.postMessage({ type: 'log', text }) },
    () => { port.postMessage({ type: 'output-limit' }) },
  )
  captureStreamWrites(logs, streams.stdout)
  captureStreamWrites(logs, streams.stderr)

  const pending = new Map<number, PendingCall>()
  wireReplies(port, pending)

  const nextId = { value: 1 }
  const errorClasses = makeBindingErrorClasses(data)
  const namespaces = makeNamespaces(data, port, pending, nextId, errorClasses)
  const errorClassParameters: string[] = []
  const errorClassValues: BindingErrorConstructor[] = []
  for (const namespace of data.namespaces) {
    if (!namespace.errorClass) continue
    errorClassParameters.push(namespace.errorClass.name)
    const errorClass = errorClasses.get(namespace.global)
    /* v8 ignore next -- makeBindingErrorClasses 已覆盖同一 data 中的每一条声明。 */
    if (!errorClass) throw new CapturedError(`missing binding error class for ${namespace.global}`)
    errorClassValues.push(errorClass)
  }
  const consoleShim = makeConsoleShim(logs)

  let done: DoneMessage
  try {
    // 通过实例拿到 async 函数构造器，因为 `AsyncFunction` 不是全局对象。
    // 程序体运行在严格模式下。
    /* v8 ignore next -- 该箭头函数只是用来拿到 AsyncFunction 构造器，本身从不调用。 */
    const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction(
      ...data.namespaces.map(namespace => namespace.global),
      ...errorClassParameters,
      'console',
      `'use strict';\n${data.code}`,
    )
    const value = await fn(...namespaces, ...errorClassValues, consoleShim)
    done = {
      type: 'done',
      ...prepareCompletion(value, logs.remainingOutputBytes(), data.maxOutputBytes),
    }
  } catch (error: unknown) {
    done = {
      type: 'done',
      ...prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes),
    }
  }
  port.postMessage(done)
}
