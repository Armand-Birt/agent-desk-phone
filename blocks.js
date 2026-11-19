// A Notion-style block editor that reads and writes plain Markdown.
//
// Blocks: text, Heading 1–3, bulleted / numbered / to-do lists (Tab to indent), toggles and toggle
// headings (with blocks inside), quote, callout, code, divider, task (a live row for a Board task: its status and
// whether Claude is busy in it; see "Task blocks" below). Type "/" for the block menu, or use Notion's shortcuts at the
// start of a line: "# ", "## ", "### ", "- ", "1. ", "[] ", "[t] " (task), "> " (toggle), '" ' (quote), "```", "---".
// Hover a block for ＋ (add below) and ⋮⋮ (drag to move, click for Turn into / Duplicate / Move to / Delete).
//
// Markdown on disk: lists as "- ", "1. ", "- [ ] "; toggles as <details><summary>…</summary>…</details>
// (a toggle heading's summary is <h2>…</h2>);
// callouts as "> [!note]" (GitHub / Obsidian style); inline **bold**, *italic*, `code`, ~~strike~~, [links](…);
// tasks as "▣ [Title](agentdesk://task/<id>)" (a normal link, so it still works from Obsidian or the CLI);
// images as "![alt](relative path)" on a line of their own.
//
// Mentions: a task, to-do or quick session inside a line of text, as a chip. Type "@" (or "/" then Task on a line
// that already has text), then a few letters: pick one, or make a new task / to-do named by what you typed. It's a
// normal link in the Markdown, "[☐ Title](agentdesk://quick/<id>)".
//
// Output: a task block can show the item's output under it (its result links and its Output notes), read-only and
// set apart from your own notes: "▸ Output" on the row toggles it; the choice is kept in the link ("…?output").
//
// Images: ⌘V with a screenshot on the clipboard, dropping image files, or "/image" (a file picker). The app saves the
// file next to the page or task (opts.saveImage(file) -> relative path; opts.imageSrc(path) -> what to show) and the
// block is a normal Markdown image, so Claude Code can open the file from the path when the notes are sent to it.
//
// Task blocks: a page can gather related tasks (trading ideas, things to learn…) and keep notes under each. The block
// shows the task's live title, status and Claude activity; click opens the task. "/task" or "[t] " starts a draft:
// type a title and press Enter to create a task (in the Area of the task above, in Backlog), or pick an existing
// one from the list that appears. Enter after a new task starts the next draft; Enter on an empty draft is plain text.

(function () {
  const TYPES = [
    { type: 'p', label: 'Text', icon: 'Aa', keys: 'text paragraph plain' },
    { type: 'h1', label: 'Heading 1', icon: 'H1', keys: 'heading title big h1', hint: '#' },
    { type: 'h2', label: 'Heading 2', icon: 'H2', keys: 'heading subtitle h2', hint: '##' },
    { type: 'h3', label: 'Heading 3', icon: 'H3', keys: 'heading small h3', hint: '###' },
    { type: 'ul', label: 'Bulleted list', icon: '•', keys: 'bullet list unordered', hint: '-' },
    { type: 'ol', label: 'Numbered list', icon: '1.', keys: 'number list ordered', hint: '1.' },
    { type: 'todo', label: 'To-do list', icon: '☐', keys: 'todo task check box', hint: '[]' },
    { type: 'toggle', label: 'Toggle list', icon: '▸', keys: 'toggle collapse details', hint: '>' },
    { type: 'th1', label: 'Toggle heading 1', icon: '▸H1', keys: 'toggle heading collapse h1' },
    { type: 'th2', label: 'Toggle heading 2', icon: '▸H2', keys: 'toggle heading collapse h2' },
    { type: 'th3', label: 'Toggle heading 3', icon: '▸H3', keys: 'toggle heading collapse h3' },
    { type: 'quote', label: 'Quote', icon: '❝', keys: 'quote citation', hint: '"' },
    { type: 'callout', label: 'Callout', icon: '💡', keys: 'callout note tip info' },
    { type: 'code', label: 'Code', icon: '</>', keys: 'code snippet', hint: '```' },
    { type: 'divider', label: 'Divider', icon: '—', keys: 'divider line separator hr', hint: '---' },
    { type: 'task', label: 'Task, to-do or session', icon: '▣', keys: 'task card idea claude session board todo to-do inbox quick link mention', hint: '[t] @' },
    { type: 'image', label: 'Image', icon: '🖼', keys: 'image picture screenshot photo png file', hint: '⌘V' },
    { type: 'page', label: 'Page', icon: '📄', keys: 'page sub-page subpage child new' },
  ];
  const TIGHT = new Set(['ul', 'ol', 'todo', 'task']); // one line apart in Markdown
  const LISTS = new Set(['ul', 'ol', 'todo']);
  const NEW_PICKS = new Set(['new', 'todo', 'quick']); // the "New …" rows of a task pick list
  const SHORTCUTS = { '# ': 'h1', '## ': 'h2', '### ': 'h3', '- ': 'ul', '* ': 'ul', '+ ': 'ul', '1. ': 'ol', '1) ': 'ol', '[] ': 'todo', '[ ] ': 'todo', '[t] ': 'task', '> ': 'toggle', '" ': 'quote', '```': 'code', '---': 'divider' };
  // The menu's name for a block: a toggle heading is a toggle with a level.
  // A mention of a task / Inbox item inside a line: "[✳︎ Title](agentdesk://quick/<id>)"; "?output" shows its output under the line.
  // (a link saved from a session also says which session: "?session=<id>"; then it is "&output")
  const MENTION = /\[([^\]]+)\]\(agentdesk:\/\/(task|quick)\/([^)\s?]+)(\?[^)\s]*)?\)/g;
  const OUT_PARAM = /[?&]output(?=&|$)/;
  const mentionsIn = (b) => (b.type === 'code' || b.type === 'task' || typeof b.text !== 'string' ? [] : [...b.text.matchAll(MENTION)].map((m) => ({ label: m[1], kind: m[2], id: decodeURIComponent(m[3]), query: m[4] || '', out: OUT_PARAM.test(m[4] || ''), raw: m[0] })));
  // The same mention with its output shown or not.
  const mentionWith = (m, out) => {
    const rest = m.query.replace(/^\?/, '').split('&').filter((p) => p && p !== 'output');
    if (out) rest.push('output');
    return `[${m.label}](agentdesk://${m.kind}/${encodeURIComponent(m.id)}${rest.length ? `?${rest.join('&')}` : ''})`;
  };
  const kindOf = (b) => (b.type === 'toggle' && b.level ? `th${b.level}` : b.type);
  const PLACEHOLDER = { p: "Type '/' for commands", h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', ul: 'List', ol: 'List', todo: 'To-do', toggle: 'Toggle', th1: 'Toggle heading 1', th2: 'Toggle heading 2', th3: 'Toggle heading 3', quote: 'Quote', callout: 'Callout', code: 'Code', task: 'Task title · Enter creates it, or pick one below' };

  let dragging = null; // the editor a block is being dragged from (blocks can move between editors of one opts.group)
  // The rectangle you drag out to select blocks (one for all editors).
  const bandRect = typeof document === 'undefined' ? {} : document.createElement('div'); // (no page when the Markdown functions are tested on their own)
  if (typeof document !== 'undefined') {
    bandRect.className = 'band-rect';
    bandRect.hidden = true;
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(bandRect));
    if (document.body) document.body.appendChild(bandRect);
  }
  // Where a block's text ends (the right edge of its last line), for clicks in the empty space after it.
  function textRight(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    let right = el.getBoundingClientRect().left;
    for (const rect of r.getClientRects()) right = Math.max(right, rect.right);
    return right;
  }
  let seq = 0;
  const uid = () => `b${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const blk = (type = 'p', text = '', extra = {}) => ({ id: uid(), type, text, ...extra });
  const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---- Inline Markdown <-> HTML (what's shown in a block) ----
  function mdToHtml(md) {
    return String(md || '')
      .split(/(`[^`\n]+`)/)
      .map((part) => {
        if (/^`[^`\n]+`$/.test(part)) return `<code>${escH(part.slice(1, -1))}</code>`;
        return escH(part)
          .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => `<a href="${href}"${href.startsWith('agentdesk:') ? ' class="mention" contenteditable="false"' : ''}>${text}</a>`)
          .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
          .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>')
          .replace(/~~([^~]+)~~/g, '<s>$1</s>')
          .replace(/\n/g, '<br>');
      })
      .join('');
  }
  function htmlToMd(el) {
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1) {
        const t = n.tagName;
        const inner = htmlToMd(n);
        if (t === 'B' || t === 'STRONG') s += inner.trim() ? `**${inner}**` : inner;
        else if (t === 'I' || t === 'EM') s += inner.trim() ? `*${inner}*` : inner;
        else if (t === 'S' || t === 'STRIKE' || t === 'DEL') s += inner.trim() ? `~~${inner}~~` : inner;
        else if (t === 'CODE') s += n.textContent ? `\`${n.textContent}\`` : '';
        else if (t === 'A') s += `[${inner}](${n.getAttribute('href') || ''})`;
        else if (t === 'BR') s += '\n';
        else if (t === 'DIV' || t === 'P') s += (s && !s.endsWith('\n') ? '\n' : '') + inner;
        else s += inner;
      }
    }
    return s.replace(/ /g, ' ');
  }

  // ---- Markdown <-> blocks ----
  const SPECIAL = /^(```|<details|<\/details>|(---|\*\*\*|___)\s*$|#{1,3} |\s*[-*+] |\s*\d+[.)] |>|📄 \[|▣ \[|!\[)/;
  // An image on a line of its own: "![alt](path)" (or "(<path with spaces>)").
  const IMG_LINE = /^!\[([^\]]*)\]\(<?([^>)]+?)>?\)\s*$/;
  // A task (or an Inbox session / to-do), as a block: "▣ [Title](agentdesk://task/<id>)" ("…://quick/<id>" for Inbox items).
  const TASK_LINE = /^▣ \[(.*)\]\(agentdesk:\/\/(?:task|quick)\/([^)\s?]+)(\?output)?\)\s*$/;
  // A sub-page, as a block: "📄 [Title](<Page/Title.md>)" (a normal Markdown link to its file).
  const PAGE_LINE = /^📄 \[(.*)\]\(<?([^>)]*?)>?\)\s*$/;
  function parse(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    let i = 0;
    const indentOf = (sp) => Math.min(4, Math.floor(sp.replace(/\t/g, '  ').length / 2));
    function until(end) {
      const out = [];
      while (i < lines.length) {
        const line = lines[i];
        if (end && end(line)) {
          i++;
          return out;
        }
        if (!line.trim()) {
          i++;
          continue;
        }
        let m;
        if ((m = line.match(/^```(\S*)\s*$/))) {
          i++;
          const buf = [];
          while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
          i++;
          out.push(blk('code', buf.join('\n'), { lang: m[1] }));
        } else if ((m = line.match(/^<details( open)?>\s*$/))) {
          i++;
          const sm = (lines[i] || '').match(/^<summary>(.*)<\/summary>\s*$/);
          if (sm) i++;
          const hm = sm && sm[1].match(/^<h([123])>(.*)<\/h\1>$/);
          out.push(blk('toggle', hm ? hm[2] : sm ? sm[1] : '', { open: Boolean(m[1]), ...(hm && { level: Number(hm[1]) }), children: until((l) => /^<\/details>\s*$/.test(l)) }));
        } else if ((m = line.match(IMG_LINE))) {
          i++;
          out.push(blk('image', '', { src: m[2], alt: m[1] }));
        } else if ((m = line.match(TASK_LINE))) {
          i++;
          out.push(blk('task', m[1], { ref: decodeURIComponent(m[2]), ...(m[3] && { out: true }) }));
        } else if ((m = line.match(PAGE_LINE))) {
          i++;
          out.push(blk('page', m[1], { ref: decodeURI(m[2]).split('/').pop().replace(/\.md$/, '') }));
        } else if (/^(---|\*\*\*|___)\s*$/.test(line)) {
          i++;
          out.push(blk('divider'));
        } else if ((m = line.match(/^(#{1,3}) (.*)$/))) {
          i++;
          out.push(blk(`h${m[1].length}`, m[2]));
        } else if ((m = line.match(/^(\s*)[-*+] \[([ xX])\] ?(.*)$/))) {
          i++;
          out.push(blk('todo', m[3], { checked: m[2] !== ' ', indent: indentOf(m[1]) }));
        } else if ((m = line.match(/^(\s*)[-*+] (.*)$/))) {
          i++;
          out.push(blk('ul', m[2], { indent: indentOf(m[1]) }));
        } else if ((m = line.match(/^(\s*)\d+[.)] (.*)$/))) {
          i++;
          out.push(blk('ol', m[2], { indent: indentOf(m[1]) }));
        } else if (/^>/.test(line)) {
          const buf = [];
          while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^> ?/, ''));
          if (/^\[!\w+\]/.test(buf[0])) {
            buf[0] = buf[0].replace(/^\[!\w+\]\s*/, '');
            if (!buf[0]) buf.shift();
            out.push(blk('callout', buf.join('\n')));
          } else out.push(blk('quote', buf.join('\n')));
        } else {
          const buf = [];
          while (i < lines.length && lines[i].trim() && (buf.length === 0 || !SPECIAL.test(lines[i]))) {
            buf.push(lines[i++]);
            if (SPECIAL.test(buf[0])) break; // a stray line like "</details>": keep it as text
          }
          out.push(blk('p', buf.join('\n')));
        }
      }
      return out;
    }
    return until(null);
  }

  // Blocks worth saving: a missing sub-page or an empty list item isn't (it would come back as a stray "-").
  const keep = (b) => !b.missing && !(LISTS.has(b.type) && !b.text && !b.children?.length);
  // Markdown shown read-only (a task's output under its block): the same shapes as blocks, without the editor.
  function staticMd(md, imageSrc) {
    const one = (b) => {
      const ind = `style="margin-left:${(b.indent || 0) * 18}px"`;
      const t = mdToHtml(b.text || '');
      switch (b.type) {
        case 'h1':
        case 'h2':
        case 'h3':
          return `<div class="o-h o-${b.type}">${t}</div>`;
        case 'ul':
          return `<div class="o-li" ${ind}><span class="o-b">•</span><span>${t}</span></div>`;
        case 'ol':
          return `<div class="o-li" ${ind}><span class="o-b">–</span><span>${t}</span></div>`;
        case 'todo':
          return `<div class="o-li" ${ind}><span class="o-b">${b.checked ? '☑' : '☐'}</span><span>${t}</span></div>`;
        case 'quote':
        case 'callout':
          return `<div class="o-q">${t}</div>`;
        case 'code':
          return `<pre class="o-code">${escH(b.text || '')}</pre>`;
        case 'divider':
          return '<hr>';
        case 'image':
          return `<img src="${escH(imageSrc ? imageSrc(b.src) : b.src)}" alt="">`;
        case 'toggle':
          return `<div class="o-p"><b>${t}</b></div>${(b.children || []).map(one).join('')}`;
        case 'task':
        case 'page':
          return `<div class="o-p">${escH(b.text || '')}</div>`;
        default:
          return t ? `<div class="o-p">${t}</div>` : '';
      }
    };
    return parse(md).map(one).join('');
  }
  let pageBase = ''; // the open page's file name: sub-pages live in the folder of that name
  function toMarkdown(blocks) {
    let out = '';
    let prev = null;
    for (const b of blocks) {
      const md = blockMd(b);
      if (prev) out += TIGHT.has(prev.type) && TIGHT.has(b.type) ? '\n' : '\n\n';
      out += md;
      prev = b;
    }
    return out;
  }
  function blockMd(b) {
    const ind = '  '.repeat(b.indent || 0);
    const t = b.text || '';
    switch (b.type) {
      case 'h1':
        return `# ${t}`;
      case 'h2':
        return `## ${t}`;
      case 'h3':
        return `### ${t}`;
      case 'ul':
        return `${ind}- ${t}`;
      case 'ol':
        return `${ind}1. ${t}`;
      case 'todo':
        return `${ind}- [${b.checked ? 'x' : ' '}] ${t}`;
      case 'quote':
        return t.split('\n').map((l) => `> ${l}`).join('\n');
      case 'callout':
        return `> [!note]\n${t.split('\n').map((l) => `> ${l}`).join('\n')}`;
      case 'code':
        return `\`\`\`${b.lang || ''}\n${t}\n\`\`\``;
      case 'divider':
        return '---';
      case 'page':
        return `📄 [${t.replace(/[[\]]/g, '')}](<${pageBase}/${b.ref}.md>)`;
      case 'image':
        return `![${(b.alt || '').replace(/[[\]]/g, '')}](${/\s/.test(b.src) ? `<${b.src}>` : b.src})`;
      case 'task':
        return b.ref ? `▣ [${t.replace(/[[\]]/g, '')}](agentdesk://${String(b.ref).startsWith('q-') ? 'quick' : 'task'}/${encodeURIComponent(b.ref)}${b.out ? '?output' : ''})` : t; // a draft is just its text
      case 'toggle':
        return `<details${b.open ? ' open' : ''}>\n<summary>${b.level ? `<h${b.level}>${t.replace(/\n/g, ' ')}</h${b.level}>` : t.replace(/\n/g, ' ')}</summary>\n\n${toMarkdown(b.children || [])}\n\n</details>`;
      default:
        return t;
    }
  }

  // ---- Caret helpers (in a block's editable element) ----
  function caretRange(el) {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return el.contains(r.startContainer) ? r : null;
  }
  function textBefore(el) {
    const r = caretRange(el);
    if (!r) return '';
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString();
  }
  function atStart(el) {
    const r = caretRange(el);
    return Boolean(r && r.collapsed && textBefore(el) === '');
  }
  function atEnd(el) {
    const r = caretRange(el);
    if (!r || !r.collapsed) return false;
    const post = document.createRange();
    post.selectNodeContents(el);
    post.setStart(r.endContainer, r.endOffset);
    return post.toString() === '';
  }
  // The block's content split at the caret, as Markdown: [before, after].
  function splitAt(el) {
    const r = caretRange(el);
    if (!r) return [htmlToMd(el), ''];
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    const post = document.createRange();
    post.selectNodeContents(el);
    post.setStart(r.endContainer, r.endOffset);
    const a = document.createElement('div');
    a.appendChild(pre.cloneContents());
    const b = document.createElement('div');
    b.appendChild(post.cloneContents());
    return [htmlToMd(a), htmlToMd(b)];
  }
  function setCaret(el, offset) {
    el.focus();
    const sel = getSelection();
    const r = document.createRange();
    let left = offset ?? Infinity;
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          if (left <= n.nodeValue.length) {
            r.setStart(n, left);
            return true;
          }
          left -= n.nodeValue.length;
        } else if (walk(n)) return true;
      }
      return false;
    };
    if (offset === Infinity || !walk(el)) {
      r.selectNodeContents(el);
      r.collapse(false);
    }
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function onFirstLine(el) {
    const r = caretRange(el);
    if (!r) return true;
    const rect = r.getClientRects()[0] || el.getBoundingClientRect();
    return rect.top - el.getBoundingClientRect().top < 14;
  }
  function onLastLine(el) {
    const r = caretRange(el);
    if (!r) return true;
    const rect = r.getClientRects()[0] || el.getBoundingClientRect();
    return el.getBoundingClientRect().bottom - rect.bottom < 14;
  }

  class BlockEditor {
    // opts: onChange(), openMenu(anchor, items), pageTargets() -> [{ id, label }], moveToPage(markdown, pageId)
    constructor(root, opts) {
      this.root = root;
      this.opts = opts;
      this.blocks = [blk()];
      this.slash = null; // { id, query, fromPlus }
      this.pick = null; // { id, sel, items }: the task list under a task draft
      this.drag = null; // id of the block being dragged
      root.classList.add('blocks');
      root.tabIndex = -1; // takes the keys while blocks are selected
      this.selected = new Set();
      root.addEventListener('input', (e) => this.onInput(e));
      root.addEventListener('mousedown', (e) => this.onMouseDown(e));
      document.addEventListener('mousemove', (e) => this.onMouseMove(e));
      document.addEventListener('mouseup', () => ((this.dragSel = null), this.endBand()));
      document.addEventListener('mousedown', (e) => {
        if (this.selected.size && !this.root.contains(e.target) && !e.target.closest?.('.menu, [data-keep-selection]')) this.clearSelection();
      });
      root.addEventListener('keydown', (e) => this.onKey(e));
      root.addEventListener('click', (e) => this.onClick(e));
      root.addEventListener('dblclick', (e) => {
        const im = e.target.closest('[data-image]');
        if (im) this.opts.openImage?.(im.dataset.image);
      });
      root.addEventListener('paste', (e) => this.onPaste(e));
      root.addEventListener('dragstart', (e) => this.onDragStart(e));
      root.addEventListener('dragover', (e) => this.onDragOver(e));
      root.addEventListener('drop', (e) => this.onDrop(e));
      root.addEventListener('dragend', () => this.endDrag());
      root.addEventListener('dragleave', (e) => {
        if (this.fromSibling() && !this.root.contains(e.relatedTarget)) this.clearMarks();
      });
      this.menuEl = document.createElement('div');
      this.menuEl.className = 'slash-menu';
      this.menuEl.hidden = true;
      document.body.appendChild(this.menuEl);
      this.menuEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const it = e.target.closest('[data-type]');
        if (it) this.applySlash(it.dataset.type);
        const pk = e.target.closest('[data-pick]');
        if (pk && this.at) this.chooseAt(pk.dataset.pick);
        else if (pk) this.choosePick(pk.dataset.pick);
      });
      document.addEventListener('mousedown', (e) => {
        if (!this.menuEl.hidden && !this.menuEl.contains(e.target)) this.closeSlash();
      });
    }

    // children: the page's sub-pages [{ ref, title }]; any not placed in the page yet are added at the end.
    load(md, { base = '', children = [] } = {}) {
      pageBase = base;
      this.blocks = parse(md);
      const seen = new Set();
      const mark = (list) =>
        list.forEach((b) => {
          if (b.type === 'page') {
            const c = children.find((x) => x.ref === b.ref);
            b.missing = !c;
            if (c) b.text = c.title;
            seen.add(b.ref);
          }
          if (b.type === 'task' && b.ref) {
            const t = this.opts.taskInfo?.(b.ref);
            if (t) b.text = t.title; // the page keeps the task's current title
          }
          if (b.children) mark(b.children);
        });
      mark(this.blocks);
      for (const c of children) if (!seen.has(c.ref)) this.blocks.push(blk('page', c.title, { ref: c.ref }));
      if (!this.blocks.length || this.blocks[this.blocks.length - 1].type !== 'p' || this.blocks[this.blocks.length - 1].text) this.blocks.push(blk());
      this.closeSlash();
      this.selected = new Set();
      this.history = [this.markdown()];
      this.hIndex = 0;
      this.render();
    }
    markdown() {
      const md = toMarkdown(this.blocks.filter((b, i) => !(i === this.blocks.length - 1 && b.type === 'p' && !b.text)).filter(keep));
      return md ? `${md}\n` : '';
    }
    changed() {
      this.opts.onChange?.();
      this.root.classList.toggle('is-empty', this.blocks.length === 1 && this.blocks[0].type === 'p' && !this.blocks[0].text);
      // Undo history: a snapshot once you pause typing (structural edits snapshot right away via snap()).
      clearTimeout(this.snapTimer);
      this.snapTimer = setTimeout(() => this.snap(), 450);
    }
    snap() {
      clearTimeout(this.snapTimer);
      const md = this.markdown();
      if (md === this.history[this.hIndex]) return;
      this.history = [...this.history.slice(0, this.hIndex + 1), md].slice(-200);
      this.hIndex = this.history.length - 1;
    }
    // ⌘Z / ⌘⇧Z across the whole page (a block's own undo would only know that block).
    undo(redo = false) {
      this.snap();
      const next = this.hIndex + (redo ? 1 : -1);
      if (next < 0 || next >= this.history.length) return;
      const at = this.focusIndex();
      this.hIndex = next;
      const keepHistory = { history: this.history, hIndex: this.hIndex };
      this.load(this.history[next], { base: pageBase, children: this.opts.subPages?.() || [] });
      Object.assign(this, keepHistory);
      this.opts.onChange?.();
      const flat = this.flat();
      const b = flat[Math.min(at, flat.length - 1)];
      if (b) this.focus(b.id);
    }
    focusIndex() {
      const el = document.activeElement?.closest?.('.blk');
      return el ? this.flat().findIndex((b) => b.id === el.dataset.id) : 0;
    }

    // ---- The block tree ----
    find(id, list = this.blocks, parent = null) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].id === id) return { list, index: i, block: list[i], parent };
        if (list[i].children) {
          const f = this.find(id, list[i].children, list[i]);
          if (f) return f;
        }
      }
      return null;
    }
    // Blocks in reading order (open toggles' children included): for arrow keys and merging.
    flat(list = this.blocks, out = []) {
      for (const b of list) {
        out.push(b);
        if (b.type === 'toggle' && b.open && b.children) this.flat(b.children, out);
      }
      return out;
    }
    el(id) {
      return this.root.querySelector(`.blk[data-id="${id}"] > .blk-row > .bc`);
    }

    // ---- Drawing ----
    render() {
      this.root.innerHTML = this.list(this.blocks) + '<div class="blk-tail" title="Click to add a block"></div>';
    }
    list(list) {
      let n = 0;
      let prevIndent = -1;
      return list
        .map((b) => {
          if (b.type === 'ol') {
            n = prevIndent === (b.indent || 0) || n === 0 ? n + 1 : 1;
            prevIndent = b.indent || 0;
          } else {
            n = 0;
            prevIndent = -1;
          }
          return this.block(b, n);
        })
        .join('');
    }
    block(b, num) {
      const lead = {
        ul: `<span class="blk-lead bullet">${['•', '◦', '▪'][(b.indent || 0) % 3]}</span>`,
        ol: `<span class="blk-lead num">${num}.</span>`,
        todo: `<span class="blk-lead"><button class="blk-check ${b.checked ? 'on' : ''}" data-check tabindex="-1"></button></span>`,
        toggle: `<span class="blk-lead"><button class="blk-arrow ${b.open ? 'open' : ''}" data-arrow tabindex="-1">▶</button></span>`,
        callout: '<span class="blk-lead emoji">💡</span>',
        task: b.ref ? '' : '<span class="blk-lead task-lead">▣</span>',
      }[b.type] || '';
      const kind = kindOf(b);
      const content =
        b.type === 'divider'
          ? '<div class="bc divider" tabindex="0"><hr></div>'
          : b.type === 'page'
            ? `<div class="bc page-link ${b.missing ? 'missing' : ''}" tabindex="0" data-open-page="${escH(b.ref)}"><span class="pg-ic">📄</span><span class="pg-title">${escH(b.text || 'Untitled')}</span>${b.missing ? '<span class="pg-missing">not found</span>' : ''}</div>`
          : b.type === 'task' && b.ref
            ? this.taskHtml(b)
          : b.type === 'image'
            ? `<div class="bc image-block" tabindex="0" data-image="${escH(b.src)}"><img src="${escH(this.opts.imageSrc ? this.opts.imageSrc(b.src) : b.src)}" alt="${escH(b.alt || '')}" draggable="false"></div>`
          : `<div class="bc" contenteditable="true" spellcheck="${b.type === 'code' ? 'false' : 'true'}" data-ph="${PLACEHOLDER[kind] || ''}">${b.type === 'code' ? escH(b.text) : mdToHtml(b.text)}</div>`;
      const kids =
        b.type === 'toggle' && b.open
          ? `<div class="blk-children">${b.children?.length ? this.list(b.children) : `<div class="blk-empty-toggle" data-fill="${b.id}">Empty toggle. Click to add a block inside.</div>`}</div>`
          : '';
      return `<div class="blk t-${b.type}${b.level ? ` th th${b.level}` : ''} ${b.checked ? 'checked' : ''}" data-id="${b.id}" style="--indent:${b.indent || 0}">
        <div class="blk-row">
          ${this.gutter()}
          ${lead}${content}
        </div><div class="blk-outs" contenteditable="false">${this.outsHtml(b)}</div>${kids}</div>`;
    }
    outBox(t, title) {
      const links = (t.links || []).map((l) => `<a class="tk-link" href="${escH(l.url)}" title="${escH(l.url)}">${l.label}</a>`).join('');
      return `${title ? `<div class="tk-out-of">${escH(title)}</div>` : ''}${links ? `<div class="tk-links">${links}</div>` : ''}${String(t.output || '').trim() ? staticMd(t.output, t.imageSrc) : links ? '' : '<div class="tk-none">No output yet. Write it on the item’s Output tab, or save a reply there from Claude Code.</div>'}`;
    }
    // The output of the items mentioned in a line (those switched on from the ⋮⋮ menu), under the line.
    outsHtml(b) {
      return mentionsIn(b)
        .filter((m) => m.out)
        .map((m) => {
          const t = this.opts.taskInfo?.(m.id);
          return t ? `<div class="tk-out inline" data-open-task="${escH(m.id)}" data-open-output title="Open its Output">${this.outBox(t, t.title)}</div>` : '';
        })
        .join('');
    }
    // A task block becomes a line of text with the item as a mention in it, so you can write around it.
    toInline(b, offset = Infinity, type = '') {
      const t = this.opts.taskInfo?.(b.ref);
      const kind = String(b.ref).startsWith('q-') ? 'quick' : 'task';
      const icon = t?.kind === 'todo' ? '☐' : t?.kind === 'session' ? '✳︎' : '▣';
      const title = String(t?.title || b.text || 'Untitled').replace(/[[\]]/g, '');
      this.snap();
      const link = `[${icon} ${title}](agentdesk://${kind}/${encodeURIComponent(b.ref)}${b.out ? '?output' : ''})`;
      b.type = 'p';
      b.text = offset === 0 ? `${type} ${link}` : `${link} ${type}`;
      delete b.ref;
      delete b.out;
      this.render();
      this.focus(b.id, offset === 0 ? type.length : Infinity);
      this.changed();
    }
    // A task block, live: a chip like a mention (its icon: a status dot, ✳︎ for an Inbox session, ☐ for a to-do; the
    // title), then "Running / Needs input / New" and the status. Gone (in the Trash): faint. Notes about it are the
    // blocks you keep under it.
    taskHtml(b) {
      const t = this.opts.taskInfo?.(b.ref);
      if (!t) return `<div class="bc task-link gone" tabindex="0" data-open-task="${escH(b.ref)}"><div class="tk-row"><span class="tk-chip"><span class="tk-ic">▣</span>${escH(b.text || 'Task')}</span><span class="tk-status">not here any more</span></div></div>`;
      const flag = t.flag ? `<span class="tk-flag ${t.flag}"><span class="dot"></span>${escH(t.flagLabel || t.flag)}</span>` : '';
      const has = Boolean(String(t.output || '').trim() || t.links?.length);
      const toggle = has || b.out ? `<span class="tk-out-toggle ${b.out ? 'on' : ''}" data-out-toggle title="Show or hide its output here">${b.out ? '▾' : '▸'} Output</span>` : '';
      const box = b.out ? `<div class="tk-out" data-open-output>${this.outBox(t)}</div>` : '';
      return `<div class="bc task-link ${t.closed ? 'closed' : ''}" tabindex="0" data-open-task="${escH(b.ref)}" title="Open it"><div class="tk-row"><span class="tk-chip"><span class="tk-ic">${t.icon || ''}</span>${escH(t.title || b.text || 'Untitled')}</span>${flag}<span class="tk-spacer"></span>${toggle}<span class="tk-status">${escH(t.statusLabel || '')}</span></div>${box}</div>`;
    }
    // Tasks changed (status, Claude activity, a rename): redraw the task blocks in place, without disturbing typing.
    refreshTasks() {
      for (const el of this.root.querySelectorAll('.blk.t-task')) {
        const b = this.find(el.dataset.id)?.block;
        if (!b?.ref) continue;
        const t = this.opts.taskInfo?.(b.ref);
        if (t) b.text = t.title;
        const row = el.querySelector(':scope > .blk-row');
        const html = this.gutter() + this.taskHtml(b);
        if (row && row.innerHTML.trim() !== html.trim()) row.innerHTML = html;
      }
      for (const el of this.root.querySelectorAll('.blk > .blk-outs')) {
        const b = this.find(el.parentElement.dataset.id)?.block;
        const html = b ? this.outsHtml(b) : '';
        if (el.innerHTML !== html) el.innerHTML = html;
      }
    }
    gutter() {
      return '<div class="blk-gutter"><span class="blk-add" data-add title="Add a block below">＋</span><span class="blk-handle" draggable="true" data-handle title="Drag to move · click for options">⋮⋮</span></div>';
    }
    focus(id, offset = Infinity) {
      const el = this.el(id);
      if (el) {
        if (el.classList.contains('divider') || el.classList.contains('page-link') || el.classList.contains('task-link') || el.classList.contains('image-block')) el.focus();
        else setCaret(el, offset);
      }
    }
    insertAfter(id, nb) {
      const f = this.find(id);
      f.list.splice(f.index + 1, 0, nb);
      return nb;
    }

    // ---- Typing ----
    onInput(e) {
      const el = e.target.closest('.bc');
      if (!el) return;
      const id = el.closest('.blk').dataset.id;
      const f = this.find(id);
      if (!f) return;
      const b = f.block;
      b.text = b.type === 'code' ? el.innerText.replace(/\n$/, '') : htmlToMd(el);
      if (!el.textContent && el.innerHTML) el.innerHTML = ''; // keep :empty working for the placeholder
      if (this.shortcut(b, el)) return;
      if (b.type === 'task') this.updatePick(b);
      else if (this.at?.id === b.id || (this.opts.findTasks && b.type !== 'code' && /(^|\s)@$/.test(textBefore(el)))) this.updateAt(b, el);
      else this.updateSlash(b, el);
      this.changed();
    }
    // Notion's Markdown shortcuts: typed at the start of a text block, right before the caret.
    shortcut(b, el) {
      if (b.type !== 'p') return false;
      const before = textBefore(el).replace(/\u00a0/g, ' ');
      const type = SHORTCUTS[before];
      if (!type || (type === 'divider' && el.textContent !== '---')) return false;
      b.text = htmlToMd(el).slice(before.length);
      this.setType(b, type);
      return true;
    }
    setType(b, type) {
      if (type === 'page') return this.makePage(b);
      if (type === 'task') return this.makeTask(b);
      if (type === 'image') return this.makeImage(b);
      this.snap();
      const was = b.type;
      const th = type.match(/^th([123])$/);
      if (th) type = 'toggle';
      b.type = type;
      if (th) b.level = Number(th[1]);
      else delete b.level;
      if (type === 'toggle' && !b.children) b.children = [];
      if (type === 'toggle') b.open = true;
      if (!LISTS.has(type)) delete b.indent;
      if (was === 'task') delete b.ref;
      if (type === 'divider') {
        b.text = '';
        const next = this.insertAfter(b.id, blk());
        this.render();
        this.focus(next.id, 0);
      } else {
        this.render();
        this.focus(b.id, was === 'p' ? 0 : Infinity);
      }
      this.changed();
    }

    onKey(e) {
      if (e.target === this.root && this.selected.size) return this.onSelectionKey(e);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        return this.undo(e.shiftKey);
      }
      const el = e.target.closest('.bc');
      if (!el) return;
      if (e.key === 'Escape' && !this.slash) {
        // Esc selects the block you're in (then Backspace deletes it, ⌘C copies it, arrows move…)
        e.preventDefault();
        e.stopPropagation();
        return this.select([el.closest('.blk').dataset.id]);
      }
      if (el.classList.contains('page-link') || el.classList.contains('task-link') || el.classList.contains('image-block') || el.classList.contains('divider')) {
        const id = el.closest('.blk').dataset.id;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (el.dataset.openPage) return this.opts.openPage?.(el.dataset.openPage);
          if (el.dataset.openTask && (e.metaKey || e.ctrlKey)) return this.opts.openTask?.(el.dataset.openTask);
          const nb = this.insertAfter(id, blk());
          this.render();
          return this.focus(nb.id, 0);
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          return this.select([id]);
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return this.step(e, this.find(id).block, e.key === 'ArrowUp' ? -1 : 1);
        // Typing on a task block: it becomes a line with the item mentioned in it, and what you type goes before it.
        if (el.classList.contains('task-link') && e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
          const b = this.find(id)?.block;
          if (b?.ref) {
            e.preventDefault();
            this.toInline(b, 0, e.key);
          }
        }
        return;
      }
      const id = el.closest('.blk').dataset.id;
      const f = this.find(id);
      if (!f) return;
      const b = f.block;
      if (this.slash && this.slashKey(e)) return;
      if (this.at && this.atKey(e)) return;
      if (this.pick && this.pickKey(e)) return;
      // ⌘A in a block whose text is all selected already: select every block
      if (mod && e.key === 'a' && getSelection().toString() === el.textContent) {
        e.preventDefault();
        return this.select(this.flat().map((x) => x.id));
      }
      // Shift+↑/↓ at the edge of a block: start selecting blocks
      if (e.shiftKey && !mod && ((e.key === 'ArrowUp' && atStart(el)) || (e.key === 'ArrowDown' && atEnd(el)))) {
        e.preventDefault();
        return this.select([b.id], e.key === 'ArrowUp' ? -1 : 1);
      }
      if (mod && !e.shiftKey && (e.key === 'b' || e.key === 'i')) {
        e.preventDefault();
        document.execCommand(e.key === 'b' ? 'bold' : 'italic');
        return;
      }
      if (mod && e.key === 'e') {
        e.preventDefault();
        return this.wrapCode(el);
      }
      if (e.key === 'Enter' && !e.isComposing) {
        if (b.type === 'code' && !mod) {
          e.preventDefault();
          document.execCommand('insertLineBreak');
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          document.execCommand('insertLineBreak');
          return;
        }
        e.preventDefault();
        return this.enter(b, el);
      }
      if (e.key === 'Backspace' && atStart(el) && getSelection().isCollapsed) {
        e.preventDefault();
        return this.backspace(b, f);
      }
      if (e.key === 'Delete' && atEnd(el)) {
        const next = this.flat()[this.flat().indexOf(b) + 1];
        if (next && next.type !== 'divider' && !next.children?.length) {
          e.preventDefault();
          const len = el.textContent.length;
          b.text += next.text;
          this.remove(next.id);
          this.render();
          this.focus(b.id, len);
          this.changed();
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (LISTS.has(b.type)) {
          b.indent = Math.max(0, Math.min(4, (b.indent || 0) + (e.shiftKey ? -1 : 1)));
          const off = textBefore(el).length;
          this.render();
          this.focus(b.id, off);
          this.changed();
        }
        return;
      }
      if (e.key === 'ArrowUp' && onFirstLine(el)) return this.step(e, b, -1);
      if (e.key === 'ArrowDown' && onLastLine(el)) return this.step(e, b, 1);
    }
    step(e, b, dir) {
      const flat = this.flat();
      const next = flat[flat.indexOf(b) + dir];
      if (!next) return;
      e.preventDefault();
      this.focus(next.id, dir < 0 ? Infinity : 0);
    }
    enter(b, el) {
      this.snap();
      const [before, after] = splitAt(el);
      // Enter on an empty list item / toggle / quote: back to plain text (or one level out).
      if (!before && !after && b.type !== 'p') {
        if (LISTS.has(b.type) && b.indent) b.indent--;
        else (b.type = 'p'), delete b.level;
        this.render();
        this.focus(b.id, 0);
        return this.changed();
      }
      if (b.type === 'task') return this.commitTask(b, null, before + after); // a draft: create the task
      b.text = before;
      let nb;
      if (b.type === 'toggle' && b.open) {
        nb = blk('p', after);
        b.children = [nb, ...(b.children || [])];
      } else {
        const keep = LISTS.has(b.type) || (b.type === 'toggle' && !b.level) ? b.type : 'p';
        nb = this.insertAfter(b.id, blk(keep, after, LISTS.has(keep) ? { indent: b.indent || 0 } : keep === 'toggle' ? { open: false, children: [] } : {}));
      }
      this.render();
      this.focus(nb.id, 0);
      this.changed();
    }
    backspace(b, f) {
      this.snap();
      if (b.type !== 'p') {
        if (b.type === 'task') this.closeSlash();
        if (LISTS.has(b.type) && b.indent) b.indent--;
        else {
          if (b.type === 'toggle' && b.children?.length) f.list.splice(f.index + 1, 0, ...b.children);
          b.type = 'p';
          delete b.children;
          delete b.level;
        }
        this.render();
        this.focus(b.id, 0);
        return this.changed();
      }
      const flat = this.flat();
      const prev = flat[flat.indexOf(b) - 1];
      if (!prev) return;
      if (prev.type === 'divider') {
        this.remove(prev.id);
        this.render();
        this.focus(b.id, 0);
        return this.changed();
      }
      const len = (this.el(prev.id)?.textContent || '').length;
      prev.text = (prev.text || '') + (b.text || '');
      this.remove(b.id);
      this.render();
      this.focus(prev.id, len);
      this.changed();
    }
    remove(id) {
      const f = this.find(id);
      if (f) f.list.splice(f.index, 1);
      if (!this.blocks.length) this.blocks.push(blk());
    }
    wrapCode(el) {
      const r = caretRange(el);
      if (!r || r.collapsed) return;
      const code = document.createElement('code');
      code.appendChild(r.extractContents());
      r.insertNode(code);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    onPaste(e) {
      const el = e.target.closest('.bc');
      if (!el) return;
      const id = el.closest('.blk').dataset.id;
      const b = this.find(id).block;
      const images = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
      if (images.length && this.opts.saveImage) {
        e.preventDefault();
        return this.insertImages(images, b);
      }
      const text = e.clipboardData.getData('text/plain');
      e.preventDefault();
      if (b.type === 'code' || !text.includes('\n')) return document.execCommand('insertText', false, text);
      // Several lines: they become blocks (Markdown is understood), after this one.
      const parsed = parse(text);
      if (!parsed.length) return;
      let at = b;
      if (!b.text) {
        Object.assign(b, { ...parsed.shift(), id: b.id });
      }
      for (const nb of parsed) at = this.insertAfter(at.id, nb);
      this.render();
      this.focus(at.id);
      this.changed();
    }

    // ---- Selecting whole blocks (Esc, Shift+↑/↓ at an edge, dragging across blocks, ⌘A twice) ----
    select(ids, extend = 0) {
      const flat = this.flat().map((b) => b.id);
      let list = ids.filter((id) => flat.includes(id));
      if (extend && list.length) {
        const i = flat.indexOf(list[list.length - 1]) + extend;
        if (flat[i]) list = extend < 0 ? [flat[i], ...list] : [...list, flat[i]];
      }
      this.selected = new Set(list);
      this.selAnchor = list[0];
      document.activeElement?.blur?.();
      getSelection().removeAllRanges();
      this.root.focus({ preventScroll: true });
      this.paintSelection();
    }
    selectRange(fromId, toId) {
      const flat = this.flat().map((b) => b.id);
      const [a, b] = [flat.indexOf(fromId), flat.indexOf(toId)].sort((x, y) => x - y);
      this.select(flat.slice(a, b + 1));
    }
    clearSelection() {
      if (!this.selected.size) return;
      this.selected = new Set();
      this.paintSelection();
    }
    paintSelection() {
      for (const el of this.root.querySelectorAll('.blk')) {
        const on = this.selected.has(el.dataset.id);
        el.classList.toggle('selected', on);
        if (on) el.setAttribute('draggable', 'true');
        else el.removeAttribute('draggable');
      }
    }
    selectedBlocks() {
      return this.flat().filter((b) => this.selected.has(b.id));
    }
    // Keys while blocks are selected.
    onSelectionKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        return this.undo(e.shiftKey);
      }
      const blocks = this.selectedBlocks();
      const flat = this.flat();
      if (e.key === 'Escape') return this.clearSelection();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        return this.deleteBlocks(blocks);
      }
      if (mod && (e.key === 'c' || e.key === 'x')) {
        e.preventDefault();
        navigator.clipboard.writeText(toMarkdown(blocks));
        if (e.key === 'x') this.deleteBlocks(blocks);
        return;
      }
      if (mod && e.key === 'd') {
        e.preventDefault();
        let at = blocks[blocks.length - 1];
        for (const b of parse(toMarkdown(blocks))) at = this.insertAfter(at.id, b);
        this.render();
        this.snap();
        return this.changed();
      }
      if (mod && e.key === 'a') {
        e.preventDefault();
        return this.select(flat.map((b) => b.id));
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const b = blocks[0];
        this.clearSelection();
        return this.focus(b.id);
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        if (e.shiftKey) return this.select(blocks.map((b) => b.id), dir);
        const edge = dir < 0 ? blocks[0] : blocks[blocks.length - 1];
        const next = flat[flat.indexOf(edge) + dir] || edge;
        return this.select([next.id]);
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        for (const b of blocks) if (LISTS.has(b.type)) b.indent = Math.max(0, Math.min(4, (b.indent || 0) + (e.shiftKey ? -1 : 1)));
        this.render();
        this.paintSelection();
        return this.changed();
      }
    }
    deleteBlocks(blocks) {
      const pages = blocks.filter((b) => b.type === 'page' && !b.missing);
      // A sub-page block is the page itself (like Notion): deleting it moves the page to the Trash.
      if (pages.length && !this.opts.deletePages?.(pages.map((b) => b.ref))) return;
      const flat = this.flat();
      const after = flat[flat.indexOf(blocks[blocks.length - 1]) + 1];
      for (const b of blocks) this.remove(b.id);
      this.selected = new Set();
      this.render();
      this.snap();
      this.changed();
      if (after && this.find(after.id)) this.focus(after.id, 0);
    }
    onMouseDown(e) {
      if (e.target.closest('.blk-gutter') || e.button !== 0) return;
      // Pressing outside the text (the margin, between blocks, below the last one) and dragging selects the blocks
      // the pointer passes, as in Notion.
      if (!e.target.closest('.bc, .blk-lead, .blk-check, .blk-arrow')) return this.startBand(e);
      // Right of a block's text (not on it): a drag selects blocks too, as in Notion.
      const bc = e.target.closest('.bc');
      if (bc && bc.isContentEditable && e.target === bc && bc.textContent && e.clientX > textRight(bc) + 6) return this.startBand(e, bc);
      if (e.target.closest('.blk.selected')) {
        // Pressing on a selected block starts a drag of the selection; a plain click clears it instead.
        e.preventDefault();
        const clear = () => {
          document.removeEventListener('mouseup', clear);
          document.removeEventListener('dragstart', cancel, true);
          this.clearSelection();
        };
        const cancel = () => document.removeEventListener('mouseup', clear);
        document.addEventListener('mouseup', clear);
        document.addEventListener('dragstart', cancel, true);
        return;
      }
      this.clearSelection();
      const blkEl = e.target.closest('.blk');
      this.dragSel = blkEl ? { from: blkEl.dataset.id, active: false } : null;
    }
    // A rubber-band selection started in the margin (the app also starts one from the page's padding around the editor).
    startBand(e, clicked = null) {
      if (e.button !== 0) return;
      e.preventDefault();
      this.clearSelection();
      document.activeElement?.blur?.();
      this.band = { x0: e.clientX, y0: e.clientY, active: false, clicked };
    }
    endBand() {
      const b = this.band;
      this.band = null;
      bandRect.hidden = true;
      if (b?.active) this.bandAt = Date.now(); // (the click that ends the drag isn't a click on the page)
      if (b && !b.active && b.clicked?.isConnected) setCaret(b.clicked, Infinity); // (it was just a click: type there)
    }
    // Dragging the mouse from one block into another selects whole blocks, as in Notion.
    onMouseMove(e) {
      if (this.band && e.buttons & 1) {
        const [top, bottom] = [Math.min(this.band.y0, e.clientY), Math.max(this.band.y0, e.clientY)];
        if (!this.band.active && bottom - top < 4 && Math.abs(e.clientX - this.band.x0) < 4) return;
        this.band.active = true;
        const [left, right] = [Math.min(this.band.x0, e.clientX), Math.max(this.band.x0, e.clientX)];
        Object.assign(bandRect.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
        bandRect.hidden = false;
        const ids = [];
        for (const el of this.root.querySelectorAll('.blk')) {
          const r = el.querySelector(':scope > .blk-row').getBoundingClientRect();
          if (r.bottom >= top && r.top <= bottom) ids.push(el.dataset.id);
        }
        const flat = new Set(this.flat().map((b) => b.id));
        const list = ids.filter((id) => flat.has(id));
        if (list.join() !== [...this.selected].join()) {
          if (list.length) this.select(list);
          else this.clearSelection();
        }
        return;
      }
      if (!this.dragSel || !(e.buttons & 1) || this.drag) return;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.blk');
      if (!over || !this.root.contains(over)) return;
      if (over.dataset.id === this.dragSel.from && !this.dragSel.active) return;
      this.dragSel.active = true;
      this.selectRange(this.dragSel.from, over.dataset.id);
    }

    // ---- The / menu ----
    updateSlash(b, el) {
      const before = textBefore(el);
      const m = before.match(/(?:^|\s)\/([\w ]{0,24})$/);
      if (!m || b.type === 'code') return this.slash?.fromPlus ? null : this.closeSlash();
      this.openSlash(b.id, m[1], false);
    }
    openSlash(id, query, fromPlus) {
      this.slash = { id, query: query.trim().toLowerCase(), fromPlus, sel: this.slash?.id === id ? this.slash.sel : 0 };
      const items = this.slashItems();
      if (!items.length) return this.closeSlash();
      this.slash.sel = Math.min(this.slash.sel, items.length - 1);
      this.menuEl.innerHTML =
        '<div class="slash-head">Blocks</div>' +
        items
          .map(
            (t, i) => `<div class="slash-item ${i === this.slash.sel ? 'sel' : ''}" data-type="${t.type}"><span class="slash-ic">${t.icon}</span><span class="slash-label">${t.label}</span>${t.hint ? `<span class="slash-hint">${escH(t.hint)}</span>` : ''}</div>`
          )
          .join('');
      this.menuEl.hidden = false;
      const el = this.el(id);
      const r = (caretRange(el)?.getClientRects()[0]) || el.getBoundingClientRect();
      const top = r.bottom + 6 + this.menuEl.offsetHeight > innerHeight ? r.top - this.menuEl.offsetHeight - 6 : r.bottom + 6;
      this.menuEl.style.top = `${Math.max(8, top)}px`;
      this.menuEl.style.left = `${Math.min(r.left, innerWidth - this.menuEl.offsetWidth - 8)}px`;
      this.menuEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }
    slashItems() {
      const q = this.slash.query;
      return TYPES.filter(
        (t) => (t.type !== 'page' || this.opts.createPage) && (t.type !== 'task' || this.opts.createTask) && (t.type !== 'image' || this.opts.pickImage) && (!q || t.label.toLowerCase().includes(q) || t.keys.includes(q))
      );
    }
    slashKey(e) {
      const items = this.slashItems();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.slash.sel = (this.slash.sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        this.openSlash(this.slash.id, this.slash.query, this.slash.fromPlus);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (items[this.slash.sel]) this.applySlash(items[this.slash.sel].type);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeSlash();
        return true;
      }
      return false;
    }
    applySlash(type) {
      const { id, fromPlus } = this.slash;
      this.closeSlash();
      const f = this.find(id);
      if (!f) return;
      const b = f.block;
      if (!fromPlus) {
        // take out the "/query" you typed
        const el = this.el(id);
        const before = textBefore(el);
        const cut = before.length - before.lastIndexOf('/');
        for (let i = 0; i < cut; i++) document.execCommand('delete');
        b.text = b.type === 'code' ? el.innerText : htmlToMd(el);
      }
      if (type === 'task' && b.text.trim() && b.type !== 'task' && this.opts.findTasks) {
        const el = this.el(id);
        el.focus();
        document.execCommand('insertText', false, '@');
        b.text = htmlToMd(el);
        return this.updateAt(b, el);
      }
      if (b.text && (type === 'divider' || type === 'code')) {
        // below what you've written, rather than turning it into a divider / code
        const nb = this.insertAfter(b.id, blk(type));
        const focusId = type === 'divider' ? this.insertAfter(nb.id, blk()).id : nb.id;
        this.render();
        this.focus(focusId, 0);
        return this.changed();
      }
      this.setType(b, type);
    }
    closeSlash() {
      this.slash = null;
      this.pick = null;
      this.at = null;
      this.menuEl.hidden = true;
    }

    // ---- Mentions: "@…" inside a line becomes a chip for a task, to-do or quick session ----
    updateAt(b, el) {
      const before = textBefore(el);
      const i = before.lastIndexOf('@');
      const q = i < 0 ? null : before.slice(i + 1);
      if (q === null || q.length > 40 || q.includes('\n')) return this.closeSlash();
      const query = q.trim();
      const items = [
        { pick: 'new', icon: '＋', label: query ? `New task “${query}”` : 'New task', sub: this.opts.newTaskHint?.(this.taskAbove(b)) || '' },
        this.opts.createTodo && { pick: 'todo', icon: '☐', label: query ? `New to-do “${query}”` : 'New to-do', sub: 'in the Inbox' },
        this.opts.createQuick && { pick: 'quick', icon: '✳︎', label: query ? `New quick session “${query}”` : 'New quick session', sub: 'in the Inbox' },
        ...(this.opts.findTasks?.(query, []) || []).map((t) => ({ pick: t.id, icon: t.icon || '▣', label: t.title, sub: t.sub || '' })),
      ].filter(Boolean);
      // (with nothing typed, the first existing item is the likely pick; once you type, "New …" is)
      const news = items.filter((x) => NEW_PICKS.has(x.pick)).length;
      const sel = this.at?.id === b.id && this.at.q === q ? this.at.sel : !query && items.length > news ? news : 0;
      this.at = { id: b.id, q, sel: Math.min(sel, items.length - 1), items };
      this.slash = null;
      this.menuEl.innerHTML =
        '<div class="slash-head">Link a task, to-do or session</div>' +
        items
          .map(
            (t, k) => `<div class="slash-item ${k === this.at.sel ? 'sel' : ''}" data-pick="${escH(t.pick)}"><span class="slash-ic">${t.icon}</span><span class="slash-text"><span class="slash-label">${escH(t.label)}</span>${t.sub ? `<span class="slash-sub">${escH(t.sub)}</span>` : ''}</span></div>`
          )
          .join('');
      this.menuEl.hidden = false;
      const r = caretRange(el)?.getClientRects()[0] || el.getBoundingClientRect();
      const top = r.bottom + 6 + this.menuEl.offsetHeight > innerHeight ? r.top - this.menuEl.offsetHeight - 6 : r.bottom + 6;
      this.menuEl.style.top = `${Math.max(8, top)}px`;
      this.menuEl.style.left = `${Math.min(r.left, innerWidth - this.menuEl.offsetWidth - 8)}px`;
      this.menuEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }
    atKey(e) {
      const n = this.at.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.at.sel = (this.at.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.menuEl.querySelectorAll('.slash-item').forEach((x, i) => x.classList.toggle('sel', i === this.at.sel));
        this.menuEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if ((e.key === 'Enter' && !e.isComposing) || e.key === 'Tab') {
        e.preventDefault();
        this.chooseAt(this.at.items[this.at.sel].pick);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeSlash();
        return true;
      }
      return false;
    }
    // The "@query" you typed becomes the chip (a new task / to-do is made first, named by the query).
    async chooseAt(pick) {
      const at = this.at;
      const f = at && this.find(at.id);
      this.closeSlash();
      if (!f) return;
      const el = this.el(at.id);
      el.focus();
      const title = at.q.trim();
      if (NEW_PICKS.has(pick) && !title) return; // (nothing to name it by: keep typing)
      for (let i = 0; i < at.q.length + 1; i++) document.execCommand('delete'); // "@" and the query
      const range = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
      let t = NEW_PICKS.has(pick) ? null : this.opts.taskInfo?.(pick);
      if (pick === 'new') t = await this.opts.createTask?.(title, { after: this.taskAbove(f.block) });
      if (pick === 'todo') t = await this.opts.createTodo?.(title);
      if (pick === 'quick') t = await this.opts.createQuick?.(title);
      if (!t) return;
      const info = this.opts.taskInfo?.(t.id) || t;
      const kind = String(t.id).startsWith('q-') ? 'quick' : 'task';
      const icon = info.kind === 'todo' ? '☐' : info.kind === 'session' ? '✳︎' : '▣';
      if (range && el.isConnected) {
        el.focus();
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      document.execCommand('insertHTML', false, `<a href="agentdesk://${kind}/${encodeURIComponent(t.id)}" class="mention" contenteditable="false">${icon} ${escH(info.title || title)}</a>&nbsp;`);
      f.block.text = htmlToMd(el);
      this.changed();
    }

    // ---- Task blocks ----
    // "/task", "[t] " or Turn into → Task. With text already on the line it becomes a task right away;
    // an empty line becomes a draft to type the title into.
    makeTask(b) {
      // A line that already mentions an item: the block is that item (not a new task named after the line);
      // anything else written on the line stays, as a line under it.
      const m = mentionsIn(b)[0];
      if (m) {
        this.snap();
        const rest = b.text.replace(m.raw, '').replace(/\s+/g, ' ').trim();
        b.type = 'task';
        b.ref = m.id;
        b.text = this.opts.taskInfo?.(m.id)?.title || m.label.replace(/^[▣☐✳︎]+\s*/, '');
        if (m.out) b.out = true;
        else delete b.out;
        delete b.indent;
        delete b.level;
        if (rest) this.insertAfter(b.id, blk('p', rest));
        this.render();
        this.focus(b.id);
        return this.changed();
      }
      if (b.text.trim()) return this.commitTask(b, null, b.text);
      this.snap();
      b.type = 'task';
      delete b.ref;
      delete b.indent;
      delete b.level;
      this.render();
      this.focus(b.id, 0);
      this.updatePick(b);
      this.changed();
    }
    // The list under a draft: "New task …" plus existing tasks that match what's typed.
    updatePick(b) {
      if (b.ref) return;
      const q = (b.text || '').trim();
      const items = [{ pick: 'new', icon: '＋', label: q ? `New task “${q}”` : 'New task', sub: this.opts.newTaskHint?.(this.taskAbove(b)) || '' }];
      if (this.opts.createTodo) items.push({ pick: 'todo', icon: '☐', label: q ? `New to-do “${q}”` : 'New to-do', sub: 'in the Inbox' });
      if (this.opts.createQuick) items.push({ pick: 'quick', icon: '✳︎', label: q ? `New quick session “${q}”` : 'New quick session', sub: 'in the Inbox' });
      for (const t of this.opts.findTasks?.(q, this.taskRefs()) || []) items.push({ pick: t.id, icon: t.icon || '▣', label: t.title, sub: t.sub || '' });
      this.pick = { id: b.id, sel: Math.min(this.pick?.id === b.id ? this.pick.sel : 0, items.length - 1), items };
      this.slash = null;
      this.menuEl.innerHTML =
        '<div class="slash-head">Tasks</div>' +
        items
          .map(
            (t, i) => `<div class="slash-item ${i === this.pick.sel ? 'sel' : ''}" data-pick="${escH(t.pick)}"><span class="slash-ic">${t.icon}</span><span class="slash-text"><span class="slash-label">${escH(t.label)}</span>${t.sub ? `<span class="slash-sub">${escH(t.sub)}</span>` : ''}</span></div>`
          )
          .join('');
      this.menuEl.hidden = false;
      const el = this.el(b.id);
      const r = el.getBoundingClientRect();
      const top = r.bottom + 6 + this.menuEl.offsetHeight > innerHeight ? r.top - this.menuEl.offsetHeight - 6 : r.bottom + 6;
      this.menuEl.style.top = `${Math.max(8, top)}px`;
      this.menuEl.style.left = `${Math.min(r.left, innerWidth - this.menuEl.offsetWidth - 8)}px`;
      this.menuEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }
    pickKey(e) {
      const n = this.pick.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.pick.sel = (this.pick.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.menuEl.querySelectorAll('.slash-item').forEach((x, i) => x.classList.toggle('sel', i === this.pick.sel));
        this.menuEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && this.pick.sel > 0)) {
        e.preventDefault();
        this.choosePick(this.pick.items[this.pick.sel].pick);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeSlash();
        return true;
      }
      return false; // Enter on "New task" goes through enter() → commitTask
    }
    choosePick(pick) {
      const b = this.pick && this.find(this.pick.id)?.block;
      if (!b) return this.closeSlash();
      this.commitTask(b, NEW_PICKS.has(pick) ? null : pick, b.text, pick);
    }
    taskRefs() {
      return this.flat().filter((b) => b.type === 'task' && b.ref).map((b) => b.ref);
    }
    // The nearest task block above this one (a new task joins its Area).
    taskAbove(b) {
      const flat = this.flat();
      for (let i = flat.indexOf(b) - 1; i >= 0; i--) if (flat[i].type === 'task' && flat[i].ref) return flat[i].ref;
      return null;
    }
    // Turn a draft into a real task block: an existing task (ref) or a new one named by the text. Then the
    // next draft is ready below, so a list of ideas goes in with Enter, Enter, Enter.
    async commitTask(b, ref, text, make = 'new') {
      this.closeSlash();
      const title = String(text || '').trim();
      if (!ref && !title) {
        b.type = 'p';
        this.render();
        this.focus(b.id, 0);
        return this.changed();
      }
      this.snap();
      let t = ref ? this.opts.taskInfo?.(ref) : null;
      if (!ref) {
        t = make === 'todo' ? await this.opts.createTodo?.(title) : make === 'quick' ? await this.opts.createQuick?.(title) : await this.opts.createTask?.(title, { after: this.taskAbove(b) });
        if (!t) return;
        ref = t.id;
      }
      const f = this.find(b.id);
      if (!f) return;
      b.type = 'task';
      b.ref = ref;
      b.text = t?.title || title;
      const next = f.list[f.index + 1];
      // The next line is a plain one (write notes under the task, or "/task" again for another).
      const nb = next && next.type === 'p' && !next.text ? next : this.insertAfter(b.id, blk());
      this.render();
      this.focus(nb.id, 0);
      this.changed();
    }
    // "/page" or Turn into → Page: a new sub-page (named after the block's text, if any) in its place.
    async makePage(b) {
      this.snap();
      const page = await this.opts.createPage?.(b.text || '');
      if (!page) return;
      const f = this.find(b.id);
      if (!f) return;
      const pb = blk('page', page.title, { ref: page.ref });
      f.list.splice(f.index, 1, pb);
      if (f.list[f.index + 1]?.type !== 'p') f.list.splice(f.index + 1, 0, blk());
      this.render();
      this.changed();
      this.opts.openPage?.(page.ref);
    }

    // ---- Images ----
    // Files (pasted or dropped) become image blocks after `b` (in its place when it's an empty text block).
    async insertImages(files, b) {
      const saved = [];
      for (const f of files) {
        try {
          const src = await this.opts.saveImage(f);
          if (src) saved.push(blk('image', '', { src, alt: '' }));
        } catch (err) {
          console.error(err);
        }
      }
      if (!saved.length) return;
      this.snap();
      const f = b && this.find(b.id);
      let at;
      if (f && b.type === 'p' && !b.text) {
        f.list.splice(f.index, 1, ...saved);
        at = saved[saved.length - 1];
      } else {
        at = b || this.blocks[this.blocks.length - 1];
        for (const nb of saved) at = this.insertAfter(at.id, nb);
      }
      const after = this.find(at.id);
      const next = after.list[after.index + 1];
      const nb = next && next.type === 'p' ? next : this.insertAfter(at.id, blk());
      this.render();
      this.focus(nb.id, 0);
      this.changed();
    }
    // "/image" or Turn into → Image: pick a file; it goes in this block's place (or after its text).
    async makeImage(b) {
      const src = await this.opts.pickImage?.();
      if (!src) return;
      const f = this.find(b.id);
      if (!f) return;
      this.snap();
      const ib = blk('image', '', { src, alt: '' });
      if (!b.text) f.list.splice(f.index, 1, ib);
      else f.list.splice(f.index + 1, 0, ib);
      const g = this.find(ib.id);
      const next = g.list[g.index + 1];
      const nb = next && next.type === 'p' ? next : this.insertAfter(ib.id, blk());
      this.render();
      this.focus(nb.id, 0);
      this.changed();
    }

    // ---- For the app: parts of the page as Markdown, and adding to it ----
    markdownOf(list) {
      return toMarkdown(list.filter((b) => !(b.type === 'p' && !b.text) && keep(b)));
    }
    // New Markdown in place of these blocks (or of the whole page, without a list): one step you can undo.
    replaceBlocks(list, md) {
      this.snap();
      const parsed = parse(md);
      const first = list?.length ? this.find(list[0].id) : null;
      if (first) {
        first.list.splice(first.index, 1, ...parsed);
        for (const b of list.slice(1)) this.remove(b.id);
      } else this.blocks = parsed;
      const tail = this.blocks[this.blocks.length - 1];
      if (!tail || tail.type !== 'p' || tail.text) this.blocks.push(blk());
      this.selected = new Set();
      this.render();
      this.snap();
      this.changed();
    }
    // Markdown added at the end (before the trailing empty line).
    appendMarkdown(md) {
      const parsed = parse(md);
      if (!parsed.length) return;
      const last = this.blocks[this.blocks.length - 1];
      const i = last && last.type === 'p' && !last.text ? this.blocks.length - 1 : this.blocks.length;
      this.blocks.splice(i, 0, ...parsed);
      if (i === this.blocks.length) this.blocks.push(blk());
      this.render();
      this.changed();
    }

    // ---- Mouse ----
    onClick(e) {
      if (Date.now() - (this.bandAt || 0) < 400) return; // the end of a rubber-band selection
      const blkEl = e.target.closest('.blk');
      const id = blkEl?.dataset.id;
      if (e.target.closest('[data-check]')) {
        const b = this.find(id).block;
        b.checked = !b.checked;
        this.render();
        return this.changed();
      }
      if (e.target.closest('[data-arrow]')) {
        const b = this.find(id).block;
        b.open = !b.open;
        this.render();
        return this.changed();
      }
      if (e.target.closest('[data-fill]')) {
        const b = this.find(e.target.closest('[data-fill]').dataset.fill).block;
        const nb = blk();
        b.children = [nb];
        this.render();
        return this.focus(nb.id, 0);
      }
      if (e.target.closest('[data-add]')) {
        const nb = this.insertAfter(id, blk());
        this.render();
        this.focus(nb.id, 0);
        return this.openSlash(nb.id, '', true);
      }
      if (e.target.closest('[data-handle]')) return this.blockMenu(e.target.closest('[data-handle]'), id);
      const pg = e.target.closest('[data-open-page]');
      if (pg) return this.opts.openPage?.(pg.dataset.openPage);
      if (e.target.closest('[data-out-toggle]')) {
        const b = this.find(id)?.block;
        if (!b) return;
        b.out = !b.out;
        this.render();
        return this.changed();
      }
      const ob = e.target.closest('[data-open-output]');
      if (ob && !e.target.closest('a')) return this.opts.openTask?.(ob.closest('[data-open-task]').dataset.openTask, 'output');
      const tl = e.target.closest('a.tk-link, .tk-out a'); // a link in a task's output: open it, not the task
      if (tl) {
        e.preventDefault();
        return this.opts.openLink?.(tl.getAttribute('href'));
      }
      if (e.target.matches?.('.tk-spacer, .tk-row')) {
        // The blank part of a task block's row: write there (the block becomes a line with the item mentioned in it).
        const b = this.find(id)?.block;
        if (b?.type === 'task' && b.ref) return this.toInline(b);
      }
      const tk = e.target.closest('[data-open-task]');
      if (tk) return this.opts.openTask?.(tk.dataset.openTask);
      // Links to a task / session / page open on click; web links on ⌘-click (a click edits the text).
      const a = e.target.closest('a');
      if (a && (a.getAttribute('href')?.startsWith('agentdesk:') || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        return this.opts.openLink?.(a.getAttribute('href'));
      }
      if (e.target.closest('.blk-tail') || e.target === this.root) {
        const last = this.blocks[this.blocks.length - 1];
        if (last.type === 'p' && !last.text) return this.focus(last.id, 0);
        const nb = blk();
        this.blocks.push(nb);
        this.render();
        this.focus(nb.id, 0);
      }
    }
    blockMenu(anchor, id) {
      const f = this.find(id);
      if (!f) return;
      const b = f.block;
      if (b.type === 'task' && b.ref) {
        const t = this.opts.taskInfo?.(b.ref);
        return this.opts.openMenu(anchor, [
          { head: t?.kind === 'todo' ? 'To-do block' : t?.kind === 'session' ? 'Quick session block' : 'Task block' },
          { icon: '↗', label: 'Open', run: () => this.opts.openTask?.(b.ref) },
          { icon: 'Aa', label: 'Turn into a line of text', sub: 'the item stays as a mention you can write around', run: () => this.toInline(b) },
          t && { icon: '✳︎', label: 'Open Claude Code', run: () => this.opts.openTask?.(b.ref, 'code') },
          t &&
            t.kind === 'task' &&
            this.opts.taskStatuses && {
              icon: '◐',
              label: `Status: ${t.statusLabel}`,
              children: this.opts.taskStatuses().map((s) => ({ icon: s.key === t.status ? '✓' : '', label: s.label, run: () => s.key !== t.status && this.opts.setStatus?.(b.ref, s.key) })),
            },
          { icon: '⎘', label: 'Copy as Markdown', run: () => navigator.clipboard.writeText(blockMd(b)) },
          ...(this.opts.extraMenu?.(b) || []),
          'hr',
          { icon: '✕', label: 'Remove from this page', sub: t?.kind === 'task' ? 'The task stays on the Board' : 'It stays in the Inbox', run: () => this.deleteBlocks([b]) },
          t && t.kind === 'task' && { icon: '🗑', label: 'Move task to Trash', danger: true, run: () => this.opts.trashTask?.(b.ref) && this.deleteBlocks([b]) },
        ]);
      }
      if (b.type === 'image') {
        return this.opts.openMenu(anchor, [
          { icon: '↗', label: 'Open', sub: b.src, run: () => this.opts.openImage?.(b.src) },
          { icon: '⎘', label: 'Copy as Markdown', run: () => navigator.clipboard.writeText(blockMd(b)) },
          'hr',
          { icon: '🗑', label: 'Delete', sub: 'The file stays in the folder', danger: true, run: () => this.deleteBlocks([b]) },
        ]);
      }
      if (b.type === 'page') {
        return this.opts.openMenu(anchor, [
          { icon: '↗', label: 'Open', run: () => this.opts.openPage?.(b.ref) },
          { icon: '↪', label: 'Move to', children: this.opts.pageTargets().map((p) => ({ icon: '📄', label: p.label, run: () => this.opts.movePage?.(b.ref, p.id) })) },
          'hr',
          { icon: '🗑', label: 'Move page to Trash', danger: true, run: () => this.deleteBlocks([b]) },
        ]);
      }
      const toggleOut = (m) => {
        this.snap();
        b.text = b.text.replace(m.raw, mentionWith(m, !m.out));
        this.render();
        this.changed();
      };
      this.opts.openMenu(anchor, [
        { head: TYPES.find((t) => t.type === kindOf(b))?.label || 'Block' },
        {
          icon: '↻',
          label: 'Turn into',
          children: TYPES.map((t) => ({ icon: t.icon, label: t.label, check: t.type === kindOf(b), run: () => this.setType(b, t.type) })),
        },
        ...mentionsIn(b).map((m) => ({ icon: m.out ? '▾' : '▸', label: `${m.out ? 'Hide' : 'Show'} output of “${m.label.replace(/^[▣☐✳︎]+\s*/, '').slice(0, 40)}”`, run: () => toggleOut(m) })),
        {
          icon: '⧉',
          label: 'Duplicate',
          run: () => {
            const copy = parse(blockMd(b))[0];
            this.insertAfter(b.id, copy);
            this.render();
            this.changed();
          },
        },
        this.opts.pageTargets().length && {
          icon: '↪',
          label: 'Move to',
          children: this.opts.pageTargets().map((p) => ({ icon: '📄', label: p.label, run: () => this.moveOut(b.id, p.id) })),
        },
        { icon: '⎘', label: 'Copy as Markdown', run: () => navigator.clipboard.writeText(blockMd(b)) },
        ...(this.opts.extraMenu?.(b) || []),
        'hr',
        {
          icon: '🗑',
          label: 'Delete',
          danger: true,
          run: () => this.deleteBlocks([b]),
        },
      ]);
    }
    // Send a block (with what's inside it) to another page; it leaves this one.
    moveOut(id, pageId) {
      const f = this.find(id);
      if (!f) return;
      this.opts.moveToPage(blockMd(f.block), pageId);
      this.remove(id);
      this.render();
      this.changed();
    }

    // ---- Dragging blocks (within the page; onto a page in the sidebar is handled by the app) ----
    // Drag a block by its handle, or a whole selection (Esc / Shift+↑↓ / drag across blocks, then drag any of them).
    onDragStart(e) {
      const h = e.target.closest?.('[data-handle]');
      const sel = e.target.closest?.('.blk.selected');
      if (!h && !sel) return;
      const el = h ? h.closest('.blk') : sel;
      this.drag = el.dataset.id;
      // The selection moves together when the dragged block is part of it (top-level blocks only).
      this.dragIds = this.selected.has(this.drag) ? this.blocks.filter((b) => this.selected.has(b.id)).map((b) => b.id) : [this.drag];
      if (!this.dragIds.includes(this.drag)) this.dragIds = [this.drag];
      dragging = this;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', toMarkdown(this.dragIds.map((id) => this.find(id).block)));
      e.dataTransfer.setDragImage(el, 10, 12);
      requestAnimationFrame(() => this.dragIds.forEach((id) => this.root.querySelector(`.blk[data-id="${id}"]`)?.classList.add('dragging')));
    }
    // A block from another editor of the same group (Not sent ↔ Claude knows) can be dropped here too.
    fromSibling() {
      return !this.drag && dragging && dragging !== this && dragging.drag && this.opts.group && dragging.opts.group === this.opts.group ? dragging : null;
    }
    onDragOver(e) {
      if (!this.drag && !this.fromSibling()) {
        if (this.opts.saveImage && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); // (files can be dropped here)
        return;
      }
      const over = e.target.closest?.('.blk');
      this.clearMarks();
      if (!over) {
        if (this.fromSibling()) {
          e.preventDefault();
          this.root.classList.add('drop-end'); // (an empty editor, or below its last block: goes at the end)
        } else if (this.root.contains(e.target)) {
          // Below the last block: it goes to the end.
          const last = this.root.querySelector(':scope > .blk:last-of-type');
          if (last && !this.dragIds.includes(last.dataset.id)) {
            e.preventDefault();
            last.classList.add('drop-after');
          }
        }
        return;
      }
      if (this.drag && this.dragIds.some((id) => over.dataset.id === id || over.closest(`.blk[data-id="${id}"]`))) return;
      e.preventDefault();
      const r = over.querySelector('.blk-row').getBoundingClientRect();
      over.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    }
    onDrop(e) {
      // Image files dropped on the page become image blocks (other files are the app's to handle).
      const files = this.drag ? [] : [...(e.dataTransfer?.files || [])];
      if (files.length && this.opts.saveImage && files.every((f) => f.type.startsWith('image/'))) {
        e.preventDefault();
        e.stopPropagation();
        const over = e.target.closest?.('.blk');
        const b = over ? this.find(over.dataset.id)?.block : this.blocks[this.blocks.length - 1];
        return this.insertImages(files, b);
      }
      const src = this.fromSibling();
      if (src) {
        e.preventDefault();
        const over = this.root.querySelector('.blk.drop-before, .blk.drop-after');
        const after = over?.classList.contains('drop-after');
        const md = src.takeDragged();
        this.clearMarks();
        if (!md) return;
        const blocks = parse(md);
        if (over && this.find(over.dataset.id)) {
          const target = this.find(over.dataset.id);
          target.list.splice(target.index + (after ? 1 : 0), 0, ...blocks);
        } else {
          const last = this.blocks[this.blocks.length - 1];
          const i = last && last.type === 'p' && !last.text ? this.blocks.length - 1 : this.blocks.length;
          this.blocks.splice(i, 0, ...blocks);
        }
        this.render();
        this.changed();
        return;
      }
      if (!this.drag) return;
      const over = this.root.querySelector('.blk.drop-before, .blk.drop-after');
      if (!over) return;
      e.preventDefault();
      const after = over.classList.contains('drop-after');
      const moving = this.dragIds.map((id) => this.find(id)).filter(Boolean);
      const blocks = moving.map((m) => m.block);
      for (const m of moving) m.list.splice(m.list.indexOf(m.block), 1);
      const target = this.find(over.dataset.id);
      target.list.splice(target.index + (after ? 1 : 0), 0, ...blocks);
      const tail = this.blocks[this.blocks.length - 1];
      if (!tail || tail.type !== 'p' || tail.text) this.blocks.push(blk()); // (always an empty line to write on at the end)
      this.endDrag();
      this.render();
      this.changed();
      if (blocks.length > 1) this.select(blocks.map((b) => b.id));
    }
    endDrag() {
      this.drag = null;
      this.dragIds = [];
      if (dragging === this) dragging = null;
      this.clearMarks();
      this.root.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
    }
    clearMarks() {
      this.root.classList.remove('drop-end');
      this.root.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    }
    // The block being dragged, taken out of this page (for a drop onto another page).
    takeDragged() {
      if (!this.drag) return null;
      const found = this.dragIds.map((id) => this.find(id)).filter(Boolean);
      this.endDrag();
      if (!found.length) return null;
      const md = toMarkdown(found.map((f) => f.block));
      for (const f of found) this.remove(f.block.id);
      this.selected = new Set();
      this.render();
      this.changed();
      return md;
    }
    draggedBlock() {
      return this.drag ? this.find(this.drag)?.block : null;
    }
    isEditing() {
      return this.root.contains(document.activeElement);
    }
  }

  window.BlockEditor = BlockEditor;
  window.BlockMarkdown = { parse, toMarkdown, staticMd, inline: mdToHtml };
})();
