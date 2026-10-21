/** 校验并捕获单个程序可用的绑定名称。 */
import { DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingFunction, PtcBindingNamespace, PtcJsonValue, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { encodePtcJsonWire } from './json-wire.ts'
import type { ReplyMessage } from './protocol.ts'
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
/**
 * 在启动进程之前拒绝不可用的命名空间。
 * @param request - 宿主持有的绑定声明。
 * @returns 以各自声明的全局名为键的命名空间。
 */
export function validateBindings(request: PtcRunRequest): Map<string, PtcBindingNamespace> {
  const bindings = new Map<string, PtcBindingNamespace>()
  for (const namespace of request.bindings) {
    if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
      throw new Error(`dsh-ptc-runtime-node: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
    }
    // RESERVED_BINDING_GLOBALS 是 seam 共用的“后端自有”集合：
    // `console` 是本后端的日志捕获槽位；那些 dunder 条目是为 Python 一侧准备的 ——
    // 它预置/包装的槽位加上 `__debug__` 编译期常量 —— 此处同样拒绝，
    // 好让命名空间列表在各后端之间保持可移植。每条为何被保留，唯一权威在 seam 的声明处。
    if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
      throw new Error(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(namespace.global)}`)
    }
    if (bindings.has(namespace.global)) {
      throw new Error(`dsh-ptc-runtime-node: duplicate binding global ${JSON.stringify(namespace.global)}`)
    }
    bindings.set(namespace.global, namespace)
  }

  const errorClassNames = new Set<string>()
  for (const namespace of request.bindings) {
    const descriptor = namespace.errorClass
    if (!descriptor) continue
    if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
      throw new Error(`dsh-ptc-runtime-node: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
    }
    if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
      throw new Error(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(descriptor.name)}`)
    }
    if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
      throw new Error(`dsh-ptc-runtime-node: duplicate injected global ${JSON.stringify(descriptor.name)}`)
    }
    const member = descriptor.memberNameProperty
    if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
      throw new Error(`dsh-ptc-runtime-node: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
    }
    errorClassNames.add(descriptor.name)
  }
  return bindings
}

/**
 * 调用一个宿主绑定，并把它的无损结果或有界通道拒绝编码为回复。
 * @param id - 程序发出的关联标识符。
 * @param binding - 本次求值所声明的函数；若已被移除则为缺席。
 * @param args - 已从程序中分离出来的、经校验的 JSON 参数。
 * @returns 一条适合运行时有界控制通道的回复。
 */
export async function replyToBinding(id: number, binding: PtcBindingFunction | undefined, args: PtcJsonValue): Promise<ReplyMessage> {
  try {
    if (!binding) throw new Error('binding is unavailable in this evaluation; reacquire the current tool')
    const value = snapshotJsonValue(await binding(args))
    if (value === undefined) throw new Error('binding resolution must be lossless JSON')
    return { type: 'reply', id, ok: true, value: encodePtcJsonWire(value) }
  } catch (error: unknown) {
    return { type: 'reply', id, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
