import { mkdir, readdir, readFile, lstat, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { hash, invariant, uid } from './util'
import { looksSecret } from './vault'

const Metadata = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().trim().min(1).max(1024),
})
export type InstalledSkill = { name: string; description: string; hash: string; path: string }
type SkillPackage = InstalledSkill & { files: { path: string; content: Buffer }[]; text: string }

/** Agent Skills format. Installation copies a reviewed package; it never runs install scripts. */
export class Skills {
  readonly root: string
  constructor(dataDir: string) {
    this.root = join(dataDir, 'skills')
  }
  async inspect(path: string): Promise<SkillPackage> {
    const root = await realpath(path)
    const files: SkillPackage['files'] = []
    let bytes = 0
    const visit = async (directory: string, depth: number) => {
      invariant(depth < 8, 'Skill directories are too deeply nested.')
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        invariant(!entry.isSymbolicLink(), 'Skill packages cannot contain symbolic links.')
        invariant(
          !['.git', '.env', '.ssh', 'node_modules'].includes(entry.name),
          'Skill packages cannot contain secrets, Git state, or installed dependencies.',
        )
        const target = join(directory, entry.name)
        if (entry.isDirectory()) await visit(target, depth + 1)
        else {
          const stat = await lstat(target)
          invariant(
            stat.isFile() &&
              stat.size <= 128_000 &&
              bytes + stat.size <= 512_000 &&
              files.length < 64,
            'Skill packages are limited to 64 small text files and 512 KB.',
          )
          const content = await readFile(target)
          invariant(
            !content.includes(0) && !looksSecret(content.toString('utf8')),
            'Skill packages must contain text without credentials.',
          )
          bytes += content.length
          files.push({ path: relative(root, target), content })
        }
      }
    }
    await visit(root, 0)
    const text = files.find((file) => file.path === 'SKILL.md')?.content.toString('utf8')
    invariant(text, 'The selected directory needs a SKILL.md file.')
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    invariant(header, 'SKILL.md needs YAML name and description fields.')
    const metadata = Metadata.parse(parse(header[1], { maxAliasCount: 0 }))
    const fingerprint = hash(
      files
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({ path: file.path, hash: hash(file.content.toString('base64')) })),
    )
    return { ...metadata, hash: fingerprint, path: root, text, files }
  }
  async list(): Promise<InstalledSkill[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const result: InstalledSkill[] = []
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const { name, description, hash, path } = await this.inspect(join(this.root, entry.name))
        if (entry.name === name) result.push({ name, description, hash, path })
      } catch {
        /* An invalid or edited package is not offered to an agent. */
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }
  async read(name: string) {
    Metadata.shape.name.parse(name)
    const info = await lstat(join(this.root, name))
    invariant(info.isDirectory() && !info.isSymbolicLink(), 'This skill is not installed.')
    return this.inspect(join(this.root, name))
  }
  async install(source: string, expectedHash: string) {
    const skill = await this.inspect(source)
    invariant(skill.hash === expectedHash, 'The skill changed after it was reviewed.')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const destination = join(this.root, skill.name)
    invariant(
      !(await lstat(destination).catch(() => null)),
      'This skill is already installed. Remove the reviewed version before replacing it.',
    )
    const temporary = join(this.root, `.${uid()}`)
    await mkdir(temporary, { mode: 0o700 })
    try {
      // Write the exact bytes inspected above, rather than re-reading a mutable source directory.
      for (const file of skill.files) {
        const path = join(temporary, file.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, file.content, { mode: 0o600, flag: 'wx' })
      }
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return { name: skill.name, hash: skill.hash, path: destination }
  }
  async remove(name: string, expectedHash: string) {
    const skill = await this.read(name)
    invariant(skill.hash === expectedHash, 'The installed skill changed after it was reviewed.')
    const path = relative(await realpath(this.root), skill.path)
    invariant(!isAbsolute(path) && !path.startsWith('..'), 'The skill is outside Jarvis storage.')
    await rm(skill.path, { recursive: true })
    return { removed: name }
  }
}
