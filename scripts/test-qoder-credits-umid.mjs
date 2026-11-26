import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const tempFile = path.join(__dirname, '.test-qoder-credits-umid-bundle.mjs')
const kernel = pathToFileURL(path.join(rootDir, 'scripts/lib/channel-pack-kernel.mjs')).href
const llmKernel = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(kernel)}
export class LlmError extends Error {
  constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status }
}
let nextMessage = 0
export function createUserMessage(value) { return { id: 'fixture-message-' + ++nextMessage, ...value } }
`)}`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llmKernel, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

await esbuild.build({
  stdin: {
    contents: `
      export * from './vendor/channel-pack/src/qoder-umid-installer.ts'
      export * from './vendor/channel-pack/src/qoder-machine.ts'
      export * from './vendor/channel-pack/src/qoder-credits.ts'
      export * from './vendor/channel-pack/src/qoder-product.ts'
      export { qoderDisplayName } from './vendor/channel-pack/src/qoder-adapter.ts'
    `,
    resolveDir: rootDir,
    sourcefile: 'test-qoder-credits-umid-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  packages: 'external',
  outfile: tempFile,
  format: 'esm',
  platform: 'node',
})

let mod
try {
  mod = await import(pathToFileURL(tempFile).href)
} finally {
  try {
    fs.unlinkSync(tempFile)
  } catch {}
}

const {
  UMID_BLOB_MIN_LEN,
  scanLongBase64Literals,
  identifyUmidBlob,
  extractFileFromTarGz,
  installQoderUmid,
  runtimeInfoEnvironmentFor,
  runtimeInfoArgs,
  resolveQoderMachineIdentityAsync,
  resetQoderMachineIdentityCache,
  QODER_CAMPAIGN_FAILURE_CN,
  claimQoderCampaign,
  claimQoderDailyCheckin,
  QODER,
  QODER_CN,
  qoderDisplayName,
} = mod

function buildPeBinary({ machine, isDll }) {
  const buf = Buffer.alloc(160)
  buf[0] = 0x4d
  buf[1] = 0x5a
  buf.writeUInt32LE(0x80, 60)
  buf.write('PE\0\0', 0x80, 'ascii')
  buf.writeUInt16LE(machine, 0x84)
  buf.writeUInt16LE(isDll ? 0x2000 : 0x0002, 0x80 + 22)
  return buf
}

function buildElfBinary(machine) {
  const buf = Buffer.alloc(32)
  buf[0] = 0x7f
  buf.write('ELF', 1, 'ascii')
  buf.writeUInt16LE(machine, 18)
  return buf
}

function buildMachoBinary(cpuType) {
  const buf = Buffer.alloc(32)
  buf.writeUInt32LE(0xfeedfacf, 0)
  buf.writeUInt32LE(cpuType, 4)
  return buf
}

function buildTarGz(entries) {
  const chunks = []
  for (const { name, content } of entries) {
    const header = Buffer.alloc(512)
    header.write(name, 0, Math.min(name.length, 100), 'utf8')
    header.write('0000644\0', 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header.fill(' ', 148, 156)
    header[156] = '0'.charCodeAt(0)
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
    chunks.push(header)
    const padded = Math.ceil(content.length / 512) * 512
    const dataBlock = Buffer.alloc(padded)
    content.copy(dataBlock)
    chunks.push(dataBlock)
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const savedEnv = {
  QODER_RUNTIME_INFO: process.env.QODER_RUNTIME_INFO,
  QODER_AUTO_INSTALL_UMID: process.env.QODER_AUTO_INSTALL_UMID,
  QODER_MACHINE_TOKEN_PATH: process.env.QODER_MACHINE_TOKEN_PATH,
  QODER_UMID_DIR: process.env.QODER_UMID_DIR,
  DSH_CHANNEL_PACK_STATE_DIR: process.env.DSH_CHANNEL_PACK_STATE_DIR,
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-qoder-umid-test-'))

try {
  // 1. scanLongBase64Literals: handles >10M char single base64 literal without RangeError, skips short & invalid
  const hugeBlob = 'A'.repeat(10_500_000)
  const shortBlob = 'B'.repeat(UMID_BLOB_MIN_LEN - 1)
  const escapedBlob = 'C'.repeat(UMID_BLOB_MIN_LEN) + '\\n' + 'C'.repeat(100)
  const multilineBlob = 'D'.repeat(UMID_BLOB_MIN_LEN) + '\n' + 'D'.repeat(100)
  const secondHuge = 'Q'.repeat(4500) + '=='
  const sampleSrc = `const a="${shortBlob}";const b='${escapedBlob}';const c="${multilineBlob}";const dll="${hugeBlob}";const exe='${secondHuge}';`
  const scanned = scanLongBase64Literals(sampleSrc, UMID_BLOB_MIN_LEN)
  assert.equal(scanned.length, 2)
  assert.equal(scanned[0].length, 10_500_000)
  assert.equal(scanned[1], secondHuge)

  // 2. identifyUmidBlob: PE exe/dll, ELF, Mach-O, WASM, unknown, truncated
  assert.equal(identifyUmidBlob(buildPeBinary({ machine: 0x8664, isDll: false })), 'pe-x64-exe')
  assert.equal(identifyUmidBlob(buildPeBinary({ machine: 0x8664, isDll: true })), 'pe-x64-dll')
  assert.equal(identifyUmidBlob(buildPeBinary({ machine: 0xaa64, isDll: false })), 'pe-arm64-exe')
  assert.equal(identifyUmidBlob(buildPeBinary({ machine: 0xaa64, isDll: true })), 'pe-arm64-dll')
  assert.equal(identifyUmidBlob(buildElfBinary(0x3e)), 'elf-x64')
  assert.equal(identifyUmidBlob(buildElfBinary(0xb7)), 'elf-arm64')
  assert.equal(identifyUmidBlob(buildMachoBinary(0x01000007)), 'macho-x64')
  assert.equal(identifyUmidBlob(buildMachoBinary(0x0100000c)), 'macho-arm64')
  assert.equal(identifyUmidBlob(Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])), 'wasm')
  assert.equal(identifyUmidBlob(Uint8Array.from([0x4d, 0x5a, 0x00, 0x00])), 'unknown')
  assert.equal(identifyUmidBlob(Buffer.from('plain text')), 'unknown')

  // 2b. extractFileFromTarGz + installQoderUmid with synthetic npm tarball
  const mockExe = Buffer.concat([buildPeBinary({ machine: 0x8664, isDll: false }), Buffer.alloc(250 * 1024, 0x90)])
  const mockDll = Buffer.concat([buildPeBinary({ machine: 0x8664, isDll: true }), Buffer.alloc(2_200_000, 0x90)])
  const workerRuntimeJs = `const e="${mockExe.toString('base64')}";const d="${mockDll.toString('base64')}";`
  const tgz = buildTarGz([{ name: 'package/bundle/qoder-worker-runtime.mjs', content: Buffer.from(workerRuntimeJs, 'utf8') }])
  const extracted = extractFileFromTarGz(tgz, 'package/bundle/qoder-worker-runtime.mjs')
  assert.ok(extracted !== undefined)
  assert.equal(extracted.toString('utf8'), workerRuntimeJs)

  const installDest = path.join(tmpDir, 'umid-install')
  const installRes = await installQoderUmid({
    destDir: installDest,
    platform: 'win32',
    arch: 'x64',
    fetcher: async (url) => {
      if (String(url).endsWith('/latest')) {
        return jsonResponse(200, { version: '9.9.9-test', dist: { tarball: 'https://mock.local/pkg.tgz' } })
      }
      return new Response(tgz, { status: 200 })
    },
  })
  assert.equal(installRes.version, '9.9.9-test')
  assert.equal(installRes.alreadyInstalled, false)
  assert.equal(fs.existsSync(path.join(installDest, 'runtime-info.exe')), true)
  assert.equal(fs.existsSync(path.join(installDest, 'sgsdk.dll')), true)
  assert.equal(identifyUmidBlob(fs.readFileSync(path.join(installDest, 'runtime-info.exe'))), 'pe-x64-exe')
  assert.equal(identifyUmidBlob(fs.readFileSync(path.join(installDest, 'sgsdk.dll'))), 'pe-x64-dll')

  // 3. runtimeInfoEnvironmentFor & runtimeInfoArgs
  assert.equal(runtimeInfoEnvironmentFor('qoder'), '3')
  assert.equal(runtimeInfoEnvironmentFor('qodercn'), '0')
  assert.equal(runtimeInfoEnvironmentFor(undefined), '3')
  assert.deepEqual(runtimeInfoArgs('0', 'win32'), ['0', '--account-stdin'])
  assert.deepEqual(runtimeInfoArgs('3', 'darwin'), ['3', '--account-stdin'])
  assert.deepEqual(runtimeInfoArgs('0', 'linux'), ['0'])

  // 4. Offline isolation + cachedByEnv separation
  resetQoderMachineIdentityCache()
  process.env.QODER_RUNTIME_INFO = path.join(tmpDir, 'missing-runtime-info.exe')
  process.env.QODER_AUTO_INSTALL_UMID = '0'
  process.env.QODER_MACHINE_TOKEN_PATH = path.join(tmpDir, 'missing-machine-token.json')
  delete process.env.DSH_CHANNEL_PACK_STATE_DIR

  const missingIdentity = await resolveQoderMachineIdentityAsync(undefined, 'qoder')
  assert.equal(missingIdentity, undefined)

  resetQoderMachineIdentityCache()
  const fileIntl = path.join(tmpDir, 'token-intl.json')
  const fileCn = path.join(tmpDir, 'token-cn.json')
  fs.writeFileSync(fileIntl, JSON.stringify({ token: 'tok-intl', type: 'type-intl' }), 'utf8')
  fs.writeFileSync(fileCn, JSON.stringify({ token: 'tok-cn', type: 'type-cn' }), 'utf8')

  process.env.QODER_MACHINE_TOKEN_PATH = fileIntl
  const idIntl = await resolveQoderMachineIdentityAsync(undefined, 'qoder')
  assert.deepEqual(idIntl, { token: 'tok-intl', type: 'type-intl' })

  process.env.QODER_MACHINE_TOKEN_PATH = fileCn
  const idCn = await resolveQoderMachineIdentityAsync(undefined, 'qodercn')
  assert.deepEqual(idCn, { token: 'tok-cn', type: 'type-cn' })

  // Switching path must NOT overwrite cached bucket '3' ('qoder')
  const idIntlAgain = await resolveQoderMachineIdentityAsync(undefined, 'qoder')
  assert.deepEqual(idIntlAgain, { token: 'tok-intl', type: 'type-intl' })

  // Verify claimQoderDailyCheckin passes product.id headers distinctly per product
  const dummyCred = { access_token: 'tok-bearer', refresh_token: 'ref', expires_at: Date.now() + 3600_000 }
  const seenHeaders = []
  for (const product of [QODER, QODER_CN]) {
    await claimQoderDailyCheckin(
      dummyCred,
      product,
      async (_url, init) => {
        seenHeaders.push({ product: product.id, headers: init?.headers })
        return jsonResponse(200, { showCampaign: false, claimable: false, campaigns: [] })
      },
      Date.UTC(2026, 10, 26, 6, 0, 0),
    )
  }
  const intlReqHeaders = seenHeaders.find((h) => h.product === 'qoder')?.headers
  const cnReqHeaders = seenHeaders.find((h) => h.product === 'qodercn')?.headers
  assert.equal(intlReqHeaders['Cosy-MachineToken'], 'tok-intl')
  assert.equal(cnReqHeaders['Cosy-MachineToken'], 'tok-cn')

  // 5. claimQoderCampaign & claimQoderDailyCheckin refusal semantics
  {
    const res = await claimQoderCampaign(dummyCred, QODER, 'camp-1', async () =>
      jsonResponse(409, { errorCode: 'ALREADY_CLAIMED' }),
    )
    assert.equal(res.kind, 'already-claimed')
  }
  {
    const res = await claimQoderCampaign(dummyCred, QODER, 'camp-1', async () =>
      jsonResponse(409, { message: 'not confirmed' }),
    )
    assert.equal(res.kind, 'failed')
    assert.equal(res.code, 409)
  }
  {
    const res = await claimQoderCampaign(dummyCred, QODER, 'camp-1', async () =>
      jsonResponse(200, { status: 'BLOCKED', failureCode: 'RISK_BLOCKED' }),
    )
    assert.equal(res.kind, 'failed')
    assert.ok(res.message.includes('风控拦截'))
  }
  {
    const res = await claimQoderCampaign(dummyCred, QODER, 'camp-1', async () =>
      jsonResponse(200, { status: 'BLOCKED', failureCode: 'SAME_PERSON_ALREADY_CLAIMED' }),
    )
    assert.equal(res.kind, 'inactive')
    assert.ok(res.message.includes('同人/同设备'))
  }
  {
    const res = await claimQoderCampaign(dummyCred, QODER, 'camp-1', async () =>
      jsonResponse(200, { success: false, message: 'denied' }),
    )
    assert.equal(res.kind, 'failed')
    assert.equal(res.message, 'denied')
  }
  {
    const res = await claimQoderCampaign(dummyCred, QODER, 'camp-1', async () =>
      jsonResponse(200, { replayed: true }),
    )
    assert.equal(res.kind, 'already-claimed')
  }
  {
    const res = await claimQoderCampaign(dummyCred, QODER, 'camp-1', async () =>
      jsonResponse(200, { status: 'CLAIMED', benefit: { amount: 100 } }),
    )
    assert.equal(res.kind, 'claimed')
    assert.equal(res.credit, 100)
  }
  {
    const res = await claimQoderDailyCheckin(
      dummyCred,
      QODER,
      async () =>
        jsonResponse(200, {
          showCampaign: true,
          claimable: false,
          campaigns: [
            {
              campaignId: 'c1',
              actionType: 'CLAIM_BENEFIT',
              claimStatus: 'UNAVAILABLE',
              unavailableReason: 'ACHIEVEMENT_NOT_COMPLETED',
            },
          ],
        }),
      Date.UTC(2026, 10, 26, 6, 0, 0),
    )
    assert.equal(res.kind, 'inactive')
    assert.ok(res.message.includes('需先完成新人任务'))
  }
  {
    const res = await claimQoderDailyCheckin(
      dummyCred,
      QODER,
      async () =>
        jsonResponse(200, {
          showCampaign: true,
          claimable: false,
          campaigns: [
            {
              campaignId: 'c2',
              actionType: 'CLAIM_BENEFIT',
              claimStatus: 'UNAVAILABLE',
              unavailableReason: 'RISK_BLOCKED',
            },
          ],
        }),
      Date.UTC(2026, 10, 26, 6, 0, 0),
    )
    assert.equal(res.kind, 'failed')
    assert.ok(res.message.includes('风控拦截'))
  }
  assert.ok(QODER_CAMPAIGN_FAILURE_CN.RISK_BLOCKED)

  // 6. HungerG intl-only free model
  const intlHungerG = QODER.fallbackModels.find((m) => m.id === 'HungerG')
  assert.ok(intlHungerG !== undefined, 'QODER.fallbackModels must include HungerG')
  assert.equal(intlHungerG.isFree, true)
  assert.equal(intlHungerG.priceFactor, 0)
  assert.equal(qoderDisplayName(intlHungerG), 'HungerG · 免费')
  assert.equal(
    QODER_CN.fallbackModels.some((m) => m.id === 'HungerG'),
    false,
    'QODER_CN.fallbackModels must NOT include HungerG',
  )

  // 7. Rebuilt pack.js contains required markers
  const packPath = path.join(rootDir, 'vendor/channel-pack/pack.js')
  const packText = fs.readFileSync(packPath, 'utf8')
  for (const marker of ['scanLongBase64Literals', 'runtimeInfoEnvironmentFor', 'QODER_CAMPAIGN_FAILURE_CN', 'HungerG']) {
    assert.equal(packText.includes(marker), true, `pack.js missing marker: ${marker}`)
  }

  console.log('ok  qoder credits & UMID auto-extractor tests passed')
} finally {
  hooks.deregister()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
