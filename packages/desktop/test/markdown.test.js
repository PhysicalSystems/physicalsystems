import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdown } from '../src/renderer/markdown.js'

// A DOM tree fixture, without HTML parsing or browser/hardware dependencies.
// Disallow attributes and active elements to catch accidental expansion of the
// renderer's capability even when a supplied message contains hostile markup.
const allowedTags = new Set(['div', 'p', 'br', 'strong', 'em', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
class Node {
  constructor(ownerDocument, tagName, data = '') {
    this.ownerDocument = ownerDocument
    this.tagName = tagName
    this.data = data
    this.childNodes = []
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') {
        this.childNodes.push(...node.childNodes); node.childNodes = []
      } else this.childNodes.push(node)
    }
  }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes) }
  get textContent() { return this.tagName === '#text' ? this.data : this.childNodes.map((node) => node.textContent).join('') }
  set textContent(text) { this.replaceChildren(this.ownerDocument.createTextNode(text)) }
  set innerHTML(_) { throw new Error('HTML parsing is forbidden') }
  setAttribute() { throw new Error('Message content must not become attributes') }
}
const document = {
  createElement(tag) { assert.ok(allowedTags.has(tag), `Unexpected element ${tag}`); return new Node(this, tag) },
  createTextNode(text) { return new Node(this, '#text', String(text)) },
  createDocumentFragment() { return new Node(this, '#fragment') },
}
function render(text) { return renderMarkdown(document.createElement('div'), text) }
function tree(node) {
  if (node.tagName === '#text') return node.data
  return [node.tagName, ...node.childNodes.map(tree)]
}
function descendants(node, tag) {
  return node.childNodes.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...descendants(child, tag)])
}

test('chat Markdown renders readable semantic blocks, inline formatting and line breaks', () => {
  const container = render('## A **clear** heading\r\n\r\nA **bold** and *gentle* sentence.\r\nNext `literal *code*` line.\n\nFinal paragraph.')
  assert.deepEqual(tree(container), ['div',
    ['h2', 'A ', ['strong', 'clear'], ' heading'],
    ['p', 'A ', ['strong', 'bold'], ' and ', ['em', 'gentle'], ' sentence.', ['br'], 'Next ', ['code', 'literal *code*'], ' line.'],
    ['p', 'Final paragraph.'],
  ])
})

test('lists retain order, nested structure, wrapped text and quote semantics', () => {
  const container = render('- **First**\n  continued\n  - Nested\n- Second\n\n3. Third\n4. Fourth\n\n> ## Quoted heading\n> A *quoted* line.\n>\n> Another paragraph.')
  assert.deepEqual(tree(container), ['div',
    ['ul', ['li', ['p', ['strong', 'First'], ['br'], 'continued'], ['ul', ['li', ['p', 'Nested']]]], ['li', ['p', 'Second']]],
    ['ol', ['li', ['p', 'Third']], ['li', ['p', 'Fourth']]],
    ['blockquote', ['h2', 'Quoted heading'], ['p', 'A ', ['em', 'quoted'], ' line.'], ['p', 'Another paragraph.']],
  ])
  assert.equal(descendants(container, 'ol')[0].start, 3)
})

test('fenced code preserves indentation and HTML literally, including incomplete streaming blocks', () => {
  const source = '```html\n  <img src="https://example.invalid/x" onerror="alert(1)">\n**literal**\n```\n\n~~~js\nconst unfinished = `<script>`;'
  const container = render(source)
  assert.deepEqual(descendants(container, 'pre').map(tree), [
    ['pre', ['code', '  <img src="https://example.invalid/x" onerror="alert(1)">\n**literal**\n']],
    ['pre', ['code', 'const unfinished = `<script>`;']],
  ])
  assert.equal(descendants(container, 'strong').length, 0)
  assert.equal(render('```\nline\n').textContent, 'line\n')
  assert.equal(render('````\n```\ncontent\n````').textContent, '```\ncontent\n')
})

test('raw HTML, images and unsafe URLs stay text and create no executable or navigable nodes', () => {
  const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)> <svg onload=alert(1)>\n[run](javascript:alert(1)) ![image](https://example.invalid/private) [file](file:///etc/passwd)\n<iframe src="data:text/html,evil"></iframe> &lt;b&gt;'
  const container = render(hostile)
  assert.equal(container.textContent, hostile.replaceAll('\n', ''))
  assert.deepEqual(tree(container), ['div', ['p', ...hostile.split('\n').flatMap((line, i) => i ? [['br'], line] : [line])]])
})

test('escaped syntax remains literal and nested inline formatting uses semantic elements', () => {
  assert.equal(render('\\*literal\\* \\`code\\` \\[label\\] C:\\temp \\\\ end\\').textContent, '*literal* `code` [label] C:\\temp \\ end\\')
  assert.deepEqual(tree(render('**bold *and emphasis***; *em **and strong***; ***both***')), ['div', ['p',
    ['strong', 'bold ', ['em', 'and emphasis']], '; ', ['em', 'em ', ['strong', 'and strong']], '; ', ['strong', ['em', 'both']],
  ]])
  assert.deepEqual(tree(render('``a ` b`` and `a\\` end')), ['div', ['p', ['code', 'a ` b'], ' and ', ['code', 'a\\'], ' end']])
  assert.deepEqual(tree(render('\\``code`')), ['div', ['p', '`', ['code', 'code']]])
})

test('streamed partial delimiters remain visible and each update replaces the old message', () => {
  const container = document.createElement('div')
  for (const partial of ['A *', 'A **', 'A **part', 'A **partial*', 'A `part', 'A \\']) {
    assert.equal(renderMarkdown(container, partial), container)
    assert.equal(container.textContent, partial)
    assert.equal(descendants(container, 'strong').length, 0)
  }
  renderMarkdown(container, 'A **complete**')
  assert.deepEqual(tree(container), ['div', ['p', 'A ', ['strong', 'complete']]])
  renderMarkdown(container, '')
  assert.deepEqual(tree(container), ['div'])
  renderMarkdown(container, null)
  assert.deepEqual(tree(container), ['div'])
})

test('unsupported syntax and deep quote input remain visible without unbounded recursion', () => {
  const plain = 'setext heading\n=====\n\n| table | cell |\n| --- | --- |\n\n____\n\n****'
  assert.equal(render(plain).textContent, plain.replaceAll('\n', ''))
  const deep = render('> '.repeat(1000) + 'visible')
  assert.ok(deep.textContent.endsWith('visible'))
  assert.equal(descendants(deep, 'blockquote').length, 32)
})
