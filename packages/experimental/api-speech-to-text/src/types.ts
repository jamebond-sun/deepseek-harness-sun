/** 实验性语音 Remote 命名空间的、JSON 安全的输入与结果。 */
import type { SpeechProviderId, SpeechSnapshot } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** 音频编码或摄入限制阻止了转写。 */
    'speech/invalid-audio': { readonly reason: string }
    /** 所选的提供方拒绝了转写。 */
    'speech/transcription-failed': { readonly reason: string }
  }
}

/** 为转写而提交的完整录音，与 Session 准入相互独立。 */
export interface TranscriptionRequest {
  readonly audioBase64: string
  readonly providerId?: SpeechProviderId
  readonly language?: string
}

/** 当前的提供方选项与音频摄入限制。 */
export interface SpeechCatalog extends SpeechSnapshot {
  readonly maxAudioBytes: number
  readonly maxDurationSeconds: number
}
