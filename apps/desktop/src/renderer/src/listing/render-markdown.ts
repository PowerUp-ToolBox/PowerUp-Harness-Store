/**
 * A Publisher's Markdown (README.md, changelogs) as HTML the Store detail page can show without
 * trusting it (P0-09.3): `marked` turns the Markdown into HTML with raw HTML dropped (no
 * passthrough; an inline `<script>` or `<style>` goes together with its content, which would
 * otherwise be left as text), then DOMPurify keeps only an allow-list of what Markdown makes: headings,
 * paragraphs, lists, quotes, code, emphasis, links, images and tables, without any style, class,
 * event handler or other attribute but the few listed. So no script, iframe, form, style sheet or
 * remote-loading trick survives, whether written as HTML or smuggled through a link or image.
 *
 * Links keep their href only when it is an absolute http(s) URL, and then open in a new window,
 * which the main window refuses and hands to the User's browser (src/main/index.ts); a fragment,
 * relative or `mailto:` link keeps its text only (a `#anchor` would change the app's hash route).
 * Images load only from the Store's asset bucket (as `store-asset:` URLs, served by main) or as a
 * raster `data:` image; any other image is removed.
 */
import DOMPurify from 'dompurify';
import { Marked, type Token, type Tokens } from 'marked';
import { storeAssetUrlOf } from '../../../shared/store-assets.js';

const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'blockquote',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

/** `align` is a table cell's; `start` an ordered list's first number. */
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'align', 'start'];

/**
 * The URLs DOMPurify lets through, before this module's own checks: DOMPurify's default list with
 * the `store-asset:` scheme added, which the Store's images use.
 */
const ALLOWED_URI = /^(?:(?:https?|mailto|store-asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/** A raster image inlined as base64: never SVG, which can carry script and remote loads. */
const RASTER_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;

/**
 * The elements whose content is not text to show. Inline raw HTML comes as one token per tag, so
 * dropping the tags alone would leave a `<script>`'s code or a `<style>`'s rules as text.
 */
const HIDDEN_CONTENT =
  /^<(script|style|iframe|noscript|noembed|noframes|object|template|textarea|title|xmp|svg|math)\b/i;

/**
 * Inline `tokens` without each element of {@link HIDDEN_CONTENT} and everything up to its closing
 * tag; one never closed loses its opening tag only.
 */
function withoutHiddenContent(tokens: Token[]): Token[] {
  const kept: Token[] = [];
  let skipTo = -1;
  tokens.forEach((token, index) => {
    if (index <= skipTo) return;
    const opened = token.type === 'html' ? HIDDEN_CONTENT.exec(token.raw) : null;
    if (opened === null) {
      kept.push(token);
      return;
    }
    const closing = new RegExp(`^</${opened[1] ?? ''}\\s*>`, 'i');
    skipTo = tokens.findIndex(
      (each, at) => at > index && each.type === 'html' && closing.test(each.raw),
    );
  });
  return kept;
}

/** GitHub-flavoured Markdown, with raw HTML (blocks and inline tags alike) dropped. */
const markdown = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html: () => '',
  },
  // Called on each token before its children, so the children it walks are the kept ones.
  walkTokens: (token) => {
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      for (const cell of [...table.header, ...table.rows.flat()]) {
        cell.tokens = withoutHiddenContent(cell.tokens);
      }
    } else if ('tokens' in token && token.tokens !== undefined) {
      token.tokens = withoutHiddenContent(token.tokens);
    }
  },
});

/** A DOMPurify of its own, so its configuration is this module's alone. */
let purifier: ReturnType<typeof DOMPurify> | null = null;

/** The sanitised HTML of Markdown `source`. */
export function renderMarkdown(source: string): string {
  const html = markdown.parse(source, { async: false });
  purifier ??= DOMPurify(window);
  const fragment = purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    if (href !== null && isWebUrl(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    } else {
      link.removeAttribute('href');
    }
  }
  for (const image of fragment.querySelectorAll('img')) {
    const src = imageSource(image.getAttribute('src') ?? '');
    if (src === null) image.remove();
    else image.setAttribute('src', src);
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

/** An absolute http(s) URL. */
function isWebUrl(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Where an image may load from: the Store's asset bucket or a raster data URI; else null. */
function imageSource(src: string): string | null {
  if (RASTER_DATA_URI.test(src)) return src;
  return storeAssetUrlOf(src);
}
