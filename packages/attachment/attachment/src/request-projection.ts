/**
 * 由模型路由与提供方侧请求计价共享的纯请求投影几何。
 * @module @deepseek-ai/dsh-attachment/request-projection
 */

/** 单张投影图像的整数宽度和高度。 */
export interface ProjectedDimensions {
  width: number
  height: number
}

/**
 * 在硬性总像素预算内计算保持宽高比的整数尺寸。
 * @param width - 正的源宽度。
 * @param height - 正的源高度。
 * @param maxPixels - 正的宽乘高上限。
 * @returns 向内取整的尺寸；小图不会被放大。
 */
export function requestImageDimensions(
  width: number,
  height: number,
  maxPixels: number,
): ProjectedDimensions {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * 以精确长边计算保持宽高比的整数尺寸；
 * 短边就近取整到像素，等同于编码器
 * 仅按长边进行的缩放。
 * @param width - 正的源宽度。
 * @param height - 正的源高度。
 * @param longEdge - 较长源边的正数目标。
 * @returns 目标尺寸；长边大于等于源尺寸时原样返回源尺寸。
 */
export function longEdgeDimensions(
  width: number,
  height: number,
  longEdge: number,
): ProjectedDimensions {
  if (longEdge >= Math.max(width, height)) return { width, height }
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round(longEdge * height / width)) }
    : { width: Math.max(1, Math.round(longEdge * width / height)), height: longEdge }
}
