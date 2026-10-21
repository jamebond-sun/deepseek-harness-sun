/**
 * 带有稳定、可机器路由的错误码与可链式 cause 的 Harness 错误基类。
 * 包内错误继承它，因此工具结果与回放都能保留失败类别。
 * @module @deepseek-ai/dsh-llm/error
 */

/**
 * 所有 harness 错误的基类。携带一个 `code`（稳定、供程序使用——
 * 例如 `NO_ADAPTER`、`INVALID_ARGS`），它区别于面向人类的 `message`，
 * 并通过标准的 `ErrorOptions` 支持 `cause` 链。`name` 默认为子类构造器名。
 */
export class HarnessError extends Error {
  /** 稳定、可机器路由的失败类别（例如 `RATE_LIMIT`）；按它路由，绝不解析 `message`。 */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** 因超出上下文窗口而被拒绝的模型请求所对应的、规范的与提供方无关的错误码。 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** 账号配额或余额耗尽所对应的、规范的与提供方无关的错误码。 */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'

/** 可通过第一方账单页面补充的账号令牌配额。 */
export const ACCOUNT_QUOTA_EXCEEDED_CODE = 'ACCOUNT_QUOTA'

/**
 * 一次正常完成但完全没有携带任何内容块的响应所对应的、
 * 规范的与提供方无关的错误码。提供方偶尔会发出一个退化的完成
 * （一个输出为零的终止性 stop）；适配器把它归类为这个失败，
 * 而不是产出一条空的助手消息，因为一条空消息会静默地结束轮次，
 * 让用户和循环都无从着手。该尝试没有产生任何持久化的东西，
 * 因此重试策略把它当作可以安全地重复。
 */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/**
 * 已提供但无法使用的凭据所对应的、规范的与提供方无关的错误码——
 * 是格式错误而非缺失。它区别于 `MISSING_CREDENTIAL`，因为修复方式不同：
 * 应更正已存储的值，而不是提供一个值。有意置于默认可重试集合之外——
 * 一个格式错误的凭据在每次尝试上都会同样失败。
 */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'

/** 明确指名某个上下文边界被超出的结构化错误码与常见短语。 */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)

/** 把“太大”直接与模型上下文容量绑定在一起的请求规模措辞。 */
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)

/** “超出”这一措辞只有在其宾语明确是模型上下文时才是安全的。 */
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/**
 * 识别 OpenAI 兼容提供方与各类库适配器所使用的上下文溢出措辞。
 * 适配器传入全部可用的提供方 code、type 与消息文本，因此抛出式
 * 与带内式两种投递风格共享同一个分类器。
 * @param detail - 拼接成一个字符串的提供方错误码/类型/消息文本。
 * @returns 当该细节标识出一次超出模型上下文窗口的请求时为 true。
 */
export function isContextWindowExceededError(detail: string): boolean {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

/**
 * 识别标识账号配额已耗尽（而非瞬时请求速率限制）的提供方措辞。
 * @param detail - 拼接成一个字符串的提供方错误码/类型/消息文本。
 * @returns 仅对终局性的配额、余额、积分、预算或用量的措辞为 true。
 */
export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/**
 * 用完整的 `cause` 链与 AggregateError 成员渲染一个被抛出的值，
 * 因此像 undici 的 `TypeError: fetch failed` 这样的传输包装
 * 会暴露底层失败，而不是把它掩盖起来。普通的结构化失败渲染它们自己
 * 由数据支撑的 `message`。仅供诊断面的渲染（消息、通知、日志）——
 * 绝不解析其结果；请按 {@link HarnessError.code} 路由。
 * @param value - 被捕获的值（在 catch 子句中为 `unknown`）。
 * @returns 最外层消息在前，每个 cause 以 `: ` 追加（当它逐字重复
 * 包装消息时跳过），而 AggregateError 的成员以方括号括起并以 `; ` 连接。
 */
export function errorChain(value: unknown): string {
  // 跟踪活跃的递归路径（退出时移除条目），因此只有真正的环才会被标记，
  // 而菱形共享的 cause 仍会完整渲染。
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : ''
      const causeText = current.cause === undefined || current.cause === null
        ? ''
        : render(current.cause)
      // 像 `new HarnessError(String(value), code, { cause: value })` 这样的包装
      // 会逐字重复它们的 cause；再次渲染只会增加噪声。
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      // 只有恶意的类型强制或恶意访问器（非 Error 上会抛出的 toString /
      // Symbol.toPrimitive，或 Error 子类上会抛出的 message/name/cause/
      // errors 取值器）：本渲染器服务于 UI 通知与日志，因此任何东西都不得逃逸。
      // 内层帧各自捕获自己的抛出，因此只有那个恶意节点坍缩，而不是整条链。
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

/**
 * 把一个任意的被抛出值收窄为 HarnessError（供运行期边界处的 `instanceof` 使用）。
 * @param value - 被捕获的值（在 catch 子句中为 `unknown`）。
 * @returns 仅对真实实例为 true；鸭子类型化的或跨 realm 的错误不会被收窄。
 */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
}

/**
 * 一个具备图像能力的路由在卸载更多图像之前无法发送的请求所对应的规范错误码。
 * 该失败的 `offloadImages` 指名还需额外卸载多少个最早的被保留出现；
 * `dsh-compaction-image-offload` 会在 agent 或摘要器用新派生的输入
 * 重试之前记录一次 `image/offload` 选择。
 */
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED'
