/**
 * 一个低依赖的**保留（retention）**库：为有界、面向模型的输出而设，适用于那些
 * 必须限制返回上下文量的工具。调用方将条目或文本块喂入一个有界对象，然后得到
 * 保留内容加上精确的省略元数据（{@link RetainedItems} / {@link RetainedText}）。
 *
 * 本库只负责一个机械性问题「我们保留了什么、省略了什么？」。工具特有的代码仍
 * 负责业务语义：文件分组、行号、退出码、提供方错误状态、逐行预览截断、溢出文件，
 * 以及面向模型的行文。尤其要注意，{@link RetainedText.truncated}/
 * {@link RetainedItems.truncated} 意为「保留方因预算而省略了本可获取的内容」——
 * 而非「上游不完整」。权限失败、跳过的二进制文件、提供方部分失败，以及不可读
 * 的候选，仍停留在工具领域字段中，绝不会折进 `truncated`。
 *
 * 这刻意是一个库，而非 cordis 服务或插件：它不接收 `ctx`、不注册任何东西、也不
 * 发出事件。两个保留器是唯一有状态的部分，且其状态是每实例的（一次累积），绝不
 * 跨调用。工具包在需要有限输出时直接导入它。
 *
 * 两个保留器在资源模型上不同，这正是它们是两个名称而非一个通用收集器的原因：
 * - {@link ItemRetainer} 限定有序的逻辑单元（路径、grep 匹配、搜索来源）。
 *   v1 中仅 `head` 保留。
 * - {@link TextRetainer} 限定面向字节的文本流（bash 的 stdout/stderr、Web 正文）。
 *   `head` / `tail` / `headTail`，并在 {@link TextRetainer.finish} 处保留 UTF-8
 *   边界。
 *
 * @module @deepseek-ai/dsh-output-retention
 */

/**
 * 保留方省略了多少内容。
 *
 * `exact` 是正常的保留器形态：每个单元/字节都已被观察到，因此省略计数是精确的。
 * `unknown` 保留给一个不带计数就省略的调用方；保留器自身永远不会返回它。
 */
export type Omitted =
  | { kind: 'none' }
  | { kind: 'exact'; count: number }
  | { kind: 'unknown' }

/**
 * 调用方在每次 `push()` 后收到这个。
 */
export interface PushDecision {
  /** 整个单元 / 该分块的所有字节是否都被保留了（没有任何丢弃）？ */
  kept: boolean
  /** 累积的：保留方是否因预算而已经省略了什么？ */
  truncated: boolean
}

/**
 * 有序逻辑单元的最终结果。
 *
 * `seen` 指保留方 OBSERVED 到的单元，未必是上游来源中的总数。`kept` 即
 * `items.length`，被显式暴露，以便通知格式化器无需重新计数。
 */
export interface RetainedItems<T> {
  items: T[]
  truncated: boolean
  seen: number
  kept: number
  omitted: Omitted
}

/**
 * 文本流的最终结果。
 *
 * 返回的 `text` 可安全交给格式化器：保留器不添加任何工具特有的头、退出标记、
 * XML 标签或恢复指引，且 `omittedBytes` 计的是 BYTES（而非字符或行）——文本
 * 保留是面向字节的，以保进程/正文安全。每次裁剪处的 UTF-8 边界都被保留，因此
 * `text` 永远不会携带由裁剪本身引入的替换字符。
 */
export interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: Omitted
}

/** 条目保留策略。v1 中仅 `head`；窗口/分组预算留待第二个消费方。 */
export type ItemRetentionStrategy = {
  /** 保留前 `maxItems` 个单元。用于 `glob`、`grep` 与 Web 来源。 */
  kind: 'head'
  maxItems: number
}

/** 文本保留策略：保留前缀、后缀或两者，以字节计。 */
export type TextRetentionStrategy =
  | {
    /** 保留前 `maxBytes` 个字节。 */
    kind: 'head'
    maxBytes: number
  }
  | {
    /** 保留最后的 `maxBytes` 个字节。需读到末尾。 */
    kind: 'tail'
    maxBytes: number
  }
  | {
    /** 保留稳定的前缀与后缀，省略中间。需读到末尾。 */
    kind: 'headTail'
    headBytes: number
    tailBytes: number
  }

/**
 * 对一个保留结果的中立、与工具无关的描述——即 {@link formatRetentionNotice} 的
 * 输入。它携带机械事实（策略、单元、上限、保留计数、{@link Omitted}）；工具提供
 * 恢复措辞，因为只有工具知道恢复动作（「收窄模式」、「获取更具体的 URL」、
 * 「读取溢出文件」）。
 */
export interface RetentionNotice {
  /** 工具/作用域标签，例如 `grep`、`web_fetch`、`bash stdout`。 */
  scope: string
  strategy: 'head' | 'tail' | 'headTail'
  unit: 'items' | 'bytes' | 'chars' | 'lines'
  limit: number | { head: number; tail: number }
  kept: number
  omitted: Omitted
}

/** 断言预算字段是一个非负整数（保留器请求契约）。 */
function assertBudget(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}

/**
 * 限定一个有序的逻辑单元流，保留前 `maxItems` 个（{@link ItemRetentionStrategy}
 * 的 `head`）。`push()` 会就每个单元报告它是否被保留，以及保留结果此刻是否已
 * 截断。
 *
 * 分组、排序、路径映射、逐单元预览截断，以及任何 `incomplete` 状态都留在保留器
 * 之外：它只计数与保留，仅此而已。调用方推入已准备好的逻辑单元，并在
 * {@link finish} 之后自行对保留子集进行分组/排序。
 */
export class ItemRetainer<T> {
  private readonly maxItems: number
  private readonly items: T[] = []
  private seen = 0
  private omittedCount = 0

  /** @param strategy Head 策略：`maxItems`（非负整数）。 */
  constructor(strategy: ItemRetentionStrategy) {
    assertBudget(strategy.maxItems, 'maxItems')
    this.maxItems = strategy.maxItems
  }

  /**
   * 提供一个单元。当保留器低于 `maxItems` 时保留，否则丢弃并计为省略。调用方持续
   * 推入所有观察到的单元，因此最终的 {@link Omitted} 计数是精确的。
   *
   * @param item 已准备好的逻辑单元（路径、扁平匹配、来源）。
   * @returns 每次推送的 {@link PushDecision}。
   */
  push(item: T): PushDecision {
    this.seen++
    if (this.items.length < this.maxItems) {
      // 仅在低于上限、任何省略发生之前才会到达此处（条目只增不减，上限固定），
      // 因此还没有任何东西被丢弃：truncated 始终为 false。
      this.items.push(item)
      return { kept: true, truncated: false }
    }
    this.omittedCount++
    return {
      kept: false,
      truncated: true,
    }
  }

  /**
   * 结束并报告被保留与被省略的内容。
   *
   * @returns {@link RetainedItems} 快照（可安全地在下游分组/排序）。
   */
  finish(): RetainedItems<T> {
    const truncated = this.omittedCount > 0
    return {
      items: this.items,
      truncated,
      seen: this.seen,
      kept: this.items.length,
      omitted: truncated
        ? { kind: 'exact', count: this.omittedCount }
        : { kind: 'none' },
    }
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder() // utf-8，非致命：内部畸形字节 → U+FFFD

/**
 * 丢弃尾部不完整的 UTF-8 序列，使前缀裁剪永远不会在边界处发出替换字符。沿续
 * 字节（`10xxxxxx`）回退到前导字节；若其后的字节少于前导字节声明的长度，则该
 * 序列不完整并被裁剪。完整的尾部，或一段过长/过短而不构成合法前导的，则原样
 * 返回（任何真正畸形的内部字节留给解码器去替换）。
 */
function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1
  // 续字节为 0b10xxxxxx；最多回退 3（最大序列为 4）。
  // 索引由循环守卫做边界检查，因此读操作都在范围内。
  while (i >= 0 && ((bytes[i] as number) & 0xc0) === 0x80 && bytes.length - i <= 3) i--
  if (i < 0) return bytes
  const lead = bytes[i] as number
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0
  // expected 为 0 → 不是前导字节（游离续字节 / 非法）：保留它。
  if (expected === 0) return bytes
  return bytes.length - i < expected ? bytes.subarray(0, i) : bytes
}

/**
 * 丢弃前导续字节（`10xxxxxx`），使后缀裁剪从一个前导/ASCII 字节而非码点中间开始。
 */
function trimLeadingContinuationUtf8(bytes: Uint8Array): Uint8Array {
  let i = 0
  // i < length 守卫读操作。
  while (i < bytes.length && ((bytes[i] as number) & 0xc0) === 0x80) i++
  return bytes.subarray(i)
}

/**
 * 限定一个面向字节的文本流，保留前缀、后缀或两者（{@link TextRetentionStrategy}）。
 * 三种策略共享同一个前缀/后缀累加器：`head` 仅前缀，`tail` 仅后缀，`headTail`
 * 两者皆有。
 *
 * 是字节，而非字符：上限与 `omittedBytes` 都是字节计数，以保进程/正文安全。
 * 跨码点的分块会得到处理——{@link finish} 会在每次裁剪处裁掉部分码点，使返回的
 * 文本永远不会在边界处引入替换字符。保留器在内存中至多持有
 * `prefixCap + tailBytes + 一个分块`（旧的尾部分块滑出时即被丢弃），因此大流不会
 * 无限累积。
 */
export class TextRetainer {
  private readonly prefixCap: number
  private readonly suffixCap: number
  private readonly prefixChunks: Uint8Array[] = []
  private prefixHeld = 0
  private readonly suffixChunks: Uint8Array[] = []
  private suffixHeld = 0
  private total = 0

  /** @param strategy 一个 {@link TextRetentionStrategy} 变体；字节预算必须为非负整数。 */
  constructor(strategy: TextRetentionStrategy) {
    switch (strategy.kind) {
      case 'head':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = strategy.maxBytes
        this.suffixCap = 0
        break
      case 'tail':
        assertBudget(strategy.maxBytes, 'maxBytes')
        this.prefixCap = 0
        this.suffixCap = strategy.maxBytes
        break
      case 'headTail':
        assertBudget(strategy.headBytes, 'headBytes')
        assertBudget(strategy.tailBytes, 'tailBytes')
        this.prefixCap = strategy.headBytes
        this.suffixCap = strategy.tailBytes
        break
    }
  }

  /**
   * 提供一个分块（一个 `Uint8Array`，或一个编码为 UTF-8 的 `string`）。前缀字节
   * 填满至前缀上限后停止；后缀字节滚动，仅保留最后 `suffixCap` 个字节。`kept` 仅
   * 当本分块没有一个字节被丢弃时才为 `true`。
   *
   * @param chunk 流的下一个字节（`Uint8Array` 或 UTF-8 `string`）。
   * @returns 每次推送的 {@link PushDecision}。
   */
  push(chunk: Uint8Array | string): PushDecision {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk
    const before = this.total
    this.total += bytes.length

    // 前缀：只取到上限；本分块的其余部分是「未被前缀保留」。
    const room = this.prefixCap - this.prefixHeld
    const take = Math.max(0, Math.min(room, bytes.length))
    if (take > 0) {
      this.prefixChunks.push(bytes.subarray(0, take))
      this.prefixHeld += take
    }

    // 后缀：追加整个分块，然后丢弃已经完全滑出最后 `suffixCap` 字节的整块前导
    // 分块（有界内存）。
    if (this.suffixCap > 0) {
      this.suffixChunks.push(bytes)
      this.suffixHeld += bytes.length
      let head = this.suffixChunks[0]
      while (head !== undefined && this.suffixHeld - head.length >= this.suffixCap) {
        this.suffixChunks.shift()
        this.suffixHeld -= head.length
        head = this.suffixChunks[0]
      }
      // 头分块仍可能持有超出最后 `suffixCap` 的前导字节——一个大于窗口的单一
      // 分块会被上面的循环整体保留（丢弃唯一分块会少于上限）。裁掉这些前导字节，
      // 使累加器（以及 finish() 的 concat）受 `suffixCap` 约束，而非再次分配/复制
      // 整个分块；finish() 只读最后 `suffixLen ≤ suffixCap` 个字节，因此这不会
      // 丢弃它会返回的任何东西。（在循环不变量 `suffixHeld - head.length <
      // suffixCap` 下 head.length > excess，因此切片非空。）
      if (head !== undefined && this.suffixHeld > this.suffixCap) {
        const excess = this.suffixHeld - this.suffixCap
        this.suffixChunks[0] = head.subarray(excess)
        this.suffixHeld -= excess
      }
    }

    // 被丢弃 = 两侧都无法保留的字节。以与 finish() 相同的方式（经由 omittedAt）
    // 计算累积省略，使 push 与 finish 永不产生分歧；每次推送我们只关心本分块是否
    // 把总数推过了两个上限所能容纳的部分。
    const droppedThisChunk = this.omittedAt(this.total) > this.omittedAt(before)
    return {
      kept: !droppedThisChunk,
      truncated: this.omittedAt(this.total) > 0,
    }
  }

  /** 已观察到 `total` 字节后省略的字节数：`total − keptPrefix − keptSuffix`。 */
  private omittedAt(total: number): number {
    const prefixLen = Math.min(total, this.prefixCap)
    const suffixLen = Math.min(total - prefixLen, this.suffixCap)
    return total - prefixLen - suffixLen
  }

  /**
   * 结束：解码保留的前缀与后缀（各自在裁剪处裁到 UTF-8 边界）并报告精确的省略
   * 字节数。
   *
   * @returns {@link RetainedText} 快照（可安全交给格式化器）。
   */
  finish(): RetainedText {
    const prefixLen = Math.min(this.total, this.prefixCap)
    const suffixLen = Math.min(this.total - prefixLen, this.suffixCap)

    const prefix = concat(this.prefixChunks) // 恰好 prefixLen 字节（prefixHeld === prefixLen）
    const suffix = concat(this.suffixChunks).subarray(this.suffixHeld - suffixLen)

    // 当预算没有省略任何内容时，前缀与后缀是同一流的 ADJACENT 切片
    // （prefixLen + suffixLen === total），因此 head|tail 的切分是人为的：一个码点
    // 可能跨越它。把连续整体作为一个缓冲区解码——此处若分别裁剪或解码两半，会破坏
    // 一个跨越边界的码点，尽管没有任何内容被丢弃。只有当真正存在省略间隔时，两侧
    // 才是真正的切分：将各自裁到 UTF-8 边界并分别解码，使码点绝不会跨越间隔重建。
    const budgetOmitted = this.omittedAt(this.total)
    const [keptPrefix, keptSuffix] = budgetOmitted > 0
      ? [trimTrailingPartialUtf8(prefix), trimLeadingContinuationUtf8(suffix)]
      : [prefix, suffix]
    const text = budgetOmitted > 0
      ? decoder.decode(keptPrefix) + decoder.decode(keptSuffix)
      : decoder.decode(concat([prefix, suffix]))

    // 针对实际返回的字节报告省略，而非裁剪前的预算：边界裁剪也会丢弃部分码点的
    // 字节，因此仅由预算推导出的精确计数会高估保留文本（而据此构建的任何
    // 「已省略 N 字节」通知都将是一句谎言）。
    const omitted = this.total - keptPrefix.length - keptSuffix.length
    const truncated = omitted > 0

    return {
      text,
      truncated,
      omittedBytes: truncated
        ? { kind: 'exact', count: omitted }
        : { kind: 'none' },
    }
  }
}

/** 将分块拼接为一个连续缓冲区（它们精确的总长度）。 */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * 为一个 {@link Omitted} 值提供标准化、安全的措辞——即本库所拥有的「可能标准化
 * 省略措辞」那一半。`exact` 打印计数（`Omitted 3 items`）；`unknown` 不打印计数，
 * 因为调用方没有提供。`none` 为空字符串。
 *
 * @param omitted 来自保留器结果的省略元数据。
 * @param unit 被省略数量的名词（`items`、`bytes`、`chars`、`lines`）。
 * @returns 一个中立的从句（无尾随空格），或当没有任何省略时为 `''`。
 */
export function describeOmitted(omitted: Omitted, unit: RetentionNotice['unit']): string {
  switch (omitted.kind) {
    case 'none':
      return ''
    case 'exact':
      return `Omitted ${omitted.count} ${unit}.`
    case 'unknown':
      return `More ${unit} were omitted.`
  }
}

/**
 * 将一个 {@link RetentionNotice} 变成一行脚注：先是本库所拥有的标准化省略从句
 * （{@link describeOmitted}），随后是工具自身的恢复指引。本库永不拥有恢复措辞——
 * 只有工具知道动作（「收窄模式」、「获取更具体的 URL」、「读取溢出文件」）——因此
 * `recovery` 提供它们，并收到完整的通知以据此措辞（`kept`、`limit`、`omitted`……）。
 * 任一半都可能为空；两者以单个空格连接。
 *
 * @param notice 中立的保留结果。
 * @param recovery 工具提供的指引构建器；收到通知，返回一个句子（或 `''`）。
 * @returns 合并后的脚注行。
 */
export function formatRetentionNotice(
  notice: RetentionNotice,
  recovery: (notice: RetentionNotice) => string,
): string {
  return [describeOmitted(notice.omitted, notice.unit), recovery(notice)]
    .filter(part => part.length > 0)
    .join(' ')
}

/**
 * 将 `text` 截断到 `maxChars` 个 UTF-16 码单元，且不引入孤立的高代理项：落在代理
 * 对内部的裁剪会丢弃未配对的一半，因此结果比上限少一个码单元。未配对的代理项
 * 不是良构文本——严格的 JSON 读取方会拒绝携带它的持久 Session 日志。`text` 已
 * 携带的未配对代理项不在此处修复。
 *
 * @param text 待截断的文本。
 * @param maxChars 待保留的最大 UTF-16 码单元数。
 * @returns 不再长于 `maxChars` 的 `text` 前缀；裁剪绝不引入孤立的高代理项。
 */
export function truncateWithoutSplittingSurrogatePair(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const capped = text.slice(0, maxChars)
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped
}
