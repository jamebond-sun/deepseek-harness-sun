/** 常驻 Node REPL 的私有构建入口。 */
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'
import { runPersistentMain } from './persistent-process.ts'

void runPersistentMain(openInheritedControlChannel(), Number(process.argv[2]), process)
