import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from './repo.js';

/** The docs a reader follows step by step, where an in-page link that leads nowhere strands them. */
const GUIDES = [
  'README.md',
  'docs/README.md',
  ...readdirSync(repoPath('docs', 'guides'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/guides/${file}`),
];

/** The anchors GitHub gives a Markdown file's headings (a repeated one gets `-1`, `-2`, ...). */
function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const [, heading = ''] of markdown.matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-');
    let anchor = slug;
    for (let n = 1; anchors.has(anchor); n += 1) anchor = `${slug}-${String(n)}`;
    anchors.add(anchor);
  }
  return anchors;
}

describe('docs', () => {
  it.each(GUIDES)('%s links only to headings it has', (file) => {
    // Code blocks hold shell comments and examples, not headings or links.
    const markdown = readFileSync(repoPath(...file.split('/')), 'utf8').replace(
      /```[\s\S]*?```/g,
      '',
    );
    const anchors = headingAnchors(markdown);
    const links = [...markdown.matchAll(/\]\(#([^)\s]+)\)/g)].map(([, anchor = '']) => anchor);
    expect(links.filter((anchor) => !anchors.has(anchor))).toEqual([]);
  });
});
