// @vitest-environment jsdom
/**
 * Ticket P0-09.3: the README sanitiser. A hostile README (scripts, iframes, an `onerror` image,
 * remote images and style sheets, `javascript:` links, SVG data, raw HTML of every kind) renders
 * with every dangerous part gone and its Markdown content intact; links keep only absolute http(s)
 * targets, which open in a new window (the User's browser); images load only from the Store's
 * asset bucket or as raster data URIs.
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/renderer/src/listing/render-markdown.js';

/** The rendered HTML, as a DOM to query. */
function rendered(source: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderMarkdown(source);
  return container;
}

const HOSTILE_README = `# Writer

Writer drafts **long** texts and _edits_ them.

<script>alert('owned')</script>

<iframe src="https://evil.example.com/frame"></iframe>

<img src="x" onerror="alert('owned')">

![remote tracker](https://evil.example.com/pixel.png)

<style>body { display: none }</style>

<link rel="stylesheet" href="https://evil.example.com/style.css">

<object data="https://evil.example.com/flash.swf"></object>

<form action="https://evil.example.com/"><input name="key"></form>

[Click me](javascript:alert('owned'))

<a href="https://example.com" onclick="alert('owned')">raw link</a>

## Usage

- Install it
- Launch it

1. First
2. Second

\`\`\`js
const answer = 42;
\`\`\`

| Key | Meaning |
| --- | :-----: |
| a   | b       |

> A quote.

Inline \`code\` and ~~old~~ text.
`;

describe('renderMarkdown', () => {
  it('removes scripts, iframes, onerror images and every other remote-loading trick', () => {
    const html = renderMarkdown(HOSTILE_README);
    for (const banned of [
      '<script',
      'alert(',
      '<iframe',
      'onerror',
      'onclick',
      'evil.example.com',
      '<style',
      '<link',
      '<object',
      '<form',
      '<input',
      'javascript:',
    ]) {
      expect(html, banned).not.toContain(banned);
    }
  });

  it('keeps the Markdown content intact around what it removed', () => {
    const page = rendered(HOSTILE_README);
    expect(page.querySelector('h1')?.textContent).toBe('Writer');
    expect(page.querySelector('h2')?.textContent).toBe('Usage');
    expect(page.querySelector('p strong')?.textContent).toBe('long');
    expect(page.querySelector('p em')?.textContent).toBe('edits');
    expect([...page.querySelectorAll('ul li')].map((item) => item.textContent)).toEqual([
      'Install it',
      'Launch it',
    ]);
    expect([...page.querySelectorAll('ol li')].map((item) => item.textContent)).toEqual([
      'First',
      'Second',
    ]);
    expect(page.querySelector('pre code')?.textContent).toBe('const answer = 42;\n');
    expect([...page.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'Key',
      'Meaning',
    ]);
    expect(page.querySelector('blockquote')?.textContent.trim()).toBe('A quote.');
    expect(page.querySelector('del')?.textContent).toBe('old');
    // A link to a script keeps its text, not its target.
    const click = [...page.querySelectorAll('a')].find((link) => link.textContent === 'Click me');
    expect(click?.hasAttribute('href')).toBe(false);
  });

  it('removes an inline script or style with its content, the rest of the line intact', () => {
    const page = rendered(
      [
        'Intro <script>alert(1)</script> more <img src=x onerror=alert(2)> text.',
        'Plain <style>body{display:none}</style> **bold** end.',
        '*Emphasis <script>alert(3)</script> kept*',
        '| Key | Value |\n| --- | --- |\n| a <script>alert(4)</script> | b |',
        'Never closed <script> stays text.',
        '`<script>alert(5)</script>` is code.',
      ].join('\n\n'),
    );
    expect(page.innerHTML).not.toMatch(/alert\([1-4]\)|display:none|<script|<style/);
    expect([...page.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual([
      'Intro  more  text.',
      'Plain  bold end.',
      'Emphasis  kept',
      'Never closed  stays text.',
      '<script>alert(5)</script> is code.',
    ]);
    expect(page.querySelector('p strong')?.textContent).toBe('bold');
    expect([...page.querySelectorAll('td')].map((cell) => cell.textContent.trim())).toEqual([
      'a',
      'b',
    ]);
  });

  it('allows no attribute but the few Markdown makes', () => {
    const page = rendered(HOSTILE_README);
    const attributes = new Set(
      [...page.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes].map((attribute) => attribute.name),
      ),
    );
    for (const name of attributes) {
      expect(['href', 'src', 'alt', 'title', 'align', 'start', 'target', 'rel']).toContain(name);
    }
  });

  it('opens absolute http(s) links in a new window, which main hands to the browser', () => {
    const page = rendered(
      '[Docs](https://writer.example.com/docs) [Old](http://old.example.com) ' +
        '[Top](#usage) [Relative](docs/usage.md) [Mail](mailto:me@example.com)',
    );
    const links = [...page.querySelectorAll('a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
      link.getAttribute('target'),
      link.getAttribute('rel'),
    ]);
    expect(links).toEqual([
      ['Docs', 'https://writer.example.com/docs', '_blank', 'noopener noreferrer'],
      ['Old', 'http://old.example.com', '_blank', 'noopener noreferrer'],
      // A fragment would change the app's own route; relative and mail links lead nowhere here.
      ['Top', null, null, null],
      ['Relative', null, null, null],
      ['Mail', null, null, null],
    ]);
  });

  it('loads images only from the Store’s asset bucket or as raster data URIs', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const page = rendered(
      [
        '![bucket](https://store.example.com/storage/v1/object/public/harness-assets/alice/writer/1.0.0/screenshots/1.png)',
        '![asset](store-asset://harness-assets/alice/writer/1.0.0/icon.png)',
        `![inline](${png})`,
        '![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
        '![other bucket](https://store.example.com/storage/v1/object/public/harness-packages/alice/writer/1.0.0.zip)',
        '![escape](https://store.example.com/storage/v1/object/public/harness-assets/../harness-packages/x.zip)',
        '![relative](screenshots/1.png)',
        '![remote](https://images.example.com/a.png)',
      ].join('\n\n'),
    );
    expect(
      [...page.querySelectorAll('img')].map((image) => [image.alt, image.getAttribute('src')]),
    ).toEqual([
      ['bucket', 'store-asset://harness-assets/alice/writer/1.0.0/screenshots/1.png'],
      ['asset', 'store-asset://harness-assets/alice/writer/1.0.0/icon.png'],
      ['inline', png],
    ]);
  });
});
