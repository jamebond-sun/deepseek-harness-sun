/**
 * DeepSeek 路由的提供方侧请求图像定价：用公开的视觉令牌计量，
 * 把每个被保留的表面出现按其按模型的请求目标计价，并把表面标记为已卸载的
 * 每个出现计为其占位文本。token meter 通过 `LlmAdapter.imageRequestPricing`
 * 同步消费它；对于已完成的请求，提供方用量仍然是权威锚点。
 *
 * @module dsh-llm-deepseek/request-pricing
 */

import { offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentAccessResolver, ImageBlock, LlmImageRequestPrice, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { longEdgeDimensions, requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { deepSeekImageTokens, deepSeekRequestImageDimensions } from './image-tokens.ts'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'

/** 每次请求中文件引用的图像字节累计量的默认上限。 */
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024
/** 提供方的请求图像数量上限。 */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600
/** 与提供方低细节图像输入相匹配的总像素预算。 */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** 一张确定性模型请求图像的编码字节目标；当没有质量档位可用时使用最小的质量阶梯输出。 */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/**
 * 提供方对携带 15 张及以上图像的请求施加的每边上限，
 * 它被施加到每张请求图像上，因此图像数量永远不会改变一次投影。
 */
export const REQUEST_IMAGE_MAX_DIMENSION = 4096

/**
 * 解析一条 DeepSeek 模型路由施加到每张请求图像上的编码字节目标。
 * @param model - 已宣告的模型路由及其可选的图像覆盖项。
 * @returns 该路由的编码字节目标。
 * @internal
 */
export function resolveRequestImageMaxBytes(model: DeepSeekCatalogModel): number {
  return model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
}

/**
 * 解析一条 DeepSeek 模型路由为一张源图像所选择的确定性请求目标：
 * 先取公开的令牌网格，除非模型用像素预算覆盖它，再施加提供方每边上限，
 * 最后施加该路由的编码字节目标。小图像永远不会被放大。
 * @param model - 已宣告的模型路由及其可选的图像覆盖项。
 * @param source - 已规范化附件的内在尺寸。
 * @returns 完整的请求尺寸与编码字节目标。
 * @internal
 */
export function resolveRequestImageTarget(
  model: DeepSeekCatalogModel,
  source: Pick<ImageAttachmentRef, 'width' | 'height'>,
): ImageRequestTarget {
  const budget = model.imagePixelBudget === 'low' ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET : model.imagePixelBudget
  const projected = budget === undefined
    ? deepSeekRequestImageDimensions(source.width, source.height)
    : requestImageDimensions(source.width, source.height, budget)
  const capped = Math.max(projected.width, projected.height) > REQUEST_IMAGE_MAX_DIMENSION
    ? longEdgeDimensions(source.width, source.height, REQUEST_IMAGE_MAX_DIMENSION)
    : projected
  return { ...capped, maxBytes: resolveRequestImageMaxBytes(model) }
}

/**
 * 为一个纯文本路由用确定性文本替换掉的那次出现计价，
 * 复现 `LlmRuntime` 在分发到不具备 `image` 模态的路由之前
 * 所应用的 `projectImagesForTextModel` 替换。
 */
function textOnlyPrice(block: ImageBlock): LlmImageRequestPrice {
  return { visualTokens: 0, text: textOnlyImageText(block.attachment) }
}

/**
 * 基于一份已校验的连接快照，构建一条 DeepSeek 路由的请求图像定价。
 * 未编入目录的模型与纯文本模型把每次出现都计为其确定性文本替换；
 * 具备图像能力的模型把已卸载的出现计为其占位文本，把被保留的出现
 * 按其投影后的请求尺寸计价，而每次出现的句柄或占位文本都通过与
 * 序列化器相同的访问解析来构建。访问路径在计价时解析，
 * 因此在请求之前发生变化的路径只会让文本计价按其自身长度偏移。
 * @param connection - 本次计价解析所依据的、已校验的连接事实。
 * @param model - 请求头中指明的精确模型 id。
 * @param resolveAccess - 与请求序列化共享的、当前执行世界的访问解析。
 * @returns 该路由的按出现同步计价。
 */
export function deepSeekImageRequestPricing(
  connection: DeepSeekConnectionOptions,
  model: string,
  resolveAccess?: ImageAttachmentAccessResolver,
): LlmImageRequestPricing {
  const catalogModel = connection.models.find(entry => entry.id === model)
  if (catalogModel?.inputModalities?.includes('image') !== true) {
    return { priceImages: images => images.map(textOnlyPrice) }
  }
  return {
    priceImages: images => images.map(({ attachment: ref, offloaded }) => {
      if (offloaded === true) {
        return { visualTokens: 0, text: offloadedImageText(ref, resolveAccess?.(ref)) }
      }
      const target = resolveRequestImageTarget(catalogModel, ref)
      return {
        visualTokens: deepSeekImageTokens(target.width, target.height),
        text: requestImageHandleText(ref, target, resolveAccess?.(ref)),
      }
    }),
  }
}
