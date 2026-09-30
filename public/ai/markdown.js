/* ============================================================
   SaveHatke AI — safe Markdown renderer.

   Renders assistant Markdown to HTML without ever allowing arbitrary HTML
   through: every piece of text is HTML-escaped, and only a known set of
   tags is emitted. Supports headings, bold/italic, inline code, fenced
   code blocks (with a language label and copy button), links (http/https/
   mailto only), lists, blockquotes, tables, and horizontal rules.

   No third-party library — a small, auditable block/inline parser.
   ============================================================ */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(url) {
  const trimmed = String(url || '').trim();
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
  return '';
}

/* ---- inline: escape first, then apply inline spans on the escaped text ---- */
function renderInline(text) {
  let out = escapeHtml(text);

  // inline code — protect its contents from further inline parsing
  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return '\u0000CODE' + (codeSpans.length - 1) + '\u0000';
  });

  // links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeHref(url);
    if (!href) return label;
    return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });

  // bold, then italic
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // restore inline code
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => '<code>' + codeSpans[Number(i)] + '</code>');

  return out;
}

function renderTable(rows) {
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  let html = '<div class="md-table-wrap"><table><thead><tr>';
  html += header.map((c) => '<th>' + renderInline(c) + '</th>').join('');
  html += '</tr></thead><tbody>';
  for (const row of body) {
    html += '<tr>' + header.map((_, i) => '<td>' + renderInline(row[i] || '') + '</td>').join('') + '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

/**
 * Render Markdown to safe HTML.
 * @param {string} markdown
 * @returns {string} HTML
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      const label = lang ? escapeHtml(lang) : 'code';
      html.push(
        '<div class="md-code"><div class="md-code-head"><span class="md-code-lang">' + label
        + '</span><button class="md-code-copy" type="button" data-copy>Copy</button></div>'
        + '<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre></div>',
      );
      continue;
    }

    // table (header + separator row of dashes)
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i])) rows.push(lines[i++]);
      html.push(renderTable(rows));
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    // horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      html.push('<blockquote>' + renderInline(quote.join(' ')) + '</blockquote>');
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      }
      html.push('<ul>' + items.map((it) => '<li>' + renderInline(it) + '</li>').join('') + '</ul>');
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      }
      html.push('<ol>' + items.map((it) => '<li>' + renderInline(it) + '</li>').join('') + '</ol>');
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) { i++; continue; }

    // paragraph — gather consecutive non-empty, non-special lines
    const para = [];
    while (
      i < lines.length
      && !/^\s*$/.test(lines[i])
      && !/^```/.test(lines[i])
      && !/^#{1,6}\s/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !/^>\s?/.test(lines[i])
      && !/^\|.*\|$/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    if (para.length) html.push('<p>' + renderInline(para.join(' ')) + '</p>');
  }

  return html.join('\n');
}

/**
 * Wires "Copy" buttons inside a rendered container. Idempotent per button.
 * @param {HTMLElement} container
 */
export function wireCodeCopy(container) {
  container.querySelectorAll('button[data-copy]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const code = btn.closest('.md-code')?.querySelector('code')?.textContent || '';
      const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(() => {});
      }
    });
  });
}
