/**
 * 动态包运行器插件，node 半区。纯浏览器侧能力：这里的
 * 空 apply 存在，是为了让该行出现在 host 的 cordis.yml / Loader 中，
 * 而浏览器半区通过 exports["./client"] 提供，并由
 * package.json 的 dshClient 声明发现。
 */

/** Host 插件主体 —— 本包在 host 侧不贡献任何内容。 */
export function apply(): void {}
