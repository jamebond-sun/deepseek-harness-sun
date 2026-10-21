/**
 * 名册预设的展示文案解析，供所有渲染预设名称的界面共用：
 * 内置预设通过多语言字典的键解析，用户编写的元数据一律不翻译。
 * 这是一个无导入的纯折叠，因此浏览器打包可以直接内联，
 * Host 也用这唯一一处来维护「哪个内置 id 对应哪个文案键」。
 * @module @deepseek-ai/dsh-agent-preset-registry/display
 */

/** 承载某个内置预设展示文案的字典键。 */
export type BuiltInPresetCopyKey =
  | 'presetStandardName' | 'presetStandardDescription'
  | 'presetPtcName' | 'presetPtcDescription'
  | 'presetMinimalName' | 'presetMinimalDescription'
  | 'presetCordisName' | 'presetCordisDescription'

/** 解析展示文案所需的预设名册字段。 */
export interface PresetDisplaySource {
  /** 稳定的预设 id。 */
  readonly id: string
  /** 预设发布的、未本地化的名称。 */
  readonly name?: string
  /** 预设发布的、未本地化的描述。 */
  readonly description?: string
}

/** 针对当前语言解析出的展示文案。 */
export interface PresetDisplayText {
  /** 本地化后的内置名称，或预设自身的回退名称。 */
  readonly name: string
  /** 本地化后的内置描述，或预设自身的描述。 */
  readonly description?: string
}

interface PresetLocaleKeys {
  readonly name: BuiltInPresetCopyKey
  readonly description: BuiltInPresetCopyKey
}

const BUILT_IN_PRESET_KEYS: Readonly<Partial<Record<string, PresetLocaleKeys>>> = {
  standard: { name: 'presetStandardName', description: 'presetStandardDescription' },
  ptc: { name: 'presetPtcName', description: 'presetPtcDescription' },
  minimal: { name: 'presetMinimalName', description: 'presetMinimalDescription' },
  cordis: { name: 'presetCordisName', description: 'presetCordisDescription' },
}

/**
 * 判断一条名册行是否属于字典中承载了文案的内置预设。
 * 内置预设不发布 `name`；自行命名的声明拥有自己的文案。
 * @param preset - 名册行。
 * @returns 对于未发布名称的内置预设 id，返回 true。
 */
export function isBuiltInPreset(preset: PresetDisplaySource): boolean {
  return preset.name === undefined && BUILT_IN_PRESET_KEYS[preset.id] !== undefined
}

/**
 * 解析预设的展示文案，同时不让用户编写的元数据进入翻译。
 * @param preset - 正在渲染其文案的名册行。
 * @param t - 覆盖 {@link BuiltInPresetCopyKey} 的当前语言查询函数。
 * @returns 已知内置预设的本地化文案，否则返回声明中的元数据。
 */
export function presetDisplayText(
  preset: PresetDisplaySource,
  t: (key: BuiltInPresetCopyKey) => string,
): PresetDisplayText {
  const keys = isBuiltInPreset(preset) ? BUILT_IN_PRESET_KEYS[preset.id] : undefined
  if (keys !== undefined) return { name: t(keys.name), description: t(keys.description) }
  return {
    name: preset.name ?? preset.id,
    ...preset.description === undefined ? {} : { description: preset.description },
  }
}
