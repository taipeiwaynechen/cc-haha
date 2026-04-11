/**
 * Local staging directory for IM-downloaded resources.
 *
 * Layout: {root}/{platform}/{sessionId}/{safeName}
 * Default root: ~/.claude/im-downloads
 *
 * Responsibilities:
 *  - Generate unique, safe paths from (platform, sessionId, originalName)
 *  - Atomic write (tmp → rename) so concurrent downloads never corrupt each other
 *  - GC files that haven't been touched for `retentionMs` (default 24h)
 */

import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { ImPlatform } from './attachment-types.js'

export interface AttachmentStoreConfig {
  root: string
  retentionMs: number
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000

function defaultRoot(): string {
  return path.join(os.homedir(), '.claude', 'im-downloads')
}

/** Strip path separators / .. / control chars from a filename. */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(name || '').replace(/[\x00-\x1f]/g, '')
  const cleaned = base.replace(/[\/\\]/g, '_').replace(/\.\.+/g, '_')
  return cleaned.trim() || 'unnamed'
}

export class AttachmentStore {
  private readonly root: string
  private readonly retentionMs: number

  constructor(config?: Partial<AttachmentStoreConfig>) {
    this.root = config?.root ?? defaultRoot()
    this.retentionMs = config?.retentionMs ?? DEFAULT_RETENTION_MS
  }

  /** Compute the target path. Creates parent dirs on demand.
   *  If a file with the same name already exists, prefix with a timestamp
   *  to avoid clobbering. */
  resolvePath(platform: ImPlatform, sessionId: string, name: string): string {
    const safeSession = sanitizeFilename(sessionId)
    const dir = path.join(this.root, platform, safeSession)
    fsSync.mkdirSync(dir, { recursive: true })
    const safeName = sanitizeFilename(name)
    const candidate = path.join(dir, safeName)
    if (!fsSync.existsSync(candidate)) return candidate
    const { name: base, ext } = path.parse(safeName)
    return path.join(dir, `${base}-${Date.now()}${ext}`)
  }

  /** Write atomically: stream to {target}.part, then rename. */
  async write(target: string, data: Buffer): Promise<string> {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${Date.now()}.part`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, target)
    return target
  }

  /** Remove files older than retentionMs. Returns summary. */
  async gc(): Promise<{ removed: number; bytes: number }> {
    let removed = 0
    let bytes = 0
    const now = Date.now()

    const walk = async (dir: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(full)
            const age = now - stat.mtimeMs
            if (age > this.retentionMs) {
              bytes += stat.size
              await fs.unlink(full)
              removed++
            }
          } catch {
            // ignore races
          }
        }
      }
    }

    await walk(this.root).catch(() => {})
    return { removed, bytes }
  }
}
