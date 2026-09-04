import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { parsePreparationArguments } from '../../../scripts/prepare-product-candidate.mjs'
import { assertProductArchiveSize, MAX_PRODUCT_ARCHIVE_BYTES } from '../scripts/product-size-policy.js'

test('product preparation defaults to pinned metadata without an offline wheel bundle', () => {
  const output = path.join(tmpdir(), 'ps-product')
  assert.deepEqual(parsePreparationArguments(['--output', output]), { output })
  assert.deepEqual(parsePreparationArguments(['--output', output, '--offline', '--wheelhouse', output]), {
    output, offline: true, wheelhouse: output,
  })
  assert.deepEqual(parsePreparationArguments(['--offline', '--output', output, '--metadata', output]), {
    offline: true, output, directory: output,
  })
})

test('offline options cannot silently change the normal published product', () => {
  const output = path.join(tmpdir(), 'ps-product')
  for (const option of ['--wheelhouse', '--metadata']) {
    assert.throws(() => parsePreparationArguments(['--output', output, option, output]), /require explicit --offline/)
  }
  for (const args of [[], ['--output'], ['--output', 'relative'], ['--output', output, '--unknown'],
    ['--output', output, '--offline', '--offline'], ['--output', output, '--output', output]]) {
    assert.throws(() => parsePreparationArguments(args), /Usage:/)
  }
})

test('small archive policy catches oversized/invalid candidates before publishing', () => {
  for (const size of [1, 16_110_199, MAX_PRODUCT_ARCHIVE_BYTES]) assert.doesNotThrow(() => assertProductArchiveSize(size))
  for (const size of [MAX_PRODUCT_ARCHIVE_BYTES + 1, 204_897_944, 0, -1, 1.5, NaN, Infinity, undefined, '16110199']) {
    assert.throws(() => assertProductArchiveSize(size), /50 MiB/)
  }
})
