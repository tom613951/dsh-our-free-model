import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

// 通过 esbuild 动态打包测试模块
const tempFile = path.join(__dirname, '.test-workbuddy-intl-bundle.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        claimDailyCheckin,
        triggerWorkBuddyIntlDailyActive,
      } from './vendor/channel-pack/src/buddy-credits.ts'
      export { WORKBUDDY, CODEBUDDY } from './vendor/channel-pack/src/product.ts'
    `,
    resolveDir: rootDir,
    sourcefile: 'test-workbuddy-intl-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  packages: 'external',
  outfile: tempFile,
  format: 'esm',
  platform: 'node',
})

let claimDailyCheckin, triggerWorkBuddyIntlDailyActive, WORKBUDDY
try {
  const mod = await import(pathToFileURL(tempFile).href)
  claimDailyCheckin = mod.claimDailyCheckin
  triggerWorkBuddyIntlDailyActive = mod.triggerWorkBuddyIntlDailyActive
  WORKBUDDY = mod.WORKBUDDY
} finally {
  try {
    fs.unlinkSync(tempFile)
  } catch {}
}

console.log('Testing WorkBuddy International Daily Active Heartbeat integration...')

const mockCredential = {
  access_token: 'test_token_intl_123',
  user_id: 'user_intl_789',
  enterprise_id: '',
  domain: 'www.workbuddy.ai',
}

function createMockFetcher(handlers = {}) {
  return async (url, options = {}) => {
    const urlStr = String(url)
    const method = options.method || 'GET'
    const pathname = new URL(urlStr).pathname

    if (handlers[pathname]) {
      const resp = handlers[pathname](method, options)
      return {
        status: resp.status || 200,
        ok: (resp.status || 200) < 400,
        text: async () => JSON.stringify(resp.body || {}),
        json: async () => resp.body || {},
      }
    }

    return {
      status: 404,
      ok: false,
      text: async () => JSON.stringify({ code: 404, msg: 'Not found' }),
      json: async () => ({ code: 404, msg: 'Not found' }),
    }
  }
}

// 场景 1: 国际版发送轻量心跳成功激活
{
  let chatRequested = false
  let notifyRequested = false

  const mockFetcher = createMockFetcher({
    '/v2/chat/completions': (method, options) => {
      chatRequested = true
      assert.equal(method, 'POST')
      const headers = options.headers
      assert.equal(headers.get('Authorization'), 'Bearer test_token_intl_123')
      assert.equal(headers.get('X-Domain'), 'www.workbuddy.ai')
      const body = JSON.parse(options.body)
      assert.equal(body.model, 'fast-model')
      assert.equal(body.max_tokens, 1)
      assert.equal(body.messages[0].content, 'ping')
      return { status: 200, body: { id: 'chat_resp_1', choices: [] } }
    },
    '/v2/billing/meter/get-dosage-notify': () => {
      notifyRequested = true
      return { status: 200, body: { code: 0, data: { message: '今日活跃配额已下发' } } }
    },
  })

  const outcome = await claimDailyCheckin(mockCredential, WORKBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 0)
  assert.ok(chatRequested)
  assert.ok(notifyRequested)
  assert.ok(outcome.delayedMessage?.includes('已向国际版发送轻量心跳激活当日活跃配额'))
  assert.ok(outcome.delayedMessage?.includes('今日活跃配额已下发'))
  console.log('✓ 场景 1 通过：国际版轻量心跳成功触发活跃度并拉取到通知')
}

// 场景 2: 国际版凭据失效（401 / 403）
{
  const mockFetcher = createMockFetcher({
    '/v2/chat/completions': () => ({
      status: 401,
      body: { code: 401, message: 'Unauthorized' },
    }),
  })

  const outcome = await claimDailyCheckin(mockCredential, WORKBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.code, 401)
  assert.ok(outcome.message?.includes('凭据已失效'))
  console.log('✓ 场景 2 通过：401 凭据失效正常捕获')
}

// 场景 3: 缺少 access_token
{
  const outcome = await claimDailyCheckin({ access_token: '' }, WORKBUDDY)
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.code, 401)
  assert.ok(outcome.message?.includes('缺少 access_token'))
  console.log('✓ 场景 3 通过：缺少 token 防御校验正常')
}

console.log('ALL WORKBUDDY INTL HEARTBEAT CHECKS PASSED!')
