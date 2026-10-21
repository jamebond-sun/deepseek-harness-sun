/**
 * Cordis 动态插件卡片，node 半区。纯 UI 插件：这里的
 * 空 apply 存在，是为了让该插件出现在 host 的 cordis.yml / Loader 中；
 * 浏览器半区通过 exports["./client"] 提供，并由
 * package.json 的 dshClient 声明发现。
 */

/** Host 插件主体 —— 本表面插件没有 host 侧行为。 */
export function apply(): void {}
