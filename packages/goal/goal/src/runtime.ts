/** goal 领域的运行时构造函数与协议常量。 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GoalId as GoalIdType } from './types.ts'
import type { GoalErrorCode } from './domain.ts'

/** 嵌入在 round-zero 消息来源中的目标变更版本。 */
export const GOAL_CHANGE_VERSION = 1

/**
 * 给字符串打上 goal id 的品牌标记。
 * @param id - 原始目标标识。
 * @returns 带有编译期品牌的同一字符串。
 */
export function GoalId(id: string): GoalIdType {
  return id as GoalIdType
}

/** goal 领域边界返回的错误。 */
export class GoalError extends HarnessError {
  /**
   * @param message - 人类可读的拒绝原因。
   * @param code - 稳定的、可供程序路由的分类码。
   */
  // 保留该构造函数，以便在此边界收窄 HarnessError 的字符串 code。
  // oxlint-disable-next-line typescript/no-useless-constructor -- 仅用于类型收窄
  constructor(message: string, code: GoalErrorCode) {
    super(message, code)
  }
}
