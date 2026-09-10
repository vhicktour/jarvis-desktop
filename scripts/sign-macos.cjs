const { signAsync } = require('@electron/osx-sign')
const { openSync, readSync, closeSync, statSync, realpathSync } = require('node:fs')
const { resolve } = require('node:path')

const executableHeaders = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
])

module.exports = async function signMac(options) {
  const originalOptions = options.optionsForFile
  await signAsync({
    ...options,
    ignore(file) {
      if (!statSync(file).isFile()) return false
      const fd = openSync(file, 'r')
      try {
        const header = Buffer.alloc(4)
        readSync(fd, header, 0, 4, 0)
        // Python source, model data, fonts, and locale packs are sealed as resources.
        return !executableHeaders.has(header.toString('hex'))
      } finally {
        closeSync(fd)
      }
    },
    optionsForFile(file) {
      const base = originalOptions?.(file) ?? {}
      return /\/workers\/runtime\/[^/]+\/bin\/python3[.]12$/.test(realpathSync(file))
        ? { ...base, entitlements: resolve('native/model-entitlements.plist') }
        : base
    },
  })
}
