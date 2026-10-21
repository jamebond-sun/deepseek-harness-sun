/**
 * 代理安装：本包在传输方面的那一半。它负责 undici 的全局 dispatcher 以及
 * 当前哪个策略处于活动状态的进程级记录。
 *
 * `undici` 为动态导入，以便纯粹的 {@link ProxyPolicy} 那一半在没有 Node
 * 传输之处仍可加载，这与 `dsh-web-fetch-http` 推迟自身传输导入的方式一致。
 * @module @deepseek-ai/dsh-http-proxy/install
 */

import type { Dispatcher, Pool } from 'undici'
import {
  isSupportedProxyUrl,
  POLICY_ENV_NAMES,
  PROXY_ENV_NAMES,
  proxyForUrl,
  resolveProxyPolicy,
  type EnvLookup,
  type ProxyPolicy,
} from './policy.ts'


/** 当前活动策略，未安装前为 `undefined`。与它所跟踪的 dispatcher 一样是进程级的。 */
let active: ProxyPolicy | undefined

/**
 * 用户导出的代理环境，或当未安装策略时为 `undefined`。
 *
 * 由最外层的安装所拥有：若其上再叠加一层 launcher 的，会把外层策略发布的
 * 值当作用户所写的一般记录下来，并把用户从未要求的规范化强加给每个子进程。
 *
 * {@link proxyEnvironmentForChild} 保留用户设定的值，而非本进程从它解析
 * 出来的值，因此 `curl` 能用的 SOCKS 代理不会被另一个 scheme 名下的 HTTP
 * 代理所替换。
 */
let inheritedProxyEnv: Readonly<Record<string, string | undefined>> | undefined

/** 随 {@link active} 安装的 dispatcher，因此一条路由可以交回正在路由的那一个。 */
let installed: Dispatcher | undefined

/**
 * 本进程必须如何发送单个请求。
 *
 * 一个依据答案分叉的调用方，需要该答案所假定的传输，否则两次操作之间若
 * 发生了安装或释放，会把请求发往该分叉未清除的地方。因此走代理的分支携带
 * 本策略已经在路由的 dispatcher：它是进程级且长生命周期的，调用方使用它但
 * 绝不关闭它。释放会关闭该 dispatcher 而非销毁它，因此当某个策略被卸载时
 * 已经派发出去的请求仍能完成。
 */
export type ProxyRoute =
  | { readonly proxied: true; readonly proxy: string; readonly dispatcher: Dispatcher }
  | { readonly proxied: false }

/** 一条不经过代理发送任何内容的路由，因不携带每请求状态而被共享。 */
const DIRECT_ROUTE: ProxyRoute = { proxied: false }

/**
 * 决定如何发送单个请求，并交回该决策所假定的传输。
 *
 * @param url - 请求 URL。
 * @returns 带代理 URL 与 dispatcher 的代理路由，或直接路由。
 */
export function proxyRouteFor(url: URL): ProxyRoute {
  const policy = active
  const dispatcher = installed
  if (policy === undefined || dispatcher === undefined) return DIRECT_ROUTE
  const proxy = proxyForUrl(policy, url)
  return proxy === undefined ? DIRECT_ROUTE : { proxied: true, proxy, dispatcher }
}

/**
 * 通过代理环境变量发布一份策略，这正是那些读取环境而非策略对象的消费方——
 * `node:http` 的 `proxyEnv` 以及每个被 spawn 的子进程——看到统一解析答案的
 * 方式，包括 `ALL_PROXY` 回退以及合并后的环回绕过，这两者各自都无法独立
 * 推导。全局 dispatcher 并不读取这些变量；它依据策略路由。
 *
 * @param policy - 待发布的策略。
 * @returns 一个恢复本调用所改动每个名称的函数。
 */
function applyPolicyEnv(policy: ProxyPolicy): () => void {
  const previousInherited = inheritedProxyEnv
  inheritedProxyEnv = previousInherited ?? snapshotProxyEnv()
  const published: Record<string, string | undefined> = {}
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = policy[field as keyof typeof POLICY_ENV_NAMES]
    for (const name of names) published[name] = value
  }
  const restore = writeProxyEnv(published)
  return () => {
    restore()
    inheritedProxyEnv = previousInherited
  }
}

/**
 * 读取本包发布的每个代理名称，即 `process.env` 当前的持有状态。
 *
 * @returns {@link POLICY_ENV_NAMES} 中每个名称一条；`undefined` 表示缺失的名称。
 */
function snapshotProxyEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const names of Object.values(POLICY_ENV_NAMES)) {
    for (const name of names) snapshot[name] = process.env[name]
  }
  return snapshot
}

/**
 * 将每个代理名称设为 `values` 中为它持有的值，值若为 `undefined` 则移除该名称。
 *
 * @param values - {@link POLICY_ENV_NAMES} 中每个名称应当持有的值。
 * @returns 一个将每个名称恢复到本调用之前所持有状态的函数。
 */
function writeProxyEnv(values: Readonly<Record<string, string | undefined>>): () => void {
  // 在写入任何名称之前先快照 EVERY 个名称。Windows 会大小写不敏感地折叠环境
  // 名称，因此在写入小写拼写后再读取大写拼写，会读回刚刚写入的值，并把策略
  // 而非用户的环境恢复回去。
  const previous = snapshotProxyEnv()
  for (const name of Object.keys(previous)) {
    const value = values[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

/**
 * 为一份策略构建全局 dispatcher。
 *
 * 路由按来源逐个经过 {@link proxyForUrl}，因此 `fetch` 以及每个询问某 URL
 * 去向的调用方，都从同一个匹配器读取同一答案。undici 的 `EnvHttpProxyAgent`
 * 无法表达此策略：在没有 `HTTPS_PROXY` 时，它会为 `https:` 复用 HTTP 代理，
 * 而本包在拒绝了用户为其指定的 SOCKS 或畸形 URL 后，刻意保持直连——届时
 * 路由与诊断就会相互矛盾。
 *
 * @param policy - 据以路由的策略；它必须至少代理一个 scheme。
 * @returns 待安装的 dispatcher，拥有其工厂创建的所有每来源 agent。
 */
async function createPolicyDispatcher(policy: ProxyPolicy): Promise<Dispatcher> {
  const { Agent, Pool, ProxyAgent } = await import('undici')
  return new Agent({
    factory(origin, options) {
      // undici 将该参数声明为 `Object`，丢弃了它实际传入的池选项。
      const passed = options as Pool.Options
      const proxy = proxyForUrl(policy, new URL(origin.toString()))
      if (proxy !== undefined) return new ProxyAgent({ ...passed, uri: proxy })
      // 这正是 undici 自身默认工厂为这些选项所构建的，`factory` 会整体替换它。
      // 它只在 `connections: 1` 时才求助于裸 `Client`，而这个 dispatcher 永不
      // 携带该选项：它是用 undici 的默认值构造的。
      return new Pool(origin, passed)
    },
  })
}

/**
 * 将本进程的出口 HTTP 经由 `policy` 路由。
 *
 * 安装会替换 undici 的全局 dispatcher，这正是 Node 内置 `fetch` 所解析的
 * 对象，因此每个发出普通 `fetch()` 的调用方都被覆盖，而无需知道本包存在。
 * 一个什么也不代理的策略会安装一个直连 dispatcher 并保持环境不变。
 *
 * Worker 线程拥有自己的 `globalThis`，因此也有自己的 dispatcher；此处的安装
 * 不会触及它。目前没有任何 worker 安装过：本仓库发布的两者——工作流引擎与
 * PTC 运行时——会执行模型编写的脚本，绝不能收到可能携带凭据的代理 URL。需要
 * 该策略的 worker 必须被显式传入并自行安装。
 *
 * @param policy - 待安装的已解析策略。
 * @returns 一个收集器，恢复先前的 dispatcher、策略与环境，随后关闭 agent。
 */
async function installGlobalProxy(policy: ProxyPolicy): Promise<() => Promise<void>> {
  const previousPolicy = active
  if (policy.source === 'none') {
    // 安装在已安装策略之上的直连策略必须真正停止代理。仅记录策略会让先前的
    // agent 继续作为全局 dispatcher，于是普通 `fetch()` 仍在隧道转发，而
    // `proxyForUrl()` 却报告直连——并且 `mode: 'off'` 会成为一个静默的空操作。
    // 当没有任何已安装内容时，就没有什么可被替换。
    if (previousPolicy === undefined) {
      active = policy
      return () => {
        active = previousPolicy
        return Promise.resolve()
      }
    }
    const previousInstalled = installed
    // 其下层的安装把规范化后的策略发布进了 `process.env`，而这正是被 spawn 子进程
    // 所复制的。当没有活动策略时，就没有需要撑住的规范化，因此窗口期内返回用户
    // 自己的值，而外层安装的值在其结束时回归。其下层的安装若什么也不代理，则
    // 什么也没发布，也就没什么可放回去的。
    const restoreEnv = inheritedProxyEnv === undefined ? undefined : writeProxyEnv(inheritedProxyEnv)
    const undici = await import('undici')
    const previous = undici.getGlobalDispatcher()
    const direct = new undici.Agent()
    undici.setGlobalDispatcher(direct)
    active = policy
    installed = undefined
    return async () => {
      undici.setGlobalDispatcher(previous)
      active = previousPolicy
      installed = previousInstalled
      restoreEnv?.()
      await direct.close()
    }
  }
  const restoreEnv = applyPolicyEnv(policy)
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previousDispatcher = getGlobalDispatcher()
  const previousInstalled = installed
  const agent = await createPolicyDispatcher(policy)
  setGlobalDispatcher(agent)
  active = policy
  installed = agent
  return async () => {
    setGlobalDispatcher(previousDispatcher)
    active = previousPolicy
    installed = previousInstalled
    restoreEnv()
    await agent.close()
  }
}




/**
 * 被 spawn 子进程所需的代理环境。
 *
 * 子进程继承父进程环境，而本进程已将其改写为自身解析出的策略。直接透传这种
 * 规范化，会替换用户为其他工具所设定的值，因此用户导出的每个代理名称都会
 * 恢复到他们所写的内容：`curl` 使用的 SOCKS 代理不会被本包为该 scheme 回退
 * 到的 HTTP 代理所替换。
 *
 * 用户未以任何一种大小写形式命名的 scheme，会携带解析后的值而非被移除。没有
 * 这一点，子进程的路由会静默地与其父进程偏离：`NODE_USE_ENV_PROXY` 不读取
 * `ALL_PROXY`，因此一个从父进程经该名称解析出代理的子进程会在父进程代理时
 * 直连。
 *
 * 绕过列表始终是解析后的那一份。它只会在用户所写内容之上添加环回条目，因此
 * 不会丢失任何内容，且子进程会停止把自身的 localhost 流量发往一个无法路由
 * 它的代理。
 *
 * 该标志只抵达 Node 22.21+ 与 24+；较旧的运行时让该子进程保持直连。这样的
 * 子进程还会用 Node 自己的 `NO_PROXY` 规则匹配绕过条目，而该规则在本包的
 * 分隔符与 IPv4 范围支持上与其不同。非 Node 的子进程（curl、git、pnpm）
 * 忽略该标志，自行读取这些变量。
 *
 * 当子进程收到的某个代理值是本包所拒绝的值时，该标志会被 withholding。Node
 * 会在运行程序之前、在该标志下解析 `HTTP_PROXY` 与 `HTTPS_PROXY`，并在 scheme
 * 非 `http:` 或 `https:` 时退出——因此为 `curl` 保留的 SOCKS 值会让每个 Node
 * 子进程都无法启动。没有该标志时，这样的子进程会直连，正如本进程对该 scheme
 * 已报告的那样，而 `curl` 仍读取为其保留的值。
 *
 * Worker 线程刻意不在此处提供服务——参见工作流引擎，它运行模型编写的脚本，
 * 绝不能收到可能携带凭据的代理 URL。
 *
 * @returns 待应用到子进程环境的名称，其中 `undefined` 表示移除；或当没有活动
 *   代理时为空对象。
 */
export function proxyEnvironmentForChild(): Readonly<Record<string, string | undefined>> {
  const policy = active
  const inherited = inheritedProxyEnv
  if (policy === undefined || policy.source === 'none' || inherited === undefined) return {}
  const overlay: Record<string, string | undefined> = { NODE_USE_ENV_PROXY: '1' }
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const resolved = policy[field as keyof typeof POLICY_ENV_NAMES]
    // 以任一种大小写命名某 scheme 即认领该 scheme：子进程随后得到用户所写的
    // 确切内容、所写的大小写，而非为本进程推导的值。
    const named = field !== 'noProxy' && names.some(name => inherited[name] !== undefined)
    for (const name of names) overlay[name] = named ? inherited[name] : resolved
  }
  const parsedByNode = [...POLICY_ENV_NAMES.httpProxy, ...POLICY_ENV_NAMES.httpsProxy]
  if (parsedByNode.some(name => overlay[name] !== undefined && !isSupportedProxyUrl(overlay[name]))) {
    delete overlay.NODE_USE_ENV_PROXY
  }
  return overlay
}

/**
 * 从 `env` 解析本进程的代理策略并进行安装。
 *
 * 解析、报告与安装是一个操作，因为没有调用方需要把它们分开：启动器在第一个
 * 插件挂载前依次完成这三者，而一份已解析却未安装的策路不会路由任何东西。
 *
 * 环境提供但本包无法使用的值会被报告并跳过，而非抛出：该变量可能是为另一个
 * 工具导出的，而 harness 无法使用的代理绝不能阻止 agent 启动。
 *
 * @param env - 启动环境，其自身的分层已经优先真实的变量而非 `.env` 文件。
 * @param report - 每拒绝一个值就接收一条消息，顺序与值被考虑的顺序一致。
 * @returns 一个收集器，恢复先前的 dispatcher、策略与环境。
 */
export async function installProxyFromEnvironment(
  env: EnvLookup,
  report: (message: string) => void,
): Promise<() => Promise<void>> {
  const { policy, diagnostics } = resolveProxyPolicy(env)
  for (const diagnostic of diagnostics) report(diagnostic.message)
  return await installGlobalProxy(policy)
}

/**
 * 从被 spawn 子进程中移除每个代理名称的环境覆盖层。
 *
 * 回放已记录会话的 harness 必须抵达自身的 fixture 服务器，而非开发者或 CI
 * 运行者导出的代理；`undefined` 是 spawn 移除所继承名称的方式。
 *
 * @returns 每个代理名称一条，每条均为 `undefined`。
 */
export function clearedProxyEnv(): Record<string, undefined> {
  return Object.fromEntries(PROXY_ENV_NAMES.map(name => [name, undefined]))
}
