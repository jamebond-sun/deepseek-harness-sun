import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '../codec.ts'

/**
 * 通过原生编解码器校验制品，不做感知词表的恢复。
 * @param artifact - 待编码与解码的当前代际制品。
 */
export function assertReleasedV4Artifact(artifact: SessionFormatArtifact): void {
  const codec = releasedV4SessionFormatCodec
  const decoder = codec.createDecoder(codec.encodeHeader(artifact.header, artifact.inheritedEventCount), 'strict')
  const output = new SessionFormatEventCollector()
  for (const event of artifact.events) decoder.decodeRow(codec.encodeEvent(event), output)
  decoder.finish(output)
}
