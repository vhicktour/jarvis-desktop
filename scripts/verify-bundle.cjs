const { readdirSync, lstatSync, realpathSync } = require('node:fs')
const { join, relative, isAbsolute } = require('node:path')

/** Reject machine-specific links before signing can follow one outside the bundle. */
module.exports = async function verifyBundle(context) {
  const root = realpathSync(join(context.appOutDir, 'Jarvis.app'))
  function inspect(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) {
        const target = relative(root, realpathSync(path))
        if (target === '..' || target.startsWith('../') || isAbsolute(target))
          throw new Error(`The app bundle contains an external symlink: ${relative(root, path)}`)
      } else if (info.isDirectory()) inspect(path)
    }
  }
  inspect(root)
}
