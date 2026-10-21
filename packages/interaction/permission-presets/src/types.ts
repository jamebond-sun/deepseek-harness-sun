/**
 * 权限领域的纯类型：`permissions` 投影键声明及其载荷类型的唯一归属地，不含本包
 * Host 侧的值依赖（cordis、schemastery）。两个命名空间投影都为它服务 ——
 * 面向 Host 消费方的是包根再导出，面向 Client 聚合的是 `./client`（浏览器半入口的
 * 再导出）—— 且内容零重复。
 *
 * @module @deepseek-ai/dsh-permission-presets/types
 */

/** 一个可用预设（或推导出的 `custom` 当前值）的呈现信息。 */
export interface PresetOption {
  /** 稳定的选项值：已配置的预设键、生效中的 `auto`，或推导出的 `custom`。 */
  value: string
  /** 展示名称。 */
  name: string
  /** 一句面向用户的话，说明该取值的含义；未配置时缺省。 */
  description?: string
}

/**
 * 进程级的权限目录。它随实时贡献而变化，并被有意地与 Session 历史分离。
 */
export interface PermissionCatalog {
  /** 当前全部可选预设，按贡献顺序排列。 */
  options: PresetOption[]
  /** 有资格作为未来 Session 默认值的已配置预设。 */
  defaultOptions: PresetOption[]
  /** Config 字段缺省时生效的默认值。 */
  defaultPreset: string
}

/** 整个 `permissions` Session 投影：只包含当前已持久化的选择。 */
export interface PermissionSelection {
  /** 当前生效的值：某个已配置的预设键、`auto`，或 `custom`。 */
  currentValue: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 可选的进程级目录发生了变化。按设计不带载荷：消费方先订阅，
     * 再重新读取完整目录。
     * @mode emit
     */
    'permission-presets/catalog-changed'(): void
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * 该 Session 当前的权限，由三个整体取值型开关事件（`permission/preset`、
     * `sandbox/mode`、`approval/policy`）在组合默认值之上折叠得出。可选项目来自
     * 进程级目录 Remote。键缺省意味着没有组合权限服务 —— 客户端应当隐藏该控件。
     */
    permissions: PermissionSelection
  }
}
