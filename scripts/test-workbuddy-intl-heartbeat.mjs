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
      const status = resp.status || 200
      if (typeof resp.rawText === 'string' || resp.stream === true) {
        const payloadText = typeof resp.rawText === 'string' ? resp.rawText : JSON.stringify(resp.body || {})
        return new Response(payloadText, {
          status,
          headers: resp.headers || { 'Content-Type': resp.stream ? 'text/event-stream' : 'application/json' },
        })
      }
      return {
        status,
        ok: status < 400,
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

// 场景 1: /v3/config 动态挑选免费轻量模型 + 流式心跳 + 活跃事件上报成功
{
  let chatReq = null
  let reportReq = null
  let notifyRequested = false

  const mockFetcher = createMockFetcher({
    '/v3/config': (method) => {
      assert.equal(method, 'GET')
      return {
        status: 200,
        body: {
          code: 0,
          data: {
            agents: [{ name: 'cli', models: ['auto', 'max-model', 'hy4std', 'hy4flash-free'] }],
            models: [{ id: 'hy4flash-free' }, { id: 'auto' }],
          },
        },
      }
    },
    '/v2/chat/completions': (method, options) => {
      chatReq = {
        method,
        headers: options.headers,
        body: JSON.parse(options.body),
      }
      return {
        status: 200,
        stream: true,
        rawText: 'data: {"id":"chat_resp_1","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      }
    },
    '/v2/report': (method, options) => {
      reportReq = {
        method,
        headers: options.headers,
        body: JSON.parse(options.body),
      }
      return { status: 200, body: { code: 0, msg: 'OK' } }
    },
    '/v2/billing/meter/get-dosage-notify': () => {
      notifyRequested = true
      return { status: 200, body: { code: 0, data: { message: '今日活跃配额已下发' } } }
    },
  })

  const outcome = await claimDailyCheckin({ ...mockCredential, user_id: 'uid_intl_1' }, WORKBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 0)
  assert.ok(chatReq)
  assert.equal(chatReq.method, 'POST')
  assert.equal(chatReq.headers.get('Authorization'), 'Bearer test_token_intl_123')
  assert.equal(chatReq.headers.get('Accept'), 'text/event-stream')
  assert.equal(chatReq.headers.get('X-Domain'), 'www.workbuddy.ai')
  assert.equal(chatReq.headers.get('X-Product'), 'WorkBuddy')
  assert.equal(chatReq.headers.get('X-Agent-Purpose'), 'conversation')
  assert.equal(chatReq.headers.get('X-IDE-Name'), 'WorkBuddy')
  assert.equal(chatReq.headers.get('X-IDE-Type'), 'WorkBuddy')
  assert.ok(chatReq.headers.get('X-IDE-Version')?.length > 0)
  assert.ok(chatReq.headers.get('X-Conversation-ID')?.length > 0)
  assert.ok(chatReq.headers.get('X-Conversation-Message-ID')?.length > 0)
  assert.ok(chatReq.headers.get('X-Conversation-Request-ID')?.length > 0)
  assert.equal(chatReq.body.model, 'hy4flash-free')
  assert.equal(chatReq.body.stream, true)
  assert.equal(chatReq.body.max_tokens, 1)
  assert.equal(chatReq.body.messages[0].role, 'system')
  assert.equal(chatReq.body.messages[1].role, 'user')
  assert.equal(chatReq.body.messages[1].content, 'ping')

  assert.ok(reportReq)
  assert.equal(reportReq.method, 'POST')
  assert.equal(reportReq.body[0].eventCode, 'chat_request_send')
  assert.equal(reportReq.body[0].userId, 'uid_intl_1')
  assert.equal(reportReq.body[0].requestModelId, 'hy4flash-free')
  assert.ok(notifyRequested)
  assert.ok(outcome.delayedMessage?.includes('hy4flash-free'))
  assert.ok(outcome.delayedMessage?.includes('今日活跃配额已下发'))
  console.log('✓ 场景 1 通过：动态选中 hy4flash-free 并发起流式心跳与活跃上报')
}

// 场景 2: /v3/config 不可达时自动回落 auto（不回落已下线的 fast-model）
{
  let usedModel = null
  const mockFetcher = createMockFetcher({
    '/v2/chat/completions': (_method, options) => {
      usedModel = JSON.parse(options.body).model
      return { status: 200, stream: true, rawText: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n' }
    },
  })

  const outcome = await triggerWorkBuddyIntlDailyActive(mockCredential, WORKBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(usedModel, 'auto')
  console.log('✓ 场景 2 通过：/v3/config 缺失时回落 auto 而非 fast-model')
}

// 场景 3: 401 凭据失效正常捕获
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
  console.log('✓ 场景 3 通过：401 凭据失效正常捕获')
}

// 场景 4: 403 + 11140 风控限制与凭据失效严格区分
{
  const mockFetcher = createMockFetcher({
    '/v2/chat/completions': () => ({
      status: 403,
      body: {
        code: 11140,
        msg: 'request illegal',
        displayMsg: {
          en: 'Your account has been restricted due to unusual activity',
          zh: '账号存在异常行为，已被限制使用',
        },
      },
    }),
  })

  const outcome = await claimDailyCheckin(mockCredential, WORKBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.code, 403)
  assert.ok(outcome.message?.includes('11140'))
  assert.ok(outcome.message?.includes('账号存在异常行为，已被限制使用'))
  assert.equal(outcome.message?.includes('凭据已失效'), false)
  console.log('✓ 场景 4 通过：403/11140 账号风控准确上报，不误报凭据失效')
}

// 场景 5: 400 (如 11101) 与 429 不得吞掉错当作 claimed
{
  const mock400 = createMockFetcher({
    '/v2/chat/completions': () => ({
      status: 400,
      body: { code: 11101, msg: 'Non-stream chat request is currently not supported' },
    }),
  })
  const out400 = await claimDailyCheckin(mockCredential, WORKBUDDY, mock400)
  assert.equal(out400.kind, 'failed')
  assert.equal(out400.code, 11101)

  const mock429 = createMockFetcher({
    '/v2/chat/completions': () => ({
      status: 429,
      body: { code: 429, msg: 'Too Many Requests' },
    }),
  })
  const out429 = await claimDailyCheckin(mockCredential, WORKBUDDY, mock429)
  assert.equal(out429.kind, 'failed')
  assert.equal(out429.code, 429)
  assert.ok(out429.message?.includes('限流'))
  console.log('✓ 场景 5 通过：HTTP 400 与 429 均如实失败，不再假报成功')
}

// 场景 6: HTTP 200 流内携带错误码时如实判定失败
{
  const mockSseErr = createMockFetcher({
    '/v2/chat/completions': () => ({
      status: 200,
      stream: true,
      rawText: 'data: {"code":11140,"msg":"request illegal","displayMsg":{"zh":"账号存在异常行为，已被限制使用"}}\n\n',
    }),
  })

  const outSseErr = await claimDailyCheckin(mockCredential, WORKBUDDY, mockSseErr)
  assert.equal(outSseErr.kind, 'failed')
  assert.equal(outSseErr.code, 403)
  assert.ok(outSseErr.message?.includes('11140'))
  console.log('✓ 场景 6 通过：HTTP 200 SSE 流内错误精准拦截')
}

// 场景 7: 缺少 access_token
{
  const outcome = await claimDailyCheckin({ access_token: '' }, WORKBUDDY)
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.code, 401)
  assert.ok(outcome.message?.includes('缺少 access_token'))
  console.log('✓ 场景 7 通过：缺少 token 防御校验正常')
}

console.log('ALL WORKBUDDY INTL HEARTBEAT CHECKS PASSED!')
