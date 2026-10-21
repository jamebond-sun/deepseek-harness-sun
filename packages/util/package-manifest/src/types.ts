/**
 * package.json 字段与插件展示元数据的共享声明。
 * 每个读取方各自负责 JSON 校验与已解析默认值。
 * @module @deepseek-ai/dsh-package-manifest/types
 */

/** 包标识与元数据；本地 profile 读取方可接受部分声明。 */
export interface DshPackageManifest {
  /** 已发布的 npm 包名。 */
  name: string
  /** 已发布的 npm 包版本。 */
  version: string
  /** 用于发现与展示的包摘要。 */
  description?: string
  /** 相对于本清单目录的 SVG、PNG、JPEG 或 WebP 文件，至多 256 KiB，且在 realpath 解析后包含于该目录之内。 */
  icon?: string
  /** 阻止 npm 发布，例如用于本地 profile 项目。 */
  private?: boolean
  /** 与本包一同安装的包。 */
  dependencies?: Record<string, string>
  /** 由消费项目提供的包的兼容版本。 */
  peerDependencies?: Record<string, string>
  /** 运行时要求；DSH 兼容性在读取方强制执行之前仅为声明性质。 */
  engines?: DshEnginesManifest
  /** DSH 专有的作者声明。 */
  dsh?: DshManifest
}

/** `package.json.dsh` 下的公共作者字段；一个包可声明多个角色。 */
export interface DshManifest {
  /** 清单格式版本，独立于 npm 包与 Session 格式版本。 */
  manifestVersion?: 1
  /** profile 启动器消费的 bundle 元数据。 */
  bundle?: DshBundleManifest
  /** profile 启动器消费的 profile 元数据。 */
  profile?: DshProfileManifest
  /** Client 模块加载与构建元数据。 */
  client?: DshClientManifest
}

/** 字面文本，或按小写语言 id 索引的译文，并带一个必需的英文回退。 */
export type LocalizedText = string | { readonly en: string; readonly [locale: string]: string }

/** 来自导出区域、清单或图标文件的已校验插件展示字段与诊断。 */
export interface PluginLocalizedMeta {
  /** 展示标题；省略时保留消费方的技术名回退。 */
  readonly title?: LocalizedText
  /** 经区域与包字段回退后的展示简介。 */
  readonly description?: LocalizedText
  /** 来自包根清单图标或导出的 `<specifier>/icon` 的 base64 图像数据 URL；作为图像渲染，而非内联标记。 */
  readonly icon?: string
  /** 未修改的本地元数据诊断；该插件仍可被管理。 */
  readonly error?: string
}

/** `package.json.engines` 下的运行时版本要求。 */
export interface DshEnginesManifest {
  /** 兼容的 DSH 版本，以 SemVer 范围表示，含一个精确版本。 */
  dsh?: string
  /** 兼容的 Node.js 版本。 */
  node?: string
  /** 兼容的 npm 版本。 */
  npm?: string
  /** 对额外运行时或包管理器的要求。 */
  [engine: string]: string | undefined
}

/** bundle 包导出的配置层。 */
export interface DshBundleManifest {
  /** 一个补丁文件路径，或一个按顺序应用的列表，每个都相对于声明包的根目录。 */
  patch: string | string[]
}

/** 由 profile 目录声明的 bundle 组合。 */
export interface DshProfileManifest {
  /** 有序的 bundle 层列表，使用已安装的包名。 */
  bundles?: string[]
}

/** 由 client-modules 与 client 构建读取的客户端模块声明。 */
export interface DshClientManifest {
  /** 客户端平台标识符；Web 消费方选择 `web`。 */
  platform: string
  /** 信息性的包名依赖，而非 Cordis 服务注入。 */
  inject?: string[]
  /** 启动第一阶段的注册屏障；缺席意味着共享的应用程序批次。 */
  immediately?: boolean
  /**
   * 超出隐式客户端基线的精确模块表请求，包括 `<pkg>/client` 之类的子路径；
   * 缺席意味着仅有基线的外部依赖。仅类型导入会被擦除，不产生模块请求。
   */
  external?: string[]
}
