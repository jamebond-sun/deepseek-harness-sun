/** 由三个卡片族共享的、无参数的 Cordis 工具前缀。 */
import type { ReactNode } from 'react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/* v8 ignore next -- 不可展开的各行永不调用 DisclosureRow 所需的 toggle 回调。 */
const noop = (): void => undefined

type CordisPreparingRowProps = Pick<ToolCallViewProps, 'toolName'> & PropsLocale<'cordis'> & {
  readonly icon: ReactNode
  readonly title: string
  readonly className?: string | undefined
  readonly rowClassName?: string | undefined
  readonly titleClassName?: string | undefined
}

/**
 * 渲染一个不带展开的、Cordis 自有的前缀。
 * @param props - Cordis 前缀、样式与本地化。
 * @returns 准备行。
 */
export function CordisPreparingRow({
  toolName, t, icon, title, className, rowClassName, titleClassName,
}: CordisPreparingRowProps) {
  return <div data-tool={toolName} data-state="preparing" aria-label={t('a11y.preparing')}>
    <DisclosureRow icon={icon} title={title} className={className} rowClassName={rowClassName}
      titleClassName={titleClassName} open={false} expandable={false} onToggle={noop} running />
  </div>
}
