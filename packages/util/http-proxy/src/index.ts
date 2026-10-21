/**
 * DeepSeek Harness 的出口 HTTP 代理支持。
 *
 * Node 内置的 `fetch` 会忽略 `HTTP_PROXY` 及其同类变量，因此无论用户导出
 * 了什么，每个 harness 请求都会直连。启动器从启动环境解析出一份策略，并将
 * 其安装为 undici 的全局 dispatcher——这正是 `fetch` 所解析的对象——于是 LLM
 * 适配器、网络搜索、经由 HTTP 的 MCP 以及遥测都被覆盖，而无需改动它们的
 * 代码。
 *
 * 这是一个库，而非插件：传输策略每个进程只有一个答案，因此没有什么可供
 * 组合挂载、替换或作用域化。
 *
 * 四个函数，对应调用方需要的四种使用策略的方式——安装它、询问如何发送单个
 * 请求、构建子进程环境，以及为一次回放剥离环境策略。
 * @module @deepseek-ai/dsh-http-proxy
 */

export {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  type ProxyRoute,
} from './install.ts'
