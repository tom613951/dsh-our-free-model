import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Exercise the production packager with a tiny repository on every CI platform.
// The engine bytes are a fixture: this suite never executes a native binary.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const temporaryRoot = path.resolve(os.tmpdir())
const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'ofm desktop engine '))
const fixture = path.join(scratch, 'repository')
const service = path.join(scratch, 'resources', 'service')
const target = `${process.platform}-${process.arch}`
const binaryPath = `bin/magpie-${target}${process.platform === 'win32' ? '.exe' : ''}`
const engineBytes = Buffer.from('offline engine packaging fixture\0\x01')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const metadata = { version: 'packaging-fixture', binaries: { [target]: { path: binaryPath, sha256: digest(engineBytes) } } }
const write = (relative, bytes = '// fixture\n') => {
  const file = path.join(fixture, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

try {
  write('scripts/prepare-desktop.mjs', fs.readFileSync(new URL('./prepare-desktop.mjs', import.meta.url)))
  write('src/fixture.js')
  for (const name of ['cli', 'service', 'management', 'desktop-update', 'login-terminal', 'open-external', 'eac',
    'workbench', 'providers', 'library', 'client-terminal', 'routing', 'feedback']) write(`packages/standalone/${name}.mjs`)
  write('packages/standalone/channels/fixture.mjs')
  write('packages/standalone/web/assets.json', JSON.stringify(['fixture.js']))
  for (const name of ['index.html', 'splash.html', 'fixture.js']) write(`packages/standalone/web/${name}`)
  write('packages/standalone/package.json', '{}')
  write('packages/desktop/service-host.mjs')
  for (const name of ['qoder-auth-wasm.wasm', 'LICENSE', 'NOTICE.md']) write(`vendor/channel-pack/${name}`)
  write('vendor/magpie/engine.json', JSON.stringify(metadata))
  for (const name of ['LICENSE', 'NOTICE.md']) write(`vendor/magpie/${name}`, `engine ${name}\n`)
  write(`vendor/magpie/${binaryPath}`, engineBytes)
  write('icon.svg', '<svg/>')
  write('LICENSE', 'fixture license\n')
  write('scripts/standalone-third-party.txt', 'fixture notices\n')

  const { stageDesktopService } = await import(pathToFileURL(path.join(fixture, 'scripts/prepare-desktop.mjs')))
  stageDesktopService(service, { requireWorkspace: true })
  const config = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'packages/desktop/src-tauri/tauri.conf.json')))
  assert.equal(config.bundle.resources['resources/service/'], 'service/')
  for (const name of ['engine.json', 'LICENSE', 'NOTICE.md']) {
    const relative = `vendor/magpie/${name}`
    assert.ok(fs.existsSync(path.join(service, relative)), `${relative} must be inside the bundled service`)
    assert.deepEqual(fs.readFileSync(path.join(service, relative)), fs.readFileSync(path.join(fixture, relative)))
  }
  console.log('ok 1 engine manifest and licenses are inside the Tauri service resource root')
  const stagedMetadata = JSON.parse(fs.readFileSync(path.join(service, 'vendor/magpie/engine.json')))
  const stagedBinary = fs.readFileSync(path.join(service, 'vendor/magpie', stagedMetadata.binaries[target].path))
  assert.equal(digest(stagedBinary), metadata.binaries[target].sha256)
  console.log('ok 2 the pinned engine binary is staged beside its manifest without changing bytes')
  assert.equal(fs.existsSync(path.join(scratch, 'resources/vendor/magpie')), false)
  console.log('ok 3 engine resources do not escape into an unbundled sibling directory')

  fs.unlinkSync(path.join(fixture, 'vendor/magpie', binaryPath))
  assert.throws(() => stageDesktopService(path.join(scratch, 'missing-binary/service'), { requireWorkspace: true }),
    error => error.code === 'ENOENT')
  console.log('ok 4 a required but missing engine binary still fails packaging')
  write('vendor/magpie/engine.json', JSON.stringify({ binaries: {} }))
  assert.throws(() => stageDesktopService(path.join(scratch, 'unpinned/service'), { requireWorkspace: true }),
    /模型工作台需要/)
  console.log('ok 5 an unpinned required target still fails packaging')
} finally {
  assert.equal(path.dirname(scratch), temporaryRoot)
  fs.rmSync(scratch, { recursive: true, force: true })
}
