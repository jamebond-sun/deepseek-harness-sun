/** 经过鉴权、且能感知取消的、面向 Client 的语音能力访问。 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechPreparationOptions, SpeechProviderId, SpeechSelectionPatch, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { SpeechCatalog, TranscriptionRequest } from './types.ts'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 实验性的语音 Remote 控制器。 */
    speechController: SpeechController
  }
}

/** 在解码或调用提供方之前应用的限制。 */
export interface Config {
  /** 每个请求解码后 WAV 的最大字节数。 */
  maxAudioBytes: number
  /** PCM 录音时长的最大秒数。 */
  maxDurationSeconds: number
}

/** Speech calls never activate or submit to an Agent. */
export default class SpeechController extends TypertRemoteService {
  static inject = ['speechToText', 'typert']
  static Config: z<Config> = z.object({
    maxAudioBytes: z.natural().min(46).default(4 * 1024 * 1024),
    maxDurationSeconds: z.number().min(1).default(120),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'speechController', { namespace: 'speech' })
  }

  /**
   * 在不准备识别器的前提下读取提供方选项。
   * @returns 可用的提供方、已解析的默认值，以及录音限制。
   */
  @Remote
  catalog(): SpeechCatalog {
    return { ...this.ctx.speechToText.snapshot(), ...this.config }
  }

  /**
   * 独立于 Session 与准备生命周期地跟踪提供方就绪状态。
   * @param signal - Client 观察的生命周期。
   * @returns 初始及后续完整的就绪快照。
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<SpeechCatalog> {
    for await (const snapshot of this.ctx.speechToText.follow(signal)) yield { ...snapshot, ...this.config }
  }

  /**
   * 持久化用户的识别偏好。
   * @param patch - 已变更的偏好字段。
   * @returns 在偏好被保存之后。
   */
  @Remote
  configure(patch: SpeechSelectionPatch): Promise<void> { return this.ctx.speechToText.configure(patch) }

  /**
   * 启动或加入一个由 Host 拥有的准备任务。
   * @param providerId - 选定的识别器。
   * @param options - 由提供方校验的、任务局部的源选择。
   */
  @Remote
  prepare(providerId: SpeechProviderId, options?: SpeechPreparationOptions): void { this.ctx.speechToText.prepare(providerId, options) }

  /**
   * 显式取消资源准备。
   * @param providerId - 选定的识别器。
   * @returns 在准备任务结算之后。
   */
  @Remote
  cancelPreparation(providerId: SpeechProviderId): Promise<void> { return this.ctx.speechToText.cancelPreparation(providerId) }

  /**
   * 通过显式的提供方选择，校验并转写一段录音。
   * @param request - 以 base64 编码的规范 WAV、提供方 id 以及语言提示。
   * @param signal - Client 取消信号，或 Remote 贡献的销毁信号。
   * @returns 最终的转写结果，且不新增任何 Session 事件。
   */
  @Remote
  async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted()
    const encoded = request.audioBase64
    if (encoded.length > Math.ceil(this.config.maxAudioBytes / 3) * 4) {
      throw new RemoteError('speech/invalid-audio', 'Audio is invalid or exceeds the configured byte limit', { reason: 'encoding-or-size' })
    }
    const audio = Buffer.from(encoded, 'base64')
    try {
      if (audio.toString('base64') !== encoded) throw new Error('Audio must use canonical base64 encoding')
      if (audio.length > this.config.maxAudioBytes) throw new Error('Audio exceeds the configured byte limit')
      validateWave(audio, this.config.maxDurationSeconds)
      const spec = this.ctx.speechToText.resolve({ audio,
        ...request.providerId === undefined ? {} : { providerId: request.providerId },
        ...request.language === undefined ? {} : { language: request.language },
      })
      return await this.ctx.speechToText.transcribe(spec, signal)
    } catch (error) {
      signal.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('speech/transcription-failed', reason, { reason })
    }
  }
}
