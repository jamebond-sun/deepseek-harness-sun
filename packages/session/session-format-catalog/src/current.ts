/** 在感知词表的格式恢复之后，使用当前已安装的 Session 进行校验。 */

import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { currentSessionMessageProjections } from './message-projections.ts'

/**
 * 通过已安装的 Session 包校验当前逻辑元数据。
 * @param header - 已分离的当前逻辑头部。
 * @returns 校验成功时不返回内容。
 */
export function validateInstalledCurrentSessionHeader(header: SessionFormatHeader): void {
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `installed Session format is v${SESSION_FORMAT_VERSION}, got v${header.version}`,
    )
  }
  Session.fromRestore(
    SessionId(header.id),
    [],
    header as unknown as SessionHeader,
    SessionLogOffset(0),
    'detached',
  )
}

/**
 * 通过已安装的 Session 包校验当前头部、事件信封、消息、表层操作与种子切点。
 * @param artifact - 已完成词表恢复的当前逻辑制品。
 * @returns 校验成功时不返回内容。
 */
export function validateInstalledCurrentSessionArtifact(artifact: SessionFormatArtifact): void {
  if (artifact.header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `installed Session format is v${SESSION_FORMAT_VERSION}, got v${artifact.header.version}`,
    )
  }
  Session.fromRestore(
    SessionId(artifact.header.id),
    artifact.events as SessionEvent[],
    artifact.header as unknown as SessionHeader,
    SessionLogOffset(artifact.inheritedEventCount),
    'detached',
    currentSessionMessageProjections,
  )
}
