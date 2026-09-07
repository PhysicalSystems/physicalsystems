/* A small chat Markdown subset. All message content becomes DOM text; links,
 * images, raw HTML, tables and other unsupported syntax remain inert text.
 * This is deliberately not a full CommonMark parser. */

const escapedPunctuation = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/
const quoteLine = /^ {0,3}>[ \t]?(.*)$/
const headingLine = /^ {0,3}(#{1,6})[ \t]+(.*)$/
const listLine = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/
const maxDepth = 32

function fenceStart(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  return match && !(match[1][0] === '`' && match[2].includes('`')) ? match[1] : null
}

function appendInline(container, text) {
  const document = container.ownerDocument
  const frames = [{ container, marker: '' }]
  const current = () => frames.at(-1).container
  let plain = ''
  const flush = () => {
    if (plain) current().append(document.createTextNode(plain))
    plain = ''
  }

  // Cache matching backtick runs so unfinished streamed code spans do not
  // repeatedly scan the remaining message. Backslashes are literal inside code.
  const codeEnds = new Map()
  const nextRun = new Map()
  const runs = [...text.matchAll(/`+/g)]
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]
    if (nextRun.has(run[0].length)) codeEnds.set(run.index, nextRun.get(run[0].length))
    // Escaping the first backtick can leave the rest of this run as an opener.
    if (text[run.index - 1] === '\\' && nextRun.has(run[0].length - 1)) {
      codeEnds.set(run.index + 1, nextRun.get(run[0].length - 1))
    }
    nextRun.set(run[0].length, run.index)
  }

  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && escapedPunctuation.test(text[i + 1] || '')) {
      plain += text[i + 1]; i += 2
    } else if (text[i] === '\n') {
      flush(); current().append(document.createElement('br')); i += 1
    } else if (text[i] === '`') {
      let length = 1
      while (text[i + length] === '`') length += 1
      const end = codeEnds.get(i)
      if (end === undefined) { plain += text.slice(i, i + length); i += length; continue }
      flush()
      const code = document.createElement('code')
      code.textContent = text.slice(i + length, end)
      current().append(code); i = end + length
    } else if (text[i] === '*') {
      let length = 1
      while (text[i + length] === '*') length += 1
      if (length > 3) { plain += text.slice(i, i + length); i += length; continue }
      const canClose = i > 0 && !/\s/.test(text[i - 1])
      const canOpen = i + length < text.length && !/\s/.test(text[i + length])
      let remaining = length
      flush()
      while (canClose && frames.length > 1 && frames.at(-1).marker.length <= remaining) {
        const frame = frames.pop()
        const element = document.createElement(frame.marker.length === 2 ? 'strong' : 'em')
        element.append(frame.container); current().append(element)
        remaining -= frame.marker.length
      }
      while (canOpen && remaining && frames.length < maxDepth) {
        const size = remaining >= 2 ? 2 : 1
        frames.push({ container: document.createDocumentFragment(), marker: '*'.repeat(size) })
        remaining -= size
      }
      plain += '*'.repeat(remaining); i += length
    } else {
      plain += text[i]; i += 1
    }
  }
  flush()
  // Unmatched delimiters stay visible until the next streamed update completes them.
  while (frames.length > 1) {
    const frame = frames.pop()
    current().append(document.createTextNode(frame.marker), frame.container)
  }
}

function appendBlocks(container, lines, depth = 0) {
  const document = container.ownerDocument
  const make = (tag) => document.createElement(tag)
  const isBlock = (line) => !line.trim() || fenceStart(line) || headingLine.test(line) || quoteLine.test(line) || listLine.test(line)
  if (depth >= maxDepth) {
    const paragraph = make('p'); appendInline(paragraph, lines.join('\n')); container.append(paragraph)
    return
  }
  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    const fence = fenceStart(line)
    const heading = headingLine.exec(line)
    const quote = quoteLine.exec(line)
    const firstItem = listLine.exec(line)
    if (fence) {
      const start = ++i
      while (i < lines.length) {
        const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(lines[i])
        if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) break
        i += 1
      }
      const pre = make('pre'), code = make('code')
      code.textContent = lines.slice(start, i).join('\n') + (i > start && i < lines.length ? '\n' : '')
      pre.append(code); container.append(pre)
      if (i < lines.length) i += 1
    } else if (heading) {
      const element = make(`h${heading[1].length}`)
      appendInline(element, heading[2].replace(/[ \t]+#+[ \t]*$/, ''))
      container.append(element); i += 1
    } else if (quote) {
      const quoted = []
      while (i < lines.length) {
        const match = quoteLine.exec(lines[i])
        if (!match) break
        quoted.push(match[1]); i += 1
      }
      const element = make('blockquote')
      appendBlocks(element, quoted, depth + 1); container.append(element)
    } else if (firstItem) {
      const ordered = /^\d/.test(firstItem[2])
      const list = make(ordered ? 'ol' : 'ul')
      if (ordered) list.start = Number.parseInt(firstItem[2], 10)
      while (i < lines.length) {
        const item = listLine.exec(lines[i])
        if (!item || item[1].length !== firstItem[1].length || /^\d/.test(item[2]) !== ordered) break
        const contentIndent = item[1].length + item[2].length + item[3].length
        const itemLines = [item[4]]
        i += 1
        while (i < lines.length && lines[i].trim() && lines[i].startsWith(' '.repeat(contentIndent))) {
          itemLines.push(lines[i].slice(contentIndent)); i += 1
        }
        const element = make('li')
        appendBlocks(element, itemLines, depth + 1); list.append(element)
      }
      container.append(list)
    } else {
      const paragraph = [line]
      i += 1
      while (i < lines.length && !isBlock(lines[i])) { paragraph.push(lines[i]); i += 1 }
      const element = make('p')
      appendInline(element, paragraph.join('\n')); container.append(element)
    }
  }
}

/** Replace a container with the supported Markdown subset using only DOM nodes. */
export function renderMarkdown(container, text) {
  const fragment = container.ownerDocument.createDocumentFragment()
  appendBlocks(fragment, String(text ?? '').replace(/\r\n?/g, '\n').split('\n'))
  container.replaceChildren(fragment)
  return container
}
