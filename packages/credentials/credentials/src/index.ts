/**
 * 凭证引用能力 seam（`ctx.credentials`）的 Service Definition。设置与组合文件携带
 * 对秘密的*引用*——环境变量名——而提供方拥有实际的取值及其存储。消费者在每个
 * 操作解析一次引用，因此变更的凭证无需任何插件重启即可到达下一个操作，
 * 而配置界面在不曾见到其值的情况下描述一条引用。
 * @module @deepseek-ai/dsh-credentials
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialInfo, CredentialKey, CredentialRecord, CredentialRef } from './types.ts'

export type {
  ApiKeyRecord, CredentialInfo, CredentialKey, CredentialRecord, CredentialRef, GrantRecord,
} from './types.ts'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** {@link CredentialKey} 的两个半边；它们之间的 `/` 正是使其被排除在 {@link REF_PATTERN} 之外的原因。 */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * 将一个原始字符串品牌化为 {@link CredentialRef}。
 * @param value - 候选引用；一个 POSIX shell 标识符，如 `DEEPSEEK_API_KEY`。
 * @returns 品牌化后的引用。
 */
export function credentialRef(value: string): CredentialRef {
  if (!isCredentialRefName(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return brandString<CredentialRef>(value)
}

/**
 * 一个原始字符串是否可能命名一条引用。从别处（提供方库自身的环境发现、一个
 * hook 载荷）收到环境变量名的消费者会在解析前询问此函数，因为文法之外的名称
 * 并无引用可“错过”，应读作“未设置”而非抛出的错误。
 * @param value - 候选引用。
 * @returns 当 {@link credentialRef} 会接受它时为 true。
 */
export function isCredentialRefName(value: string): boolean {
  return REF_PATTERN.test(value)
}

/**
 * 一个原始字符串是否可能成为 {@link credentialKey} 的某一段。其寻址单元来自别处
 * （设置字典的键、库自身的提供方 id）的消费者会在构建键前询问此函数，因为文法
 * 之外的单元绝不可能存储过记录，应读作“未存储任何内容”而非抛出的错误。
 * @param value - 候选段。
 * @returns 当 {@link credentialKey} 会将其接受为任一段时为 true。
 */
export function isCredentialKeySegment(value: string): boolean {
  return KEY_SEGMENT_PATTERN.test(value)
}

/**
 * 将一个 scope 与一个 id 品牌化为 {@link CredentialKey}。
 * @param scope - 拥有插件的注册名，如 `llm-pi-ai`。
 * @param id - 该插件自身的寻址单元，如一个提供方路由键。
 * @returns 品牌化后的键。
 * @throws 当任一段不是小写连字符标识符时抛出 TypeError。
 */
export function credentialKey(scope: string, id: string): CredentialKey {
  for (const segment of [scope, id]) {
    if (!KEY_SEGMENT_PATTERN.test(segment)) {
      throw new TypeError(`credential key segment "${segment}" must match ${String(KEY_SEGMENT_PATTERN)}`)
    }
  }
  return brandString<CredentialKey>(`${scope}/${id}`)
}

/**
 * 将一个已存储的 `<scope>/<id>` 字符串品牌化为 {@link CredentialKey}。这是
 * {@link credentialKey} 的读取半边，供从磁盘接纳键的提供方使用。
 * @param value - 以连接形式给出的候选键。
 * @returns 品牌化后的键。
 * @throws 当该值并非恰好两段有效段时抛出 TypeError。
 */
export function parseCredentialKey(value: string): CredentialKey {
  const segments = value.split('/')
  const [scope, id] = segments
  if (segments.length !== 2 || scope === undefined || id === undefined) {
    throw new TypeError(`credential key "${value}" must be "<scope>/<id>"`)
  }
  return credentialKey(scope, id)
}

/**
 * 某个键对应的、拥有插件的名称。其 scope 未命名任何当前已注册拥有者的记录
 * 是一个孤儿，配置界面必须将其报告为孤儿，而非一个可用的凭证。
 * @param key - 要读取的键。
 * @returns scope 段。
 */
export function credentialKeyScope(key: CredentialKey): string {
  // 该品牌的构造函数都会校验两段，因此此处拆分不会少于两段。
  return key.slice(0, key.indexOf('/'))
}

/**
 * 某个键对应的、拥有插件自身的寻址单元——该插件所选择的那一半，如一个提供方路由。
 * @param key - 要读取的键。
 * @returns id 段。
 */
export function credentialKeyId(key: CredentialKey): string {
  return key.slice(key.indexOf('/') + 1)
}

/** 一个已解析的凭证取值，以及提供它的来源层。 */
export interface ResolvedCredential {
  /** 非空的秘密值。 */
  value: string
  /** 提供方定义的来源层 id（本地提供方使用 `env`、`file`、`project-env` 与 `user-env`）。 */
  source: string
}

/** 单个记录的存在性与可写性事实，对配置 UI 安全——绝不含值。 */
export interface CredentialRecordInfo {
  /**
   * 是否存储了一条记录。与引用不同，仅凭存在性即可回答这一点：一个既无 key
   * 也无环境值的 {@link ApiKeyRecord} 表示其拥有者已确认环境认证，这是已配置，
   * 而非空白。
   */
  configured: boolean
  /** 已存储记录的判别字段；未存储时缺省。 */
  kind?: CredentialRecord['kind']
  /** {@link CredentialProvider.modifyRecord} 当前是否会成功。 */
  writable: boolean
}

/** 单条已存储记录的地址与标签，用于枚举——绝不含其值。 */
export interface CredentialRecordEntry {
  /** 记录的地址。 */
  key: CredentialKey
  /** 已存储记录的判别字段。 */
  kind: CredentialRecord['kind']
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentials: CredentialProvider
  }
}

/**
 * 跨越两个键空间、回答两个问题的抽象凭证服务。
 *
 * {@link CredentialRef} 回答“这个环境变量名背后是什么”：先是提供方管理的存储，
 * 然后是环境回退，如进程环境与 `.env` 文件。一条全 seam 的规则约束这一半边：
 * 空存储值在任何地方都视为缺失——`resolve` 跳过它，`describe` 将其报告为未配置——
 * 因此一个空白永远不会伪装成已配置的秘密。
 *
 * {@link CredentialKey} 回答“该插件为此 id 持有哪个凭证”。这里没有任何东西可以
 * 叠加——一条授权许可没有可供读取的环境——因此记录的存在性就是全部事实，而
 * {@link modifyRecord} 是唯一的写入路径，因为一次正确的写入依赖于当前值
 * （令牌刷新是在一把锁之下的读取-判断-替换）。
 */
export abstract class CredentialProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * 将一个引用解析到其当前值。解析是逐次调用进行的：消费者在每个操作重新解析，
   * 且不得在操作之间缓存——正是这种逐操作的读取，使得变更的凭证无需重启即可
   * 到达下一个操作。
   * @param ref - 要解析的引用。
   * @returns 该值及其来源；未配置时为 `undefined`。
   */
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /**
   * 在不暴露取值的情况下，为配置界面描述一条引用。
   * @param ref - 要描述的引用。
   * @returns 配置状态、提供来源，以及可写性。
   */
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>

  /**
   * 将某个值持久存储到提供方管理的可写来源中。存储的值优先于环境回退，且空值
   * 会被拒绝（请使用 {@link unset}）。
   * @param ref - 要存储的引用。
   * @param value - 非空的秘密值。
   */
  abstract set(ref: CredentialRef, value: string): Promise<void>

  /**
   * 从提供方管理的可写来源中移除一条引用；移除一条不存在的引用是无操作。
   * 环境回退层在移除之后可能重新生效。
   * @param ref - 要移除的引用。
   */
  abstract unset(ref: CredentialRef): Promise<void>

  /**
   * 读取一条已存储记录。该值以其拥有者写入时的原样返回；{@link GrantRecord}
   * 的载荷在取出时不会被解释。
   * @param key - 要读取的记录。
   * @returns 该记录；未存储时为 `undefined`。
   */
  abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>

  /**
   * 在不暴露其值的情况下，为配置界面描述一条记录。
   * @param key - 要描述的记录。
   * @returns 存在性、判别字段，以及可写性。
   */
  abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>

  /**
   * 枚举每条已存储记录的地址与标签。与引用半边不同，后者无需枚举，因为配置界面
   * 从设置模式获悉存在哪些引用；而记录没有这样的发现路径：一个无法列出它们的
   * 界面既不能展示用户被授权了什么，也无法找到由已卸载插件留下的孤儿。
   * @returns 每条已存储记录，不含值。
   */
  abstract listRecords(): Promise<readonly CredentialRecordEntry[]>

  /**
   * 针对单条记录的串行化 读取-修改-写入——唯一的写入路径。
   * `mutate` 在写入独占的那一刻看到记录的当前状态，返回 `undefined` 则保持该条目
   * 不变。在底层存储支持时，独占跨进程成立，这正是令令牌刷新安全的原因：否则
   * 两个进程并发轮转同一个刷新令牌时，先写入的一方会丢失。
   * @param key - 要修改的记录。
   * @param mutate - 接收当前记录并返回其替代项，或返回 `undefined` 以保持不变。
   * @returns 写入后的记录；当 `mutate` 拒绝时为当前记录。
   */
  abstract modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>

  /**
   * 移除一条记录；移除一条不存在的记录是无操作。
   * @param key - 要移除的记录。
   */
  abstract deleteRecord(key: CredentialKey): Promise<void>

  /**
   * 将 `credentials/reference-updated` 扇出，并包容监听器失败：每个监听器都会运行，
   * 同步抛出或异步拒绝都会被记录，而不改变已提交操作的结果。提供方仅在写入或
   * 重新加载确实提交之后才调用此函数，因此一个损坏的观察者绝不可能让一次持久
   * 化变更看起来像是失败。
   * @param ref - 其存储值发生变更的引用。
   */
  protected notifyUpdated(ref: CredentialRef): void {
    this.fanOut('credentials/reference-updated', ref)
  }

  /**
   * 按照 {@link notifyUpdated} 所记载的完全相同的条件，将 `credentials/record-updated`
   * 扇出，用于该 seam 的记录半边。
   * @param key - 其存储值发生变更的记录。
   */
  protected notifyRecordUpdated(key: CredentialKey): void {
    this.fanOut('credentials/record-updated', key)
  }

  /* jscpd:ignore-start -- 与设置 seam 的提交扇出刻意为之的对称性：被包容派发的
     形态是经过审阅的监听器生命周期契约，抽取它会把两个 seam 的事件语义耦合起来。 */
  /** 两个通知都经由的、被包容的派发；见 {@link notifyUpdated}。 */
  private fanOut(event: 'credentials/reference-updated' | 'credentials/record-updated', subject: string): void {
    const args = [event, subject]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(subject)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(event, subject, error)
          })
        }
      } catch (error) {
        this.warnListenerFailure(event, subject, error)
      }
    }
  }
  /* jscpd:ignore-end */

  /** 同步与异步失败路径所共用的、被包容监听器的诊断。 */
  private warnListenerFailure(event: string, subject: string, error: unknown): void {
    this.ctx.logger.warn('credentials: a %s listener for "%s" failed', event, subject)
    this.ctx.logger.warn(error)
  }
}

export default CredentialProvider
