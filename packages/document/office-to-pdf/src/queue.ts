/** 有界的源接纳、共享的内容转换，以及调用方拥有的 PDF 交付。 */
import { createHash } from 'node:crypto'
import { OfficeToPdfError } from './errors.ts'
import { OfficeToPdfKey, type OfficeToPdfGeneration } from './identity.ts'
import type { OfficeExtension, OfficeToPdfRequest, OfficeToPdfResult } from './types.ts'
import type { Config } from './index.ts'

type Converted = Pick<OfficeToPdfResult, 'pdf' | 'missingFonts'>
type Convert = (bytes: Uint8Array, extension: OfficeExtension, signal: AbortSignal) => Promise<Converted>
interface Reader {
  job: Job
  readonly source: string
  readonly priority: OfficeToPdfRequest['priority']
  readonly resolve: (value: OfficeToPdfResult) => void
  readonly reject: (error: unknown) => void
  readonly cleanup: () => void
}
interface Job {
  readonly request: OfficeToPdfRequest
  readonly controller: AbortController
  readonly readers: Set<Reader>
  readonly sources: Set<string>
  priority: OfficeToPdfRequest['priority']
  state: 'queued' | 'running' | 'finished'
}

/** 一个转换器生成拥有每个已排队的源、转换、读取器与保留的 PDF。 */
export class ConversionQueue {
  private readonly ready = new Map<OfficeToPdfKey, OfficeToPdfResult>()
  private readonly aliases = new Map<string, OfficeToPdfKey>()
  private readonly sources = new Map<string, Job>()
  private readonly digests = new Map<OfficeToPdfKey, Job>()
  private readonly queue: Job[] = []
  private readonly tasks = new Set<Promise<void>>()
  private readonly jobs = new Set<Job>()
  private cachedBytes = 0
  private sourceBytes = 0
  private running = 0
  private background = 0
  private readers = 0
  private disposed = false

  /**
   * @param config - 已校验的队列、源、读取器与已完成结果的上限。
   * @param generation - 提供方生命周期；在引擎或字体替换之后防止复用。
   * @param convert - 执行一次已接纳的转换，并在临时清理之后落定。
   */
  constructor(private readonly config: Config, private readonly generation: OfficeToPdfGeneration,
    private readonly convert: Convert) {}

  /**
   * 在加载源字节之前接纳元数据，并在经授权的读取器之间共享转换。
   * @param request - 已授权的元数据与延迟的有界源读取。
   * @param signal - 此读取器的取消；最后一个读取器取消共享工作。
   * @returns 独立的 PDF 字节；忙碌或已取消的读取器会拒绝，而不提前释放活跃引擎容量。
   */
  async read(request: OfficeToPdfRequest, signal?: AbortSignal): Promise<OfficeToPdfResult> {
    signal?.throwIfAborted()
    if (this.disposed) throw this.unavailable()
    if (request.source.bytes !== undefined && request.source.bytes > this.config.maxInputBytes) {
      throw new OfficeToPdfError('input-too-large', 'The Office source exceeds maxInputBytes.')
    }
    const source = JSON.stringify([request.source.key, request.source.version, request.extension])
    const alias = this.aliases.get(source)
    const cached = alias === undefined ? undefined : this.ready.get(alias)
    if (cached !== undefined) {
      this.ready.delete(cached.cacheKey)
      this.ready.set(cached.cacheKey, cached)
      this.aliases.delete(source)
      this.aliases.set(source, cached.cacheKey)
      return this.copy(cached)
    }
    const readerLimit = request.priority === 'background' ? this.config.maxReaders - 1 : this.config.maxReaders
    if (this.readers >= readerLimit) throw this.busy()
    if (request.priority === 'background' && this.config.maxBackgroundConversions === 0) throw this.busy()
    let job = this.sources.get(source)
    if (job === undefined) {
      if (this.queue.length >= this.config.maxQueuedJobs) {
        const obsolete = request.priority === 'foreground' ? this.queue.find(item => item.priority === 'background') : undefined
        if (obsolete === undefined) throw this.busy()
        this.fail(obsolete, this.busy())
      }
      job = { request, priority: request.priority, controller: new AbortController(), readers: new Set(), sources: new Set([source]), state: 'queued' }
      this.sources.set(source, job)
      this.jobs.add(job)
      this.queue.push(job)
    }
    const shared = job
    if (request.priority === 'foreground') shared.priority = 'foreground'
    this.readers++
    const promise = new Promise<OfficeToPdfResult>((resolve, reject) => {
      const abort = (): void => {
        this.release(reader)
        const reason: unknown = signal?.reason
        reject(reason instanceof Error ? reason : new Error('Office conversion cancelled', { cause: reason }))
        if (reader.job.readers.size === 0) this.cancel(reader.job)
        // 取消或降级可以解除排队中的后台工作的阻塞。
        this.drain()
      }
      const reader: Reader = { job: shared, source, priority: request.priority, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) }
      shared.readers.add(reader)
      signal?.addEventListener('abort', abort, { once: true })
    })
    this.drain()
    return promise
  }

  /** 取消所有读取器，并等待实际读取、转换与临时清理完成。 */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const job of this.jobs) this.fail(job, this.unavailable())
    this.ready.clear()
    this.aliases.clear()
    this.cachedBytes = 0
    await Promise.allSettled(this.tasks)
  }

  private busy(): OfficeToPdfError { return new OfficeToPdfError('busy', 'The document converter has reached its admission limit.') }
  private unavailable(): OfficeToPdfError { return new OfficeToPdfError('unavailable', 'The document converter is unavailable.') }
  private copy(result: OfficeToPdfResult): OfficeToPdfResult {
    return { ...result, pdf: Uint8Array.from(result.pdf), missingFonts: [...result.missingFonts] }
  }
  private release(reader: Reader): void {
    reader.job.readers.delete(reader)
    if (reader.job.state === 'queued') {
      reader.job.priority = [...reader.job.readers].some(other => other.priority === 'foreground') ? 'foreground' : 'background'
    }
    if (![...reader.job.readers].some(other => other.source === reader.source)) {
      reader.job.sources.delete(reader.source)
      if (this.sources.get(reader.source) === reader.job) this.sources.delete(reader.source)
    }
    reader.cleanup()
    this.readers--
  }
  private cancel(job: Job): void {
    job.controller.abort()
    if (job.state === 'queued') {
      this.queue.splice(this.queue.indexOf(job), 1)
      job.state = 'finished'
      this.jobs.delete(job)
    }
  }
  private fail(job: Job, error: unknown): void {
    for (const reader of job.readers) { this.release(reader); reader.reject(error) }
    this.cancel(job)
  }
  private reservation(job: Job): number { return Math.max(1, job.request.source.bytes ?? this.config.maxInputBytes) }

  private drain(): void {
    while (!this.disposed && this.running < this.config.maxConcurrentConversions) {
      const eligible = (job: Job): boolean => this.sourceBytes + this.reservation(job) <= this.config.maxSourceBytes
        && (job.priority === 'foreground' || this.background < Math.min(this.config.maxBackgroundConversions, Math.max(1, this.config.maxConcurrentConversions - 1)))
      const foregroundWaiting = this.queue.some(item => item.priority === 'foreground')
      const job = this.queue.find(item => (!foregroundWaiting || item.priority === 'foreground') && eligible(item))
      if (job === undefined) return
      this.queue.splice(this.queue.indexOf(job), 1)
      job.state = 'running'
      const background = job.priority === 'background'
      const reserved = this.reservation(job)
      this.running++
      if (background) this.background++
      this.sourceBytes += reserved
      const task = this.execute(job, reserved).catch((error: unknown) => { this.fail(job, error) }).finally(() => {
        this.running--
        if (background) this.background--
        this.sourceBytes -= reserved
        job.state = 'finished'
        this.jobs.delete(job)
        this.tasks.delete(task)
        this.drain()
      })
      this.tasks.add(task)
    }
  }

  private async execute(job: Job, reserved: number): Promise<void> {
    const signal = job.controller.signal
    signal.throwIfAborted()
    const input = await job.request.source.read(signal, reserved)
    signal.throwIfAborted()
    if (input.version !== job.request.source.version) throw new OfficeToPdfError('source-changed', 'The source changed while waiting for conversion.')
    if (input.bytes.byteLength > reserved) throw new OfficeToPdfError('input-too-large', 'The source exceeds its reserved read capacity.')
    const digest = createHash('sha256').update(job.request.extension).update('\0').update(input.bytes).digest('hex')
    const key = OfficeToPdfKey(`${this.generation}:${digest}`)
    const cached = this.ready.get(key)
    if (cached !== undefined) {
      this.ready.delete(key)
      this.ready.set(key, cached)
      this.finish(job, cached)
      return
    }
    const existing = this.digests.get(key)
    if (existing !== undefined && !existing.controller.signal.aborted) {
      if (job.priority === 'foreground') existing.priority = 'foreground'
      for (const reader of job.readers) { reader.job = existing; existing.readers.add(reader) }
      job.readers.clear()
      for (const source of job.sources) { existing.sources.add(source); this.sources.set(source, existing) }
      job.sources.clear()
      return
    }
    this.digests.set(key, job)
    try {
      const converted = await this.convert(input.bytes, job.request.extension, signal)
      signal.throwIfAborted()
      const result = { ...converted, cacheKey: key, generation: this.generation }
      this.retain(result)
      this.finish(job, result)
    } finally { if (this.digests.get(key) === job) this.digests.delete(key) }
  }

  private finish(job: Job, result: OfficeToPdfResult): void {
    for (const source of job.sources) this.sources.delete(source)
    if (this.ready.has(result.cacheKey)) {
      for (const source of job.sources) {
        this.aliases.delete(source)
        this.aliases.set(source, result.cacheKey)
        while (this.aliases.size > this.config.maxSourceEntries) this.aliases.delete(this.aliases.keys().next().value as string)
      }
    }
    for (const reader of job.readers) { this.release(reader); reader.resolve(this.copy(result)) }
  }
  private retain(result: OfficeToPdfResult): void {
    if (result.pdf.byteLength > this.config.maxCachedBytes) return
    while (this.ready.size >= this.config.maxCachedEntries || this.cachedBytes + result.pdf.byteLength > this.config.maxCachedBytes) {
      const [key, oldest] = this.ready.entries().next().value as [OfficeToPdfKey, OfficeToPdfResult]
      this.ready.delete(key)
      this.cachedBytes -= oldest.pdf.byteLength
      for (const [source, digest] of this.aliases) if (digest === key) this.aliases.delete(source)
    }
    this.ready.set(result.cacheKey, result)
    this.cachedBytes += result.pdf.byteLength
  }
}
