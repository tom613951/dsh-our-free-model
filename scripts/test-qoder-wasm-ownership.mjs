import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const wasmTsUrl = pathToFileURL(path.join(repoRoot, 'vendor', 'channel-pack', 'src', 'qoder-wasm.ts')).href

const bundled = await build({
  stdin: {
    contents: `export * from './vendor/channel-pack/src/qoder-wasm.ts'`,
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
})

const moduleCode = bundled.outputFiles[0].text.replace(
  'import.meta.url',
  JSON.stringify(wasmTsUrl),
)
const mod = await import(`data:text/javascript;base64,${Buffer.from(moduleCode, 'utf8').toString('base64')}`)
const { QoderEncryptedInfer } = mod

// 场景 1: 连续 50 轮 create -> prepareInfer(qfmodel) -> dispose，验证无 WASM input double-free trap
const metadata = { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' }
for (let i = 1; i <= 50; i++) {
  const client = await QoderEncryptedInfer.create({
    user: { uid: `uid-${i}`, securityOauthToken: `tok-${i}` },
    machineId: '11111111-1111-4111-8111-111111111111',
    metadata,
    host: 'https://api2.qoder.sh',
  })
  try {
    const req = client.prepareInfer({
      modelKey: 'qfmodel',
      userText: `round ${i}`,
      displayName: 'Qwen3.8-Flash',
      maxInputTokens: 1_000_000,
      isReasoning: true,
      isVl: true,
      business: { type: 'agent' },
    })
    assert.ok(req.url.includes('agent_chat_generation'), `round ${i} url mismatch`)
    assert.ok(req.headers.Authorization?.startsWith('Bearer COSY.'), `round ${i} missing COSY Authorization`)
    assert.ok(req.body.length > 0, `round ${i} empty encrypted body`)
  } finally {
    client.dispose()
    client.dispose()
  }
}
console.log('✓ 场景 1 通过：50 轮 Qoder WASM create/prepareInfer(qfmodel)/dispose 连续调用无 unreachable，幂等释放正常')

// 场景 2: prepareInfer 在读取 headers 抛错时仍释放 RequestResult
{
  const released = []
  const readError = new Error('fixture header read failed')
  const resultPointer = 42
  const glue = {
    withStrings: () => resultPointer,
    exports: {
      requestresult_headers: () => { throw readError },
      __wbg_requestresult_free: (ptr) => released.push(ptr),
    },
  }
  const failingClient = new QoderEncryptedInfer(glue, 1, metadata, 'localhost')
  assert.throws(() => failingClient.prepareInfer({ modelKey: 'qfmodel', userText: 'offline' }), (err) => err === readError)
  assert.deepEqual(released, [resultPointer])
  console.log('✓ 场景 2 通过：prepareInfer 异常分支可靠释放 RequestResult')
}

// 场景 3: 产物 pack.js 包含 WASM 上下文/结果释放且不包含输入双释放循环
{
  const packPath = path.join(repoRoot, 'vendor', 'channel-pack', 'pack.js')
  const packTxt = fs.readFileSync(packPath, 'utf8')
  assert.equal(packTxt.includes('__wbg_qodercontext_free'), true, 'pack.js missing __wbg_qodercontext_free')
  assert.equal(packTxt.includes('__wbg_requestresult_free'), true, 'pack.js missing __wbg_requestresult_free')
  assert.equal(packTxt.includes('if (outPtr) g.exports.__wbindgen_export4(outPtr, outLen, 1)'), true, 'pack.js missing returned string free')
  assert.equal(packTxt.includes('freeString(pointers[i], lengths[i])'), false, 'pack.js still has WASM input double-free loop')
  console.log('✓ 场景 3 通过：pack.js 已清理 WASM 输入双重释放并保留 context/result/输出串释放')
}

console.log('ALL QODER WASM OWNERSHIP CHECKS PASSED!')
