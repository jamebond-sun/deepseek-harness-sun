/** 由各个进程提供方共享的有界输出尾部与私有溢出文件。 */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CollectedOutput } from '@deepseek-ai/dsh-subprocess'

/**
 * 接收一次溢出失败，以便所有者通过其自身日志器记录它。
 * 每个收集器最多调用一次，在溢出已被丢弃、且内存尾部继续收集之后。
 * 抛出异常的记录器会被隔离，其失败被写入 stderr。
 * @param error - 来自 `node:fs`、因打开或追加溢出文件而产生的失败。
 * @param label - 失败收集器的流标签。
 */
export type SpillFailureReporter = (error: unknown, label: string) => void

/** 一条收集流的溢出存储；`undefined` 表示仅尾部收集。 */
export interface SpillOptions {
  /** 整流产字节上限；超过后不完整的溢出会被丢弃。 */
  maxBytes: number
  /** 接收溢出文件的私有目录。 */
  dir: string
  /** 所有者一侧对溢出打开或写入失败的记录。 */
  onFailure: SpillFailureReporter
}

let spillCounter = 0
let defaultSpillDir: string | undefined

/**
 * 默认溢出位置：位于操作系统 tmpdir 之下、每个进程一个的私有（0700）目录，惰性创建。
 * 可预测的全局可读路径会让其他本地用户读到命令输出，或预先创建符号链接。该目录每个
 * 进程只创建一次且不再重建：当某个外部临时文件清理器在其为空时将其移除，下一次溢出
 * 打开会失败，收集器退化为仅保留内存尾部。在 JavaScript 可观察的进程退出时，该目录
 * 仅在不持有任何已完成的溢出文件时才被移除（溢出文件作为完整输出恢复产物保留，直到
 * 外部清理为止）。
 */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))
  return defaultSpillDir
}

// 每个进程的溢出目录在进程退出时被移除，前提是它不持有任何已完成的溢出文件：从未
// 溢出的目录为空、可安全移除；而持有已完成溢出文件的目录会保留它们（其内容保留到
// 外部清理为止）。被 SIGKILL 的进程根本无法运行此逻辑；其残留交由操作系统的临时目录
// 卫生机制处理。
/* v8 ignore next 4 -- exit listeners run after the coverage dump; removal is verified by the CI /tmp residue measurement. */
process.once('exit', () => {
  if (defaultSpillDir === undefined) return
  try { rmdirSync(defaultSpillDir) } catch { /* best-effort: ENOENT/ENOTEMPTY/EBUSY/EPERM must not change the exit code. */ }
})

/**
 * The stderr reporter used when no owner supplies one: a bare
 * {@link prepareManagedProcessBinding} caller has no plugin logger, and the
 * failure must still reach the process diagnostics.
 * @param error - the spill failure.
 * @param label - the failed stream label.
 */
function reportSpillFailureToStderr(error: unknown, label: string): void {
  process.stderr.write(`dsh-subprocess-local: ${label} spill failed; only the in-memory tail is retained: ${String(error)}\n`)
}

/**
 * 构建所有者作为 {@link SpillOptions.onFailure} 传入的记录器：一行错误级日志，
 * 点名所有者与流，并附加上失败信息，从而将其 `code`、`syscall` 与 `path` 送达日志。
 * @param logger - 所有者的插件日志器。
 * @param owner - 行中所点名的组件。
 * @returns 该记录器。
 */
export function logSpillFailure(logger: { error(message: string, ...detail: unknown[]): void }, owner: string): SpillFailureReporter {
  return (error, label) => {
    const removedDirectory = (error as NodeJS.ErrnoException).code === 'ENOENT'
    logger.error(
      `${owner} could not write the complete ${label} stream to its spill file; the result keeps only the in-memory tail and reports no full-output path.`
      + (removedDirectory ? ' The spill directory no longer exists; a temporary-file cleaner removing it while empty is the usual cause.' : ''),
      error,
    )
  }
}

/** Inputs a managed native process needs before its output streams are bound. */
export interface ManagedProcessBinding {
  /** 接收溢出文件的目录。 */
  spillDir: string
  /** 接收溢出打开或写入失败。 */
  onSpillFailure: SpillFailureReporter
}

/**
 * 在启动受管原生进程之前，准备好可能失败的输出存储。
 * 这是溢出输入的显式 resolve 步骤：溢出目录默认取每个进程私有的目录，
 * 而失败记录器在调用方没有日志器时默认为一行 stderr 输出。
 * @param internals - 可选的、由调用方拥有的溢出目录与失败记录器。
 * @returns 溢出目录已就绪的绑定输入。
 */
export function prepareManagedProcessBinding(
  internals: { spillDir?: string; onSpillFailure?: SpillFailureReporter } = {},
): ManagedProcessBinding {
  return {
    spillDir: internals.spillDir ?? privateSpillDir(),
    onSpillFailure: internals.onSpillFailure ?? reportSpillFailureToStderr,
  }
}


/**
 * 以有界内存尾部收集一条流。若提供溢出选项，则在首次溢出时创建溢出文件，并将每个
 * 分块（包括已收集的那些）追加其中，只要整条流仍在上限之内；若不提供，则只保留
 * 内存尾部（诊断尾部形态——即语言服务器的 stderr）。
 *
 * 溢出是尽力而为的：溢出打开或写入失败会丢弃溢出、通过 {@link SpillOptions.onFailure}
 * 报告一次，且从不打断内存收集，因为 `push()` 运行在流的 `'data'` 监听器内部，而在
 * 那里抛出的错误会变成未捕获异常。
 *
 * 保留尾部的理由（pi/OpenCode）：错误与最终结果聚集在命令输出的末尾；溢出文件覆盖头部。
 */
export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean
  /** 累计推送的字节总数（不止是保留下来的）。 */
  private total = 0

  /**
   * @param maxBytes - 内存尾部的字节上限。
   * @param label - 用于溢出文件名与失败报告的流标签。
   * @param spill - 溢出存储；省略则仅做尾部收集。
   */
  constructor(
    private readonly maxBytes: number,
    private readonly label: string,
    private readonly spill: SpillOptions | undefined,
  ) {
    this.spillDisabled = spill === undefined
  }

  /**
   * 摄入一个流分块，并将其计入整流产总量。在内存上限首次被突破时（若启用了溢出）
   * 打开溢出文件，此后每个分块（含已收集的）都追加其中；内存尾部随后从头部丢弃
   * 整个分块（或单个超限分块的头部），直到重新符合上限。
   * @param chunk - 来自某次流 'data' 事件的原始字节。
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    const spill = this.spill
    if (spill !== undefined && !this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(spill, chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        // 丢弃整个头部分块（超限时长度 ≥ 1 必然成立）。
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        // 裁剪头部，使保留窗口在到达上限时与字节精确对齐——诊断尾部（语言服务器的
        // stderr）无论流如何分块，都必须保留最后的 maxBytes。
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /**
   * 惰性打开溢出文件并追加 `chunk`（以及一次性的此前各分块）。
   * 运行在流的 `'data'` 监听器内部，因此每一次文件系统失败都在这里被隔离：溢出被丢弃、
   * 报告一次，收集则仅凭内存尾部继续。
   */
  private spillAll(spill: SpillOptions, chunk: Buffer): void {
    if (this.total > spill.maxBytes) {
      this.discardSpill()
      return
    }
    try {
      if (this.spillFd === undefined) {
        // 随机后缀 + O_EXCL + 等价于不跟随链接（'wx' 在任何已存在路径上都会失败，
        // 无论是否为符号链接）+ 仅属主模式：挫败共享临时目录中的溢出路径预测与符号
        // 链接植入。路径只在打开成功后才公开，因此一次失败的打开（包括在被植入条目上
        // 的 EEXIST）绝不会让 discardSpill 删除本进程未创建的路径。
        const file = join(
          spill.dir,
          `dsh-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
        )
        const fd = openSync(file, 'wx', 0o600)
        this.spillFile = file
        this.spillFd = fd
        for (const prior of this.chunks) writeSync(fd, prior)
      }
      writeSync(this.spillFd, chunk)
    } catch (error) {
      // ENOENT（溢出目录被临时清理器移除）、EACCES/EPERM、EMFILE 或 ENOSPC：溢出文件
      // 只是恢复辅助手段，而非收集的前提条件。
      this.discardSpill()
      try {
        spill.onFailure(error, this.label)
      } catch (reporterFailure) {
        // 记录器同样运行在流监听器内部；一个失败的日志器绝不能变成本路径旨在
        // 防止的那个未捕获异常。
        process.stderr.write(`dsh-subprocess-local: spill failure reporter threw: ${String(reporterFailure)}\n`)
      }
    }
  }

  /** 在文件不再能容纳完整流时，停止溢出并移除该文件。 */
  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Retain the descriptor so finalize can retry the failed close.
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // 一次失败的 unlink 至多留下 maxSpillBytes，绝不会留下无界文件。
      }
    }
  }

  /**
   * 以整流产字节坐标为单位的增量读取：返回自 `fromByte` 以来推送的所有内容。当
   * `fromByte` 已滑出内存尾部窗口时，该读取为 `lossy`——它返回完整保留的尾部，
   * 缺口只能从溢出文件恢复。
   * @param fromByte - 续传的整流产偏移（上一次读取的 `nextOffset`；首次读取为 0）。
   * @returns 增量文本、下一次读取的偏移、`lossy` 标志，以及（若存在）溢出文件路径。
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }

  /**
   * 复制保留下来的原始尾部，及其在完整被观察流中的位置。
   * @returns 独立的尾部字节，以及截断前的字节总数。
   */
  snapshot(): { bytes: Buffer; totalBytes: number } {
    return { bytes: Buffer.concat(this.chunks), totalBytes: this.total }
  }

  /**
   * 在流结束之后关闭溢出文件。一次失败的关闭（延迟写回故障）会停止公开溢出路径——
   * 文件可能缺失其尾部——而所有内存读取仍可正常工作。幂等；spawn 路径在结算时封存
   * 两个收集器，因此退出之后的读取绝不会指向一个仍打开的文件。
   */
  seal(): void {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      // 延迟的写回失败使溢出不可靠；保留内存结果，但停止公开该文件。
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }

  /**
   * 封存溢出文件并返回最终输出。
   * @returns 最终收集输出：尾部文本、截断标志，以及（当完好时）溢出路径。
   */
  finalize(): CollectedOutput {
    this.seal()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }
}
