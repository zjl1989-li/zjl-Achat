/* ============================================================================
 * zjl-Achat 前端原型（UI-first）
 * ----------------------------------------------------------------------------
 * 设计原则：所有「后端交互」都收口在 api 对象里。当前 api 用内存 + localStorage
 * 实现，双击 index.html 即可运行。未来接真实后端时，只需把 api.* 内部换成
 * fetch / SSE，UI 一行不用动 —— 下面这些方法签名，就是后端的契约（contract）。
 *
 * 后端契约清单（MUST implement）：
 *   api.listGroups()                       -> [{id,name,memberIds,type,status}]
 *   api.getGroup(id)                       -> {id,name,memberIds,type,status,messages[],artifacts[]}
 *   api.createGroup(name, memberIds)       -> group
 *   api.renameGroup(id, name)
 *   api.setGroupMembers(id, memberIds)
 *   api.archiveGroup(id)                   // 完结归档（status: active<->archived）
 *   api.deleteGroup(id)
 *   api.sendMessage(groupId, text, {toAgentId?}) -> 接受即返回；agent 回复经事件推送
 *   api.listAgents()                       -> [agent]  (含 status / guiPath)
 *   api.updateAgent(id, patch)             // 改 name/model/system/role...
 *   api.setAgentStatus(id, status)         // online | running | idle | offline
 *   api.launchAgentWindow(id)              // 拉起本地 GUI 主窗口（生命周期管理）
 *   api.addArtifact(groupId, {name,kind,ownerId,colorTag})
 *   api.openDM(agentId)                    -> dm group (复用 group, type:'dm')
 *   事件： api.on('message', …) / api.on('typing', …)
 * ==========================================================================*/
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const USER = { id: 'user', name: '我', color: '#3b6fd4' };

  // ---------- thin-line SVG icons ----------
  // All UI chrome uses these line icons (16x16 viewBox, currentColor) instead of
  // emoji, so buttons/badges/menus look crisp and consistent across OSes.
  const ICON = {
    gear: '<path d="M2.5 4h6.2M12 4h1.5"/><path d="M2.5 8h1.8M7.3 8h6.2"/><path d="M2.5 12h4.8M10.5 12h3"/><circle cx="10.7" cy="4" r="1.4"/><circle cx="5.2" cy="8" r="1.4"/><circle cx="8.3" cy="12" r="1.4"/>',
    users: '<circle cx="5.6" cy="5.4" r="2.2"/><circle cx="11.4" cy="6" r="1.8"/><path d="M2 13.4c0-2.1 1.6-3.6 3.6-3.6s3.6 1.5 3.6 3.6"/><path d="M10.6 10c1.6 0 3.4 1.3 3.4 3.2"/>',
    bell: '<path d="M8 2.3a4.3 4.3 0 0 1 4.3 4.3c0 3 .9 3.8.9 3.8H2.8s.9-.8.9-3.8A4.3 4.3 0 0 1 8 2.3z"/><path d="M6.7 13.1a1.4 1.4 0 0 0 2.6 0"/>',
    clipboard: '<rect x="3.5" y="3.6" width="9" height="10.8" rx="1.5"/><path d="M6.3 3.6V2.6h3.4v1"/><path d="M6 7.4h4M6 9.8h4"/>',
    flag: '<path d="M4 14.6V2.6"/><path d="M4 3h7.8l-1.9 3 1.9 3H4"/>',
    cpu: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.2"/><path d="M8 6.6v2.8M6.6 8h2.8"/><path d="M6.6 1.8v1.4M9.4 1.8v1.4M6.6 12.8v1.4M9.4 12.8v1.4M1.8 6.6h1.4M1.8 9.4h1.4M12.8 6.6h1.4M12.8 9.4h1.4"/>',
    file: '<path d="M4 1.8h5.1l2.9 2.9v9.5H4z"/><path d="M9.1 1.8v2.9H12"/>',
    image: '<rect x="2.2" y="3" width="11.6" height="10" rx="1.5"/><circle cx="5.7" cy="6.5" r="1.1"/><path d="M2.2 11.4l3.5-3.5 2.7 2.7 2.1-2.1 3 2.9"/>',
    video: '<rect x="2.2" y="4" width="9.4" height="8" rx="1.5"/><path d="M11.6 6.7l2.2-1.5v5.6l-2.2-1.5z"/>',
    audio: '<path d="M6 13V3.6l5.4-1.2V11"/><circle cx="4.2" cy="13" r="1.8"/><circle cx="9.6" cy="11.1" r="1.8"/>',
    folder: '<path d="M1.8 3.8h4.2L8 5.5h6.2v7.7H1.8z"/>',
    eye: '<path d="M1.6 8S4 3.7 8 3.7 14.4 8 14.4 8 12 12.3 8 12.3 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>',
    pencil: '<path d="M10.8 2.6l2.6 2.6L5.4 13.2l-2.8.2.2-2.8z"/>',
    link: '<path d="M6.4 9.6 9.6 6.4"/><path d="M5.5 10.5 4 12a2 2 0 0 0 2.8 2.8l1.5-1.5"/><path d="M10.5 5.5 12 4A2 2 0 0 0 9.2 1.2L7.7 2.7"/>',
    plane: '<path d="M14 2 2.6 7.7l4.5 1.6L8.7 14z"/><path d="M7.1 9.3 14 2"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V2.8h3v1.7"/><path d="M4.6 4.5l.7 9h5.4l.7-9"/><path d="M6.6 7.5v3.5M9.4 7.5v3.5"/>',
    archive: '<path d="M2.5 4.5h11V6.8H2.5z"/><path d="M3.5 6.8v6.7h9V6.8"/><path d="M8 6.8v3.2"/>',
    chat: '<path d="M2.5 3.5h11v8H6.5L4 14.5V11.5H2.5z"/>',
    play: '<path d="M5.5 3.5l7 4.5-7 4.5z"/>',
    pause: '<path d="M5.5 3.5h2v9h-2zM8.5 3.5h2v9h-2z"/>',
    upload: '<path d="M8 10.5V3.2M4.8 6.4 8 3.2l3.2 3.2"/><path d="M2.5 12.5v1.2h11v-1.2"/>',
    menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
    plus: '<path d="M8 2.5v11M2.5 8h11"/>',
    warn: '<path d="M8 2.8l6 10.4H2z"/><path d="M8 6.5v3M8 11.4v.01"/>',
    check: '<path d="M3 8.5l3.2 3.2L13 5"/>',
    tree: '<path d="M2.6 2.6h5l1.4 1.8h4.4v4.6l-2-2.6H5.4L3.4 11.4V2.6z"/><path d="M4 6.2h6l1.4 1.8H13v4.8H6.4L4.9 11"/>',
    search: '<circle cx="7.2" cy="7.2" r="4.4"/><path d="M10.6 10.6 14 14"/>',
    cloud: '<path d="M4.6 12.5h7.1a3.4 3.4 0 0 0 .3-6.8A4.6 4.6 0 0 0 3.1 6.7a3.4 3.4 0 0 0 1.5 5.8z"/>',
    plug: '<path d="M6 2.4v3.6M10 2.4v3.6"/><path d="M4.4 6h7.2v2.3a3.6 3.6 0 0 1-3.6 3.6 3.6 3.6 0 0 1-3.6-3.6z"/><path d="M8 11.9V14"/>',
    term: '<path d="M2.4 3.4h11.2v9.2H2.4z"/><path d="M5 6.4 7 8l-2 1.6"/><path d="M8.6 9.6h2.4"/>',
    box: '<path d="M2.8 5.2 8 2.6l5.2 2.6v5.6L8 13.4l-5.2-2.6z"/><path d="M2.8 5.2 8 7.8l5.2-2.6M8 7.8v5.6"/>',
    chevdown: '<path d="M4 6l4 4 4-4"/>',
    download: '<path d="M8 2.5v8M4.8 7.2 8 10.4l3.2-3.2"/><path d="M2.5 12.5v1.2h11v-1.2"/>',
    refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.4v3.4h-3.4"/>',
    x: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
    chevup: '<path d="M4 10l4-4 4 4"/>',
    arrowl: '<path d="M10.5 3 5.5 8l5 5"/>',
    arrowr: '<path d="M5.5 3l5 5-5 5"/>',
    ext: '<path d="M6.5 3.5H3.2v9.3h9.3V9.5"/><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 8 8"/>',
    deleg: '<path d="M5 3v5.5A2.5 2.5 0 0 0 7.5 11H12"/><path d="M9.5 8.5 12 11l-2.5 2.5"/>',
    funnel: '<path d="M2.4 3h11.2l-4.2 5.1v4.7L6.6 12V8.1z"/>',
    shield: '<path d="M8 1.8 13.4 4v4.2c0 3.2-2.3 5.3-5.4 6-3.1-.7-5.4-2.8-5.4-6V4z"/>',
    book: '<path d="M2.6 3.2h4.2c.8 0 1.2.5 1.2 1.2v8.6c0-.7-.4-1.2-1.2-1.2H2.6z"/><path d="M13.4 3.2H9.2c-.8 0-1.2.5-1.2 1.2v8.6c0-.7.4-1.2 1.2-1.2h4.2z"/>',
  };
  // render an icon: ic('gear') -> inline <svg> sized 14x14 (override with w/h)
  const ic = (name, w, h) => {
    const W = w || 14, H = h || w || 14;
    return `<svg viewBox="0 0 16 16" width="${W}" height="${H}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
  };

  // ================= message info hierarchy helpers =================
  // Scope: main-chat information hierarchy + message interaction only. No theme
  // overhaul, no backend contract changes. Everything below is pure frontend.

  // ---- lightweight, XSS-safe Markdown for message bubbles ----
  // Headings / lists / code / emphasis / links make long agent replies
  // scannable instead of one wall of text. HTML is escaped FIRST, so no message
  // content can inject markup or scripts regardless of what an agent writes.
  const mdEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // inline transforms. IMPORTANT: the input is RAW text; escape first so no
  // message content can ever inject markup (code spans are protected after
  // escaping and restored as safe <code>).
  function inlineMd(t) {
    if (!t) return '';
    let s = mdEsc(t);
    const codes = [];
    // 1) protect inline code spans so nothing inside them gets reformatted
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    // 2) windows / relative file paths -> monospace chip keeping the full path.
    //    The (^|[^\w]) guard stops "s://..." inside an "https://" URL from
    //    matching a drive letter.
    //    Image paths are the exception: they render as a real <img> through the
    //    server's /files proxy (http pages cannot load file://), so an agent
    //    replying with a screenshot path — markdown syntax or bare — shows
    //    the picture inline instead of a dead chip. This MUST run before any
    //    other transform, otherwise the path inside ![alt](D:\x.png) gets
    //    chip-wrapped first and the image never renders.
    s = s.replace(/(^|[^\w])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/])[\w@.\-\\/ ]*\.\w{1,8})(?![\w.])/g, (m, pre, p) => {
      const t = p.trim();
      if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(t))
        return pre + `<img class="md-img" src="/files?path=${encodeURIComponent(t)}" alt="" loading="lazy" />`;
      return pre + `<span class="path-chip">${p}</span>`;
    });
    // 3) markdown images -> inline lazy thumbnail
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      url = (url || '').trim();
      return /^(https?:|\.{0,2}[\\/]|[\\/])/i.test(url)
        ? `<img class="md-img" src="${mdEsc(url)}" alt="${mdEsc(alt || '')}" loading="lazy" />`
        : m;
    });
    // 4) markdown links -> safe target=_blank anchors
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
      url = (url || '').trim();
      return /^(https?:|\.{0,2}[\\/]|[\\/])/i.test(url)
        ? `<a href="${mdEsc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : m;
    });
    // 5) emphasis
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
    // 6) bare urls -> auto-link (trailing CJK / full-width punctuation excluded)
    s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<)>」】》〕〉,，。;；:：!！?？]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    // 7) soft line breaks + restore protected code spans
    s = s.replace(/\n/g, '<br/>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  // block-level markdown: code fences / headings / hr / blockquote / lists / p
  function renderMd(src) {
    const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^```([\w+#.-]*)\s*$/);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out += `<pre><code>${mdEsc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { out += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; i++; continue; }
      if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { out += '<hr/>'; i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out += `<blockquote>${renderMd(buf.join('\n'))}</blockquote>`;
        continue;
      }
      const lm = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (lm) {
        const ordered = /\d/.test(lm[1]);
        const items = [];
        while (i < lines.length) {
          const m2 = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
          if (m2) {
            if ((/\d/.test(m2[1])) !== ordered) break;
            items.push(inlineMd(m2[2])); i++;
          } else if (!lines[i].trim()) { i++; break; }
          else if (/^\s*>|^```|^#{1,4}\s/.test(lines[i])) break; // quote/fence/heading ends the list
          else { items[items.length - 1] = (items[items.length - 1] || '') + '<br/>' + inlineMd(lines[i].trim()); i++; }
        }
        out += `<${ordered ? 'ol' : 'ul'}>` + items.map((it) => `<li>${it}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`;
        continue;
      }
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) { buf.push(lines[i]); i++; }
      out += `<p>${inlineMd(buf.join('\n'))}</p>`;
    }
    return out;
  }

  // ---- time / date separators + sender grouping ----
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (ts) => { const d = new Date(ts || Date.now()); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const dayLabel = (ts) => {
    const d = new Date(ts || Date.now());
    const now = new Date();
    const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((sod(now) - sod(d)) / 86400000);
    if (diff <= 0) return '今天';
    if (diff === 1) return '昨天';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const senderKey = (m) => m.sender === 'user' ? 'user' : m.sender === 'system' ? 'sys' : ('agent:' + (m.agentId || ''));
  // last real message appended, used to emit date separators + grouping rhythm
  let lastMsg = { day: '', key: null, ts: 0 };
  // scroll policy: only auto-stick to bottom while the user is already at the
  // bottom; reading history up top must not be yanked down by new messages.
  let stickBottom = true;
  const SCROLL_NEAR = 48;
  function syncStick() {
    const box = $('#messages'); if (!box) return;
    const near = box.scrollTop + box.clientHeight >= box.scrollHeight - SCROLL_NEAR;
    stickBottom = near;
    $('#jumpDown') && $('#jumpDown').classList.toggle('hidden', near);
  }

  // 产物 kind -> 右栏分标签映射
  const KIND_TAB = { image: 'image', video: 'media', audio: 'media', doc: 'file', code: 'file', file: 'file' };

  // ---------------- auto-capture artifacts from agent output ----------------
  // agent 在回复 / 工具结果里给出的文件路径、图片、URL，自动登记成群空间产物，
  // 落回右栏分类（参照 WorkBuddy：agent 产出的文件会进 workspace/文件区）。
  const EXT_KIND = {
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
    mp4: 'media', mov: 'media', webm: 'media', avi: 'media',
    mp3: 'media', wav: 'media', m4a: 'media', ogg: 'media',
    md: 'file', txt: 'file', pdf: 'file', doc: 'file', docx: 'file',
    js: 'file', ts: 'file', py: 'file', json: 'file', css: 'file', html: 'file', yaml: 'file', yml: 'file',
  };
  const seenArt = {}; // groupId -> Set("name|ownerId")
  // groupId -> Map(msgId -> Set(path)) : paths an agent claimed that do not exist
  // on disk. Kept out of the artefact list on purpose -- but silently dropping
  // them means a hallucinated deliverable is indistinguishable from a quiet UI.
  const missingArt = {};

  function markMissing(groupId, msgId, path) {
    if (!groupId || !msgId) return;
    const g = missingArt[groupId] || (missingArt[groupId] = new Map());
    const s = g.get(msgId) || new Set();
    s.add(path); g.set(msgId, s);
    renderMissingChip(groupId, msgId);
  }

  function renderMissingChip(groupId, msgId) {
    if (curGroupId !== groupId) return;
    const host = document.querySelector(`.msg[data-mid="${msgId}"]`);
    if (!host) return;
    const paths = [...(missingArt[groupId].get(msgId) || [])];
    let chip = host.querySelector('.art-missing');
    if (!chip) { chip = document.createElement('div'); chip.className = 'art-missing'; host.appendChild(chip); }
    chip.innerHTML = `${ic('warn', 11, 11)} 这里提到的 ${paths.length} 个文件在磁盘上不存在，未登记为产物：`
      + paths.slice(0, 3).map((p) => `<code>${esc(p)}</code>`).join('、')
      + (paths.length > 3 ? ` 等 ${paths.length} 个` : '');
  }

  function addHit(map, src, kind) {
    if (!src) return;
    if (!map.has(src)) map.set(src, { kind: kind || null });
    else if (kind && !map.get(src).kind) map.get(src).kind = kind;
  }

  function captureArtifacts(groupId, agentId, text, msgId) {
    if (!groupId || !agentId || !text) return;
    const a = findAgent(agentId);
    const owner = a ? a.id : (agentId === 'user' ? 'user' : agentId);
    const color = a ? (a.colorTag || a.color) : (owner === 'user' ? USER.color : '#888');
    const hits = new Map();
    let m;
    const reMd = /!\[[^\]]*\]\(([^)\s]+)\)/g;            // markdown image
    while ((m = reMd.exec(text))) addHit(hits, m[1], 'image');
    const reUrl = /https?:\/\/[^\s)]+\.([A-Za-z0-9]{1,8})(?:\?[^)\s]*)?/g; // url with ext
    while ((m = reUrl.exec(text))) addHit(hits, m[0], EXT_KIND[m[1].toLowerCase()] || null);
    // The middle segment must allow separators. Without it only `D:\file.png`
    // matched, so every real path (D:\Projects\x\y.png) was silently skipped
    // while shallow junk scraped out of prose still got registered.
    const rePath = /(?:[A-Za-z]:[\\/](?:[\w.\-]+[\\/])*|\/(?:[\w.\-]+\/)+)[\w.\-]+\.([A-Za-z0-9]{1,8})/g; // file path
    while ((m = rePath.exec(text))) addHit(hits, m[0], EXT_KIND[m[1].toLowerCase()] || 'file');
    if (!hits.size) return;
    seenArt[groupId] = seenArt[groupId] || new Set();
    hits.forEach((h, src) => {
      const name = src.split(/[\\/]/).pop() || src;
      const key = name + '|' + owner;
      if (seenArt[groupId].has(key)) return;
      seenArt[groupId].add(key);
      api.addArtifact(groupId, { name, kind: h.kind || 'file', ownerId: owner, colorTag: color, src })
        .catch((e) => { if (e.status === 422 && e.reason === 'file not found') markMissing(groupId, msgId, src); });
    });
  }

  // ---------------- api (backend: fetch + SSE) ----------------
  const API = '/api';
  async function req(path, opts = {}) {
    const res = await fetch(API + path, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts,
    });
    if (!res.ok) {
      // Callers need to tell "file not found" apart from other 4xx, so carry the
      // backend's own reason instead of only the status code.
      let reason = '';
      try { reason = (await res.json()).error || ''; } catch { /* ignore */ }
      const err = new Error(reason || `${path} -> HTTP ${res.status}`);
      err.status = res.status; err.reason = reason;
      throw err;
    }
    return res.json();
  }
  const post = (path, body) => req(path, { method: 'POST', body: JSON.stringify(body || {}) });
  const patch = (path, body) => req(path, { method: 'PATCH', body: JSON.stringify(body || {}) });
  const del = (path) => req(path, { method: 'DELETE' });

  // event bus fed by SSE
  const listeners = {};
  let evtSource = null;
  let curConvId = null;
  function on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); }
  function emit(ev, data) { (listeners[ev] || []).forEach((cb) => cb(data)); }

  // SSE dies silently when the backend restarts (connection error, no event).
  // Without a reconnect the message feed and status lights stay frozen for
  // good. Reconnect with exponential backoff: 1s -> 2s -> ... cap 30s.
  function watchSse(src, back, getNext) {
    src.addEventListener('open', () => { back(1000); });
    src.onerror = () => {
      src.close();
      const delay = back();
      setTimeout(() => { try { getNext(); } catch { /* retry on next error */ } }, delay);
    };
  }
  const bump = () => {
    let v = 1000;
    return (set) => { if (set) { v = set; } else { v = Math.min(v * 2, 30000); } return v; };
  };

  function subscribe(convId) {
    if (evtSource) evtSource.close();
    curConvId = convId;
    const back = bump();
    const open = () => {
      evtSource = new EventSource(`${API}/conversations/${convId}/stream`);
      for (const ev of ['message', 'typing', 'tool', 'negotiation']) {
        evtSource.addEventListener(ev, (e) => {
          let data;
          try { data = JSON.parse(e.data); } catch { return; }
          emit(ev, { groupId: data.convId || convId, ...data });
        });
      }
      watchSse(evtSource, back, () => subscribe(curConvId));
    };
    open();
  }

  const api = {
    listGroups: () => req('/conversations'),
    getGroup: (id) => req('/conversations/' + id),
    createGroup: (name, memberIds = []) => post('/groups', { name, memberIds }),
    renameGroup: (id, name) => patch('/conversations/' + id, { name }),
    setGroupMembers: (id, memberIds) => patch('/conversations/' + id, { memberIds }),
    getHistory: (id) => req('/conversations/' + id + '/history'),
    openArchive: () => post('/archive/open', {}),
    async archiveGroup(id) {
      const g = await req('/conversations/' + id);
      return patch('/conversations/' + id, { status: g.status === 'archived' ? 'active' : 'archived' });
    },
    deleteGroup: (id) => del('/conversations/' + id),
    listAgents: () => req('/agents'),
    discoverAgents: () => req('/agents/discover'),
    updateAgent: (id, p) => patch('/agents/' + id, p),
    deleteAgent: (id) => del('/agents/' + id),
    getSettings: () => req('/settings'),
    setSettings: (p) => patch('/settings', p),
    getNotice: () => req('/notice'),
    setAgentStatus: (id, status) => patch('/agents/' + id, { status }),
    createAgent: (a) => post('/agents', a),
    probeAdapter: (config) => post('/agents/probe', { config }),
    launchAgent: (id) => post('/agents/' + id + '/launch'),
    stopAgent: (id) => post('/agents/' + id + '/stop'),
    abortAgent: (id) => post('/agents/' + id + '/abort'),
    addArtifact: (groupId, art) => post('/conversations/' + groupId + '/space', art),
    artifactFileUrl: (groupId, aid) => '/api/conversations/' + groupId + '/artifacts/' + aid + '/file',
    deleteArtifact: (groupId, aid) => del('/conversations/' + groupId + '/artifacts/' + aid),
    renameArtifact: (groupId, aid, name) => post('/conversations/' + groupId + '/artifacts/' + aid + '/rename', { name }),
    revealArtifact: (groupId, aid) => post('/conversations/' + groupId + '/artifacts/' + aid + '/reveal'),
    revealFolder: (groupId) => post('/conversations/' + groupId + '/space/folder/reveal'),
    openDM: (agentId) => post('/dm', { agentId }),
    sendMessage: (groupId, text, opts = {}) =>
      post('/conversations/' + groupId + '/messages', { text, toAgentId: opts.toAgentId }),
    startConsensus: (groupId, opts = {}) =>
      post('/conversations/' + groupId + '/consensus', opts),
    // 三库 (memory layer REST)
    kbSearch: (q, limit = 10) => req('/kb/search?q=' + encodeURIComponent(q) + '&limit=' + limit),
    kbRecent: (n = 12) => req('/kb/recent?n=' + n),
    kbRead: (title) => req('/kb/note?title=' + encodeURIComponent(title)),
    kbRemove: (title) => del('/kb/note?title=' + encodeURIComponent(title)),
    skillUpsert: (s) => post('/skills', s),
    skillRemove: (id) => del('/skills?id=' + encodeURIComponent(id)),
    aclGrant: (g) => post('/acl/grant', g),
    aclRevoke: (g) => post('/acl/revoke', g),
    aclAudit: () => req('/acl/audit'),
    distill: (convId, messageId) => post('/memory/distill', messageId ? { convId, messageId } : { convId }),
    plugins: () => req('/adapters/plugins'),
    subscribe,
    on,
  };
  async function setAgentStatus(id, s) { await api.setAgentStatus(id, s); if (curGroupId) renderMembers((await api.getGroup(curGroupId))); }

  // ---------------- traffic lights: live agent status ----------------
  // backend states: busy (red) / error (yellow) / idle (green) / offline (dark)
  // asking (purple) = the agent asked the user something and is waiting on it
  const ST_LABEL = { busy: '执行中', error: '上次失败', idle: '空闲', offline: '离线', asking: '等你回答' };
  let statusMap = {};
  let statusSrc = null;

  function subscribeStatus() {
    if (statusSrc) statusSrc.close();
    const back = bump();
    statusSrc = new EventSource(`${API}/agent-status`);
    statusSrc.addEventListener('snapshot', (e) => {
      try { statusMap = JSON.parse(e.data) || {}; } catch { statusMap = {}; }
      paintAllTraffic();
    });
    statusSrc.addEventListener('agent_status', (e) => {
      let ups = [];
      try { ups = JSON.parse(e.data) || []; } catch { return; }
      ups.forEach((u) => { statusMap[u.agentId] = u.status; });
      paintAllTraffic();
      scheduleRegRefresh(); // 服务启停会改变开关/计数，设置页开着时同步刷新
    });
    watchSse(statusSrc, back, subscribeStatus);
  }

  const stateOf = (id) => (statusMap[id] || {}).state || 'offline';

  // Agent avatar: show the agent's own picture when it has one, otherwise the
  // colored initial. cls is an extra class (e.g. 'sm' / 'msg-av').
  const avHtml = (a, cls) => {
    if (!a) return `<span class="av ${cls || ''}">?</span>`;
    const name = a.name || '?';
    if (a.avatar) return `<span class="av img ${cls || ''}" style="border-color:${a.color || 'var(--border)'}" title="${esc(name)}"><img src="${esc(a.avatar)}" alt="" /></span>`;
    return `<span class="av ${cls || ''}" style="background:${a.color || '#888'}" title="${esc(name)}">${esc(String(name)[0])}</span>`;
  };

  function trafficHtml(id, onAvatar) {
    const s = stateOf(id);
    const cls = 'traffic' + (onAvatar ? ' on-avatar' : ' lg');
    return `<span class="${cls}" data-s="${s}" data-agent="${esc(id)}" title="${esc(id)} · ${ST_LABEL[s]}"><i></i><i></i><i></i></span>`;
  }

  function paintAllTraffic() {
    $$('.traffic').forEach((el) => {
      const id = el.dataset.agent;
      const s = stateOf(id);
      el.dataset.s = s;
      el.title = `${(findAgent(id) || { name: id }).name} · ${ST_LABEL[s]}`;
    });
    if (taskAgentId) refreshTaskPop();
  }

  // ---------------- popover: interrupt / rewrite a running turn ----------------
  let taskAgentId = null;
  function taskPopEl() {
    let p = $('#taskPop');
    if (!p) {
      p = document.createElement('div');
      p.id = 'taskPop';
      p.className = 'task-pop hidden';
      document.body.appendChild(p);
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#taskPop') && !e.target.closest('.traffic')) p.classList.add('hidden');
      });
    }
    return p;
  }

  function openTaskPop(id, anchor) {
    taskAgentId = id;
    const p = taskPopEl();
    refreshTaskPop();
    p.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = 268, h = p.offsetHeight || 160;
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight) top = Math.max(12, r.top - h - 6);
    p.style.left = Math.max(12, left) + 'px';
    p.style.top = top + 'px';
  }

  function refreshTaskPop() {
    const p = $('#taskPop');
    if (!p || !taskAgentId) return;
    const a = findAgent(taskAgentId);
    if (!a) return;
    const st = statusMap[taskAgentId] || {};
    const s = st.state || 'offline';
    p.dataset.s = s;
    const secs = st.since ? Math.max(0, Math.round((Date.now() - st.since) / 1000)) : 0;
    const running = s === 'busy';
    p.innerHTML = `
      <div class="tp-head">${trafficHtml(taskAgentId)}<span>${esc(a.name)}</span><span class="st">${ST_LABEL[s]}</span></div>
      ${st.preview
        ? `<div class="tp-prev">${esc(st.preview)}</div>`
        : `<div class="tp-prev">${running ? '（该 agent 未上报任务内容）' : '当前没有执行中的任务'}</div>`}
      <div class="tp-foot">
        <button class="danger" data-act="abort">中断</button>
        <button data-act="rewrite">改内容重发</button>
      </div>
      <div class="tp-meta">${running
        ? `已运行 ${secs}s · 中断后这条不会写入记录`
        : (st.error ? esc(st.error) : '仅在「执行中」时中断有效')}</div>`;

    p.querySelector('[data-act="abort"]').onclick = async () => {
      const r = await api.abortAgent(taskAgentId).catch(() => ({ ok: false }));
      toast(r.ok ? `已中断「${a.name}」` : `「${a.name}」当前不在执行`);
      p.classList.add('hidden');
    };
    p.querySelector('[data-act="rewrite"]').onclick = async () => {
      await api.abortAgent(taskAgentId).catch(() => ({}));
      const sel = $('#sendTarget');
      if ([...sel.options].some((o) => o.value === taskAgentId)) sel.value = taskAgentId;
      $('#input').value = st.preview || $('#input').value;
      $('#input').focus();
      p.classList.add('hidden');
      toast(`已中断并回填原文，改完回车只重发给「${a.name}」`);
    };
  }

  // keep the running timer ticking without rebuilding the buttons
  function tickTaskPop() {
    const p = $('#taskPop');
    if (!p || p.classList.contains('hidden') || !taskAgentId) return;
    const st = statusMap[taskAgentId] || {};
    const s = st.state || 'offline';
    if (s !== p.dataset.s) return refreshTaskPop();
    const meta = p.querySelector('.tp-meta');
    if (meta && s === 'busy' && st.since) {
      meta.textContent = `已运行 ${Math.max(0, Math.round((Date.now() - st.since) / 1000))}s · 中断后这条不会写入记录`;
    }
  }
  setInterval(tickTaskPop, 1000);

  // agent cache: refreshed on boot and after any agent mutation, so the
  // synchronous render helpers keep working unchanged.
  let agentsCache = [];
  const findAgent = (id) => agentsCache.find((a) => a.id === id);
  async function refreshAgents() { agentsCache = await api.listAgents(); return agentsCache; }

  // ---------------- UI state ----------------
  let curGroupId = null;
  let curTab = localStorage.getItem('zjl_space_tab') || 'overview';

  // ---------------- LEFT: group list ----------------
  let groupSearch = '';
  async function renderGroups() {
    // 归档群只留在归档文件夹里，主列表不显示。
    const list = (await api.listGroups()).filter((g) => g.status !== 'archived');
    const gc = $('#groupCount'); if (gc) gc.textContent = `(${list.length})`;
    const el = $('#groupList'); el.innerHTML = '';
    const kw = groupSearch.trim().toLowerCase();
    const shown = kw ? list.filter((g) => (g.name || '').toLowerCase().includes(kw)) : list;
    if (!shown.length) {
      el.innerHTML = `<div class="empty">${kw ? '没有匹配的群' : '还没有群，点「+ 新建群」'}</div>`;
      return;
    }
    shown.forEach((g) => {
      const div = document.createElement('div');
      div.className = 'group-item' + (g.id === curGroupId ? ' active' : '') + (g.status === 'archived' ? ' archived' : '');
      const arch = g.status === 'archived' ? `<span class="garch" title="已归档">${ic('archive', 10, 10)}</span>` : '';
      div.innerHTML = `<span class="gname">${esc(g.name)}</span>${arch}
        <span class="gacts">
          <button class="gmore" title="群操作">${ic('menu', 13, 13)}</button>
        </span>`;
      // whole row selects the group; hover actions stop propagation
      div.onclick = () => selectGroup(g.id);
      div.querySelector('.gmore').onclick = (e) => { e.stopPropagation(); openGroupMenu(g, e.currentTarget); };
      el.appendChild(div);
    });
  }

  // collapsible group list: click the "群聊 (N)" header to fold / expand
  (function bindGroupFold() {
    const head = $('#groupListHead'); if (!head) return;
    head.onclick = () => {
      const folded = document.body.classList.toggle('groups-fold');
      head.classList.toggle('collapsed', folded);
      localStorage.setItem('zjl_groups_fold', folded ? '1' : '');
    };
    if (localStorage.getItem('zjl_groups_fold')) {
      document.body.classList.add('groups-fold');
      head.classList.add('collapsed');
    }
  })();

  // ⋯ menu on each group row: rename / archive / delete
  function openGroupMenu(g, anchor) {
    const menu = $('#groupMenu'); menu.innerHTML = '';
    const items = [
      { icon: 'pencil', label: '重命名', act: () => openGroupModal(g.id) },
      { icon: 'archive', label: '完结归档', act: async () => {
          await api.archiveGroup(g.id);
          if (curGroupId === g.id) { curGroupId = null; $('#convTitle').textContent = '选择一个群'; }
          await renderGroups();
          toast('已归档，可点群聊旁文件夹查看');
        } },
      { icon: 'trash', label: '删除', act: async () => {
          if (confirm('确认删除群「' + g.name + '」？此操作不可撤销')) {
            await api.deleteGroup(g.id); if (curGroupId === g.id) curGroupId = null;
            await renderGroups(); $('#convTitle').textContent = '选择一个群';
          }
        } },
    ];
    items.forEach((it) => {
      const d = document.createElement('div');
      d.className = 'ctx-item' + (it.label === '删除' ? ' del' : '');
      d.innerHTML = `${ic(it.icon, 13, 13)} ${it.label}`;
      d.onclick = () => { menu.classList.add('hidden'); it.act(); };
      menu.appendChild(d);
    });
    menu.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const mh = items.length * 36 + 12;
    let x = r.right - 160, y = r.bottom + 6;
    if (x < 8) x = 8;
    if (y + mh > window.innerHeight) y = r.top - mh - 6;
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
  }

  // ---------------- CENTER ----------------
  async function selectGroup(id) {
    curGroupId = id;
    windowCount = PAGE_SIZE; // each group starts at the newest page
    closePreview();
    api.subscribe(id);
    const g = await api.getGroup(id);
    $('#convTitle').textContent = g.name;
    renderMembers(g);
    renderMessages(g);
    renderSpace(g);
    renderSendTarget(g);
    renderNegotiation(null);
    renderGroups();
  }

  function renderMembers(g) {
    const el = $('#memberAvatars'); el.innerHTML = '';
    (g.memberIds || []).forEach((id) => {
      const a = findAgent(id); if (!a) return;
      const wrap = document.createElement('span');
      wrap.className = 'av-wrap';
      wrap.innerHTML = `${avHtml(a)}${trafficHtml(id, true)}`;
      const av = wrap.querySelector('.av');
      av.title = a.name + ' · 左键状态卡 / 右键设置+启动';
      av.onclick = (e) => { e.stopPropagation(); openAgentCard(a.id, av); };
      av.oncontextmenu = (e) => { e.preventDefault(); openCtxMenu(a.id, e.clientX, e.clientY); };
      const light = wrap.querySelector('.traffic');
      light.onclick = (e) => { e.stopPropagation(); openTaskPop(a.id, light); };
      el.appendChild(wrap);
    });
    paintAllTraffic();
  }

  // Start/stop an agent's own local service + monitor (no window, no LLM cost).
  // Lives in the settings panel, one switch per agent — the group header stays clean.
  async function toggleAgent(a) {
    const r = a.launched
      ? await api.stopAgent(a.id).catch(() => ({ stopped: false }))
      : await api.launchAgent(a.id).catch(() => ({ launched: false }));
    if (a.launched) {
      if (r.stopped) { a.launched = false; if (a.config.launcher) a.config.launcher.enabled = false; toast(r.note || `已停止「${a.name}」（本地进程与服务已关闭）`); }
      else toast(`「${a.name}」停止失败`);
    } else {
      if (r.launched) { a.launched = true; if (a.config.launcher) a.config.launcher.enabled = true; toast(r.note || `已启动「${a.name}」（静默运行，零 LLM 成本）`); }
      else toast(`「${a.name}」${r.note || '启动失败'}`);
    }
    // Persist the switch so a server restart keeps the agent's on/off state.
    if (a.config && a.config.launcher) {
      await api.updateAgent(a.id, { config: { launcher: { enabled: a.config.launcher.enabled } } }).catch(() => {});
    }
    await refreshAgents();
    renderRegistry();
    paintAllTraffic();
  }

  // Render window: painting every message at once makes long groups sluggish.
  // Show the latest PAGE and prepend older batches on demand ("加载更早消息").
  // Pure rendering concern - the backend already returns the full history.
  const PAGE_SIZE = 80;
  let windowCount = PAGE_SIZE;

  function renderMessages(g, jump = true) {
    const box = $('#messages'); box.innerHTML = '';
    const msgs = g.messages || [];
    if (!msgs.length) { box.innerHTML = '<div class="empty">还没有消息，发一条试试</div>'; return; }
    lastMsg = { day: '', key: null, ts: 0 }; // fresh grouping state per render
    const hidden = Math.max(0, msgs.length - windowCount);
    if (hidden > 0) {
      const more = document.createElement('button');
      more.className = 'load-earlier';
      more.textContent = `加载更早消息（还有 ${hidden} 条）`;
      more.onclick = () => {
        const anchor = box.querySelector('.msg');
        const anchorId = anchor ? anchor.dataset.mid : null;
        windowCount += PAGE_SIZE;
        renderMessages(g, false);
        const nb = $('#messages');
        const target = anchorId ? nb.querySelector(`.msg[data-mid="${anchorId}"]`) : null;
        nb.scrollTop = target ? target.offsetTop - 8 : nb.scrollHeight;
      };
      box.appendChild(more);
    }
    msgs.slice(-windowCount).forEach((m) => appendMessage(m, false));
    // 历史消息里的产物也补登进群空间
    msgs.forEach((m) => { if (m.agentId) captureArtifacts(g.id, m.agentId, m.text, m.id); });
    if (jump) box.scrollTop = box.scrollHeight;
    stickBottom = jump;
    syncStick();
  }
  // A summoned reply looks exactly like one the user asked for. Without this the
  // reader cannot tell that another agent pulled this one into the turn.
  function delegatedTag(m) {
    if (!m.delegatedBy) return '';
    const a = findAgent(m.delegatedBy);
    const by = esc(a ? a.name : m.delegatedBy);
    return `<span class="delegated" title="被 ${by} 点名后接手">${ic('deleg', 10, 10)} 被 ${by} 点名</span>`;
  }

  // An agent's question, rendered as an answerable card. Options come from DSH's
  // ask tool; a question recognised in plain model output has none, so the reply
  // itself is the card body. Either way the shape is the same, which is the
  // point - the channel does not care where the question came from.
  function askCard(m) {
    if (!m.ask) return '';
    const opts = (m.ask.options || []).filter((o) => o.label);
    const btns = opts.map((o) =>
      `<button class="ask-opt" data-answer="${esc(o.label)}" title="${esc(o.description || '')}">${esc(o.label)}</button>`).join('');
    return `<div class="ask-card">
        <div class="ask-head">等待你的回答</div>
        ${btns ? `<div class="ask-opts">${btns}</div>` : ''}
        <div class="ask-hint">也可以直接在下面输入框里回答</div>
      </div>`;
  }

  // Build the message DOM element (pure, reused by append + in-place update).
  function buildMsgEl(m, thinking) {
    const div = document.createElement('div');
    let who, cls, color;
    if (m.sender === 'user') { who = '我'; cls = 'user'; color = USER.color; }
    else if (m.sender === 'system') { cls = 'system'; }
    else { const a = findAgent(m.agentId); who = a ? a.name : 'agent'; cls = 'agent'; color = a ? a.color : '#888'; }
    if (cls === 'system') {
      const meta = m.meta || {};
      if (meta.consensus && meta.kind === 'round') {
        div.className = 'msg consensus-frame';
        div.innerHTML = `<div class="cf-pill">${ic('users', 11, 11)} 第 ${meta.round}/${meta.rounds} 轮 · 协商</div><div class="cf-text">${renderMd(m.text)}</div>`;
        div.dataset.mid = m.id; return div;
      }
      if (meta.consensus && meta.kind === 'conclusion') {
        div.className = 'msg consensus-frame cf-conclusion-frame';
        div.innerHTML = `<div class="cf-pill">${ic('clipboard', 11, 11)} 综合阶段</div><div class="cf-text">${renderMd(m.text)}</div>`;
        div.dataset.mid = m.id; return div;
      }
      div.className = 'msg system';
      div.innerHTML = `<div class="sys-badge">${ic('bell', 10, 10)} 系统通知</div><div class="bubble sys-bubble">${renderMd(m.text)}</div>`;
    } else {
      const isConcl = !!(m.meta && m.meta.consensusConclusion);
      const tag = isConcl ? `<span class="concl-tag">${ic('flag', 11, 11)} 共识结论</span>` : '';
      // sender role badge: one compact tag so identity reads at a glance
      const senderA = m.sender === 'agent' ? findAgent(m.agentId) : null;
      // badge shows the agent's own role; the adapter class stays internal
      const roleTag = senderA
        ? `<span class="role-tag" title="${mdEsc([capabilityOf(senderA.adapterType), senderA.role].filter(Boolean).join(' · '))}">${mdEsc(senderA.role || capabilityOf(senderA.adapterType) || 'agent')}</span>`
        : '';
      div.className = 'msg ' + cls + (isConcl ? ' consensus-conclusion' : '');
      div.innerHTML = `${senderA ? avHtml(senderA, 'msg-av') : `<span class="msg-av" style="background:${color}">${esc(who[0])}</span>`}
        <div class="msg-col">
          <div class="who"><span class="who-name">${esc(who)}</span>${roleTag}${delegatedTag(m)}${tag}<span class="time">${fmtTime(m.ts)}</span></div>
          <div class="bubble">${renderMd(m.text)}</div>${askCard(m)}${thinking ? thinkingBlockHtml(thinking.entries, thinking.collapsed) : ''}
        </div>`;
      // collapse toggle for the thinking panel baked into the final message
      const th = div.querySelector('.thinking');
      if (th) th.querySelector('.thinking-head').onclick = () => th.classList.toggle('collapsed');
      const col = div.querySelector('.msg-col');
      const cp = document.createElement('button'); cp.className = 'copy'; cp.textContent = '复制';
      cp.onclick = (e) => { e.stopPropagation(); navigator.clipboard && navigator.clipboard.writeText(m.text || ''); toast('已复制到剪贴板'); };
      col.appendChild(cp);
    }
    div.dataset.mid = m.id;
    return div;
  }

  // Cap over-long message bubbles so a giant agent reply scrolls inside its
  // own box instead of stretching the whole message. Adds a 展开/收起 toggle.
  function maybeCapBubble(div) {
    const b = div.querySelector('.bubble');
    if (!b || b.scrollHeight <= 250) return;
    b.classList.add('capped');
    const tg = document.createElement('button');
    tg.className = 'bubble-toggle';
    tg.innerHTML = '展开全部 ' + ic('chevdown', 10, 10);
    tg.style.alignSelf = div.classList.contains('user') ? 'flex-end' : 'flex-start';
    tg.onclick = () => {
      const capped = b.classList.toggle('capped');
      tg.innerHTML = capped ? '展开全部 ' + ic('chevdown', 10, 10) : '收起 ' + ic('chevup', 10, 10);
    };
    b.insertAdjacentElement('afterend', tg);
  }

  function appendMessage(m, scroll = true) {
    const box = $('#messages');
    if (box.querySelector('.empty')) box.innerHTML = '';
    // date separator: a pill appears only when the calendar day changes
    const day = dayLabel(m.ts);
    if (day !== lastMsg.day) {
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      sep.innerHTML = `<span>${day}</span>`;
      box.appendChild(sep);
      lastMsg = { day, key: null, ts: m.ts || Date.now() };
    }
    // grouping: consecutive same-sender messages inside a short window get a
    // tighter rhythm so a burst from one agent reads as one unit.
    const key = senderKey(m);
    const same = key === lastMsg.key && (m.ts - lastMsg.ts) < 10 * 60 * 1000;
    const turnSep = !same && lastMsg.key !== null && m.sender !== 'system';
    lastMsg = { day, key, ts: m.ts || Date.now() };
    // Only the newest question stays answerable. Once anything newer is on
    // screen, clicking an old card would fire a bare answer off as a new topic.
    box.querySelectorAll('.ask-card:not(.done)').forEach((el) => {
      el.classList.add('done');
      el.textContent = '曾提问';
    });
    // consume the live thinking trace for this agent's turn (if any) so the
    // final message keeps its tool-call history as a collapsible block.
    let thinking = null;
    if (m.agentId && traceStore[m.agentId] && traceStore[m.agentId].entries.length) {
      thinking = { entries: traceStore[m.agentId].entries, collapsed: traceStore[m.agentId].collapsed };
      delete traceStore[m.agentId];
    }
    const div = buildMsgEl(m, thinking);
    if (same) div.classList.add('same');
    else if (turnSep) div.classList.add('turn');
    box.appendChild(div);
    maybeCapBubble(div);
    // A question card's option buttons are real controls, not decoration:
    // clicking one sends that answer straight away. Without this binding the
    // buttons render but do nothing, so the user has to retype the label by
    // hand - a dead control that looks exactly like a bug. The card is marked
    // done immediately so a slow agent turn cannot eat a second click.
    div.querySelectorAll('.ask-opt').forEach((b) => {
      b.addEventListener('click', () => {
        const card = b.closest('.ask-card');
        if (!card || card.classList.contains('done')) return;
        card.classList.add('done');
        card.textContent = '已回答';
        send(b.dataset.answer);
      });
    });
    if (scroll) { if (stickBottom) { box.scrollTop = box.scrollHeight; } else { syncStick(); } }
  }

  function renderSendTarget(g) {
    const sel = $('#sendTarget'); sel.innerHTML = '<option value="">@ 所有人</option>';
    (g.memberIds || []).forEach((id) => {
      const a = findAgent(id); if (!a) return;
      const o = document.createElement('option'); o.value = id; o.textContent = '@ ' + a.name;
      sel.appendChild(o);
    });
    fitSendTarget();
  }

  // Native <select> sizes itself to the LONGEST option, which makes the
  // "发送对象" pill look stretched when "@ 所有人" is selected. Re-size it to
  // the currently selected option's text so it hugs its label.
  function fitSendTarget() {
    const sel = $('#sendTarget'); if (!sel) return;
    const opt = sel.options[sel.selectedIndex] || sel.options[0];
    if (!opt) return;
    const cs = getComputedStyle(sel);
    const span = document.createElement('span');
    span.textContent = opt.textContent;
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + cs.font;
    document.body.appendChild(span);
    const w = span.getBoundingClientRect().width;
    span.remove();
    // text + left padding 8 + right padding 20 + 2px border
    sel.style.width = Math.ceil(w + 30) + 'px';
  }

  // override: text supplied by an answer button instead of the input box.
  async function send(override) {
    const txt = String(override || $('#input').value).trim(); if (!txt || !curGroupId) return;
    const target = $('#sendTarget').value || null;
    $('#input').value = '';
    autosizeInput && autosizeInput();
    await api.sendMessage(curGroupId, txt, { toAgentId: target });
  }

  function showTyping(agentId, done) {
    if (done) { const t = $('#typing-' + agentId); if (t) t.remove(); return; }
    if ($('#typing-' + agentId)) return;
    const a = findAgent(agentId);
    const box = $('#messages');
    const div = document.createElement('div');
    div.className = 'msg agent'; div.id = 'typing-' + agentId;
    div.innerHTML = `<div class="who">${avHtml(a, 'sm')}${esc(a.name)}</div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
    box.appendChild(div); box.scrollTop = box.scrollHeight;
  }

  // ---------------- agent thinking / tool-call trace ----------------
  // Each agent turn produces a "thinking panel": a fixed-height, scrollable,
  // collapsible block listing steps + tool calls. We keep the data model
  // separately from the DOM so the SAME render feeds both the live typing
  // bubble and the final, persisted message.
  const traceStore = {}; // agentId -> { entries:[{kind,name,detail,callId,step,state}], collapsed }

  function tracePush(agentId, ev) {
    const t = traceStore[agentId] || (traceStore[agentId] = { entries: [], collapsed: false });
    if (ev.kind === 'tool_result') {
      const c = t.entries.find((e) => e.kind === 'tool_call' && String(e.callId) === String(ev.callId));
      if (c) c.state = 'done';
    } else {
      t.entries.push(ev);
      if (t.entries.length > 60) t.entries.shift(); // long turns must not grow forever
    }
  }

  function renderTraceBody(body, entries) {
    body.innerHTML = '';
    entries.forEach((e) => {
      if (e.kind === 'step') {
        const s = document.createElement('div'); s.className = 'tool-step'; s.textContent = `步骤 ${e.step}`; body.appendChild(s);
      } else if (e.kind === 'tool_call') {
        const done = e.state === 'done';
        const row = document.createElement('div'); row.className = 'tool-row' + (done ? ' done' : '');
        row.innerHTML = (done ? '<span class="tick">' + ic('check', 11, 11) + '</span>' : '<span class="spin"></span>') +
          `<span class="tn">${esc(e.name)}</span><span class="td">${esc(e.detail || '')}</span>`;
        body.appendChild(row);
      }
    });
  }

  function thinkingBlockHtml(entries, collapsed) {
    if (!entries || !entries.length) return '';
    const nTool = entries.filter((e) => e.kind === 'tool_call').length;
    return `<div class="thinking${collapsed ? ' collapsed' : ''}">
        <div class="thinking-head"><span class="th-ico">${ic('cpu', 12, 12)}</span><span class="th-title">思考 / 工具调用</span>
          <span class="th-count">${nTool ? nTool + ' 次调用' : ''}</span><span class="th-toggle">${ic('chevdown', 10, 10)}</span></div>
        <div class="thinking-body">${entries.map((e) => {
          if (e.kind === 'step') return `<div class="tool-step">步骤 ${esc(e.step)}</div>`;
          const done = e.state === 'done';
          return `<div class="tool-row${done ? ' done' : ''}">${done ? '<span class="tick">' + ic('check', 11, 11) + '</span>' : '<span class="spin"></span>'}<span class="tn">${esc(e.name)}</span><span class="td">${esc(e.detail || '')}</span></div>`;
        }).join('')}</div></div>`;
  }

  // Live trace of what the agent is doing, appended under its typing bubble.
  // Rows are keyed by callId so a tool/result can tick the matching tool/call off.
  function showToolCall(agentId, ev) {
    const t = $('#typing-' + agentId);
    if (!t) return;                        // typing bubble gone -> nothing to hang the trace on
    tracePush(agentId, ev);

    const bubble = t.querySelector('.bubble');
    let panel = t.querySelector('.thinking');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'thinking' + (traceStore[agentId].collapsed ? ' collapsed' : '');
      panel.innerHTML = `<div class="thinking-head"><span class="th-ico">${ic('cpu', 12, 12)}</span><span class="th-title">思考 / 工具调用</span><span class="th-count"></span><span class="th-toggle">${ic('chevdown', 10, 10)}</span></div><div class="thinking-body"></div>`;
      bubble.appendChild(panel);
      panel.querySelector('.thinking-head').onclick = () => {
        panel.classList.toggle('collapsed');
        traceStore[agentId].collapsed = panel.classList.contains('collapsed');
      };
    }
    renderTraceBody(panel.querySelector('.thinking-body'), traceStore[agentId].entries);
    const nTool = traceStore[agentId].entries.filter((e) => e.kind === 'tool_call').length;
    panel.querySelector('.th-count').textContent = nTool ? `${nTool} 次调用` : '';
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }

  // ---------------- RIGHT: group space (tabs) ----------------
  function renderSpace(g) {
    const el = $('#spaceBody'); el.innerHTML = '';
    const arts = g.artifacts || [];
    if (curTab === 'overview') {
      const grid = document.createElement('div'); grid.className = 'ov-grid';
      grid.innerHTML = `<div class="ov-card"><div class="num">${arts.length}</div><div class="lbl">产物总数</div></div>
        <div class="ov-card"><div class="num">${(g.memberIds || []).length}</div><div class="lbl">群内 agent</div></div>`;
      el.appendChild(grid);
      // 产物列表本身已带来源色点 + 类型图标，不再单独做「按来源 / 按类型」统计。
      const lbl = document.createElement('div'); lbl.className = 'section-label'; lbl.style.padding = '10px 0 4px'; lbl.textContent = '全部产物'; el.appendChild(lbl);
      if (!arts.length) el.innerHTML += '<div class="empty">还没有产物</div>';
      else appendArtGrid(el, arts);
      return;
    }
    if (curTab === 'tree') { renderTree(el, g); return; }
    if (curTab === 'browser') { renderBrowser(el); return; }
    if (curTab === 'history') { renderHistory(el, g); return; }
    // file / image / media 按 kind 过滤。kind 可能被历史数据标错（.png 标成
    // file 曾真实发生），所以每个标签都用「kind 或扩展名」双条件兜底。
    const VID_AUD_RE = /\.(mp4|webm|mov|mkv|avi|mp3|wav|m4a|ogg|flac|aac)$/i;
    const match = curTab === 'image' ? ((a) => a.kind === 'image' || IMG_NAME_RE.test(a.name || ''))
      : curTab === 'media' ? ((a) => a.kind === 'video' || a.kind === 'audio' || VID_AUD_RE.test(a.name || ''))
      : ((a) => ['file', 'doc', 'code'].includes(a.kind) && !IMG_NAME_RE.test(a.name || '') && !VID_AUD_RE.test(a.name || ''));
    const filtered = arts.filter(match);
    if (!filtered.length) { el.innerHTML = '<div class="empty">该分类暂无产物</div>'; return; }
    appendArtGrid(el, filtered);
  }

  // ---- 上下文：群聊历史（按日期生成的 markdown，agent 失忆 / 新入群可回顾） ----
  function renderHistory(el, g) {
    el.innerHTML = '<div class="empty">正在生成历史记录…</div>';
    api.getHistory(g.id).then((r) => {
      const files = r.files || [];
      el.innerHTML = '';
      const head = document.createElement('div'); head.className = 'history-head';
      head.innerHTML = `<span class="hh-t">群聊历史 · ${r.group && r.group.status === 'archived' ? '已归档' : '进行中'}</span>
        <button class="hh-ico" id="hhRefresh" title="重新生成">${ic('refresh', 13, 13)}</button>
        <button class="hh-ico" id="hhOpen" title="打开归档文件夹">${ic('folder', 13, 13)}</button>`;
      el.appendChild(head);
      if (!files.length) {
        const e = document.createElement('div'); e.className = 'empty'; e.textContent = '还没有可记录的历史对话，发几条消息试试';
        el.appendChild(e);
        bindHead(); return;
      }
      const list = document.createElement('div'); list.className = 'history-list';
      files.forEach((f) => {
        const row = document.createElement('div'); row.className = 'hitem';
        row.innerHTML = `<span class="h-date">${esc(f.date)}</span>
          <span class="h-meta">${f.msgs} 条消息 · ${f.arts} 个产物</span>
          <button class="h-down" title="下载此日 md">${ic('download', 12, 12)}</button>`;
        row.querySelector('.h-down').onclick = (e) => {
          e.stopPropagation();
          window.location.href = `/api/conversations/${encodeURIComponent(g.id)}/history/${f.date}?download=1`;
        };
        row.onclick = () => loadHistoryDay(el, g, f.date, row);
        list.appendChild(row);
      });
      el.appendChild(list);
      bindHead();
      function bindHead() {
        const rf = el.querySelector('#hhRefresh'); if (rf) rf.onclick = () => renderHistory(el, g);
        const op = el.querySelector('#hhOpen'); if (op) op.onclick = async (e) => { e.stopPropagation(); await api.openArchive(); toast('已打开归档文件夹'); };
      }
    }).catch((e) => { el.innerHTML = `<div class="empty">历史生成失败：${esc(e && e.message || e)}</div>`; });
  }

  function loadHistoryDay(el, g, date, row) {
    const exist = row.querySelector('.h-body');
    if (exist) { exist.classList.toggle('hidden'); if (!exist.classList.contains('hidden')) exist.scrollIntoView({ block: 'nearest' }); return; }
    const body = document.createElement('div'); body.className = 'h-body';
    body.innerHTML = '<div class="h-loading">加载中…</div>';
    row.appendChild(body);
    fetch(`/api/conversations/${encodeURIComponent(g.id)}/history/${date}`)
      .then((r) => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
      .then((txt) => { body.innerHTML = `<pre class="h-md">${esc(txt)}</pre>`; body.scrollIntoView({ block: 'nearest' }); })
      .catch((e) => { body.innerHTML = `<div class="empty">加载失败：${esc(e && e.message || e)}</div>`; });
  }
  // ---- 代码树：群产物目录的真实文件树（原来是写死的假结构） ----
  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const TREE_ICON = { image: ic('image', 12, 12), video: ic('video', 12, 12), audio: ic('audio', 12, 12), doc: ic('file', 12, 12), code: ic('cpu', 12, 12), file: ic('file', 12, 12) };

  // 展开的目录路径记忆：切 tab / 重渲染后保持展开状态
  const treeOpen = new Set();
  function treeNode(entry, depth) {
    const row = document.createElement('div');
    row.className = 'tnode ' + entry.type;
    row.style.paddingLeft = 6 + depth * 14 + 'px';
    if (entry.type === 'dir') {
      const isOpen = treeOpen.has(entry.path);
      row.innerHTML = `<span class="tarrow">${isOpen ? ic('chevdown', 11, 11) : ic('arrowr', 11, 11)}</span><span class="tico">${ic('folder', 12, 12)}</span><span class="tname">${esc(entry.name)}</span><span class="tsize">${(entry.children || []).length} 项</span>`;
      const kids = document.createElement('div'); kids.style.display = isOpen ? 'block' : 'none';
      (entry.children || []).forEach((ch) => kids.appendChild(treeNode(ch, depth + 1)));
      row.onclick = () => {
        const open = kids.style.display !== 'none';
        kids.style.display = open ? 'none' : 'block';
        if (open) treeOpen.delete(entry.path); else treeOpen.add(entry.path);
        row.querySelector('.tarrow').innerHTML = open ? ic('arrowr', 11, 11) : ic('chevdown', 11, 11);
      };
      const wrap = document.createElement('div'); wrap.appendChild(row); wrap.appendChild(kids);
      return wrap;
    }
    const kind = detectKind(entry.name);
    row.innerHTML = `<span class="tarrow"></span><span class="tico">${TREE_ICON[kind] || ic('file', 12, 12)}</span><span class="tname">${esc(entry.name)}</span><span class="tsize">${fmtSize(entry.size || 0)}</span>`;
    row.title = entry.path;
    row.onclick = () => openTreeFile(entry, kind);
    return row;
  }

  // A file in the folder may not be a registered artefact yet. Registering on
  // click reuses the server's existsSync check instead of a second file route.
  async function openTreeFile(entry, kind) {
    if (!curGroupId) return;
    const conv = await api.getGroup(curGroupId);
    const hit = (conv.artifacts || []).find((a) => a.src === entry.path);
    if (hit) return openPreview(hit);
    const r = await fetch('/api/conversations/' + curGroupId + '/space', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: entry.name, kind, ownerId: 'user', colorTag: USER.color, src: entry.path }),
    });
    if (!r.ok) { toast('该文件无法打开（可能已被删除）'); return; }
    openPreview(await r.json());
  }

  async function renderTree(el, g) {
    let data;
    try { data = await (await fetch('/api/conversations/' + g.id + '/tree')).json(); }
    catch { el.innerHTML = '<div class="empty">无法读取文件树</div>'; return; }
    const head = document.createElement('div'); head.className = 'tree-head';
    head.innerHTML = '<span>群产物目录</span><button class="tbtn" id="treeReveal">打开文件夹</button>';
    el.appendChild(head);
    const p = document.createElement('div'); p.className = 'tree-path'; p.textContent = data.dir || '';
    el.appendChild(p);
    if (!data.exists || !(data.entries || []).length) {
      el.insertAdjacentHTML('beforeend', '<div class="empty">该群还没有落盘文件<br/>上传产物后这里显示真实目录结构</div>');
    } else {
      const box = document.createElement('div'); box.className = 'tree';
      data.entries.forEach((e) => box.appendChild(treeNode(e, 0)));
      el.appendChild(box);
    }
    $('#treeReveal').onclick = async () => {
      try { await api.revealFolder(g.id); toast('已打开产物文件夹'); }
      catch { toast('打开文件夹失败（' + (data.dir || '未知目录') + '）'); }
    };
  }

  // ---- 浏览器：真的 iframe 嵌入，被拦时用后端代抓兜底 ----
  function renderBrowser(el) {
    const key = 'achat.browser.' + (curGroupId || '');
    const box = document.createElement('div'); box.className = 'browser-box';
    box.innerHTML = `<div class="browser-bar">
        <button class="bbtn" id="brBack" title="后退">${ic('arrowl', 12, 12)}</button>
        <button class="bbtn" id="brFwd" title="前进">${ic('arrowr', 12, 12)}</button>
        <button class="bbtn" id="brReload" title="刷新">${ic('refresh', 12, 12)}</button>
        <input id="brUrl" placeholder="http://127.0.0.1:3080" />
        <button class="bbtn" id="brGo">前往</button>
        <button class="bbtn" id="brText" title="后端代抓为文本">文本</button>
        <button class="bbtn" id="brOpen" title="新窗口打开">${ic('ext', 12, 12)}</button>
      </div>
      <div class="browser-note" id="brNote">输入地址查看 agent 产出的本地网页。<br/>被 <code>X-Frame-Options / CSP</code> 拦截时会白屏，点「文本」让后端代抓。</div>
      <iframe id="brFrame" class="br-frame" style="display:none"></iframe>
      <pre id="brPre" class="br-pre" style="display:none"></pre>`;
    el.appendChild(box);
    const inp = $('#brUrl'), frame = $('#brFrame'), note = $('#brNote'), pre = $('#brPre');
    const saved = localStorage.getItem(key); if (saved) inp.value = saved;
    const norm = (u) => (/^https?:\/\//i.test(u) ? u : 'http://' + u);
    const go = () => {
      const raw = inp.value.trim(); if (!raw) return;
      const u = norm(raw); inp.value = u; localStorage.setItem(key, u);
      note.style.display = 'none'; pre.style.display = 'none';
      frame.style.display = 'block'; frame.src = u;
    };
    $('#brGo').onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('#brOpen').onclick = () => { const u = inp.value.trim(); if (u) window.open(norm(u), '_blank'); };
    // iframe 前进/后退/刷新：跨域 iframe 访问 history/location 会被浏览器
    // 抛 SecurityError，try/catch 静默跳过（同源地址才生效）。
    $('#brBack').onclick = () => { try { frame.contentWindow.history.back(); } catch { /* cross-origin */ } };
    $('#brFwd').onclick = () => { try { frame.contentWindow.history.forward(); } catch { /* cross-origin */ } };
    $('#brReload').onclick = () => { try { frame.contentWindow.location.reload(); } catch { /* cross-origin */ } };
    $('#brText').onclick = async () => {
      const raw = inp.value.trim(); if (!raw) return;
      const u = norm(raw); inp.value = u; localStorage.setItem(key, u);
      frame.style.display = 'none'; pre.style.display = 'block'; pre.textContent = '正在抓取…';
      note.style.display = 'block'; note.textContent = '正在由后端抓取…';
      const r = await fetch('/api/fetch?url=' + encodeURIComponent(u)).then((x) => x.json()).catch((e) => ({ error: e.message }));
      if (r.error) { note.innerHTML = '抓取失败：<code>' + esc(r.error) + '</code>'; pre.style.display = 'none'; return; }
      note.style.display = 'none';
      pre.textContent = r.body.length >= 300000 ? r.body + '\n\n…内容已截断（300KB 上限）' : r.body;
    };
  }
  // One tile per artefact: a real thumbnail for images, a big icon otherwise.
  // The full path moves into the tooltip - printing it on every tile is what
  // turned the pane into a wall of wrapped text you could not scan or click.
  // Image-ness is decided by kind OR extension: legacy rows can carry a wrong
  // kind, and the extension never lies.
  const IMG_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
  const isImageArt = (a) => a.kind === 'image' || IMG_NAME_RE.test(a.name || '');
  function appendArtGrid(el, list) {
    const grid = document.createElement('div');
    grid.className = 'space-grid';
    list.forEach((it) => grid.appendChild(spaceItem(it)));
    el.appendChild(grid);
  }

  function spaceItem(it) {
    const owner = it.ownerId === 'user' ? USER : (findAgent(it.ownerId) || { name: it.ownerId, colorTag: it.colorTag });
    const icon = { image: ic('image', 13, 13), video: ic('video', 13, 13), audio: ic('audio', 13, 13), doc: ic('file', 13, 13), code: ic('cpu', 13, 13), file: ic('file', 13, 13) }[it.kind] || ic('file', 13, 13);
    const div = document.createElement('div');
    div.className = 'space-item';
    div.title = `${it.name}\n${it.src || '（无路径）'}\n来自 ${owner.name}`;
    const url = api.artifactFileUrl(curGroupId, it.id);
    div.innerHTML = `<div class="thumb">${isImageArt(it)
      ? `<img src="${url}" alt="${esc(it.name)}" loading="lazy" />`
      : `<span class="ticon">${icon}</span>`}</div>
      <div class="si-name">${esc(it.name)}</div>
      <div class="si-meta"><span class="dot" style="background:${it.colorTag || '#888'}"></span>${esc(owner.name)}</div>
      <button class="act" title="更多操作">⋯</button>`;
    // A dead path must fall back to the icon, not leave a broken-image box
    // that looks like the click failed.
    const img = div.querySelector('img');
    if (img) img.onerror = () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'ticon', textContent: icon })); };
    div.onclick = () => viewArtifact(it);
    div.querySelector('.act').onclick = (e) => { e.stopPropagation(); openArtMenu(it, e.currentTarget); };
    return div;
  }
  // Clicking a tile previews it inside the right pane. Opening a new tab for
  // every file turns the pane into a file list; previewing in place is what
  // makes it a workspace.
  const TEXT_EXT = /\.(md|txt|json|js|ts|jsx|tsx|py|css|html|yaml|yml|csv|log|ini|toml|xml|sh|bat|ps1|sql)$/i;

  function viewArtifact(it) { openPreview(it); }

  async function openPreview(it) {
    const view = $('#artView');
    const url = api.artifactFileUrl(curGroupId, it.id);
    view.classList.remove('hidden');
    $('#spaceBody').classList.add('hidden');
    view.innerHTML = `<div class="av-head">
        <button class="av-back" title="返回列表">${ic('arrowl', 12, 12)}</button>
        <span class="av-name" title="${esc(it.name)}">${esc(it.name)}</span>
        <button class="av-act" title="在系统里打开">${ic('ext', 12, 12)}</button>
      </div><div class="av-body"><div class="av-load">加载中…</div></div>`;
    view.querySelector('.av-back').onclick = closePreview;
    view.querySelector('.av-act').onclick = async () => {
      try {
        await api.revealArtifact(curGroupId, it.id);
        toast('已在文件管理器打开');
      } catch { toast('打开失败：文件可能已被移动或删除'); }
    };
    const body = view.querySelector('.av-body');
    const isText = TEXT_EXT.test(it.name || '') || it.kind === 'doc' || it.kind === 'code';
    try {
      if (isImageArt(it)) {
        body.innerHTML = `<img class="av-img" src="${url}" alt="${esc(it.name)}" />`;
      } else if (it.kind === 'video') {
        body.innerHTML = `<video class="av-media" src="${url}" controls muted autoplay></video>`;
      } else if (it.kind === 'audio') {
        body.innerHTML = `<audio class="av-audio" src="${url}" controls></audio>`;
      } else if (isText) {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // Cap the render: a 50MB log rendered into <pre> would hang the pane.
        const full = await r.text();
        const CAP = 200 * 1024;
        const t = full.length > CAP ? full.slice(0, CAP) + '\n\n…（内容过长，仅显示前 200KB）' : full;
        body.innerHTML = `<pre class="av-text">${esc(t)}</pre>`;
      } else {
        throw new Error('unsupported');
      }
    } catch {
      // URL 类产物（agent 输出的外部链接）跨域拿不到正文，给明确提示，
      // 而不是一律说「无法预览该类型」。
      const isExt = /^https?:\/\//i.test(it.src || '');
      body.innerHTML = `<div class="av-fail">${isExt ? '该产物是外部链接，无法内嵌预览' : '无法在此预览该类型'}<br/><button class="av-open">在系统里打开</button></div>`;
      body.querySelector('.av-open').onclick = async () => { await api.revealArtifact(curGroupId, it.id); };
    }
  }

  function closePreview() {
    $('#artView').classList.add('hidden');
    $('#spaceBody').classList.remove('hidden');
  }
  // 产物操作菜单（⋯）：查看/打开文件夹/重命名/分享/发送到群聊/删除
  let curArt = null;
  // 内联重命名：产物菜单里不再弹系统 prompt，改在页面上弹一个小输入框，
  // 与整体 UI 风格保持一致。
  function inlineRename(current, onOk) {
    const mask = document.createElement('div');
    mask.className = 'art-rename-mask';
    mask.innerHTML = `<div class="art-rename-box">
        <div class="art-rename-title">重命名产物</div>
        <input class="art-rename-in" value="${esc(current)}" spellcheck="false" />
        <div class="art-rename-btns"><button type="button" class="art-rename-ok">确定</button><button type="button" class="art-rename-cancel">取消</button></div>
      </div>`;
    document.body.appendChild(mask);
    const inp = mask.querySelector('.art-rename-in');
    inp.focus(); inp.select();
    const done = (val) => { mask.remove(); if (val !== null && val && val.trim() && val.trim() !== current) onOk(val.trim()); };
    mask.querySelector('.art-rename-ok').onclick = () => done(inp.value);
    mask.querySelector('.art-rename-cancel').onclick = () => done(null);
    mask.onmousedown = (e) => { if (e.target === mask) done(null); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
  }
  function openArtMenu(it, anchor) {
    curArt = it;
    const menu = $('#artMenu');
    menu.classList.remove('hidden');           // 先显示才能量到尺寸
    const r = anchor.getBoundingClientRect();
    let top = r.top - menu.offsetHeight - 4;
    if (top < 8) top = r.bottom + 4;
    let left = r.right - menu.offsetWidth;
    if (left < 8) left = 8;
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
  }
  $$('#artMenu .ctx-item').forEach((mi) => {
    mi.onclick = async () => {
      $('#artMenu').classList.add('hidden');
      const it = curArt; if (!it) return;
      const act = mi.dataset.act;
      if (act === 'view') { viewArtifact(it); }
      else if (act === 'folder') {
        try { await api.revealArtifact(curGroupId, it.id); toast('已在文件管理器打开'); }
        catch { toast('打开失败：文件可能已被移动或删除'); }
      }
      else if (act === 'rename') {
        inlineRename(it.name, async (name) => {
          await api.renameArtifact(curGroupId, it.id, name);
          const g = await api.getGroup(curGroupId); renderSpace(g);
        });
      } else if (act === 'share') {
        const url = location.origin + api.artifactFileUrl(curGroupId, it.id);
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => toast('分享链接已复制'), () => toast(url));
        else toast(url);
      } else if (act === 'send') {
        const url = location.origin + api.artifactFileUrl(curGroupId, it.id);
        await api.sendMessage(curGroupId, '产物：' + it.name + '  ' + url);
        toast('已发送到群聊');
      } else if (act === 'delete') {
        if (confirm('确认删除产物「' + it.name + '」？')) {
          await api.deleteArtifact(curGroupId, it.id);
          const g = await api.getGroup(curGroupId); renderSpace(g);
        }
      }
    };
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#artMenu') && !e.target.closest('.space-item .act')) $('#artMenu').classList.add('hidden');
  });

  // ---------------- MODAL: settings (agent registry) ----------------
  // Observed capabilities come from the backend's tool-call tally, not from the
  // hand-written skills tag. Empty means "never watched this one work yet".
  function observedHtml(observed) {
    const rows = Object.entries(observed || {}).sort((x, y) => y[1] - x[1]);
    if (!rows.length) return '<span class="skill muted">尚无记录</span>';
    return rows.map(([t, n]) => `<span class="skill obs" title="实际调用 ${n} 次">${esc(t)}<b>${n}</b></span>`).join('');
  }

  // Delegation spends an extra LLM turn per summon, so it is opt-in. The cost is
  // printed on the switch itself - a toggle that silently spends money is a bad one.
  function delegationRow(settings) {
    const row = document.createElement('label');
    row.className = 'member-row delegate-row';
    row.innerHTML = `<input type="checkbox" ${settings?.delegation ? 'checked' : ''} />
      <span>允许 agent 互相点名（回复里 @名字）
      <b>每点名一次多花一轮调用，只传递一层，不会来回踢皮球</b></span>`;
    row.querySelector('input').onchange = (e) => api.setSettings({ delegation: e.target.checked });
    return row;
  }

  // ---------------- SETTINGS: agent registry + access entries ----------------
  // Users only care about one axis: can this agent operate my computer?
  // Adapter classes (A/B/C/D/E/W) are an internal detail — they are chosen by
  // the backend probe and never shown in the UI.
  const LOCAL_CAPABLE = new Set(['A', 'C', 'D', 'E', 'G', 'W']);
  const capabilityOf = (type) => (LOCAL_CAPABLE.has(type) ? '可操作本机' : '仅云端');
  const capClass = (type) => (LOCAL_CAPABLE.has(type) ? 'local' : 'cloud');
  // 接入类型小标签：WIZ_TYPES 的简短名，hover 显示完整说明。
  const TYPE_LABELS = { A: '本地服务', W: '桌面客户端', E: 'MCP 服务', G: 'CLI 工具', C: '文件桥', D: '桌面转发', B: '模型 API' };
  const typeLabelOf = (t) => TYPE_LABELS[t] || '其他';
  const typeDescOf = (t) => { const w = WIZ_TYPES.find((x) => x.key === t); return w ? w.label : ''; };
  // 按真实 config 判断实际接入通道（比类型键更准确：如 WorkBuddy 类型键是 W，
  // 但本机走 cliPath 即 CLI 通道）。
  const channelOf = (a) => {
    const c = a.config || {};
    if (c.cliCmd || c.cliPath) return 'CLI 工具';
    if (c.mcpServer) return 'MCP 服务';
    if (c.bridge) return '桌面转发';
    if (c.ports && c.ports.length) return '本地服务';
    if (c.localDir) return '文件桥';
    if (c.baseURL || c.apiBaseUrl) return '模型 API';
    return typeLabelOf(a.adapterType);
  };
  // 接入标签的能力排序（从强到弱）：以"操作本地电脑的能力"为核心标准
  // （做任何项目都依赖操作本机能力）。本地程序/协议通道 > 弱通道的本机客户端
  // > 纯工具 > 纯云端模型。归类不写死：channelOf 按实际 config 通道判断，
  // 豆包/Codex 等以后走 CLI/ACP 时会自动落到对应档位。
  const CAP_ORDER = { '本地服务': 6, 'CLI 工具': 5, '桌面客户端': 5, '桌面转发': 4, 'MCP 服务': 3, '模型 API': 2, '文件桥': 1 };
  const capRank = (a) => CAP_ORDER[channelOf(a)] || 0;
  let registrySort = localStorage.getItem('zjl_registry_sort') === 'cap' ? 'cap' : 'default'; // 'default' | 'cap'

  // The only menu the user ever sees: four plain entries, no jargon groups.
  const SETUP_ENTRIES = [
    { icon: 'search', title: '本地 agent', sub: '扫描本机已装的 AI 客户端，勾选即接入', act: 'discover' },
    { icon: 'plug', title: 'MCP 服务 / CLI', sub: '接入 MCP 工具服务或本地命令行 agent', type: 'E' },
    { icon: 'cloud', title: '模型 API', sub: 'DeepSeek / Qwen / OpenAI 兼容等云端模型', type: 'B' },
    { icon: 'box', title: '其他', sub: '说不清是哪一类，手动描述它怎么连', act: 'manual' },
  ];

  function agentCard(a) {
    const on = a.enabled !== false; // absent flag => enabled by default
    // 合并开关：接入 + 本地服务启停，一个开关控制到底（避免与启停按钮重复）。
    // 开 = 已接入 且（无本地服务 或 服务在跑）；服务停了开关就自动显示为关。
    const la = a.config && a.config.launcher;
    const swOn = on && (!la || a.launched);
    const swTitle = la
      ? (swOn ? '退出接入并停止本地服务' : '接入并拉起本地服务')
      : (on ? '退出接入' : '重新接入');
    const card = document.createElement('div'); card.className = 'agent-card' + (on ? '' : ' off');
    card.innerHTML = `
      <div class="ac-top" title="点击展开 / 收起配置">
        <span class="ac-avhead">${avHtml(a)}</span>
        <span class="ac-name">${esc(a.name)}</span>${trafficHtml(a.id)}
        <span class="ac-cap ${capClass(a.adapterType)}">${capabilityOf(a.adapterType)}</span>
        <span class="ac-type" title="${esc(typeDescOf(a.adapterType))}">${channelOf(a)}</span>
        <label class="toggle" title="${swTitle}"><input type="checkbox" ${swOn ? 'checked' : ''} /><i></i></label>
        <span class="ac-edit">${ic('chevdown', 13, 13)}</span>
      </div>
      <div class="ac-role">${esc(a.role) || '<span class="ac-none">未填写说明</span>'}</div>
      <div class="ac-detail">
        <div class="ac-avrow">${avHtml(a, 'lg')}<button type="button" class="ac-avbtn">${ic('image', 12, 12)} 更换头像</button></div>
        <div class="field"><label>名称</label><input data-f="name" value="${esc(a.name)}" /></div>
        <div class="ac-grid">
          <div class="field"><label>角色 / 说明</label><input data-f="role" value="${esc(a.role)}" /></div>
          <div class="field"><label>模型</label><input data-f="model" value="${esc(a.model)}" /></div>
        </div>
        <label>系统提示词</label><textarea data-f="system">${esc(a.system)}</textarea>
        <label>已装技能（点击切换）</label>
        <div class="skills">${(a.skills || []).map((s) => `<span class="skill on" data-skill="${esc(s)}">${esc(s)}</span>`).join('') || '<span class="skill muted">未声明</span>'}</div>
        <label>实测能力（工具实际调用次数）</label>
        <div class="skills">${observedHtml(a.observed)}</div>
        <div class="ac-danger"><button type="button" class="ac-del">${ic('trash', 13, 13)} 删除</button></div>
      </div>
      <input type="file" accept="image/*" class="ac-avfile" hidden />`;
    card.querySelector('.ac-top').onclick = (e) => {
      if (e.target.closest('.toggle')) return; // the switch is its own control
      card.classList.toggle('open');
    };
    card.querySelectorAll('input,textarea').forEach((inp) => {
      if (inp.closest('.toggle') || inp.classList.contains('ac-avfile')) return;
      inp.onchange = () => api.updateAgent(a.id, { [inp.dataset.f]: inp.value });
    });
    // 开关 = 接入 + 本地服务联动：开→接入并拉起服务；关→退出接入并停服务。状态灯随服务启停由后端推送自动联动。
    card.querySelector('.toggle input').onchange = async (e) => {
      const want = e.target.checked;
      const ok = await api.updateAgent(a.id, { enabled: want }).then(() => true).catch(() => { e.target.checked = !e.target.checked; return false; });
      if (!ok) return;
      if (la) {
        if (want) await api.launchAgent(a.id).catch(() => {});
        else if (a.launched) await api.stopAgent(a.id).catch(() => {});
      }
      renderRegistry();
    };
    const fileInp = card.querySelector('.ac-avfile');
    fileInp.onchange = async () => {
      const f = fileInp.files && fileInp.files[0]; if (!f) return;
      if (f.size > 512 * 1024) { toast('头像图片请小于 512KB'); return; }
      const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
      await api.updateAgent(a.id, { avatar: dataUrl }); renderRegistry();
    };
    card.querySelector('.ac-avbtn').onclick = () => fileInp.click();
    const del = card.querySelector('.ac-del');
    if (del) del.onclick = async () => {
      if (!confirm(`确定删除「${a.name}」？它会退出接入且无法撤销。`)) return;
      await api.deleteAgent(a.id); renderRegistry();
    };
    const light = card.querySelector('.traffic');
    if (light) light.onclick = () => openTaskPop(a.id, light);
    return card;
  }

  let regRefreshTimer = null;
  // 服务状态变化（agent_status）时，若设置页打开则重新拉列表，让开关 / 计数
  // 与真实服务状态同步。防抖避免高频事件下反复重建 DOM。
  function scheduleRegRefresh() {
    const modal = $('#settingsModal');
    if (!modal || modal.classList.contains('hidden')) return;
    clearTimeout(regRefreshTimer);
    regRefreshTimer = setTimeout(() => { renderRegistry().catch(() => {}); }, 400);
  }

  async function renderRegistry() {
    const agents = await api.listAgents();
    // 默认：启用的在上、退出接入的沉底；「能力」模式：纯按接入标签能力从高到低排。
    let sorted;
    if (registrySort === 'cap') {
      sorted = [...agents].sort((x, y) => (capRank(y) - capRank(x)));
    } else {
      sorted = [...agents].sort((x, y) => ((x.enabled === false) - (y.enabled === false)));
    }
    const configured = document.createElement('div'); configured.className = 'reg-sec';
    // 计数 = 当前已接入配置的 agent 总数（本区块渲染全部已接入/已配置卡片，
    // 退出接入或服务停的都算已接入过的，沉底展示）。与卡片数量保持一致。
    const onCount = agents.length;
    configured.innerHTML = `<div class="reg-title">已接入 agent / 模型 <span class="reg-count">${onCount}</span>
      <span class="reg-sort">
        <button type="button" class="reg-sort-btn${registrySort === 'default' ? ' on' : ''}" data-sort="default" title="默认排序：启用在上、退出的沉底">默认</button>
        <button type="button" class="reg-sort-btn${registrySort === 'cap' ? ' on' : ''}" data-sort="cap" title="按操作本地电脑能力从高到低排序">能力</button>
      </span></div>`;
    configured.querySelectorAll('.reg-sort-btn').forEach((b) => {
      b.onclick = () => { registrySort = b.dataset.sort; localStorage.setItem('zjl_registry_sort', registrySort); renderRegistry(); };
    });
    if (!agents.length) {
      configured.insertAdjacentHTML('beforeend', '<div class="reg-empty">还没有接入任何 agent / 模型，从下面选一个入口开始。</div>');
    }
    sorted.forEach((a) => configured.appendChild(agentCard(a)));
    const box = $('#agentRegistry');
    const onboarding = box.querySelector('.reg-sec:last-child'); // keeps "接入新 agent" section below
    box.innerHTML = '';
    box.appendChild(configured);
    if (onboarding) box.appendChild(onboarding);
  }

  async function openSettings() {
    const box = $('#agentRegistry'); box.innerHTML = '';
    // notification / sound preferences - two plain toggles, opt-in, remembered
    const prefs = document.createElement('div'); prefs.className = 'reg-sec';
    prefs.innerHTML = '<div class="reg-title">通知与提醒</div>';
    const mkPref = (title, get, flip) => {
      const r = document.createElement('div'); r.className = 'pref-row';
      const btn = document.createElement('button');
      const paint = () => { btn.textContent = get() ? '已开启' : '已关闭'; btn.classList.toggle('on', get()); };
      btn.className = 'pref-toggle'; paint();
      btn.onclick = async () => { if (await flip()) paint(); };
      r.innerHTML = `<span class="pref-name">${title}</span>`;
      r.appendChild(btn);
      return r;
    };
    prefs.appendChild(mkPref('桌面通知 · agent 回复时弹系统通知（后台群也会提醒）',
      () => notifyOn,
      async () => {
        if (notifyOn) { notifyOn = false; localStorage.setItem('zjl_notify', '0'); return true; }
        if (!('Notification' in window)) { toast('此浏览器不支持桌面通知'); return false; }
        const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (p !== 'granted') { toast('通知权限被拒绝，请在浏览器地址栏的权限设置里放开'); return false; }
        notifyOn = true; localStorage.setItem('zjl_notify', '1'); return true;
      }));
    prefs.appendChild(mkPref('提示音 · 新消息轻响一声',
      () => soundOn,
      () => { soundOn = !soundOn; localStorage.setItem('zjl_sound', soundOn ? '1' : '0'); if (soundOn) ping(); return true; }));
    box.appendChild(prefs);
    await renderRegistry();
    // onboarding: one flat grid of plain-language entries
    const add = document.createElement('div'); add.className = 'reg-sec';
    add.innerHTML = '<div class="reg-title">接入新 agent / 模型</div>';
    const grid = document.createElement('div'); grid.className = 'entry-grid';
    SETUP_ENTRIES.forEach((e) => {
      const c = document.createElement('div'); c.className = 'entry-card';
      c.innerHTML = `<div class="ec-ico">${ic(e.icon, 17, 17)}</div>
        <div class="ec-main"><div class="ec-title">${esc(e.title)}</div><div class="ec-sub">${esc(e.sub)}</div></div>
        <div class="ec-go">›</div>`;
      c.onclick = () => openWizard(e);
      grid.appendChild(c);
    });
    add.appendChild(grid);
    box.appendChild(add);
    $('#settingsModal').classList.remove('hidden');
  }

  // ---------------- WIZARD: user-driven agent onboarding ----------------
  // The user picks an entry (local agent / MCP / model API / other) and we
  // walk them through only the fields that entry needs. We never ask them to
  // name an adapter class or hand-write a connection descriptor.
  const WIZ_TYPES = [
    { key: 'A', label: '本机跑的 agent 服务（如 DSH）', desc: '它自己带调用接口', cap: '可操作本机',
      fields: [{ f: 'ports', label: 'RPC 端口', ph: '3080', def: '3080' }],
      assist: '我在配置一个多 agent 协作工具，需要接入本机运行的「DeepSeek Harness (DSH)」agent 服务。请帮我：\n1. 找到 DSH 的 RPC 服务端口（默认 3080），确认该端口上的服务是否在运行；\n2. 如果实际端口不是 3080，探测出真实端口。\n只回复一段 JSON（不要多余文字、不要 markdown 代码块）：\n{"ports": [实际端口号]}' },
    { key: 'W', label: '桌面 AI 客户端（WorkBuddy / CodeBuddy）', desc: '装在本机、能替你动手', cap: '可操作本机',
      fields: [{ f: 'apiKey', label: 'API Key（可选，留空自动探测 ACP 端口）', ph: 'CODEBUDDY_API_KEY', def: '' }],
      assist: '我在配置一个多 agent 协作工具，需要接入本机的「WorkBuddy / CodeBuddy」桌面 AI。请帮我探测：\n1. 环境变量 CODEBUDDY_API_KEY 是否已设置？已设置则返回其值，未设置则返回 null；\n2. WorkBuddy 的 ACP 服务监听的本地端口（如有）。\n只回复一段 JSON（不要多余文字、不要 markdown 代码块）：\n{"apiKey": "值或null", "port": "端口或null"}' },
    { key: 'E', label: 'MCP 服务', desc: '通过 MCP 提供工具能力', cap: '可操作本机',
      modes: [{ key: 'E', label: 'MCP 服务', hint: '接入 MCP 工具服务' }, { key: 'G', label: 'CLI 工具', hint: '接入命令行 agent' }],
      fields: [{ f: 'mcpServer', label: 'MCP server 命令 或 SSE 地址', ph: 'npx -y @modelcontextprotocol/server-...', def: '' }],
      assist: '我在配置一个多 agent 协作工具，需要接入一个 MCP 服务来提供工具能力。请帮我：\n1. 列出本机已安装、或你确认可用的 MCP server；\n2. 给出其中一个的启动命令（npx / node 命令）或 SSE 地址。\n只回复一段 JSON（不要多余文字、不要 markdown 代码块）：\n{"mcpServer": "完整的启动命令或地址"}' },
    { key: 'G', label: 'CLI 工具（命令行 agent）', desc: '本机命令行的 AI agent', cap: '可操作本机',
      fields: [{ f: 'cliCmd', label: '命令或可执行文件路径', ph: 'codex 或 D:\\tools\\agent.exe', def: '' },
               { f: 'cliArgs', label: '附加参数（可选，用 {prompt} 放提示词，留空则提示词追加在末尾）', ph: 'exec --full-auto {prompt}', def: '' }],
      assist: '我在配置一个多 agent 协作工具，需要接入一个本地「CLI 工具 / 命令行 agent」（如 Codex CLI、CodeBuddy CLI 等）。请帮我：\n1. 找到本机可用的 CLI 可执行命令或完整路径（cliCmd）；\n2. 给出调用它的附加参数模板（cliArgs，用 {prompt} 表示提示词位置，不填则提示词追加在末尾）。\n只回复一段 JSON（不要多余文字、不要 markdown 代码块）：\n{"cliCmd": "命令或路径", "cliArgs": "参数模板或null"}' },
    { key: 'C', label: '文件桥（本地目录互传）', desc: '用 inbox / outbox 目录和它通信', cap: '可操作本机',
      fields: [{ f: 'localDir', label: '桥接目录', ph: 'bridge/myagent', def: '' }],
      assist: '我在配置一个多 agent 协作工具，需要接入一个「文件桥」用于本地目录互传消息。请帮我：\n1. 确定一个用于消息互传的目录（建议在项目 bridge/ 下）；\n2. 给出它的绝对路径。\n只回复一段 JSON（不要多余文字、不要 markdown 代码块）：\n{"localDir": "目录绝对路径"}' },
    { key: 'D', label: '没有接口的桌面 AI（豆包 / Codex 等）', desc: '靠文件或界面转发消息', cap: '可操作本机',
      fields: [{ f: 'bridge', label: '产品标识', ph: 'doubao', def: '' }],
      assist: '我在配置一个多 agent 协作工具，需要接入本机一个「没有 API 的桌面 AI」（豆包 / Codex / 通义 等）。请帮我：\n1. 识别本机已安装的是哪一款；\n2. 给出它的产品标识（doubao / qwen / kuaishou / codex 之一）。\n只回复一段 JSON（不要多余文字、不要 markdown 代码块）：\n{"bridge": "产品标识"}' },
    { key: 'B', label: '云端模型 API', desc: '给它一个模型身份', cap: '仅云端',
      fields: [{ f: 'baseURL', label: 'API 地址', ph: 'https://api.deepseek.com/v1', def: '' },
               { f: 'apiKey', label: 'API Key（可留空，用环境变量 DEEPSEEK_API_KEY）', ph: 'sk-...', def: '' },
               { f: 'model', label: '模型名', ph: 'deepseek-chat', def: '' }],
      assist: '我在配置一个多 agent 协作工具，需要接入一个云端大模型 API（OpenAI 兼容）。请帮我：\n1. 给出 API 地址 baseURL（例如 https://api.deepseek.com/v1）；\n2. 给出 API Key（你已知的，没有就填 null，我自己填）；\n3. 推荐一个模型名 model。\n只回复一段 JSON（不要多余文字、不要 markdown 代码块）：\n{"baseURL": "https://...", "apiKey": "sk-...或null", "model": "模型名"}' },
  ];
  let wiz = null;
  let wizSeq = 0;
  function wizReset(entry) { wiz = { entry: entry || null, flow: [], step: null, discovered: [], chosenType: null, config: {}, picks: [], skipped: 0, connectChoices: {}, proxyChoices: {}, seq: ++wizSeq }; }
  function showWizStep(step) {
    // Backing out of the first step returns the user to the settings menu.
    if (step === 'settings') { $('#wizardModal').classList.add('hidden'); openSettings(); return; }
    wiz.step = step;
    $$('#wizardModal .wstep').forEach((s) => s.classList.add('hidden'));
    const el = $(`#wizardModal .wstep[data-step="${step}"]`);
    if (el) el.classList.remove('hidden');
  }
  function wizBack() {
    const i = wiz.flow.indexOf(wiz.step);
    showWizStep(i > 0 ? wiz.flow[i - 1] : 'settings');
  }
  const WIZ_TITLES = { discover: '本地 agent', E: 'MCP 服务 / CLI', B: '模型 API', manual: '手动接入' };
  function openWizard(entry) {
    wizReset(entry);
    $('#wizTitle').textContent = WIZ_TITLES[entry && entry.act === 'discover' ? 'discover' : (entry ? entry.type : '')] || WIZ_TITLES.manual;
    $('#wizardModal').classList.remove('hidden');
    if (!entry || entry.act === 'manual') { wiz.flow = ['kind', 'cfg']; wizManual(); return; }
    if (entry.act === 'discover') { wiz.flow = ['pick']; wizDiscover(); return; }
    wiz.flow = ['cfg'];
    wiz.chosenType = WIZ_TYPES.find((t) => t.key === entry.type);
    wizRenderFields(); showWizStep('cfg');
  }
  async function wizDiscover() {
    const my = wiz.seq;
    const list = await api.discoverAgents().catch(() => []);
    if (!wiz || wiz.seq !== my || wiz.flow[0] !== 'pick') return; // user switched away while scanning
    wiz.discovered = list;
    // 已接入的 agent 标「已接入」并置灰不勾选，避免与"未接入"混淆。
    const existing = new Set((await api.listAgents().catch(() => [])).map((a) => a.name));
    const box = $('#discList'); box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="wiz-empty">本机未检测到已知 agent。可回到上一页选「其他」手动接入，或先确认程序已安装。</div>';
    }
    list.forEach((a, i) => {
      const joined = existing.has(a.name);
      const card = document.createElement('label'); card.className = 'wiz-card' + (joined ? ' joined' : '');
      card.innerHTML = `<input type="checkbox" data-i="${i}" ${joined ? '' : 'checked'} ${joined ? 'disabled' : ''} />
        <span class="wc-av">${avHtml({ name: a.name, avatar: a.avatar, color: '#888888' }, 'wc')}</span>
        <div class="wc-main"><div class="wc-name">${esc(a.name)}</div><div class="wc-meta">${joined ? '已接入' : (a.running ? '运行中' : '已安装')} · ${capabilityOf(a.suggestedType)}</div></div>
        <div class="wc-path" title="${esc((a.paths || []).join('\n'))}">${esc((a.paths || []).slice(0, 1).join(''))}</div>`;
      box.appendChild(card);
    });
    renderWizAssistHelper($('#assistDiscover'), 'discover');
    showWizStep('pick');
  }
  // Assist cards ask the user's local AI to wire up the agent directly by
  // calling the backend API — no JSON round-trip for the user. The API base is
  // derived from the page's own origin, so any port/deployment works.
  function assistSoftware() {
    return '我在配置「zjl-achat」——一个在本机运行的多 agent 协作聊天工具（界面 ' + location.origin + '）。它把多个 AI agent 接入同一个群聊，让它们协作对话、共享任务。';
  }
  function assistTypes() {
    return '可用的接入类型与技术：\nA 本机 agent 服务：自带 RPC HTTP 接口（如 DSH 默认端口 3080），功能最完整\nW 桌面 AI 客户端（WorkBuddy / CodeBuddy）：经 API Key 或本机 ACP 端口连接\nE MCP 服务：经 npx / node 启动命令或 SSE 地址提供工具能力\nG CLI 工具：经命令行命令 + 参数模板调用\nC 文件桥：经 inbox / outbox 目录互传消息\nD 无接口桌面 AI（豆包 / Codex）：经产品标识 + 文件桥 / 桌面转发\nB 云端模型 API：OpenAI 兼容接口（baseURL + apiKey + model）';
  }
  function assistPick() {
    return '请探测目标 agent 的实际连接方式并选择最匹配类型；有多种方式时优先功能最完整的（有 RPC / API 接口优先，其次 MCP / CLI，最后才用文件桥 / 桌面转发）。';
  }
  function assistCreate() {
    return '确定后调用接口创建：\nPOST ' + location.origin + '/api/agents\nContent-Type: application/json\nbody: { "name": "显示名称", "adapterType": "类型键", "config": { "该类型字段": "值" } }\n\n接入成功直接回复「接入成功：<名称>」，失败说明原因。';
  }
  function discoverAssistPrompt() {
    const lines = (wiz.discovered || []).map((a) => `- ${a.name}（建议：${capabilityOf(a.suggestedType)}，路径 ${(a.paths || []).join('; ') || '未知'}）`).join('\n');
    return assistSoftware() + '现在要接入一个本机 agent。\n\n本机检测到以下候选（部分自动接入可能失败，请逐个确认真实接入方式）：\n' +
      (lines || '- （列表为空，请直接探测本机已装的 agent）') + '\n\n' +
      assistTypes() + '\n\n' + assistPick() + '\n\n' + assistCreate();
  }
  function kindAssistPrompt() {
    return assistSoftware() + '我不确定要接入的 agent 属于哪种类型，请你探测本机已装的 AI / agent（豆包、Codex、WorkBuddy、DSH、CLI 工具、MCP 服务等），检查安装路径与启动方式，并判断它属于哪种类型。\n\n' +
      assistTypes() + '\n\n' + assistPick() + '\n\n' + assistCreate();
  }
  function mcpCliAssistPrompt() {
    return assistSoftware() + '现在要接入一个 MCP 服务或 CLI 工具，让群里的 agent 能调用它的能力。\n\n请探测本机可用的 MCP 服务（已装的 npx / npm 包、SSE 服务）或 CLI 工具（PATH 里的命令、已装程序），选择最合适的一个。\n\n接入方式：\nE MCP 服务：字段 mcpServer = 启动命令（如 npx -y @modelcontextprotocol/server-...）或 SSE 地址\nG CLI 工具：字段 cliCmd = 命令或可执行文件路径；cliArgs = 参数模板（用 {prompt} 放提示词，可省略）\n\n' + assistCreate();
  }
  function modelApiAssistPrompt() {
    return assistSoftware() + '现在要接入一个云端大模型 API，作为群里的一个 agent。\n\n请探测本机可用的模型 API 配置（如 ~/.opencodereview/config.json 中的 llm.auth_token、环境变量 DEEPSEEK_API_KEY 等），给出可用的一套。\n\n接入类型 B（云端模型 API），字段：\nbaseURL = API 地址（如 https://api.deepseek.com/v1）\napiKey = API Key（没有就留空，服务端会自动用环境变量）\nmodel = 模型名（如 deepseek-chat）\n\n' + assistCreate();
  }
  function typeAssistPrompt(t) {
    if (t.key === 'E' || t.key === 'G') return mcpCliAssistPrompt();
    if (t.key === 'B') return modelApiAssistPrompt();
    const fieldDescs = t.fields.map((f) => `${f.f} = ${f.label}`).join('；');
    return assistSoftware() + `已确定要接入的类型是「${t.label}」（${t.desc}），创建时 adapterType 用「${t.key}」。\n该类型需要填的连接字段（能探测到就填）：${fieldDescs}\n\n` + assistPick() + '\n\n' + assistCreate();
  }
  function copyText(text) {
    const ok = navigator.clipboard && navigator.clipboard.writeText(text);
    if (ok) navigator.clipboard.writeText(text).then(() => toast('提示词已复制')).catch(() => fallbackCopy(text));
    else fallbackCopy(text);
  }
  function renderWizAssistHelper(box, mode) {
    if (!box) return;
    box.innerHTML = '';
    let prompt, title, refresh;
    if (mode === 'discover') {
      prompt = discoverAssistPrompt();
      title = '接入失败？让本机 AI 直接接入';
      refresh = () => wizDiscover();
    } else {
      prompt = kindAssistPrompt();
      title = '不清楚用哪种？让本机 AI 直接接入';
      refresh = () => wizManual();
    }
    const card = document.createElement('div'); card.className = 'wiz-assist';
    card.innerHTML = `
      <div class="wa-head"><span>${title}</span>
        <button type="button" class="wa-copy">${ic('clipboard', 12, 12)} 复制提示词</button></div>
      <div class="wa-desc">把提示词发给本机已装的 AI（豆包 / WorkBuddy / Codex 等），它会直接探测本机并调用接口帮你完成接入。完成后点「刷新列表」即可看到已接入的 agent。</div>
      <button type="button" class="wa-refresh">刷新列表</button>`;
    card.querySelector('.wa-copy').onclick = () => copyText(prompt);
    card.querySelector('.wa-refresh').onclick = () => { refresh(); refreshAgents(); toast('已刷新'); };
    box.appendChild(card);
  }
  function wizManual() {
    const box = $('#typeList'); box.innerHTML = '';
    WIZ_TYPES.forEach((t) => {
      const card = document.createElement('div'); card.className = 'wiz-card wiz-type';
      card.innerHTML = `<div class="wc-main"><div class="wc-name">${esc(t.label)}</div><div class="wc-meta">${esc(t.desc)} · ${capabilityOf(t.key)}</div></div>`;
      card.onclick = () => { wiz.chosenType = t; wizRenderFields(); showWizStep('cfg'); };
      box.appendChild(card);
    });
    renderWizAssistHelper($('#assistKind'), 'kind');
    showWizStep('kind');
  }
  function wizRenderFields() {
    const t = wiz.chosenType; if (!t) return;
    const box = $('#fieldList'); box.innerHTML = '';
    if (t.modes) renderWizModes(t, box);
    t.fields.forEach((f) => {
      const wrap = document.createElement('div'); wrap.className = 'field';
      wrap.innerHTML = `<label>${esc(f.label)}</label><input data-f="${f.f}" placeholder="${esc(f.ph)}" value="${esc(f.def || '')}" />`;
      const inp = wrap.querySelector('input');
      inp.oninput = () => { wiz.config[f.f] = inp.value.trim(); wizProbe(); };
      box.appendChild(wrap);
    });
    // "Let a local AI wire this up": the agent probes the machine and creates
    // the agent via the backend API directly — no JSON round-trip for the user.
    const as = $('#assistBox');
    if (as) {
      as.innerHTML = '';
      if (t.assist) {
        const card = document.createElement('div'); card.className = 'wiz-assist';
        // 概念统一：接入模型 API 是"接入云端模型"，其他类型是"接入某类 agent"
        const verb = t.key === 'B' ? '接入云端模型' : `接入「${esc(t.label)}」`;
        card.innerHTML = `
          <div class="wa-head"><span>让本机 AI 直接帮你接入</span>
            <button type="button" class="wa-copy">${ic('clipboard', 12, 12)} 复制提示词</button></div>
          <div class="wa-desc">把提示词发给本机已装的 AI（豆包 / WorkBuddy / Codex 等），它会直接探测本机并调用接口帮你${verb}。完成后点「刷新列表」即可看到。也可以手动填写上方字段。</div>
          <button type="button" class="wa-refresh">刷新列表</button>`;
        card.querySelector('.wa-copy').onclick = () => copyText(typeAssistPrompt(t));
        card.querySelector('.wa-refresh').onclick = () => { refreshAgents(); toast('已刷新'); };
        as.appendChild(card);
      }
    }
    $('#probeHint').textContent = '';
  }
  function renderWizModes(t, box) {
    const m = document.createElement('div'); m.className = 'wiz-modes';
    m.innerHTML = `<span class="wm-title">接入方式</span>` + t.modes.map((x) =>
      `<button type="button" class="wm-btn${x.key === wiz.chosenType.key ? ' on' : ''}" data-m="${x.key}">${esc(x.label)}</button>`).join('');
    m.querySelectorAll('.wm-btn').forEach((b) => b.onclick = () => {
      const nx = WIZ_TYPES.find((z) => z.key === b.dataset.m);
      if (nx && nx.key !== wiz.chosenType.key) { wiz.chosenType = nx; wizRenderFields(); }
    });
    box.appendChild(m);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('提示词已复制'); } catch { toast('复制失败，请手动选中复制'); }
    document.body.removeChild(ta);
  }
  async function wizProbe() {
    const cfg = { ...wiz.config };
    if (wiz.chosenType) cfg.adapterType = wiz.chosenType.key;
    const hint = $('#probeHint');
    try {
      const p = await api.probeAdapter(cfg);
      const ok = p.type === wiz.chosenType.key;
      hint.className = 'wiz-probe ' + (ok ? 'ok' : 'warn');
      // capability, not adapter class — the user never sees A/B/C/D/E/W
      hint.innerHTML = ok ? ic('check', 11, 11) + ' 可以接入' : ic('warn', 11, 11) + ' 按已填信息，它会被当成「' + esc(capabilityOf(p.type)) + '」的 agent';
    } catch { hint.textContent = ''; }
  }
  async function wizOnboardDiscovered() {
    const existing = await api.listAgents();
    const names = new Set(existing.map((a) => a.name));
    const picks = $$('#discList input[type=checkbox]:checked').map((c) => wiz.discovered[Number(c.dataset.i)]);
    if (!picks.length) { toast('请至少勾选一个'); return; }
    wiz.picks = picks.filter((a) => !names.has(a.name));
    wiz.skipped = picks.length - wiz.picks.length;
    // Foreign agents pop a connect-mode card first: official account vs domestic
    // proxy. With a proxy picked, the backend spins up the proxy, waits for its
    // port, then silently launches the app — so we ask before creating.
    const asking = wiz.picks.filter((a) => a.connect);
    if (asking.length) { renderConnectCard(asking); $('#connectModal').classList.remove('hidden'); return; }
    await wizCreatePicks();
  }
  function renderConnectCard(asking) {
    const box = $('#connectCardList'); box.innerHTML = '';
    asking.forEach((a) => {
      const apps = a.connect.proxyApps || [];
      wiz.connectChoices[a.name] = wiz.connectChoices[a.name] || (apps.length ? 'proxy' : 'official');
      wiz.proxyChoices[a.name] = wiz.proxyChoices[a.name] || (apps[0] && apps[0].key) || null;
      const sec = document.createElement('div'); sec.className = 'connect-group';
      sec.innerHTML = `<div class="section-label" style="padding-left:0">${esc(a.name)}</div>
        <div class="cc-q">这个 agent 怎么连模型？</div>`;
      const mkMode = (key, label, desc, disabled) => {
        const row = document.createElement('label'); row.className = 'wiz-card';
        row.innerHTML = `<input type="radio" name="cc-${esc(a.name)}" value="${key}" ${key === wiz.connectChoices[a.name] ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
          <div class="wc-main"><div class="wc-name">${esc(label)}${disabled ? '（未检测到代理软件）' : ''}</div><div class="wc-meta">${esc(desc)}</div></div>`;
        row.querySelector('input').onchange = () => {
          wiz.connectChoices[a.name] = key;
          sec.querySelectorAll('.proxy-sub').forEach((el) => el.classList.toggle('hidden', key !== 'proxy'));
        };
        return row;
      };
      if ((a.connect.modes || []).some((m) => m.key === 'cli')) {
        sec.appendChild(mkMode('cli', 'CLI 直连（codex exec）', '每条消息跑一轮 codex exec，模型/代理由 ~/.codex/config.toml 决定'));
      }
      sec.appendChild(mkMode('official', '直连官方模型', '用自己的官方账号，直接拉起主程序静默运行'));
      sec.appendChild(mkMode('proxy', '走代理软件接国内模型', apps.length ? `已检测到 ${apps.length} 个代理软件，接入后自动拉起` : '', !apps.length));
      if (apps.length) {
        const sub = document.createElement('div'); sub.className = 'proxy-sub' + (wiz.connectChoices[a.name] === 'proxy' ? '' : ' hidden');
        sub.innerHTML = '<div class="wc-meta" style="padding:2px 0">选择要拉起的代理软件：</div>';
        apps.forEach((p) => {
          const row = document.createElement('label'); row.className = 'wiz-card';
          row.innerHTML = `<input type="radio" name="pp-${esc(a.name)}" value="${p.key}" ${p.key === wiz.proxyChoices[a.name] ? 'checked' : ''} />
            <div class="wc-main"><div class="wc-name">${esc(p.name)}</div><div class="wc-meta">${p.selfHosted ? '代理内置于主程序，拉起即就绪（端口 ' + p.port + '）' : '独立程序，先拉代理再拉主程序（端口 ' + p.port + '）'}</div></div>`;
          row.querySelector('input').onchange = () => { wiz.proxyChoices[a.name] = p.key; };
          sub.appendChild(row);
        });
        sec.appendChild(sub);
      }
      box.appendChild(sec);
    });
  }
  async function wizConnectConfirm() {
    let added = 0;
    const launches = [];
    for (const a of wiz.picks) {
      const cfg = { ...(a.prefill || {}) };
      let type = a.suggestedType;
      let wantLaunch = false;
      if (a.connect) {
        cfg.connectMode = wiz.connectChoices[a.name] || 'official';
        if (cfg.connectMode === 'proxy') { cfg.proxyApp = wiz.proxyChoices[a.name] || undefined; wantLaunch = true; }
        if (cfg.connectMode === 'cli') {
          // G class: one `codex exec` turn per message. No launcher, no
          // persistent service — codex resolves model + proxy from its own
          // ~/.codex/config.toml (codex++ local proxy at 127.0.0.1:57321).
          type = 'G';
          delete cfg.bridge; delete cfg.launcherExe;
          cfg.cliCmd = 'codex';
          cfg.cliArgs = ['exec', '--skip-git-repo-check', '{prompt}'];
          cfg.outFileFlag = '-o';
          cfg.timeoutMs = 300000;
        }
      }
      const created = await api.createAgent({
        name: a.name, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
        avatar: a.avatar || undefined, adapterType: type, role: a.notes || '',
        model: (a.prefill && a.prefill.model) || 'deepseek-chat', skills: [], system: '你是一个乐于助人的智能体。',
        status: 'online', guiPath: '', config: cfg,
      });
      added++;
      // Proxy mode: spin up the proxy first, then silently launch the app.
      if (wantLaunch && created && created.id) launches.push(api.launchAgent(created.id).catch(() => {}));
    }
    await Promise.all(launches);
    toast(`已接入 ${added} 个${wiz.skipped ? `，跳过 ${wiz.skipped} 个已存在` : ''}${wantLaunch ? '' : ''}`);
    $('#connectModal').classList.add('hidden');
    $('#wizardModal').classList.add('hidden');
    await refreshAgents(); if (curGroupId) selectGroup(curGroupId);
  }
  async function wizCreatePicks() {
    let added = 0;
    for (const a of wiz.picks) {
      await api.createAgent({
        name: a.name, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
        avatar: a.avatar || undefined, // start with the agent's own icon when we found one
        adapterType: a.suggestedType, role: a.notes || '', model: (a.prefill && a.prefill.model) || 'deepseek-chat',
        skills: [], system: '你是一个乐于助人的智能体。', status: 'online', guiPath: '',
        config: { ...(a.prefill || {}) }, // connect mode is auto-resolved by the backend
      });
      added++;
    }
    toast(`已接入 ${added} 个${wiz.skipped ? `，跳过 ${wiz.skipped} 个已存在` : ''}`);
    $('#wizardModal').classList.add('hidden');
    await refreshAgents(); if (curGroupId) selectGroup(curGroupId);
  }
  async function wizSave() {
    const t = wiz.chosenType; if (!t) return;
    const cfg = { ...wiz.config };
    const existing = await api.listAgents();
    // Name is auto-derived from what was configured; rename later in the card.
    let name = defaultWizName(t, cfg);
    if (existing.some((a) => a.name === name)) {
      let n = 2; while (existing.some((a) => a.name === `${name} ${n}`)) n++;
      name = `${name} ${n}`;
    }
    await api.createAgent({
      name, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
      adapterType: t.key, role: '', model: cfg.model || 'deepseek-chat',
      skills: [], system: '你是一个乐于助人的智能体。', status: 'online', guiPath: '', config: cfg,
    });
    toast('已接入：' + name);
    $('#wizardModal').classList.add('hidden');
    await refreshAgents(); if (curGroupId) selectGroup(curGroupId);
  }
  function defaultWizName(t, cfg) {
    const tail = (p) => { const s = String(p).replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i >= 0 ? s.slice(i + 1) : s; };
    const noExt = (p) => String(p).replace(/\.(exe|bat|cmd|ps1|js)$/i, '');
    if (t.key === 'G' && cfg.cliCmd) return noExt(tail(cfg.cliCmd));
    if (t.key === 'B' && cfg.model) return cfg.model;
    if (t.key === 'E' && cfg.mcpServer) {
      const toks = String(cfg.mcpServer).trim().split(/\s+/);
      const last = tail(toks[toks.length - 1] || '').replace(/[:,].*$/, '');
      return last && !/^(npx|node|yarn|pnpm|uvx|deno)$/i.test(last) ? last : 'MCP 服务';
    }
    if (t.key === 'C' && cfg.localDir) return tail(cfg.localDir);
    if (t.key === 'D' && cfg.bridge) return cfg.bridge;
    return t.label;
  }

  // ---------------- MODAL: group settings ----------------
  async function openGroupModal(id) {
    const g = await api.getGroup(id);
    $('#grpNameInput').value = g.name;
    const [settings] = await Promise.all([api.getSettings()]);
    const slot = $('#delegateSlot'); if (slot) { slot.innerHTML = ''; slot.appendChild(delegationRow(settings)); }
    const box = $('#groupMembers'); box.innerHTML = '';
    const agents = await api.listAgents();
    agents.forEach((a) => {
      const row = document.createElement('label'); row.className = 'member-row';
      const checked = (g.memberIds || []).includes(a.id) ? 'checked' : '';
      row.innerHTML = `<input type="checkbox" data-id="${a.id}" ${checked}/>
        ${avHtml(a)}<span class="mname">${esc(a.name)}</span>
        <span class="ac-cap ${capClass(a.adapterType)}" style="margin-left:auto">${capabilityOf(a.adapterType)}</span>`;
      box.appendChild(row);
    });
    $('#groupModal').dataset.gid = id;
    $('#groupModal').classList.remove('hidden');
  }

  // ---------------- POPOVER: agent status card (left-click avatar) ----------------
  let cardAgentId = null;
  function openAgentCard(id, anchorEl) {
    const a = findAgent(id); if (!a) return;
    cardAgentId = id;
    const acAv = $('#ac-av');
    if (a.avatar) {
      acAv.classList.add('img'); acAv.style.background = 'transparent'; acAv.style.borderColor = a.color;
      acAv.innerHTML = `<img src="${esc(a.avatar)}" alt="" />`;
    } else {
      acAv.classList.remove('img'); acAv.style.background = a.color; acAv.textContent = a.name[0];
    }
    $('#ac-name').textContent = a.name;
    const s = stateOf(a.id);
    $('#ac-status').className = 'pop-status ' + (s === 'idle' ? 'online' : s === 'offline' ? 'offline' : 'running');
    $('#ac-status-text').textContent = ST_LABEL[s];
    $('#ac-in-name').value = a.name;
    $('#ac-cap').textContent = capabilityOf(a.adapterType);
    $('#ac-cap').className = 'ac-cap ' + capClass(a.adapterType);
    $('#ac-in-model').value = a.model; $('#ac-in-role').value = a.role; $('#ac-in-sys').value = a.system;
    const pop = $('#agentCard'); pop.classList.remove('hidden');
    const r = anchorEl.getBoundingClientRect();
    const w = 320, h = pop.offsetHeight || 320;
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 6; if (top + h > window.innerHeight) top = Math.max(12, r.top - h - 6);
    pop.style.left = Math.max(12, left) + 'px'; pop.style.top = top + 'px';
    $('#ac-save').onclick = async () => {
      await api.updateAgent(id, { name: $('#ac-in-name').value, model: $('#ac-in-model').value, role: $('#ac-in-role').value, system: $('#ac-in-sys').value });
      pop.classList.add('hidden'); if (curGroupId) selectGroup(curGroupId);
    };
    $('#ac-dm').onclick = async () => { const dm = await api.openDM(id); pop.classList.add('hidden'); await selectGroup(dm.id); };
  }

  // ---------------- CTX MENU: avatar right-click ----------------
  let ctxAgentId = null;
  function openCtxMenu(id, x, y) {
    ctxAgentId = id;
    const m = $('#ctxMenu'); m.classList.remove('hidden');
    m.style.left = Math.min(x, window.innerWidth - 170) + 'px';
    m.style.top = Math.min(y, window.innerHeight - 70) + 'px';
  }
  $$('#ctxMenu .ctx-item').forEach((item) => {
    item.onclick = async () => {
      const act = item.dataset.act;
      $('#ctxMenu').classList.add('hidden');
      if (!ctxAgentId) return;
      if (act === 'settings') { openAgentCard(ctxAgentId, $('#chatHead')); }
      else if (act === 'launch') {
        const a = findAgent(ctxAgentId);
        if (a) toggleAgent(a);
      }
    };
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxMenu')) $('#ctxMenu').classList.add('hidden');
    if (!e.target.closest('#groupMenu') && !e.target.closest('.gmore')) $('#groupMenu').classList.add('hidden');
    if (!e.target.closest('#agentCard') && !e.target.closest('.av')) $('#agentCard').classList.add('hidden');
  });

  function toastEl(msg) {
    const t = document.createElement('div');
    t.textContent = msg; t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:var(--panel3);color:var(--text);border:1px solid var(--border);padding:10px 16px;border-radius:9px;z-index:90;font-size:13px;max-width:70vw';
    document.body.appendChild(t); return t;
  }
  function toast(msg) { const t = toastEl(msg); setTimeout(() => t.remove(), 2600); }

  // ---------------- MODAL: consensus / negotiation ----------------
  async function openConsensusModal() {
    if (!curGroupId) { toast('请先选择一个群'); return; }
    const g = await api.getGroup(curGroupId);
    const members = g.memberIds || [];
    const box = $('#csMembers'); box.innerHTML = '';
    members.forEach((id) => {
      const a = findAgent(id); if (!a) return;
      const row = document.createElement('label'); row.className = 'member-row';
      row.innerHTML = `<input type="checkbox" data-id="${a.id}" checked/>
        ${avHtml(a)}<span class="mname">${esc(a.name)}</span>
        <span class="ac-cap ${capClass(a.adapterType)}" style="margin-left:auto">${capabilityOf(a.adapterType)}</span>`;
      box.appendChild(row);
    });
    // synthesizer: prefer a model-backed (B-class) agent, else first member.
    const sel = $('#csSynth'); sel.innerHTML = '';
    const bFirst = members.find((id) => { const a = findAgent(id); return a && (a.adapterType === 'B' || (a.config && a.config.model)); });
    members.forEach((id) => {
      const a = findAgent(id); if (!a) return;
      const o = document.createElement('option'); o.value = id; o.textContent = a.name;
      if (id === (bFirst || members[0])) o.selected = true;
      sel.appendChild(o);
    });
    $('#csTopic').value = '';
    $('#consensusModal').classList.remove('hidden');
  }

  async function startConsensus() {
    const topic = $('#csTopic').value.trim();
    if (!topic) { toast('请填写议题'); return; }
    const ids = $$('#csMembers input[type=checkbox]').filter((c) => c.checked).map((c) => c.dataset.id);
    if (ids.length < 2) { toast('至少选择 2 个参与 agent'); return; }
    const rounds = Number($('#csRounds').value) || 3;
    const synth = $('#csSynth').value;
    $('#consensusModal').classList.add('hidden');
    await api.startConsensus(curGroupId, { topic, participantIds: ids, rounds, synthesizerId: synth });
    toast('协商已启动，多 agent 正在多轮讨论…');
  }

  // ---------------- wire up ----------------
  $('#btnNewGroup').onclick = async () => {
    const name = prompt('新群名称', '新群'); if (!name) return;
    const g = await api.createGroup(name, []);
    await selectGroup(g.id); openGroupModal(g.id);
  };
  $('#btnSettings').onclick = openSettings;
  $('#btnGroupSettings').onclick = () => { if (curGroupId) openGroupModal(curGroupId); };
  $('#btnConsensus').onclick = openConsensusModal;
  $('#closeConsensus').onclick = $('#btnCloseConsensus2').onclick = () => $('#consensusModal').classList.add('hidden');
  $('#btnStartConsensus').onclick = startConsensus;
  $('#closeSettings').onclick = () => $('#settingsModal').classList.add('hidden');
  $('#closeGroup').onclick = $('#btnCloseGroup2').onclick = () => $('#groupModal').classList.add('hidden');
  $('#ac-close').onclick = () => $('#agentCard').classList.add('hidden');

  $('#btnSaveGroup').onclick = async () => {
    const id = $('#groupModal').dataset.gid;
    const name = $('#grpNameInput').value.trim();
    const ids = $$('#groupMembers input[type=checkbox]').filter((c) => c.checked).map((c) => c.dataset.id);
    if (name) await api.renameGroup(id, name);
    await api.setGroupMembers(id, ids);
    $('#groupModal').classList.add('hidden');
    await selectGroup(id);
  };
  $('#closeWizard').onclick = () => $('#wizardModal').classList.add('hidden');
  $('#wizBackHead').onclick = wizBack;
  $('#btnOnboardDisc').onclick = wizOnboardDiscovered;
  $('#btnSaveWiz').onclick = wizSave;
  $('#closeConnect').onclick = () => $('#connectModal').classList.add('hidden');
  $('#btnConnectDone').onclick = wizConnectConfirm;

  $('#btnSend').onclick = () => send();
  const inputEl = $('#input');
  // Enter 发送：中文输入法组词（isComposing）时回车是选字，绝不能误发
  inputEl.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // 输入框自适应高度：单行 56px 起，随内容长到最多 5 行再内部滚动
  function autosizeInput() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + 'px';
  }
  inputEl.addEventListener('input', autosizeInput);
  // 群搜索：输入即过滤群列表
  $('#groupSearch').addEventListener('input', (e) => {
    groupSearch = e.target.value;
    renderGroups();
  });
  // 回到底部：悬浮按钮 + 滚动位置跟踪
  $('#jumpDown').onclick = () => {
    const box = $('#messages');
    box.scrollTop = box.scrollHeight;
    stickBottom = true;
    $('#jumpDown').classList.add('hidden');
  };
  $('#messages').addEventListener('scroll', syncStick);
  // 窄窗口抽屉：右栏「群空间」折叠为悬浮按钮
  $('#drawerToggle').onclick = () => document.body.classList.toggle('drawer-open');
  // 发送对象下拉：按当前选中项收窄宽度
  $('#sendTarget').addEventListener('change', fitSendTarget);
  // 主题切换：body.light 与深色主题互切，localStorage 记忆选择
  function syncThemeBtn() {
    const b = $('#btnTheme'); if (!b) return;
    b.title = document.body.classList.contains('light') ? '切换到深色主题' : '切换到浅色主题';
  }
  if (localStorage.getItem('zjl_theme') === 'light') document.body.classList.add('light');
  syncThemeBtn();
  $('#btnTheme').onclick = () => {
    document.body.classList.toggle('light');
    localStorage.setItem('zjl_theme', document.body.classList.contains('light') ? 'light' : 'dark');
    syncThemeBtn();
  };

  // + 上传菜单（文件/图片/视频/音频）—— 默认收起，点 + 展开
  $('#btnPlus').onclick = (e) => { e.stopPropagation(); $('#plusMenu').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#plusMenu') && !e.target.closest('#btnPlus')) $('#plusMenu').classList.add('hidden');
  });
  // 自动识别文件类型 -> 群空间产物分类
  function detectKind(f) {
    // 代码树只传文件名（没有 MIME），必须能纯靠扩展名判断，否则图片点开变成「无法预览」。
    const t = f.type || '';
    const n = (f.name || '').toLowerCase();
    if (t.startsWith('image') || /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(n)) return 'image';
    if (t.startsWith('video') || /\.(mp4|webm|mov|mkv|avi)$/.test(n)) return 'video';
    if (t.startsWith('audio') || /\.(mp3|wav|m4a|ogg|flac|aac)$/.test(n)) return 'audio';
    if (/\.(md|txt|log|csv|json|ya?ml|toml|ini|xml|sql|html?|css)$/.test(n)) return 'doc';
    if (/\.(m?jsx?|cjs|tsx?|py|sh|bat|ps1|go|rs|java|c|cpp|h)$/.test(n)) return 'code';
    return 'file';
  }
  // 文件读成 base64（零依赖后端无需 multipart 解析）
  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(new Error('读取失败'));
      fr.readAsDataURL(file);
    });
  }
  $$('#plusMenu button').forEach((b) => {
    b.onclick = () => {
      $('#plusMenu').classList.add('hidden');
      const kind = b.dataset.kind;            // file/image/video/audio：直接指定；artifact：自动识别
      const inp = document.createElement('input'); inp.type = 'file';
      inp.accept = { image: 'image/*', video: 'video/*', audio: 'audio/*', file: '*/*', artifact: '*/*' }[kind];
      inp.onchange = async (e2) => {
        const f = e2.target.files[0]; if (!f || !curGroupId) return;
        if (f.size > 80 * 1024 * 1024) { toast('文件过大（>80MB），已跳过'); return; }
        // 分类永远按真实类型来（扩展名/MIME），菜单选择只决定文件选择器
        // 的过滤范围。以前点「文件」菜单传 .png 会盲信 kind=file，图片直接
        // 掉进文件标签且无法预览。
        const finalKind = detectKind(f);
        // 大文件 base64 编码 + 上传需要时间，给个不自动消失的进行中提示。
        const pending = toastEl('正在上传「' + f.name + '」…');
        try {
          const b64 = await readAsBase64(f);
          await api.addArtifact(curGroupId, { name: f.name, kind: finalKind, ownerId: 'user', colorTag: USER.color, content_base64: b64 });
          const g = await api.getGroup(curGroupId); renderSpace(g);
          pending.remove(); toast('已上传：' + f.name);
        } catch (err) { pending.remove(); toast('上传失败：' + err.message); }
      };
      inp.click();
    };
  });
  $('#btnVoice').onclick = () => alert('语音输入占位：接 Web Speech API 或豆包 ASR（后端契约预留）');
  // 右栏「打开产物文件夹」：直接打开本群产物目录
  $('#btnOpenFolder').onclick = async () => {
    if (!curGroupId) { toast('请先选择一个群'); return; }
    try {
      await api.revealFolder(curGroupId);
      toast('已打开产物文件夹');
    } catch { toast('打开文件夹失败，请查看服务端日志'); }
  };
  // 群列表头的「归档文件夹」按钮：打开全局归档目录
  $('#btnOpenArchive').onclick = async (e) => {
    e.stopPropagation(); // 不触发群列表头折叠
    try { await api.openArchive(); toast('已打开归档文件夹'); }
    catch { toast('打开归档文件夹失败，请查看服务端日志'); }
  };

  // ---------- draggable column dividers ----------
  function makeResizer(el, side) {
    if (!el) return;
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.fold-btn')) return; // the fold button handles itself
      e.preventDefault();
      // dragging a rail implies expanding it again if it was folded
      const foldCls = side === 'left' ? 'left-fold' : 'right-fold';
      if (document.body.classList.contains(foldCls)) {
        document.body.classList.remove(foldCls);
        const fb = document.getElementById(side === 'left' ? 'foldLeft' : 'foldRight');
        if (fb) fb.classList.remove('folded');
      }
      el.classList.add('active');
      // IMPORTANT: the --left-w / --right-w custom properties are declared on
      // #app (not :root), so the live value used by #left / #right resolves
      // from #app's own declaration. Setting them on <html> is shadowed by
      // #app and has zero effect -- which is why the divider never moved.
      // We must write the variables onto #app itself.
      const root = document.getElementById('app');
      const startX = e.clientX;
      const startW = parseInt(getComputedStyle(root).getPropertyValue(side === 'left' ? '--left-w' : '--right-w')) || (side === 'left' ? 250 : 320);
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let w = side === 'left' ? startW + dx : startW - dx;
        w = Math.max(180, Math.min(560, w));
        root.style.setProperty(side === 'left' ? '--left-w' : '--right-w', w + 'px');
      };
      const onUp = () => {
        el.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
  }
  makeResizer($('#resLeft'), 'left');
  makeResizer($('#resRight'), 'right');

  // fold / expand the side rails via the pill on each hairline divider
  function makeFoldBtn(btn, side) {
    if (!btn) return;
    btn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't start a drag
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const foldCls = side === 'left' ? 'left-fold' : 'right-fold';
      const folded = document.body.classList.toggle(foldCls);
      btn.classList.toggle('folded', folded);
    });
  }
  makeFoldBtn($('#foldLeft'), 'left');
  makeFoldBtn($('#foldRight'), 'right');

  // 右栏分标签切换（刷新后记住上次停留的标签）
  $$('#spaceTabs .stab').forEach((t) => {
    t.onclick = async () => {
      $$('#spaceTabs .stab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active'); curTab = t.dataset.tab;
      localStorage.setItem('zjl_space_tab', curTab);
      closePreview();
      if (curGroupId) renderSpace(await api.getGroup(curGroupId));
    };
  });
  // 初始化时把记忆的标签设为 active（index.html 默认高亮 overview）
  {
    const saved = document.querySelector(`#spaceTabs .stab[data-tab="${curTab}"]`);
    $$('#spaceTabs .stab').forEach((x) => x.classList.remove('active'));
    if (saved) saved.classList.add('active');
  }

  // ---------------- desktop notification & sound ----------------
  // Agents reply while the user is in another group or another window. Opt-in
  // switches live at the top of the settings panel; state in localStorage.
  let notifyOn = localStorage.getItem('zjl_notify') === '1';
  let soundOn = localStorage.getItem('zjl_sound') === '1';
  let audioCtx = null;

  function ping() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.04;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.12);
    } catch { /* autoplay policy - fine */ }
  }

  function maybeNotify({ groupId, message }) {
    if (!message || !message.agentId) return;
    const active = document.hasFocus() && groupId === curGroupId;
    if (active) return;
    if (soundOn) ping();
    if (!notifyOn || !('Notification' in window) || Notification.permission !== 'granted') return;
    const a = findAgent(message.agentId);
    const text = String(message.text || '').replace(/[#*`>\[\]!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    try {
      const n = new Notification(a ? a.name : 'Agent', { body: text || '（新消息）', tag: 'achat-' + groupId });
      n.onclick = () => { window.focus(); selectGroup(groupId); n.close(); };
    } catch { /* some platforms require a service worker - ignore */ }
  }

  // event bus -> UI
  api.on('message', ({ groupId, message, artifact, update }) => {
    maybeNotify({ groupId, message });
    if (groupId !== curGroupId) return;
    // In-place update (e.g. a consensus conclusion tagged after the fact):
    // replace the existing element instead of appending a duplicate.
    if (update && message) {
      const el = $(`.msg[data-mid="${message.id}"]`);
      if (el) { const n = buildMsgEl(message); el.replaceWith(n); maybeCapBubble(n); return; }
    }
    if (message) {
      appendMessage(message);
      // agent 产出的文件/图片/URL 自动落回群空间分类
      if (message.agentId) captureArtifacts(groupId, message.agentId, message.text, message.id);
    }
    if (artifact) api.getGroup(groupId).then(renderSpace);
  });
  api.on('typing', ({ agentId, done }) => showTyping(agentId, done));
  api.on('tool', ({ groupId, agentId, kind, name, detail, step, callId }) => {
    if (groupId !== curGroupId) return;
    showToolCall(agentId, { kind, name, detail, step, callId });
    // 工具结果 / 调用里出现的路径也登记为产物
    if ((kind === 'tool_result' || kind === 'tool_call') && detail) captureArtifacts(groupId, agentId, detail);
  });
  api.on('negotiation', ({ groupId, negotiation }) => {
    if (groupId !== curGroupId) return;
    renderNegotiation(negotiation);
  });

  // Progress banner for an in-flight / completed multi-agent negotiation.
  function renderNegotiation(n) {
    const bar = $('#negotiationBar'); if (!bar) return;
    if (!n || n.status === 'done') {
      if (n && n.status === 'done') {
        bar.className = 'negotiation-bar done';
        bar.innerHTML = `${ic('check', 12, 12)} 协商完成 · 共 ${n.rounds || ''} 轮 · 议题：${esc(n.topic || '')}`;
        clearTimeout(bar._t);
        bar._t = setTimeout(() => bar.classList.add('hidden'), 6000);
      } else {
        bar.classList.add('hidden');
      }
      return;
    }
    bar.classList.remove('hidden');
    if (n.phase === 'conclusion') {
      const s = findAgent(n.synthesizer) || { name: n.synthesizer };
      bar.innerHTML = `${ic('users', 12, 12)} 综合阶段 · 正在由 <b>${esc(s.name)}</b> 汇总共识结论…`;
    } else {
      bar.innerHTML = `${ic('users', 12, 12)} 协商中 · 第 <b>${n.round || 1}</b>/<b>${n.rounds}</b> 轮 · 议题：${esc(n.topic || '')}`;
    }
  }

  // ---------------- 三库面板（左栏）：资料库 / 技能库 / 权限库 ----------------
  let libTab = 'kb';
  let libKbQuery = '';
  let libTimer = null;

  function initLibPanel() {
    const head = $('#libHead'), panel = $('#libPanel');
    if (!head || !panel) return;
    // collapse mirrors the group-list section head
    head.onclick = () => {
      const collapsed = head.classList.toggle('collapsed');
      panel.classList.toggle('hidden', collapsed);
    };
    panel.querySelectorAll('.lib-tab').forEach((tab) => {
      tab.onclick = () => {
        panel.querySelectorAll('.lib-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        libTab = tab.dataset.lib;
        renderLib();
      };
    });
    $('#btnDistill').onclick = async () => {
      if (!curGroupId) { toast('先选一个群再蒸馏'); return; }
      try {
        const note = await api.distill(curGroupId);
        toast(`已沉淀进资料库：${note.title}（同名追加日期小节）`);
        if (libTab === 'kb') renderLib();
      } catch (e) { toast('蒸馏失败：' + e.message); }
    };
    renderLib();
  }

  async function renderLib() {
    const body = $('#libBody'), count = $('#libCount');
    if (!body) return;
    body.innerHTML = '<div class="lib-empty">加载中…</div>';
    try {
      let n = 0;
      if (libTab === 'kb') n = await renderLibKb(body);
      else if (libTab === 'skills') n = await renderLibSkills(body);
      else n = await renderLibAcl(body);
      if (count) count.textContent = n ? String(n) : '';
    } catch (e) {
      body.innerHTML = `<div class="lib-empty">加载失败：${esc(e.message)}</div>`;
    }
  }

  async function renderLibKb(body) {
    body.innerHTML = `
      <div class="lib-search"><span class="ls-ico">${ic('search', 12, 12)}</span>
        <input id="kbQ" type="search" placeholder="检索沉淀的知识…" value="${esc(libKbQuery)}" /></div>
      <div class="lib-list" id="kbList"></div>`;
    const list = body.querySelector('#kbList');
    const items = libKbQuery ? await api.kbSearch(libKbQuery) : await api.kbRecent(12);
    if (!items.length) {
      list.innerHTML = `<div class="lib-empty">${libKbQuery ? '没有命中的笔记。' : '还没有沉淀。群聊顶栏点漏斗图标，把对话蒸馏进资料库。'}</div>`;
    } else {
      list.innerHTML = items.map((it) => `
        <div class="lib-item" data-title="${esc(it.title)}">
          <span class="lib-ico">${ic('book', 12, 12)}</span>
          <span class="lib-main"><span class="lib-name">${esc(it.title)}</span>
            ${it.snippet ? `<span class="lib-snippet">${esc(it.snippet)}</span>` : ''}</span>
          <button class="lib-del" title="删除该笔记">${ic('trash', 11, 11)}</button>
        </div>`).join('');
      list.querySelectorAll('.lib-item').forEach((el) => {
        el.onclick = async (ev) => {
          if (ev.target.closest('.lib-del')) return;
          await previewLibNote(el.dataset.title);
        };
      });
      list.querySelectorAll('.lib-del').forEach((btn) => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          const title = btn.closest('.lib-item').dataset.title;
          if (!confirm(`删除笔记「${title}」？`)) return;
          try { await api.kbRemove(title); toast('已删除'); renderLib(); }
          catch (e) { toast('删除失败：' + e.message); }
        };
      });
    }
    const input = body.querySelector('#kbQ');
    input.oninput = () => {
      libKbQuery = input.value.trim();
      clearTimeout(libTimer);
      libTimer = setTimeout(renderLib, 250);
    };
    return items.length;
  }

  // KB note preview: a lightweight dynamic modal, closed by click / Esc.
  async function previewLibNote(title) {
    let note;
    try { note = await api.kbRead(title); } catch (e) { toast('读取失败：' + e.message); return; }
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="modal-box" style="max-width:640px">
        <div class="modal-head">${esc(note.title)} <button class="icon-x" title="关闭">${ic('x', 12, 12)}</button></div>
        <pre class="lib-note-body">${esc(note.body)}</pre>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.icon-x').onclick = close;
    wrap.onclick = (ev) => { if (ev.target === wrap) close(); };
    document.addEventListener('keydown', function onEsc(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
  }

  async function renderLibSkills(body) {
    const items = await req('/skills');
    body.innerHTML = `
      <div class="lib-list" id="skList"></div>
      <div class="lib-form">
        <div class="lib-form-title">注册技能（JSON 声明，改配置不改代码）</div>
        <input id="skId" placeholder="id，如 daily-brief" />
        <input id="skName" placeholder="名称（可省）" />
        <textarea id="skPrompt" placeholder="prompt（技能正文，必须）或 tools"></textarea>
        <button id="skSave" class="lib-save">保存技能</button>
      </div>`;
    const list = body.querySelector('#skList');
    if (!items.length) list.innerHTML = '<div class="lib-empty">还没有技能。下方表单注册第一个。</div>';
    else {
      list.innerHTML = items.map((s) => `
        <div class="lib-item" data-id="${esc(s.id)}">
          <span class="lib-ico">${ic('plug', 12, 12)}</span>
          <span class="lib-main"><span class="lib-name">${esc(s.name || s.id)}</span>
            <span class="lib-snippet">${esc(s.desc || s.prompt || (s.tools || []).join(', ')).slice(0, 80)}</span></span>
          <button class="lib-del" title="删除技能">${ic('trash', 11, 11)}</button>
        </div>`).join('');
      list.querySelectorAll('.lib-del').forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.closest('.lib-item').dataset.id;
          if (!confirm(`删除技能「${id}」？`)) return;
          try { await api.skillRemove(id); renderLib(); } catch (e) { toast('删除失败：' + e.message); }
        };
      });
    }
    body.querySelector('#skSave').onclick = async () => {
      const id = body.querySelector('#skId').value.trim();
      const name = body.querySelector('#skName').value.trim();
      const prompt = body.querySelector('#skPrompt').value.trim();
      if (!id || !prompt) { toast('id 和 prompt 必填'); return; }
      try { await api.skillUpsert({ id, name, prompt }); toast('技能已保存'); renderLib(); }
      catch (e) { toast('保存失败：' + e.message); }
    };
    return items.length;
  }

  async function renderLibAcl(body) {
    const [trail, groups, agents] = await Promise.all([api.aclAudit(), api.listGroups(), api.listAgents()]);
    body.innerHTML = `
      <div class="lib-list" id="aclList"></div>
      <div class="lib-form">
        <div class="lib-form-title">新增授权（群 × agent × 能力，默认拒绝）</div>
        <select id="aclConv"><option value="">选群…</option>${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>
        <select id="aclAgent"><option value="">选 agent…</option>${agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
        <input id="aclCap" placeholder="能力名，如 kb.write / shell.run" />
        <button id="aclSave" class="lib-save">授权</button>
      </div>`;
    const list = body.querySelector('#aclList');
    if (!trail.length) list.innerHTML = '<div class="lib-empty">还没有授权记录。所有能力默认拒绝。</div>';
    else {
      const nameOf = (id) => { const a = agents.find((x) => x.id === id); return a ? a.name : id; };
      const gNameOf = (id) => { const g = groups.find((x) => x.id === id); return g ? g.name : (id === '*' ? '全部群' : id); };
      list.innerHTML = trail.map((g, i) => `
        <div class="lib-item" data-i="${i}">
          <span class="lib-ico">${ic('shield', 12, 12)}</span>
          <span class="lib-main"><span class="lib-name">${esc(gNameOf(g.convId))} · ${esc(nameOf(g.agentId))} · ${esc(g.cap)}</span>
            <span class="lib-snippet">由 ${esc(g.grantedBy || '未知')} 授权于 ${g.ts ? new Date(g.ts).toLocaleString() : ''}</span></span>
          <button class="lib-del" title="撤销该授权">${ic('x', 11, 11)}</button>
        </div>`).join('');
      list.querySelectorAll('.lib-del').forEach((btn) => {
        btn.onclick = async () => {
          const g = trail[Number(btn.closest('.lib-item').dataset.i)];
          try { await api.aclRevoke(g); renderLib(); } catch (e) { toast('撤销失败：' + e.message); }
        };
      });
    }
    body.querySelector('#aclSave').onclick = async () => {
      const convId = body.querySelector('#aclConv').value;
      const agentId = body.querySelector('#aclAgent').value;
      const cap = body.querySelector('#aclCap').value.trim();
      if (!convId || !agentId || !cap) { toast('群、agent、能力三项都要选/填'); return; }
      try { await api.aclGrant({ convId, agentId, cap, grantedBy: 'user' }); toast('已授权'); renderLib(); }
      catch (e) { toast('授权失败：' + e.message); }
    };
    return trail.length;
  }

  // ---------------- boot ----------------
  boot();
  async function boot() {
    subscribeStatus();
    await refreshAgents();
    await renderGroups();
    // Land on an existing conversation instead of an empty pane - opening the
    // app used to show three blank columns until you clicked a group.
    const list = await api.listGroups();
    if (list.length) await selectGroup(list[0].id);
    initLibPanel();
    await showRecoveryNotice();
  }

  // A recovered crash is indistinguishable from a working app: the conversation
  // list is simply empty. Without this the user concludes the data was deleted
  // and starts rebuilding, while the only real clue sits in a .corrupt file.
  async function showRecoveryNotice() {
    let notice;
    try { notice = await api.getNotice(); } catch { return; }
    const r = notice && notice.recovery;
    if (!r) return;
    const bar = $('#noticeBar');
    if (!bar) return;
    bar.innerHTML =
      `<b>${ic('warn', 12, 12)} 检测到数据文件损坏，本次以空数据启动</b>` +
      `<span>${esc(r.hint || '')}${r.path ? ` 路径：<code>${esc(r.path)}</code>` : ''}` +
      ` 发生时间：${esc(String(r.at || '').replace('T', ' ').slice(0, 19))}</span>` +
      `<button id="noticeDismiss" title="知道了">×</button>`;
    bar.classList.remove('hidden');
    $('#noticeDismiss').onclick = () => bar.classList.add('hidden');
  }
})();
