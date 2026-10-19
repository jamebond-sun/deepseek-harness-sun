/**
 * 合并进共享 Remote 失败词汇表的 Gateway 基础设施失败码。
 * 对 face 中立：Host face 与 Client face 各自导入本模块，
 * 两个程序因此看到相同的映射条目。
 */

/** 每个 Gateway 基础设施失败都携带的 wire 详情字段。 */
export interface TypertGatewayFaultDetails {
  /** 规范的 `<namespace>/<method>` 端点。 */
  readonly endpoint: string
  /** 失败针对特定字段时受影响的 wire 字段。 */
  readonly field?: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'gateway/ambiguous-endpoint': TypertGatewayFaultDetails
    'gateway/arguments-invalid': TypertGatewayFaultDetails
    'gateway/binding-invalid': TypertGatewayFaultDetails
    'gateway/context-failed': TypertGatewayFaultDetails
    'gateway/context-not-found': TypertGatewayFaultDetails
    'gateway/context-unavailable': TypertGatewayFaultDetails
    'gateway/definition-unavailable': TypertGatewayFaultDetails
    'gateway/input-invalid': TypertGatewayFaultDetails
    'gateway/interactions-forbidden': TypertGatewayFaultDetails
    'gateway/invocation-unavailable': TypertGatewayFaultDetails
    'gateway/lookup-failed': TypertGatewayFaultDetails
    'gateway/lookup-not-found': TypertGatewayFaultDetails
    'gateway/lookup-unavailable': TypertGatewayFaultDetails
    'gateway/method-unavailable': TypertGatewayFaultDetails
    'gateway/peer-disposed': TypertGatewayFaultDetails
    'gateway/protocol': TypertGatewayFaultDetails
    'gateway/provider-mismatch': TypertGatewayFaultDetails
    'gateway/result-invalid': TypertGatewayFaultDetails
    'gateway/service-unavailable': TypertGatewayFaultDetails
    'gateway/signature-invalid': TypertGatewayFaultDetails
    'gateway/uplink-overflow': TypertGatewayFaultDetails
  }
}
