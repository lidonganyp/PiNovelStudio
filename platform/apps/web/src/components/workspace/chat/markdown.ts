/**
 * Safe, dependency-free Markdown rendering for assistant messages.
 * HTML is escaped before the small GFM subset is converted to markup.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function renderInline(value: string): string {
  let output = escapeHtml(value);
  output = output.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  output = output.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  output = output.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  output = output.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '');
  output = output.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, href: string) => {
    const safe = safeHref(href);
    return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  return output;
}

export function renderMarkdown(value: string): string {
  const lines = value.replaceAll('\r\n', '\n').split('\n');
  const output: string[] = [];
  let inCode = false;
  let codeLanguage = '';
  let codeLines: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = (): void => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };

  /** 围栏代码块：带语言标签与复制按钮的头部（按钮由 MessageItem 事件委托处理）。 */
  const closeCode = (): void => {
    const label = codeLanguage ? escapeHtml(codeLanguage) : 'text';
    output.push(
      `<div class="code-block"><div class="code-head"><span>${label}</span>` +
        `<button type="button" class="code-copy" aria-label="复制代码">复制</button></div>` +
        `<pre><code class="language-${escapeHtml(codeLanguage)}">${escapeHtml(codeLines.join('\n'))}</code></pre></div>`,
    );
    codeLines = [];
    codeLanguage = '';
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (inCode) closeCode();
      else closeList();
      inCode = !inCode;
      codeLanguage = fence[1] ?? '';
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const list = line.match(/^\s*([-*+] |\d+\. )(.*)$/);
    if (list) {
      const nextType: 'ul' | 'ol' = /^\d+\./.test(list[1]) ? 'ol' : 'ul';
      if (listType !== nextType) {
        closeList();
        output.push(`<${nextType}>`);
        listType = nextType;
      }
      output.push(`<li>${renderInline(list[2])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) {
      output.push('<br>');
    } else if (/^### /.test(line)) {
      output.push(`<h3>${renderInline(line.slice(4))}</h3>`);
    } else if (/^## /.test(line)) {
      output.push(`<h2>${renderInline(line.slice(3))}</h2>`);
    } else if (/^# /.test(line)) {
      output.push(`<h1>${renderInline(line.slice(2))}</h1>`);
    } else if (/^> /.test(line)) {
      output.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
    } else {
      output.push(`<p>${renderInline(line)}</p>`);
    }
  }
  if (inCode) closeCode();
  closeList();
  return output.join('');
}
