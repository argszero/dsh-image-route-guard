import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

test('the built entry exists and is what package.json points at', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.main, 'lib/index.js')
  assert.ok(existsSync(join(root, manifest.main)), 'main must exist in the repo, not only after a build')
  assert.ok(existsSync(join(root, manifest.types)), 'types must exist in the repo')
})

test('every file the manifest publishes is present', () => {
  const manifest = JSON.parse(read('package.json'))
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(join(root, entry)), `${entry} is published but missing`)
  }
})

test('the runtime imports nothing the harness profile cannot resolve', () => {
  // Regression pin for the defect this packaging exists to prevent: importing
  // @deepseek-ai/dsh-llm made `dsh plugin add` succeed (rc=0) and the installed
  // copy throw ERR_MODULE_NOT_FOUND, because a profile carries the plugin, not
  // the harness's own dependency tree.
  const built = read('lib/index.js')
  const specifiers = [...built.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(specifiers, ['@deepseek-ai/schemastery'])
})

test('the bundle patch names the plugin exactly once', () => {
  const patch = read('cordis.patch.yml')
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const mounted = patch.split('\n').filter((line) => line.trim().startsWith('name:'))
  assert.deepEqual(mounted, [`      name: '${manifest.name}'`], 'the patch must mount this package exactly once')
})
