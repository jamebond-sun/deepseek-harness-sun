/**
 * DeepSeek 视觉令牌计量：提供方公开的图像令牌计算器
 * （api-docs.deepseek.com，Token & Token Usage）在其当前 `v41` 配置下的逐行移植。
 * 提供方会把总像素低于 544×544 的图像放大，将其对齐到 14px 的 patch 网格，
 * 每个轴按 3:1 降采样为令牌单元，并通过在该预算内求解保持长宽比的最大网格，
 * 把单张图像限制在 1024 个令牌以内。该计数是精确的：这一配置既没有对齐填充，
 * 也没有长宽比钳制。实际用量仍然是权威值。
 *
 * @module dsh-llm-deepseek/image-tokens
 */

import { longEdgeDimensions } from '@deepseek-ai/dsh-attachment'
import type { ProjectedDimensions } from '@deepseek-ai/dsh-attachment'
/** 视觉 patch 的像素边长。 */
const PATCH_SIZE = 14
/** 每个轴上 patch 到令牌的降采样比例。 */
const DOWNSAMPLE_RATIO = 3
/** 提供方对一张请求图像的令牌上限。 */
const MAX_IMAGE_TOKENS = 1024
/** 总像素下限；更小的图像会在网格投影之前被放大。 */
const MIN_PIXELS = 544 * 544
/** 任一轴上一个令牌单元所覆盖的像素数。 */
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor)
const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor)

interface GridResize {
  readonly gridHeight: number
  readonly gridWidth: number
  readonly bestHeight: number
  readonly bestWidth: number
  readonly numTokens: number
}

/** 一个网格的令牌数：每行带一个分隔符，再加上两个框架令牌。 */
function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2
}

/** 一条已填充像素轴上的令牌单元数。 */
function gridCells(paddedLength: number): number {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO)
}

/** 在 `budget` 个令牌内求解保持长宽比的最大网格。 */
function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5
  const idealGridHeight = idealGridWidth * aspect
  let bestHeight: number
  let bestWidth: number
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1
    const solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1)
    bestWidth = solvedGridWidth * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1
    const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1
    bestWidth = solvedGridWidth * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth)
    const solvedGridHeight = Math.trunc(idealGridHeight)
    const scale = Math.min(solvedGridWidth * CELL_SIZE / width, solvedGridHeight * CELL_SIZE / height)
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const gridHeight = gridCells(bestHeight)
  const gridWidth = gridCells(bestWidth)
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) }
}

/** 把已填充的像素尺寸投影到预算内最大的令牌网格上。 */
function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): GridResize {
  const gridHeight = gridCells(paddedHeight)
  const gridWidth = gridCells(paddedWidth)
  const direct: GridResize = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  }
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS)
  /* v8 ignore next 3 -- 公开求解器的断言；对任意正的几何形状，
     闭式解都保持在预算之内。 */
  if (solved.numTokens > MAX_IMAGE_TOKENS) {
    throw new Error(`deepseek image tokens: no grid fits the token budget for ${width}x${height}`)
  }
  return solved
}

/** 一次缩放-填充-投影过程；调用方会迭代它直到不动点。 */
function resizeOnce(width: number, height: number): GridResize {
  let scaledWidth = width
  let scaledHeight = height
  const pixels = scaledWidth * scaledHeight
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    scaledWidth = Math.trunc(scaledWidth * scale)
    scaledHeight = Math.trunc(scaledHeight * scale)
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE
  return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth)
}

function sameResize(a: GridResize, b: GridResize): boolean {
  return a.gridHeight === b.gridHeight
    && a.gridWidth === b.gridWidth
    && a.bestHeight === b.bestHeight
    && a.bestWidth === b.bestWidth
    && a.numTokens === b.numTokens
}

/**
 * harness 为了让提供方保留整张图像而发送的尺寸：当源图像的 patch 填充网格
 * 不超过令牌上限时就是源尺寸本身，否则取源长宽比在已求解网格长边上的尺寸。
 * 提供方会在自己一侧把短边填充为完整的 patch。对保持长宽比的短边取整，
 * 可能使令牌数不同于源图像已求解的网格；请求定价使用实际发送的尺寸。
 * 小图像永远不会被放大。
 * @param width - 源图像宽度的正整数像素值。
 * @param height - 源图像高度的正整数像素值。
 * @returns 要编码的请求尺寸。
 */
export function deepSeekRequestImageDimensions(width: number, height: number): ProjectedDimensions {
  const paddedWidth = ceilDiv(width, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(height, PATCH_SIZE) * PATCH_SIZE
  if (gridTokens(gridCells(paddedHeight), gridCells(paddedWidth)) <= MAX_IMAGE_TOKENS) return { width, height }
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS)
  return longEdgeDimensions(width, height, width >= height ? solved.bestWidth : solved.bestHeight)
}

/**
 * DeepSeek 对给定尺寸的一张请求图像所收取的视觉令牌数。
 * @param width - 请求图像宽度的正整数像素值。
 * @param height - 请求图像高度的正整数像素值。
 * @returns 提供方的视觉令牌计价，至多 1024。
 */
export function deepSeekImageTokens(width: number, height: number): number {
  let result = resizeOnce(width, height)
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight)
    if (sameResize(next, result)) return result.numTokens
    result = next
  }
  /* v8 ignore next 2 -- 公开求解器的不收敛保护；每一轮都是一次投影，
     因此连续两轮相同即为不动点。 */
  throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`)
}
