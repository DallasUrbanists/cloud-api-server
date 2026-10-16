import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

const referenceSidebar = JSON.parse(readFileSync(new URL('../reference/typedoc-sidebar.json', import.meta.url), 'utf8'));
for (const item of referenceSidebar) item.collapsed = true;

const repository = 'https://github.com/DallasUrbanists/cloud-api-server';

export default defineConfig({
  title: 'Dallas Urbanists Cloud API',
  description: 'System guides and generated developer reference.',
  outDir: '../docs-site',
  srcExclude: ['operation-groups.md', 'public/**', 'reference/_media/**'],
  themeConfig: {
    nav: [
      { text: 'System view', link: '/recommendable-actions' },
      { text: 'Code reference', link: '/reference/' },
      { text: 'Repository', link: repository },
    ],
    sidebar: [
      {
        text: 'Developer documentation',
        items: [
          { text: 'Overview and local setup', link: '/' },
          { text: 'Recommendable Actions', link: '/recommendable-actions' },
          { text: 'Documentation conventions', link: '/documentation-conventions' },
          { text: 'Generated code reference', link: '/reference/' },
        ],
      },
      ...referenceSidebar,
    ],
    search: { provider: 'local' },
    outline: [2, 3],
  },
  markdown: {
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, index, options, env, self) => {
        if (tokens[index].info.trim() === 'mermaid') {
          const source = encodeURIComponent(tokens[index].content);
          return `<ClientOnly><MermaidDiagram source="${source}" /></ClientOnly>`;
        }
        return fence(tokens, index, options, env, self);
      };
      const link = md.renderer.rules.link_open!;
      md.renderer.rules.link_open = (tokens, index, options, env, self) => {
        const token = tokens[index];
        const href = token.attrGet('href');
        // TypeDoc copies relative @see targets; route those links to their canonical pages.
        if (href?.endsWith('/_media/recommendable-actions.md')) {
          token.attrSet('href', '/recommendable-actions');
        } else if (href?.endsWith('/_media/swagger.ts')) {
          token.attrSet('href', `${repository}/blob/main/src/docs/swagger.ts`);
        }
        // Keep repository-relative source links useful both in Markdown and the portal.
        if (href?.startsWith('../src/') || href?.startsWith('../scripts/') || href?.startsWith('../.github/') || href === '../README.md') {
          token.attrSet('href', `${repository}/blob/main/${href.slice(3)}`);
        }
        return link(tokens, index, options, env, self);
      };
    },
  },
});
