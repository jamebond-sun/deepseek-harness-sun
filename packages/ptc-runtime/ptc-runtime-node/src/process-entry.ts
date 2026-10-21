/** 私有的、构建后的 Node 运行时子进程入口；源码执行时直接调用 runNodeMain。 */
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'
import { runNodeMain } from './process.ts'

void runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process)
