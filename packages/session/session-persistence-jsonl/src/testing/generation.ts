import {
  createJsonlGenerationRuntime,
  type JsonlGenerationRuntime,
  type JsonlGenerationRuntimeOverrides,
} from '../generation.ts'

/**
 * 为测试创建带有确定性 I/O 与竞态接缝的代际操作。
 * @param overrides - 确定性的文件系统、平台与竞态依赖。
 * @returns 已绑定的代际操作。
 */
export function createJsonlGenerationTestRuntime(
  overrides: JsonlGenerationRuntimeOverrides = {},
): JsonlGenerationRuntime {
  return createJsonlGenerationRuntime(overrides)
}
