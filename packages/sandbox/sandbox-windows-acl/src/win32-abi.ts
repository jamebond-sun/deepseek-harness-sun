/** ACL/令牌特有的 Win32 常量。 */

/** 查询当前进程令牌所需的 OpenProcess 访问权限。 */
export const PROCESS_QUERY_INFORMATION = 0x0400
/** CreateProcessAsUserW 所需的令牌权限。 */
export const TOKEN_ASSIGN_PRIMARY = 0x0001
/** DuplicateTokenEx 所需的令牌权限。 */
export const TOKEN_DUPLICATE = 0x0002
/** 读取令牌信息所需的令牌权限。 */
export const TOKEN_QUERY = 0x0008
/** 替换令牌默认 DACL 所需的令牌权限。 */
export const TOKEN_ADJUST_DEFAULT = 0x0080
/** 标识令牌登录 SID 的组属性。 */
export const SE_GROUP_LOGON_ID = 0xC0000000
/** 从写入能力授予中排除掉的标准权限部分。 */
export const STANDARD_RIGHTS_WRITE = 0x00020000
/** 通用文件写入访问权限位。 */
export const FILE_GENERIC_WRITE = 0x00120116
/** 删除或重命名一个对象。 */
export const DELETE = 0x00010000
/** 删除或重命名一个目录的子项。 */
export const FILE_DELETE_CHILD = 0x0040
/**
 * 授予写入、删除与子项删除的能力 SID 访问掩码。WRITE_DAC 与 WRITE_OWNER
 * 被刻意排除在外，因此受限子进程无法重写 DACL 或夺取所有权来逃出允许列表。
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE
/** 受限令牌默认 DACL 中使用的完全访问权限。 */
export const FILE_ALL_ACCESS = 0x1F01FF
/** 关闭最高特权的 CreateRestrictedToken 标志。 */
export const DISABLE_MAX_PRIVILEGE = 0x1
/** CreateRestrictedToken 的受限用户标志。 */
export const LUA_TOKEN = 0x4
/** 把写入访问限制到所列出的限制 SID。 */
export const WRITE_RESTRICTED = 0x8
/** Everyone 的 WELL_KNOWN_SID_TYPE 取值。 */
export const WinWorldSid = 1
/** 令牌组的 TOKEN_INFORMATION_CLASS 取值。 */
export const TokenGroups = 2
/** 令牌默认 DACL 的 TOKEN_INFORMATION_CLASS 取值。 */
export const TokenDefaultDacl = 6
/** 选中 DACL 的 SECURITY_INFORMATION 标志。 */
export const DACL_SECURITY_INFORMATION = 0x00000004
/** 选中强制完整性标签的 SECURITY_INFORMATION 标志。 */
export const LABEL_SECURITY_INFORMATION = 0x00000010
/** 承载强制完整性标签的 ACE 类型。 */
export const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11
/**
 * 拒绝对更高完整性对象进行写类访问的强制策略。内核在访问检查内部应用它，
 * 因此它也覆盖了经由父目录 FILE_DELETE_CHILD 权限所授予的写入与删除——
 * 这正是写入受限的第二趟交集所触达不到的那条路径。
 */
export const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP = 0x00000001
/** 令牌完整性级别的 TOKEN_INFORMATION_CLASS 取值。 */
export const TokenIntegrityLevel = 25
/** 标记 TOKEN_MANDATORY_LABEL 中完整性 SID 的组属性。 */
export const SE_GROUP_INTEGRITY = 0x00000020
/** Low 强制级别（S-1-16-4096）的 WELL_KNOWN_SID_TYPE 取值。 */
export const WinLowLabelSid = 66
/** x64 下 TOKEN_MANDATORY_LABEL 的字节大小（SID 是被引用，而非内嵌）。 */
export const TOKEN_MANDATORY_LABEL_SIZE = 16
/** x64 下 ACL 头的字节大小（AclRevision、Sbz1、AclSize、AceCount、Sbz2）。 */
export const ACL_HEADER_SIZE = 8
/** 一个 SYSTEM_MANDATORY_LABEL_ACE 在 ACL 头与其 SID 之外所占的字节数。 */
export const MANDATORY_ACE_OVERHEAD = 8
/** InitializeAcl 与 AddMandatoryAce 接受的 ACL 修订号。 */
export const ACL_REVISION = 2
/** 选中零初始化固定内存的 LocalAlloc 标志（LMEM_FIXED | LMEM_ZEROINIT）。 */
export const LPTR = 0x0040
/** 文件系统对象的 SE_OBJECT_TYPE 取值。 */
export const SE_FILE_OBJECT = 1
/** 受托者分类未知时使用的 TRUSTEE_TYPE 取值。 */
export const TRUSTEE_IS_UNKNOWN = 0
/** 表示受托者为一个 SID 指针的 TRUSTEE_FORM 取值。 */
export const TRUSTEE_IS_SID = 0
/** 受托者记录没有链式受托者。 */
export const NO_MULTIPLE_TRUSTEE = 0
/** 授予访问权限的 EXPLICIT_ACCESS 模式。 */
export const GRANT_ACCESS = 1
/** 拒绝访问权限的 EXPLICIT_ACCESS 模式。 */
export const DENY_ACCESS = 3
/** 撤销访问权限的 EXPLICIT_ACCESS 模式。 */
export const REVOKE_ACCESS = 4
/** 面向子容器与子对象的 ACE 继承标志。 */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3
/** 仅面向子容器（目录；文件不继承）的 ACE 继承标志。 */
export const CONTAINER_INHERIT_ACE = 0x2
/** GetTempPathW 使用的旧式 Win32 最大路径字符数。 */
export const MAX_PATH = 260
/** Win32 成功状态码。 */
export const ERROR_SUCCESS = 0
/** 无法立即取得字节区间锁时上报的 Win32 错误。 */
export const ERROR_LOCK_VIOLATION = 33
/** 通用读取访问位。 */
export const GENERIC_READ = 0x80000000
/** 通用写入访问位。 */
export const GENERIC_WRITE = 0x40000000
/** CreateFile 的共享读标志。 */
export const FILE_SHARE_READ = 0x00000001
/** CreateFile 的共享写标志。 */
export const FILE_SHARE_WRITE = 0x00000002
/** CreateFile 的共享删除标志。 */
export const FILE_SHARE_DELETE = 0x00000004
/** 打开或创建该文件的 CreateFile 处置方式。 */
export const OPEN_ALWAYS = 4
/** LockFileEx 的独占锁标志。 */
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2
/** LockFileEx 的立即失败标志。 */
export const LOCKFILE_FAIL_IMMEDIATELY = 0x1
/** 允许访问项的 ACE 类型。 */
export const ACCESS_ALLOWED_ACE_TYPE = 0
/** 拒绝访问项的 ACE 类型（与允许型 ACE 共用 Mask/SID 布局）。 */
export const ACCESS_DENIED_ACE_TYPE = 1
/** SID 子授权机构的最大数量。 */
export const SID_MAX_SUB_AUTHORITIES = 15
/** 标记继承项的 ACE 标志。 */
export const INHERITED_ACE = 0x10
/** SID 分配的最大字节数。 */
export const SECURITY_MAX_SID_SIZE = 68
/** x64 下 SID_AND_ATTRIBUTES 的字节大小。 */
export const SID_AND_ATTRIBUTES_SIZE = 16
/** x64 下 TOKEN_GROUPS 中首个组条目的偏移。 */
export const TOKEN_GROUPS_OFFSET = 8
/** x64 下 EXPLICIT_ACCESS_W 的字节大小。 */
export const EXPLICIT_ACCESS_W_SIZE = 48
/** x64 下 TRUSTEE_W 在 EXPLICIT_ACCESS_W 内的偏移。 */
export const TRUSTEE_W_OFFSET = 16
/** x64 下 ptstrName 在 TRUSTEE_W 内的偏移。 */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24
