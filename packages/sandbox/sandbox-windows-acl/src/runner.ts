/**
 * windows-acl 限制运行器：沙箱接缝用它作为 argv 前缀包装器，替代调用方的
 * 命令去 spawn。它创建带有工作区写入 SID 允许列表的 WRITE_RESTRICTED 令牌，
 * 在该令牌之下、以继承调用方 stdio 的方式（字节直通）派生被包装的 argv，
 * 原样镜像子进程的退出码，并在退出时撤销其临时授予（工作区 ACE 作为复用
 * 缓存保持常驻）。
 *
 * 稳定的 argv 契约（由该接缝构建；一个原生 exe 的替代实现会沿用同一契约）：
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>,
 *    ['--write-sid', <S-1-4-…>,
 *     '--temp-write-sid', <S-1-4-…>], '--', <argv...>]
 *
 * 模式：
 *  - workspace-write：工作区与临时目录各自带有不同的能力 SID 写入授予；
 *    除已记录的 Everyone 与硬链接边界之外，其他可由 ACL 触达的写入都被拒绝。
 *  - read-only：没有任何能力 SID 授予；限制列表不携带任何能力 SID，因此
 *    来自更早一段 workspace-write 时期的常驻授予 ACE 保持惰性。两种模式都
 *    丢弃 Authenticated Users（CIM 不可用——已记录在 README 中）与
 *    INTERACTIVE/LOCAL（Public 目录树的写入被拒绝）；两份列表共用同一个保活
 *    组（登录 SID、EVERYONE），只在能力上有差别。
 *
 * `--write-sid` + `--temp-write-sid`：该接缝的授予契约——调用方已经物化了
 * 互不相同的工作区与私有临时 ACE 并持有其撤销权，因此运行器既不授予也不
 * 撤销（`manageDacls: false`）。这两个值都会对照其所属路径做校验。若没有
 * 这一对参数（独立/无 agent 的用法），workspace-write 会把 `--temp` 当作
 * 一个根，创建一个随机的私有子目录，自行派生它的临时 SID，并在子进程退出
 * 之后删除该目录。两种流程中，运行器都会在派生之前把自身环境中的
 * TMP/TEMP 改写为该私有目录；子进程继承那个环境块（`lpEnvironment` 为
 * NULL；通过 koffi 传一个显式块会在 CreateProcessAsUserW 中触发
 * ERROR_INVALID_PARAMETER，已实测验证）。read-only 则让环境临时目录项
 * 保持原样（那里的写入本来就被拒绝）。
 *
 * 失败契约：每一个运行器侧的失败（参数错误、目录缺失、令牌/授予/派生错误）
 * 都会向 stderr 打印 `windows-acl-run: <detail>` 并以 127 退出——该接缝的
 * RUNNER_FAILURE_RULES 正是匹配这一特征串。子进程绝不会被不受限地派生。
 * @module @deepseek-ai/dsh-sandbox-windows-acl/runner
 */

import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { closeSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { win32 } from './ffi.ts'
import { AclSandbox, assertTempRootOutsideWorkspace } from './index.ts'
import { tempWriteSid, workspaceWriteSid } from './workspace-sid.ts'

const RUNNER_SIGNATURE = 'windows-acl-run'
const RUNNER_FAILURE_EXIT = 127

class RunnerFailure extends Error {}

/** 打印运行器失败特征串所在行并展开清理。 */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

interface ParsedArgs {
  workspace: string
  temp: string
  mode: 'read-only' | 'workspace-write'
  writeSid: string | undefined
  tempWriteSid: string | undefined
  command: string
  args: string[]
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined
  let temp: string | undefined
  let mode: string | undefined
  let writeSid: string | undefined
  let parsedTempWriteSid: string | undefined
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      case '--temp-write-sid': parsedTempWriteSid = value; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (workspace === undefined) fail('missing --workspace')
  if (temp === undefined) fail('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write') fail(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) fail('missing command after --')
  return { workspace, temp, mode, writeSid, tempWriteSid: parsedTempWriteSid, command, args: argv.slice(1) }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  // 两种模式都会校验这两个目录：一个传入伪造根的提供者缺陷必须在运行器
  // 边界上响亮失败，而绝不能失败于子进程运行中途。
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const seamManaged = parsed.writeSid !== undefined || parsed.tempWriteSid !== undefined
  if (parsed.mode === 'read-only' && seamManaged) {
    fail('read-only does not accept --write-sid or --temp-write-sid')
  }
  if (parsed.mode === 'workspace-write' && (parsed.writeSid === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail('workspace-write requires --write-sid and --temp-write-sid together')
  }
  if (parsed.mode === 'workspace-write') {
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp)
  }

  const api = await win32()
  // 忽略本进程自己的 CTRL+C：受限子进程（同一控制台）继续按自己的方式处理；
  // 运行器必须存活下来，以便撤销授予并镜像子进程的退出码。
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)
  }

  let ownedTempDir: string | undefined
  let sandbox: AclSandbox | undefined
  let initialized = false
  try {
    let privateTempDir: string | null = null
    let writeSid: string | undefined
    let privateTempSid: string | undefined
    if (parsed.mode === 'workspace-write') {
      writeSid = workspaceWriteSid(parsed.workspace)
      if (seamManaged) {
        if (parsed.writeSid !== writeSid) fail('--write-sid does not match --workspace')
        privateTempDir = parsed.temp
        privateTempSid = tempWriteSid(privateTempDir)
        if (parsed.tempWriteSid !== privateTempSid) fail('--temp-write-sid does not match --temp')
      } else {
        ownedTempDir = mkdtempSync(join(parsed.temp, 'dsh-'))
        privateTempDir = ownedTempDir
        privateTempSid = tempWriteSid(privateTempDir)
      }
    }
    sandbox = new AclSandbox({
      writableDirs: parsed.mode === 'workspace-write' ? [parsed.workspace] : [],
      tempDir: privateTempDir,
      mode: parsed.mode,
      ...writeSid === undefined ? {} : { writeSid },
      ...privateTempSid === undefined ? {} : { tempWriteSid: privateTempSid },
      manageDacls: !seamManaged,
    })
    await sandbox.init()
    initialized = true

    if (privateTempDir !== null) {
      if (api.setEnvironmentVariableW('TMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`)
      }
      if (api.setEnvironmentVariableW('TEMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`)
      }
    }

    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      stdio: 'inherit',
      ...process.env[SUBPROCESS_CONTROL_ENV] === 'pipe' ? { controlFileDescriptor: SUBPROCESS_CONTROL_FD } : {},
    })
    if (process.env[SUBPROCESS_CONTROL_ENV] === 'pipe') closeSync(SUBPROCESS_CONTROL_FD)
    const result = await child.wait()
    return result.exitCode
  } finally {
    // 清理失败不得掩盖子进程的退出码：上报并继续。
    if (initialized) {
      try {
        sandbox?.dispose()
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (ownedTempDir !== undefined) {
      try {
        rmSync(ownedTempDir, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

main().then(
  (exitCode) => {
    // 在 Windows 上，退出码镜像是全位宽的，已在本机（Windows 11 build
    // 26200，Node 24）实测验证：一个以 NTSTATUS 0xC0000005
    // （STATUS_ACCESS_VIOLATION）退出的子进程，经 GetExitCodeProcess 读回
    // 的是 uint32 的 3221225477，而在 process.exitCode = 3221225477 之后，
    // 父进程观测到的正是 3221225477（spawnSync status）。PowerShell 的
    // $LASTEXITCODE 与 cmd 打印的是有符号视图（-1073741819），但这条链上
    // 任何环节都没有发生截断或掩码——镜像契约在整个 32 位范围内成立，
    // 因此无需重映射。
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
