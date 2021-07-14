import { promises as fsp } from 'fs'
import { resolve, join, dirname, basename } from 'upath'
import type { Plugin } from 'vite'
import Critters from 'critters'
import glob from 'globby'
import template from 'lodash.template'
import htmlMinifier from 'html-minifier'
import { camelCase } from 'scule'
import genericMessages from '../templates/messages.json'

const r = (...path: string[]) => resolve(join(__dirname, '..', ...path))

export const RenderPlugin = () => {
  return <Plugin>{
    name: 'render',
    enforce: 'post',
    async writeBundle () {
      const distDir = r('dist')
      const critters = new Critters({ path: distDir })
      const htmlFiles = await glob(r('dist/templates/**/*.html'))

      const templateExports = []

      for (const fileName of htmlFiles) {
        // Infer template name
        const templateName = basename(dirname(fileName))

        // eslint-disable-next-line no-console
        console.log('Processing', templateName)

        // Read source template
        let html = await fsp.readFile(fileName, 'utf-8')

        // Apply criters to inline styles
        html = await critters.process(html)
        // We no longer need references to external CSS
        html = html.replace(/<link[^>]*>/g, '')

        // Inline SVGs
        const svgSources = Array.from(html.matchAll(/src="([^"]+)"|url([^)]+)/g))
          .map(m => m[1])
          .filter(src => src.match(/\.svg$/))

        for (const src of svgSources) {
          const svg = await fsp.readFile(r('dist', src), 'utf-8')
          const base64Source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
          html = html.replaceAll(src, base64Source)
        }

        // Inline our scripts
        const scriptSources = Array.from(html.matchAll(/<script[^>]*src="(.*)"[^>]*>[\s\S]*?<\/script>/g))
          .filter(([_block, src]) => src.match(/^\/.*\.js$/))

        for (const [scriptBlock, src] of scriptSources) {
          let contents = await fsp.readFile(r('dist', src), 'utf-8')
          contents = contents.replaceAll('/* empty css               */', '').trim()
          html = html.replace(scriptBlock, contents.length ? `<script>${contents}</script>` : '')
        }

        // Minify HTML
        html = htmlMinifier.minify(html, { collapseWhitespace: true })

        // Load messages
        const messages = JSON.parse(await fsp.readFile(r(`templates/${templateName}/messages.json`), 'utf-8'))

        // Serialize into a js function
        const jsCode = [
          `const _messages = ${JSON.stringify({ ...genericMessages, ...messages })}`,
          `const _render = ${template(html, { interpolate: /{{([\s\S]+?)}}/g }).toString()}`,
          'const _template = (messages) => _render({ messages: { ..._messages, ...messages } })'
        ].join('\n').trim()

        // Generate types
        const types = [
          `const defaultMessages = ${JSON.stringify(messages)}`,
          'export type DefaultMessages = typeof defaultMessages',
          'declare const template: (data: Partial<DefaultMessages>) => string',
          'export { template }'
        ].join('\n')

        // Register exports
        templateExports.push({
          exportName: camelCase(templateName),
          templateName,
          types
        })

        // Write new template
        await fsp.writeFile(fileName.replace('/index.html', '.mjs'), `${jsCode}\nexport const template = _template`)
        await fsp.writeFile(fileName.replace('/index.html', '.d.ts'), `${types}`)

        // Remove original html file
        await fsp.unlink(fileName)
        await fsp.rmdir(dirname(fileName))
      }

      // Write an index file with named exports for each template
      const contents = templateExports.map(exp => `export { template as ${exp.exportName} } from './templates/${exp.templateName}.mjs'`).join('\n')
      await fsp.writeFile(r('dist/index.mjs'), contents, 'utf8')

      await fsp.writeFile(r('dist/index.d.ts'), contents.replaceAll(/\.mjs/g, ''), 'utf8')
    }
  }
}
