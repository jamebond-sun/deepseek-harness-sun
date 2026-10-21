/** 共享的提供方上限与 Chat Files API 默认值。 */

/** 适配器的一次流式读取处于未完成状态时的默认最大空闲间隔。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** 默认的请求与响应合计上下文容量。 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** 默认的按请求输出令牌上限。 */
export const DEFAULT_MAX_TOKENS = 256_000
/** Files API 回退之后，base64 图像载荷累计量的默认上限。 */
export const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** 确定性的原始字节移除步长。 */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 64 * 1024 * 1024
/** Files API 回退之后，确定性的 base64 字节移除步长。 */
export const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
/** 确定性的图像数量移除步长。 */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
/** 已上传图像的默认显式生命周期。 */
export const DEFAULT_FILE_EXPIRY_SECONDS = 7 * 24 * 60 * 60
/** 已索引文件 id 的默认主动刷新窗口。 */
export const DEFAULT_FILE_REFRESH_MARGIN_SECONDS = 60 * 60
/** 配额恢复时移除的最早的、由 harness 持有的文件的默认数量。 */
export const DEFAULT_FILE_QUOTA_CLEANUP_BATCH = 100
/** 通过 Files API 解析一张请求图像的默认截止时间。 */
export const DEFAULT_FILES_API_TIMEOUT_MS = 60_000
