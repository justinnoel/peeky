import fs from 'fs'
import { join } from 'path'
import consola from 'consola'
import { resolveConfig as resolveViteConfig } from 'vite'
import type { PeekyConfig } from './types'
import { setupConfigContentLoader } from './fs.js'
import { transformConfigCode } from './transform.js'
import { defaultPeekyConfig } from './defaults.js'
import { mergeConfig } from './util.js'

export interface PeekyConfigLoaderOptions {
  baseDir?: string
  glob?: string | string[]
}

export async function setupConfigLoader (options: PeekyConfigLoaderOptions = {}) {
  const contentLoader = await setupConfigContentLoader(options.baseDir, options.glob)

  async function loadConfig (): Promise<PeekyConfig> {
    const file = contentLoader.getConfigPath()
    const resolvedPath = join(options.baseDir || process.cwd(), file + '.temp.mjs')
    try {
      let config: PeekyConfig = {}

      if (file) {
        const rawCode = await contentLoader.loadConfigFileContent()
        const result = await transformConfigCode(rawCode, file)
        fs.writeFileSync(resolvedPath, result.code)
        config = (
          // eslint-disable-next-line no-eval
          await eval(`import('${resolvedPath}?t=${Date.now()}')`)
        ).default
        fs.unlinkSync(resolvedPath)
      }

      // Integrate in vite config
      try {
        const viteConfig = await resolveViteConfig({}, 'serve')
        if (viteConfig?.test) {
          config = mergeConfig(config, viteConfig.test)
        }
      } catch (e) {
        consola.error(`Failed to resolve vite config: ${e.stack ?? e.message}`)
      }

      config = mergeConfig(defaultPeekyConfig(), config)

      return config
    } catch (e) {
      if (fs.existsSync(resolvedPath)) {
        fs.unlinkSync(resolvedPath)
      }
      consola.error(e)
    }
  }

  function destroy () {
    return contentLoader.destroy()
  }

  return {
    loadConfig,
    destroy,
  }
}
