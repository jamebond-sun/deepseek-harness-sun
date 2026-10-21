/** 在 x64 上校验过的、通用的 Win32 进程、stdio 与 Job Object 常量。 */

/** STARTUPINFOW 使用标准输入、输出与错误句柄。 */
export const STARTF_USESTDHANDLES = 0x00000100
/** STARTUPINFOW 在创建控制台窗口时应用 wShowWindow。 */
export const STARTF_USESHOWWINDOW = 0x00000001
/** 保留子进程控制台依附关系的初始窗口可见性。 */
export const SW_HIDE = 0
/** 允许子进程继承的 HandleInformation 标志。 */
export const HANDLE_FLAG_INHERIT = 0x1
/** WaitForSingleObject 的无限超时。 */
export const INFINITE = 0xFFFFFFFF
/** WaitForSingleObject 因零时长探测未被触发而返回。 */
export const WAIT_TIMEOUT = 258
/** 防止用户代码在恢复前运行的 CreateProcess 标志。 */
export const CREATE_SUSPENDED = 0x4
/** 选择 UTF-16 环境块的 CreateProcess 标志。 */
export const CREATE_UNICODE_ENVIRONMENT = 0x400
/** 用于标准输入的 GetStdHandle 选择器。 */
export const STD_INPUT_HANDLE = -10
/** 用于标准输出的 GetStdHandle 选择器。 */
export const STD_OUTPUT_HANDLE = -11
/** 用于标准错误的 GetStdHandle 选择器。 */
export const STD_ERROR_HANDLE = -12
/** FormatMessage 读取操作系统的消息表。 */
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000
/** FormatMessage 不对插入占位符作解释。 */
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200
/** 报告调用方提供的缓冲区过小的 Win32 代码。 */
export const ERROR_INSUFFICIENT_BUFFER = 122
/** 报告管道另一端已关闭的 Win32 代码。 */
export const ERROR_BROKEN_PIPE = 109
/** 报告管道已无剩余数据的 Win32 代码。 */
export const ERROR_NO_DATA = 232
/** 在最后一个 Job 句柄关闭时终止每个成员的 Job 限制。 */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
/** 用于基础记账与活动进程计数的 QueryInformationJobObject 类。 */
export const JobObjectBasicAccountingInformation = 1
/** 用于 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 的 SetInformationJobObject 类。 */
export const JobObjectExtendedLimitInformation = 9
/** x64 下 JOBOBJECT_BASIC_ACCOUNTING_INFORMATION 的字节大小。 */
export const JOBOBJECT_BASIC_ACCOUNTING_SIZE = 48
/** ActiveProcesses 在 JOBOBJECT_BASIC_ACCOUNTING_INFORMATION 中的字节偏移。 */
export const JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET = 40
/** x64 下 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 的字节大小。 */
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
/** BasicLimitInformation.LimitFlags 在扩展 Job 记录中的字节偏移。 */
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16
/** 由原生探测校验过的 x64 STARTUPINFOW 字节大小。 */
export const STARTUPINFOW_SIZE = 104
/** 由原生探测校验过的 x64 PROCESS_INFORMATION 字节大小。 */
export const PROCESS_INFORMATION_SIZE = 24
