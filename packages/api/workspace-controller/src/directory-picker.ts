/**
 * Host 目录选择 Remote 属主：`ctx.directoryPicker` 接缝之上的
 * 能力门控、取消，以及稳定的 wire 失败词汇。
 */

import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryPickerCapabilities, DirectoryPickerErrorCode,
} from '@deepseek-ai/dsh-host-directory-picker'
// 该接缝拥有列表声明；生成器要求引用处指向那个包，
// 而不是本包对它的重新导出。
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'

const createDirectoryRequestSchema = z.object({
  path: z.string(),
  name: z.string(),
}).refine(
  request => request.name.trim() !== '' && request.name !== '.' && request.name !== '..'
    && !/[/\\]/.test(request.name),
  { message: 'host.createDirectory requires a single non-blank path segment name' },
)

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host 目录选择 Remote 命名空间属主。 */
    directoryPickerController: DirectoryPickerController
  }
}

/**
 * 支撑生成的 `ctx.remote.directoryPicker` 命名空间的 Host 服务。其导出的
 * 接缝是抽象的，因此从不是独立的 Loader 入口，所以该控制器承载
 * wire 动词：一个组合后端要么服务原生选择器，要么服务浏览原语，
 * 组合无法服务的动词会被拒绝而非近似替代。
 */
export class DirectoryPickerController extends TypertRemoteService {
  static inject = ['directoryPicker']

  /** @param ctx - 携带组合目录选择后端的 Host 上下文。 */
  constructor(ctx: Context) {
    super(ctx, 'directoryPickerController', { namespace: 'directoryPicker' })
  }

  /**
   * 打开宿主机的 OS 选择器，供 Remote 调用方使用。
   * @param signal - 调用方生命周期；中止会终止选择器。
   * @returns 所选绝对路径，操作者取消时为 null。
   */
  @Remote('pick')
  async pick(signal: AbortSignal): Promise<string | null> {
    const capability = this.requireCapability('native', 'pick')
    try {
      return await capability.pick(signal)
    } catch (error: unknown) {
      throw cancellableFailure(error, signal, 'directory picker was aborted', 'directory picker failed')
    }
  }

  /**
   * 为 Remote 调用方的应用内浏览器列出一个目录层级。
   * @param path - 要列出的绝对目录；缺省时列出主目录。
   * @param signal - 调用方生命周期；中止会停止后端的扫描，
   *   而不是让它活得比已断开的调用方更久。
   * @returns 该层级的列表及其祖先链。
   */
  @Remote('list')
  async list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing> {
    const capability = this.requireCapability('browse', 'list')
    try {
      return await capability.list(path, signal)
    } catch (error: unknown) {
      throw cancellableFailure(error, signal, 'directory listing was aborted')
    }
  }

  /**
   * 为 Remote 调用方的应用内浏览器创建一个子目录。
   * @param path - 存在的绝对父目录。
   * @param name - 单个非空路径段。
   * @returns 所创建目录的绝对路径。
   */
  @Remote('createDirectory')
  async createDirectory(path: string, name: string): Promise<string> {
    const request = createDirectoryRequestSchema.safeParse({ path, name })
    if (!request.success) {
      throw new RemoteError(
        'gateway/bad-request',
        'invalid payload for host.createDirectory',
        { issues: request.error.issues },
      )
    }
    const capability = this.requireCapability('browse', 'createDirectory')
    try {
      return await capability.createDirectory(request.data.path, request.data.name)
    } catch (error: unknown) {
      throw browseFailure(error)
    }
  }

  /** 解析一个 wire 动词所需的能力，否则以本后端服务的种类拒绝。 */
  private requireCapability<Kind extends keyof DirectoryPickerCapabilities>(
    kind: Kind,
    method: string,
  ): DirectoryPickerCapabilities[Kind] {
    const capability = this.ctx.directoryPicker.capability()
    if (capability.kind !== kind) {
      throw new RemoteError(
        'directory-picker/unavailable',
        `directoryPicker.${method} needs the ${kind} capability; the composed picker serves "${capability.kind}"`,
        { capability: capability.kind },
      )
    }
    return capability as DirectoryPickerCapabilities[Kind]
  }
}

/**
 * 每种接缝浏览失败所应答的 wire code。接缝的封闭 code 是其自身的
 * 本地词汇，因此由本控制器负责投影到 Remote 调用方用以区分的
 * `directory-picker/*` code。
 */
const BROWSE_FAILURE_CODES = {
  'directory-unreadable': 'directory-picker/unreadable',
  'directory-exists': 'directory-picker/exists',
  'directory-create-failed': 'directory-picker/create-failed',
} as const satisfies Record<DirectoryPickerErrorCode, RemoteErrorCode>

/**
 * 对浏览原语的拒绝分类：接缝自身的封闭 code 携带其所指的路径，
 * 其余一切保持为基础设施失败。
 * @param error - 原语的拒绝。
 * @returns 跨 Remote 边界抛出的失败。
 */
function browseFailure(error: unknown): RemoteError {
  if (error instanceof DirectoryPickerError) {
    return new RemoteError(
      BROWSE_FAILURE_CODES[error.code],
      error.message,
      { path: error.path },
      { cause: error },
    )
  }
  return new RemoteError('gateway/internal', errorMessage(error), {}, { cause: error })
}

/**
 * 对可取消原语的拒绝分类。中止是调用方自己的超时或断开，
 * 不是后端失败，因此在业务分类运行之前以 `gateway/cancelled` 应答。
 * @param error - 原语的拒绝。
 * @param signal - 原语运行所处的调用方生命周期。
 * @param cancelled - 面向操作者的中止结果文案。
 * @param failed - 非接缝失败的前缀，用于没有封闭 code 的动词。
 * @returns 跨 Remote 边界抛出的失败。
 */
function cancellableFailure(
  error: unknown,
  signal: AbortSignal,
  cancelled: string,
  failed?: string,
): RemoteError {
  if (signal.aborted) return new RemoteError('gateway/cancelled', cancelled, {}, { cause: error })
  if (failed === undefined) return browseFailure(error)
  return new RemoteError('gateway/internal', `${failed}: ${errorMessage(error)}`, {}, { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
