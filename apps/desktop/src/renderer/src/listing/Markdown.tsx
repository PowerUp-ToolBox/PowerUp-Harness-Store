import { useMemo } from 'react';
import { renderMarkdown } from './render-markdown.js';

/**
 * A Publisher's Markdown (README, changelog) as sanitised HTML: see ./render-markdown.ts for what is
 * kept. The HTML is set only after sanitising, so nothing the Publisher wrote runs or loads.
 */
export function Markdown({ source }: { readonly source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
