/** 从拥有该路径的桌面查询的原生文件关联。 */
import { runNativeCommand } from './runner.ts'
import { linuxFileApplications } from './file-applications-linux.ts'
import { windowsFileApplications } from './file-applications-windows.ts'
import { nativeFileManager } from './path-opener.ts'
import type { PathOpenerInternals } from './path-opener.ts'
import { parseNativeFileApplications, type NativeFileApplication } from './types.ts'

/** AppKit 运行于系统 JXA 宿主内部；路径以 argv 形式到达，绝不为可执行源码。 */
const MAC_APPLICATIONS = `
ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var preferredPath = preferred.isNil() ? null : ObjC.unwrap(preferred.path);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var apps = [];
  for (var i = 0; i < urls.count; i++) {
    var url = urls.objectAtIndex(i);
    var path = ObjC.unwrap(url.path);
    var image = null;
    if (argv[1] === 'icons') {
      var icon = workspace.iconForFile(path);
      var thumbnail = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
      thumbnail.lockFocus;
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
      thumbnail.unlockFocus;
      var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
      var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      image = png.isNil() ? null : 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    }
    var bundle = $.NSBundle.bundleWithURL(url);
    var bundleId = bundle.isNil() || bundle.bundleIdentifier.isNil() ? null : ObjC.unwrap(bundle.bundleIdentifier);
    var version = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
    apps.push({
      id: path,
      name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path)),
      default: path === preferredPath,
      icon: image,
      bundle: bundleId,
      version: version === null || version.isNil() ? null : String(ObjC.unwrap(version))
    });
  }
  return JSON.stringify(apps);
}`

/**
 * 按 OS 偏好顺序列出已注册的处理程序，含当前默认项与应用图标。
 * @param path - 已校验的绝对本地文件路径。
 * @param signal - 调用方生命周期，传播给 OS 查询。
 * @param internals - 用于确定性测试的、平台与命令适配器。
 * @returns 当前文件处理程序；在 macOS 上，共享同一 bundle 标识符与显示名的副本
 *   折叠为一项；当平台没有关联查询时为空列表。
 */
export async function nativeFileApplications(
  path: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<readonly NativeFileApplication[]> {
  return queryFileApplications(path, signal, internals, true)
}

/**
 * 查询处理程序元数据；显示查询渲染 macOS 图标并折叠重复副本，启动校验则保留每个
 * 已注册副本。
 */
async function queryFileApplications(
  path: string, signal: AbortSignal, internals: PathOpenerInternals, display: boolean,
): Promise<readonly NativeFileApplication[]> {
  signal.throwIfAborted()
  const target = await desktopTarget(path, signal, internals)
  const run = internals.run ?? runNativeCommand
  if (target.platform === 'linux') return linuxFileApplications(path, signal, run, internals.env ?? process.env)
  if (target.platform === 'darwin') {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', MAC_APPLICATIONS, target.path, display ? 'icons' : 'handlers'], signal, 'hidden')
    const applications = parseMacApplications(JSON.parse(stdout))
    return display ? dedupeMacApplications(applications) : applications
  }
  if (target.platform !== 'win32') return []
  const stdout = await windowsFileApplications(target.path, null, signal, run)
  return parseNativeFileApplications(JSON.parse(stdout))
}

/** 一个已校验的 macOS 处理程序，含显示查询会剥离的分组元数据。 */
interface MacApplication extends NativeFileApplication {
  readonly bundle: string | null
  readonly version: string | null
}

/**
 * 校验已解码 macOS 查询输出的每个条目，基础字段与分组元数据皆然。
 * @param value - 来自 macOS 查询的已解码应用列表。
 * @returns 按 OS 偏好顺序的已校验处理程序。
 * @throws 当任一条目畸形时抛出 Error，与其他平台解析器一致。
 */
function parseMacApplications(value: unknown): readonly MacApplication[] {
  if (!Array.isArray(value)) throw new Error('Invalid native application list')
  const entries: readonly unknown[] = value
  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid native application entry')
    const bundle = macField('bundle' in entry ? entry.bundle : null)
    const version = macField('version' in entry ? entry.version : null)
    const [base] = parseNativeFileApplications([entry])
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 单条目输入解析为单条目
    return { ...base!, bundle, version }
  })
}

/** 校验 macOS 条目的一个可选字符串字段；缺失字段、null 与空字符串读作 null。 */
function macField(field: unknown): string | null {
  if (field === null) return null
  if (typeof field !== 'string') throw new Error('Invalid native application entry')
  return field.length === 0 ? null : field
}

/**
 * 为显示折叠同一应用的重复注册。自更新应用会在磁盘上留下额外副本（在 Application
 * Support 下暂存更新、按版本安装），而 LaunchServices 会注册每一个，因此原始处理
 * 程序列表会重复该应用。Finder 每个应用显示一个条目，并仅对刻意并排安装、携带不同
 * 显示名的副本拆分；与此一致，共享一个 bundle 标识符与显示名的副本折叠为系统默认
 * 项，否则为该组最高版本、位于该组首位。启动校验绕过此折叠，因而每个已注册副本
 * 仍可打开。
 * @param applications - 按 OS 偏好顺序的已校验处理程序。
 * @returns 每个应用一个条目、无分组元数据的应用元数据。
 */
function dedupeMacApplications(applications: readonly MacApplication[]): readonly NativeFileApplication[] {
  const order: MacApplication[] = []
  const groups = new Map<string, number>()
  for (const app of applications) {
    if (app.bundle === null) {
      order.push(app)
      continue
    }
    const key = `${app.bundle}\u0000${app.name}`
    const index = groups.get(key)
    if (index === undefined) {
      groups.set(key, order.length)
      order.push(app)
      continue
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- 组索引指向已推送的条目
    const held = order[index]!
    if (held.default) continue
    if (app.default || compareVersions(app.version, held.version) > 0) order[index] = app
  }
  return order.map(({ id, name, default: preferred, icon }) => ({ id, name, default: preferred, icon }))
}

/** 以数值顺序比较两个点分版本字符串；非数字段计为 0，缺失版本排最低。 */
function compareVersions(left: string | null, right: string | null): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1
  const a = left.split('.')
  const b = right.split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (Number(a[i]) || 0) - (Number(b[i]) || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * 在目前已注册的处理程序中打开一个文件；陈旧的或任意的应用标识符会被拒绝。
 * 校验检查完整的已注册列表，因此从显示列表中折叠出去的 macOS 副本仍可打开。
 * @param path - 已校验的绝对本地文件路径。
 * @param application - 文件关联查询返回的标识符。
 * @param signal - 调用方生命周期，传播给查询与启动。
 * @param internals - 用于确定性测试的、平台与命令适配器。
 * @returns 在系统启动器接受该文件之后。
 */
export async function openNativeFileApplication(
  path: string, application: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<void> {
  const target = await desktopTarget(path, signal, internals)
  const run = internals.run ?? runNativeCommand
  if (target.platform === 'win32') {
    await windowsFileApplications(target.path, application, signal, run)
    return
  }
  const apps = await queryFileApplications(path, signal, internals, false)
  if (!apps.some(app => app.id === application)) throw new Error('Application is not registered for this file')
  if (target.platform === 'linux') await run('gio', ['launch', application, path], signal, 'hidden')
  else await run('open', ['-a', application, path], signal, 'hidden')
}

/** 解析拥有该文件的桌面，包括从 WSL 可达的 Windows 应用。 */
async function desktopTarget(
  path: string, signal: AbortSignal, internals: PathOpenerInternals,
): Promise<{ platform: NodeJS.Platform; path: string }> {
  signal.throwIfAborted()
  const platform = internals.platform ?? process.platform
  if (platform === 'linux' && nativeFileManager(internals) === 'explorer') {
    const translated = await (internals.run ?? runNativeCommand)('wslpath', ['-w', path], signal, 'hidden')
    signal.throwIfAborted()
    const windowsPath = translated.stdout.replace(/[\r\n]+$/, '')
    if (windowsPath === '') throw new Error('wslpath returned no Windows path')
    return { platform: 'win32', path: windowsPath }
  }
  return { platform, path }
}
