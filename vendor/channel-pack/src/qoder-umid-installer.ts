/**
 * Qoder UMID 自动解包：从 `@qoder-ai/qodercli` 官方包里取出 `runtime-info`。
 *
 * ## 为什么需要它
 *
 * `qoder-machine.ts` 的**主路径**是实时 spawn `runtime-info(.exe)` 以生成
 * `Cosy-MachineToken` / `Cosy-MachineType`；缺这两个头时服务端**不下发可领取
 * 的活动**（见该文件模块注释的消融表）。但纯插件用户**没装 Qoder 桌面端**，
 * 本机就没有这个可执行文件 —— 只能退回陈旧磁盘缓存，于是再次落入
 * 「没领过却显示今天已领」那个缺陷（误报已领会让用户真的错过当天积分）。
 *
 * 官方 CLI 包 `@qoder-ai/qodercli` 是**纯 npm 包**（无需安装客户端），它的
 * `bundle/qoder-worker-runtime.mjs` 里内嵌了各平台的 UMID 二进制，以**超长
 * base64 字符串字面量**形式存在。把它们取出来落盘，就能在未安装桌面端的
 * 机器上复用与官方逐字节相同的 `runtime-info`。
 *
 * ## 约束（都是踩过的坑）
 *
 * - **依赖只有 node 内建模块**：本文件会被打进 `pack.js`，不能引入三方包；
 * - **扫描绝不能用正则**：`sgsdk.dll` 的 base64 字面量约 9.8 MB，任何
 *   回溯型正则会直接 `RangeError: Maximum call stack size exceeded`；
 *   故 {@link scanLongBase64Literals} 是线性 charCode 扫描（O(n)、无回溯）；
 * - **产物必须与官方成对**：win32 上 `runtime-info.exe` 依赖同目录的
 *   `sgsdk.dll`，缺一个都跑不起来，故两者**同时**解出，否则不下任何文件。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/**
 * 官方 CLI 包的 npm 元数据地址（`latest` 标签）。
 *
 * 用 registry 直连而不是 `npm pack`：本模块在**运行时**被调用（用户点一次
 * 「一键领取」的冷路径），不能假设本机有 npm 可执行文件。
 */
export const QODERCLI_REGISTRY_URL = 'https://registry.npmjs.org/@qoder-ai/qodercli/latest'

/**
 * 认定为「内嵌二进制」的字面量最小长度。
 *
 * 实测 `runtime-info.exe` 约 1 MB（base64 ≈ 1.4 MB）、`sgsdk.dll` 约 9.8 MB
 * （base64 ≈ 13 MB）。取 4000 是为了**排除**同一文件里大量小的 base64 常量
 * （图标、密钥、小段 wasm），同时给未来二进制小幅缩水留足余量。
 */
export const UMID_BLOB_MIN_LEN = 4000

/** 一个内嵌二进制按魔数识别出的类型。 */
export type UmidBlobKind =
  | 'pe-x64-exe'
  | 'pe-x64-dll'
  | 'pe-arm64-exe'
  | 'pe-arm64-dll'
  | 'elf-x64'
  | 'elf-arm64'
  | 'macho-x64'
  | 'macho-arm64'
  | 'wasm'
  | 'unknown'

/** 一次安装的结果（也用于「已装」的短路返回）。 */
export interface UmidInstallResult {
  /** 产物目录（`runtime-info(.exe)` 与 win32 的 `sgsdk.dll` 都在这）。 */
  dir: string
  /** `runtime-info(.exe)` 的绝对路径。 */
  executablePath: string
  /** win32 才有：同目录的 `sgsdk.dll`（`runtime-info.exe` 的硬依赖）。 */
  companionDllPath?: string
  /** 来源包的版本号（`@qoder-ai/qodercli` 的 `version`）。 */
  version: string
  /** `true` = 命中已有产物，本次没有下载。 */
  alreadyInstalled: boolean
}

/**
 * 默认产物目录：`<dshHome>/channel-pack/qoder-umid`。
 *
 * `QODER_UMID_DIR` 可覆盖（供单测隔离与用户自定义）；home 取 `DSH_HOME`
 * （与其它 channel-pack 状态同源），缺省 `~/.dsh`。
 */
export function resolveDefaultUmidDir(): string {
  const override = process.env.QODER_UMID_DIR?.trim()
  if (override !== undefined && override.length > 0) return override
  const fromEnv = process.env.DSH_HOME?.trim()
  const baseHome = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
  return join(baseHome, 'channel-pack', 'qoder-umid')
}

/**
 * 检查产物目录里是否已有**可用**的二进制；返回可执行文件路径或 `undefined`。
 *
 * ⚠️ win32 **必须**同时要求 `sgsdk.dll`：只有 exe 时 spawn 会因缺 DLL 直接
 * 失败（Windows 报「找不到指定的模块」），表现为「装了却永远拿不到身份」。
 */
export function hasInstalledUmidBinary(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') {
    const exe = join(dir, 'runtime-info.exe')
    const dll = join(dir, 'sgsdk.dll')
    if (existsSync(exe) && existsSync(dll)) return exe
    return undefined
  }
  const exe = join(dir, 'runtime-info')
  return existsSync(exe) ? exe : undefined
}

/** base64 字符集（`0-9` `A-Z` `a-z` `+` `/` `=`）判定，纯 charCode 比较。 */
function isBase64Char(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 ||
    code === 47 ||
    code === 61
  )
}

/**
 * 扫描源码里长度 ≥ `minLen` 的**单引号/双引号 base64 字面量**。
 *
 * ⚠️ **禁止用正则**（真实缺陷）：`sgsdk.dll` 的字面量约 9.8 MB，`/([A-Za-z0-9+/=]+)/`
 * 这类分组捕获会让 V8 爆栈（`Maximum call stack size exceeded`）。这里是对
 * 字符的一次线性遍历：命中引号后向右找「连续的 base64 字符 + 同种引号闭合」，
 * 长度够就收下，然后从闭合引号之后继续 —— 全程无回溯，复杂度 O(n)。
 *
 * 反斜杠与换行**不算** base64 字符，故转义串/模板串天然被排除。
 */
export function scanLongBase64Literals(
  source: string,
  minLen: number = UMID_BLOB_MIN_LEN,
): string[] {
  const found: string[] = []
  const length = source.length
  let index = 0
  while (index < length) {
    const quote = source.charCodeAt(index)
    if (quote !== 39 && quote !== 34) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < length && isBase64Char(source.charCodeAt(end))) end += 1
    // 必须以**同种**引号闭合才算字面量；否则这一串不是我们想要的常量。
    if (end < length && source.charCodeAt(end) === quote) {
      if (end - index - 1 >= minLen) found.push(source.slice(index + 1, end))
      index = end + 1
      continue
    }
    // 未闭合：跳过这段 base64 字符，保证整体仍是 O(n)
    index = end
  }
  return found
}

/** 按小端读 uint16/uint32（越界一律 0，调用方负责先判长度）。 */
function readLe16(raw: Uint8Array, offset: number): number {
  return (raw[offset] ?? 0) | ((raw[offset + 1] ?? 0) << 8)
}

function readLe32(raw: Uint8Array, offset: number): number {
  return (
    ((raw[offset] ?? 0) |
      ((raw[offset + 1] ?? 0) << 8) |
      ((raw[offset + 2] ?? 0) << 16) |
      ((raw[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

/**
 * 按魔数识别二进制类型（PE / ELF / Mach-O / wasm）。
 *
 * 全部读取都**先判长度**：这些字节来自 base64 解码，可能是截断/损坏的，
 * 越界读取在 `Uint8Array` 上会静默返回 `undefined` 并被当成 0，
 * 于是可能把一段垃圾识别成合法 PE —— 故长度是分类的一部分。
 */
export function identifyUmidBlob(raw: Uint8Array): UmidBlobKind {
  const byte = (offset: number): number => raw[offset] ?? 0

  // wasm：\0asm
  if (raw.length >= 4 && byte(0) === 0x00 && byte(1) === 0x61 && byte(2) === 0x73 && byte(3) === 0x6d) {
    return 'wasm'
  }

  // ELF：0x7f 'E' 'L' 'F'，e_machine 在 offset 18
  if (raw.length >= 20 && byte(0) === 0x7f && byte(1) === 0x45 && byte(2) === 0x4c && byte(3) === 0x46) {
    const machine = readLe16(raw, 18)
    if (machine === 0x3e) return 'elf-x64'
    if (machine === 0xb7) return 'elf-arm64'
    return 'unknown'
  }

  // Mach-O 64：magic 0xfeedfacf，cputype 在 offset 4
  if (raw.length >= 8 && readLe32(raw, 0) === 0xfeedfacf) {
    const cpuType = readLe32(raw, 4)
    if (cpuType === 0x01000007) return 'macho-x64'
    if (cpuType === 0x0100000c) return 'macho-arm64'
    return 'unknown'
  }

  // PE：'MZ' + e_lfanew(60) → 'PE\0\0' → machine(peOff+4) / characteristics(peOff+22)
  if (raw.length >= 64 && byte(0) === 0x4d && byte(1) === 0x5a) {
    const peOff = readLe32(raw, 60)
    // 需要读到 peOff+24（characteristics 末尾）才可判定
    if (peOff + 24 <= raw.length) {
      const isPe =
        byte(peOff) === 0x50 && byte(peOff + 1) === 0x45 && byte(peOff + 2) === 0x00 && byte(peOff + 3) === 0x00
      if (isPe) {
        const machine = readLe16(raw, peOff + 4)
        // IMAGE_FILE_DLL = 0x2000：区分 exe / dll 靠它，不是靠文件名
        const isDll = (readLe16(raw, peOff + 22) & 0x2000) !== 0
        if (machine === 0x8664) return isDll ? 'pe-x64-dll' : 'pe-x64-exe'
        if (machine === 0xaa64) return isDll ? 'pe-arm64-dll' : 'pe-arm64-exe'
      }
    }
    return 'unknown'
  }

  return 'unknown'
}

/** 读 tar 头里的定长字段（NUL 截断 + 去尾部空格）。 */
function readTarString(header: Uint8Array, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && (header[end] ?? 0) !== 0) end += 1
  let text = ''
  for (let index = offset; index < end; index += 1) text += String.fromCharCode(header[index] ?? 0)
  return text.replace(/ +$/, '')
}

/**
 * 从 `.tar.gz` 里取出单个成员（npm 包的 tarball 形态）。
 *
 * 只实现 POSIX ustar 子集：512 字节头、`name[0..100]`、八进制 `size[124..136]`、
 * `prefix[345..500]`，数据按 512 对齐；遇到全零块即结束（tar 的归档终止标记）。
 */
export function extractFileFromTarGz(tgzBuffer: Uint8Array, memberPath: string): Buffer | undefined {
  let raw: Buffer
  try {
    raw = gunzipSync(tgzBuffer)
  } catch {
    // 不是合法的 gzip：交给调用方当作「取不到」
    return undefined
  }

  let offset = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    // 全零块 = 归档结束（两个零块是标准结尾，遇到第一个即可停）
    let zero = true
    for (let index = 0; index < 512; index += 1) {
      if ((header[index] ?? 0) !== 0) { zero = false; break }
    }
    if (zero) return undefined

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const sizeText = readTarString(header, 124, 12).trim()
    const size = sizeText.length > 0 ? Number.parseInt(sizeText, 8) : 0
    const safeSize = Number.isFinite(size) && size >= 0 ? size : 0
    const dataStart = offset + 512
    const dataEnd = dataStart + safeSize
    if (dataEnd > raw.length) return undefined

    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name
    if (fullName === memberPath) return raw.subarray(dataStart, dataEnd)

    // 数据段按 512 对齐，故偏移必须向上取整
    offset = dataStart + Math.ceil(safeSize / 512) * 512
  }
  return undefined
}

/** 已识别的一个内嵌二进制。 */
interface UmidCandidate {
  kind: UmidBlobKind
  data: Buffer
}

/**
 * 在同类候选里挑一个：优先满足 `prefer`，其次取**最大**的。
 *
 * 取最大是安全方向：同一 kind 的小体积候选通常是占位/裁剪版，
 * 而真实二进制被 base64 打包时往往还有 debug 段。
 */
function pickCandidate(
  candidates: readonly UmidCandidate[],
  kind: UmidBlobKind,
  prefer: (data: Buffer) => boolean,
): UmidCandidate | undefined {
  const matched = candidates.filter((candidate) => candidate.kind === kind)
  if (matched.length === 0) return undefined
  const preferred = matched.filter((candidate) => prefer(candidate.data))
  const pool = preferred.length > 0 ? preferred : matched
  return pool.reduce((best, candidate) => (candidate.data.length > best.data.length ? candidate : best))
}

/** 先写临时文件再 `rename`，避免半个文件被当成「已安装」。 */
function writeAtomic(target: string, data: Uint8Array): void {
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, data)
  try {
    renameSync(temp, target)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
}

/** 读 `.version` 元数据里的版本号（缺失/损坏时回退 `'unknown'`）。 */
function readInstalledVersion(dir: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, '.version'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as Record<string, unknown>).version
      if (typeof version === 'string' && version.length > 0) return version
    }
  } catch {
    // 没有元数据（旧版本产物/写入中断）：不影响可用性
  }
  return 'unknown'
}

/** 从 npm registry 的 metadata 里取一个字符串字段（含 `dist.` 前缀）。 */
function readMetaString(source: unknown, ...keys: string[]): string | undefined {
  let current: unknown = source
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined
}

/** 单飞表：同一 `destDir` 的并发调用共享一次下载。 */
const inflight = new Map<string, Promise<UmidInstallResult>>()

/**
 * 安装（或复用）UMID 产物。
 *
 * 同一 `destDir` 的并发调用会**共享同一个** Promise（单飞），否则多个请求
 * 同时冷启动会各下一份 13 MB 的包。⚠️ 传入自定义 `fetcher`/`force` 时**不共享**
 * （测试与强制重装必须拿到各自的结果）。
 */
export async function installQoderUmid(options: {
  destDir?: string
  fetcher?: typeof fetch
  force?: boolean
  platform?: NodeJS.Platform
  arch?: string
} = {}): Promise<UmidInstallResult> {
  const destDir = options.destDir ?? resolveDefaultUmidDir()
  const shareable = options.fetcher === undefined && options.force !== true
  if (!shareable) {
    return await installQoderUmidInternal(
      destDir,
      options.platform ?? process.platform,
      options.arch ?? process.arch,
      options.fetcher ?? fetch,
      options.force === true,
    )
  }
  const running = inflight.get(destDir)
  if (running !== undefined) return await running
  const task = installQoderUmidInternal(
    destDir,
    options.platform ?? process.platform,
    options.arch ?? process.arch,
    options.fetcher ?? fetch,
    options.force === true,
  ).finally(() => { inflight.delete(destDir) })
  inflight.set(destDir, task)
  return await task
}

/** 真正的安装流程（单飞包装之外的部分，便于测试独立调用）。 */
async function installQoderUmidInternal(
  destDir: string,
  platform: NodeJS.Platform,
  arch: string,
  fetcher: typeof fetch,
  force: boolean,
): Promise<UmidInstallResult> {
  const installed = hasInstalledUmidBinary(destDir, platform)
  if (installed !== undefined && !force) {
    return {
      dir: destDir,
      executablePath: installed,
      // win32 的 dll 与 exe 是成对的（`hasInstalledUmidBinary` 已确保存在）
      ...(platform === 'win32' ? { companionDllPath: join(destDir, 'sgsdk.dll') } : {}),
      version: readInstalledVersion(destDir),
      alreadyInstalled: true,
    }
  }

  // ① 取 registry 元数据
  let meta: unknown
  try {
    const response = await fetcher(QODERCLI_REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
    meta = await response.json()
  } catch (error) {
    throw new Error(`无法获取 ${QODERCLI_REGISTRY_URL}：${error instanceof Error ? error.message : String(error)}`)
  }
  const version = readMetaString(meta, 'version')
  const tarball = readMetaString(meta, 'dist', 'tarball')
  const integrity = readMetaString(meta, 'dist', 'integrity')
  if (version === undefined || tarball === undefined) {
    throw new Error('官方 CLI 包元数据缺少 version/dist.tarball')
  }

  // ② 下载 tarball 并校验完整性
  let tgz: Uint8Array
  try {
    const response = await fetcher(tarball, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    tgz = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new Error(`下载 ${tarball} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (integrity !== undefined && integrity.startsWith('sha512-')) {
    const digest = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
    if (digest !== integrity) {
      throw new Error(`tarball 完整性校验失败（期望 ${integrity}，实得 ${digest}）`)
    }
  }

  // ③ 解出 runtime 脚本并扫描内嵌二进制
  const runtimeMjs = extractFileFromTarGz(tgz, 'package/bundle/qoder-worker-runtime.mjs')
  if (runtimeMjs === undefined) {
    throw new Error('官方 CLI 包里没有 package/bundle/qoder-worker-runtime.mjs')
  }
  const candidates: UmidCandidate[] = []
  for (const literal of scanLongBase64Literals(runtimeMjs.toString('utf8'), UMID_BLOB_MIN_LEN)) {
    const data = Buffer.from(literal, 'base64')
    candidates.push({ kind: identifyUmidBlob(data), data })
  }

  // ④ 按平台/架构挑选。挑选失败即**整体失败**：只落一半的产物比没有更糟
  //    （`hasInstalledUmidBinary` 会认为已装，之后永远拿不到身份）。
  const selections: Array<{ name: string; data: Buffer }> = []
  if (platform === 'win32') {
    const isArm = arch === 'arm64'
    // exe 通常 200 KB–2 MB；dll 是 9.8 MB 级别的巨型依赖
    const exe = pickCandidate(candidates, isArm ? 'pe-arm64-exe' : 'pe-x64-exe', (data) => data.length >= 200 * 1024 && data.length <= 2 * 1024 * 1024)
    const dll = pickCandidate(candidates, isArm ? 'pe-arm64-dll' : 'pe-x64-dll', (data) => data.length > 2 * 1024 * 1024)
    if (exe === undefined || dll === undefined) {
      throw new Error(`官方 CLI 包 ${version} 里没有匹配 win32/${arch} 的 runtime-info/sgsdk 二进制`)
    }
    selections.push({ name: 'runtime-info.exe', data: exe.data }, { name: 'sgsdk.dll', data: dll.data })
  } else if (platform === 'darwin') {
    const exe = pickCandidate(candidates, arch === 'arm64' ? 'macho-arm64' : 'macho-x64', () => true)
    if (exe === undefined) throw new Error(`官方 CLI 包 ${version} 里没有匹配 darwin/${arch} 的 runtime-info 二进制`)
    selections.push({ name: 'runtime-info', data: exe.data })
  } else {
    const exe = pickCandidate(candidates, arch === 'arm64' ? 'elf-arm64' : 'elf-x64', () => true)
    if (exe === undefined) throw new Error(`官方 CLI 包 ${version} 里没有匹配 ${platform}/${arch} 的 runtime-info 二进制`)
    selections.push({ name: 'runtime-info', data: exe.data })
  }

  // ⑤ 落盘（先临时文件再 rename）
  mkdirSync(destDir, { recursive: true })
  for (const selection of selections) {
    writeAtomic(join(destDir, selection.name), selection.data)
  }
  const executablePath = join(destDir, platform === 'win32' ? 'runtime-info.exe' : 'runtime-info')
  if (platform !== 'win32') {
    // 落盘默认不带可执行位，缺它 spawn 会 EACCES
    chmodSync(executablePath, 0o755)
  }
  writeAtomic(join(destDir, '.version'), Buffer.from(JSON.stringify({ version, installedAt: Date.now() }), 'utf8'))

  return {
    dir: destDir,
    executablePath,
    ...(platform === 'win32' ? { companionDllPath: join(destDir, 'sgsdk.dll') } : {}),
    version,
    alreadyInstalled: false,
  }
}

/**
 * 确保产物已就绪；返回可执行文件路径，失败（离线/包里没匹配项）返回 `undefined`。
 *
 * ⚠️ **不抛错**：这是积分链路上的一步增强，装不上必须安静降级回
 * 「不带 machine 头」（与修复前行为一致），不能把签到整体弄失败。
 */
export async function ensureQoderUmidInstalled(): Promise<string | undefined> {
  try {
    const result = await installQoderUmid()
    return result.executablePath
  } catch {
    return undefined
  }
}
