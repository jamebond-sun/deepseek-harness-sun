/** profile schema 生成：组合诊断、运行时解析，以及无需启动的发现。 */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, createRuntimeResolution, type Profile } from '../profile.ts'
import { collectConfigSchemas } from './collect.ts'
import type { ConfigSchemaDiagnostic, ConfigSchemaDump } from './types.ts'
export type { ConfigSchemaDump, NativeConfigSchema } from './types.ts'

/**
 * 为已准备的 profile 的有序补丁层生成 JSON Schema，无需挂载插件或求值表达式。
 * import、Config getter 与惰性构建器会执行受信任的代码。原生校验器与转换回调不会被执行。
 * 调用不得与另一次 profile-resolution 拦截重叠；收集在成功或拒绝时释放其拦截，
 * 而 Node 会保留已导入的模块。所提供的层不会被修改。profile 准备、层选择、进程流与
 * 退出策略属于调用方。
 * @param profile - 已准备的磁盘 profile，其目录锚定了根模块与 include 解析。
 * @param layers - 已按应用顺序解析的补丁列表，包含调用方选中的 home 与 argv 覆盖层。
 * @param installAnchor - 锚定该安装运行时依赖的包清单。
 * @returns 一个带有声明引用、部分结果与位于 `x-cordis` 下诊断的 JSON Schema 文档。
 * @throws 当组合或运行时解析无法被准备时。
 */
export async function generateConfigSchema(
  profile: Profile,
  layers: readonly PatchOptions[][],
  installAnchor: string,
): Promise<ConfigSchemaDump> {
  const diagnostics: ConfigSchemaDiagnostic[] = []
  for (const { packageName } of profile.skippedBundles) {
    diagnostics.push({
      level: 'error',
      message: `Selected profile bundle ${JSON.stringify(packageName)} could not be loaded; repair or remove its bundle selection.`,
    })
  }
  const entries = composeEntries(layers, message => diagnostics.push({ level: 'warning', message }))
  const resolution = await createRuntimeResolution({ installAnchor, profile })
  return collectConfigSchemas(profile, entries, resolution, diagnostics)
}
