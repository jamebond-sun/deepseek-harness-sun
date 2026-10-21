/**
 * 供度量使用的按位置定价：每个保留下来的节点都保存自己的身份、启发式价格，
 * 以及路由定价会替换掉的附件细节。占用量与上下文分解投影则改用
 * 标量的影子价格协议。
 *
 * 该折叠是一对 plan/commit：{@link planSurfaceTokens} 以只读方式执行每个
 * 可能失败的步骤，而 {@link commitSurfaceTokens} 原地修改，因此一次抛出
 * 不会触及调用方的状态，而同一个格式错误的事件在每次重试时都会同样失败。
 * 各个节点还携带持久化的附件出现及其结构性价格，因此 `measure()`
 * 可以对发送给模型的请求表示定价。
 *
 * @module @deepseek-ai/dsh-token-meter/surface-fold
 */

import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SessionSeq, SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import { estimateMessage, estimateStructuralBlock } from './estimate.ts'

type FileAttachmentRef = Extract<ContentBlock, { type: 'file' }>['attachment']

/** 一个已计价的表面节点，以及路由定价会替换掉的图像出现。 */
export interface MeterSurfaceNode {
  /** 该表面事件的持久化序号。 */
  readonly seq: SessionSeq
  /** 该节点那条精确消息的固定启发式价格。 */
  readonly heuristicTokens: number
  /** 当被路由的请求投影图像时被替换掉的结构性 JSON 价格。 */
  readonly imageStructuralTokens: number
  /** 当请求装配把文件投影为文本时被替换掉的结构性 JSON 价格。 */
  readonly fileStructuralTokens: number
  /** 按消息顺序排列的持久化图像块，包含 `offloaded` 标记；无图像节点为空。 */
  readonly images: readonly ImageBlock[]
  /** 按消息顺序排列的持久化文件出现；无文件节点为空。 */
  readonly files: readonly FileAttachmentRef[]
}

/** 一个已校验、但尚未修改已计价表面的表面迁移。 */
export interface SurfaceTokenPlan<Node = MeterSurfaceNode> {
  /** 该事件自身消息的启发式价格；当它没有派生出消息时为 0。 */
  readonly tokens: number
  /** 表面总量的带符号变化：`tokens` 减去被遮蔽的部分。 */
  readonly deltaTokens: number
  /** 提交时为该事件插入的已计价节点。 */
  readonly node: Node
  /** 提交位置：`append`，或被替换的闭区间索引范围。 */
  readonly target: 'append' | { readonly startIdx: number; readonly endIdx: number }
}

/** 收集被投影的附件出现及其结构性价格。 */
function collectProjectedAttachments(
  blocks: readonly ContentBlock[],
  images: ImageBlock[],
  files: FileAttachmentRef[],
): { readonly imageTokens: number; readonly fileTokens: number } {
  let imageTokens = 0
  let fileTokens = 0
  for (const block of blocks) {
    if (block.type === 'image') {
      images.push(block)
      imageTokens += estimateStructuralBlock(block)
    } else if (block.type === 'file') {
      files.push(block.attachment)
      fileTokens += estimateStructuralBlock(block)
    }
  }
  return { imageTokens, fileTokens }
}

/** 从一个表面事件派生出的消息构建一个已计价节点。 */
function analyzeNode(seq: SessionSeq, message: Message | null): MeterSurfaceNode {
  if (message === null) {
    return {
      seq,
      heuristicTokens: 0,
      imageStructuralTokens: 0,
      fileStructuralTokens: 0,
      images: [],
      files: [],
    }
  }
  const heuristicTokens = estimateMessage(message)
  const images: ImageBlock[] = []
  const files: FileAttachmentRef[] = []
  const structural = collectProjectedAttachments(message.content, images, files)
  return {
    seq,
    heuristicTokens,
    imageStructuralTokens: structural.imageTokens,
    fileStructuralTokens: structural.fileTokens,
    images,
    files,
  }
}

/**
 * 校验并计价一个表面事件，且不修改表面。
 * @param nodes - 该事件之前的已计价表面，按模型可见顺序排列。
 * @param event - 要放置的表面事件。
 * @returns 供 {@link commitSurfaceTokens} 使用的计划。
 * @throws 当一次替换指名了 `nodes` 中不存在的区间时——已提交的日志
 *   在追加时就做过表面校验，因此无法解析的区间就是日志损坏，
 *   必须立即失败而不是跳过该事件。
 */
export function planSurfaceTokens(
  nodes: readonly Pick<MeterSurfaceNode, 'seq' | 'heuristicTokens'>[],
  event: SurfaceEvent,
): SurfaceTokenPlan {
  const node = analyzeNode(event.seq, deriveEventMessage(event))
  const tokens = node.heuristicTokens
  const op = event.surfaceOp
  if (op === 'append') {
    return { tokens, deltaTokens: tokens, node, target: 'append' }
  }
  const startIdx = nodes.findIndex(candidate => candidate.seq === op.startSeq)
  const endIdx = nodes.findIndex(candidate => candidate.seq === op.endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(
      `token surface: replace at seq ${event.seq} has invalid current range ${op.startSeq}-${op.endSeq}`,
    )
  }
  const removed = nodes
    .slice(startIdx, endIdx + 1)
    .reduce((total, candidate) => total + candidate.heuristicTokens, 0)
  return { tokens, deltaTokens: tokens - removed, node, target: { startIdx, endIdx } }
}

/**
 * 把一个已校验的计划原地应用到已计价表面；不会失败，因此不会留下
 * 应用了一半的表面。
 * @param nodes - 该计划所针对的、精确的已计价表面。
 * @param plan - 由 {@link planSurfaceTokens} 返回的迁移。
 */
export function commitSurfaceTokens<Node>(nodes: Node[], plan: SurfaceTokenPlan<Node>): void {
  if (plan.target === 'append') {
    nodes.push(plan.node)
    return
  }
  nodes.splice(plan.target.startIdx, plan.target.endIdx - plan.target.startIdx + 1, plan.node)
}
