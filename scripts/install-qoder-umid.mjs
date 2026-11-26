import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')
const tempFile = path.join(__dirname, '.install-qoder-umid-bundle.mjs')

await esbuild.build({
  stdin: {
    contents: `export { installQoderUmid } from './vendor/channel-pack/src/qoder-umid-installer.ts'`,
    resolveDir: rootDir,
    sourcefile: 'install-qoder-umid-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  packages: 'external',
  outfile: tempFile,
  format: 'esm',
  platform: 'node',
})

let installQoderUmid
try {
  const mod = await import(pathToFileURL(tempFile).href)
  installQoderUmid = mod.installQoderUmid
} finally {
  try {
    fs.unlinkSync(tempFile)
  } catch {}
}

const force = process.argv.includes('--force')
const result = await installQoderUmid({ force })
console.log(JSON.stringify(result, null, 2))
