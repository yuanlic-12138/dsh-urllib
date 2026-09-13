/* dsh-urllib — 本地网址库
 *
 * 数据主存储：library.json（磁盘文件）
 * 页面支持两种宿主，自动识别：
 *   dsh   —— 由 dsh-worktable 的 /api/worktable/site/... 提供（可顺便种工作台项目卡）
 *   local —— 由本目录的 server.mjs 提供（独立运行，不依赖 DSH）
 *
 * localStorage 只存 UI 偏好，不存网址。
 */
(function () {
  'use strict'

  var UI_KEY = 'dsh.urllib.ui.v1'
  var WT_KEY = 'dsh.worktable.projects.v1'
  var CARD_ID = 'layout-urllib'
  var POLL_MS = 5000
  var PING_MS = 20000

  var BACKEND = null   // { mode, fileApi, writeApi, dataPath, backupPath }
  var state = {
    doc: { schema: 'dsh-urllib/v1', updatedAt: '', items: [] },
    raw: null,
    query: '',
    tag: '',
    color: '',
    sort: 'recent',
    theme: 'light',
    editing: null,
    editingColor: 'none',
    loadError: '',
    external: false
  }

  // ---------- DOM helpers ----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k]
        if (v === null || v === undefined || v === false) return
        if (k === 'text') node.textContent = String(v)
        else if (k === 'class') node.className = v
        else if (k === 'style') node.setAttribute('style', v)
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v)
        else if (v === true) node.setAttribute(k, '')
        else node.setAttribute(k, String(v))
      })
    }
    ;(children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return node
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }
  function $(id) { return document.getElementById(id) }

  // ---------- 后端识别 ----------
  function resolveBackend() {
    var path = location.pathname
    if (path.indexOf('/api/worktable/site/') === 0) {
      var dir = decodeURIComponent(path.split('/')[4] || '')
      var sep = dir.indexOf('\\') >= 0 ? '\\' : '/'
      return Promise.resolve({
        mode: 'dsh',
        fileApi: '/api/worktable/file?path=',
        writeApi: '/api/worktable/write',
        dataPath: dir + sep + 'library.json',
        backupPath: dir + sep + 'library.json.bak'
      })
    }
    return fetch('/api/config', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('本地服务未响应（HTTP ' + r.status + '）')
      return r.json()
    }).then(function (c) {
      return {
        mode: 'local',
        fileApi: c.fileApi || '/api/file?path=',
        writeApi: c.writeApi || '/api/write',
        dataPath: c.dataPath || 'library.json',
        backupPath: c.backupPath || 'library.json.bak'
      }
    })
  }

  // ---------- 文件读写 ----------
  function fetchRaw() {
    return fetch(BACKEND.fileApi + encodeURIComponent(BACKEND.dataPath), { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) return null          // 文件还没建
      if (!r.ok) throw new Error('读取失败 HTTP ' + r.status)
      return r.text()
    })
  }
  function postWrite(path, content) {
    return fetch(BACKEND.writeApi, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path, content: content })
    }).then(function (r) {
      if (!r.ok) throw new Error('写入失败 HTTP ' + r.status)
      return r.json().catch(function () { return {} })
    })
  }
  function parseDoc(text) {
    // 去掉可能的 UTF-8 BOM：用记事本另存为 UTF-8 会加，JSON.parse 会被它噎住
    var t = String(text === null || text === undefined ? '' : text).replace(/^\uFEFF/, '')
    var doc = JSON.parse(t)
    if (!doc || typeof doc !== 'object') throw new Error('数据格式不是对象')
    if (!Array.isArray(doc.items)) doc.items = []
    doc.items = doc.items.filter(function (it) { return it && typeof it.url === 'string' && it.url })
    return doc
  }
  // 读-改-写：每次操作都基于磁盘最新内容，避免覆盖 agent 刚写进去的条目
  function mutate(fn) {
    return fetchRaw().then(function (prevRaw) {
      var doc
      try { doc = prevRaw ? parseDoc(prevRaw) : { schema: 'dsh-urllib/v1', updatedAt: '', items: [] } }
      catch (e) { throw new Error('现有 library.json 解析失败：' + e.message) }
      fn(doc)
      doc.schema = doc.schema || 'dsh-urllib/v1'
      doc.updatedAt = new Date().toISOString()
      var next = JSON.stringify(doc, null, 2) + '\n'
      var backup = prevRaw ? postWrite(BACKEND.backupPath, prevRaw).catch(function () {}) : Promise.resolve()
      return backup.then(function () { return postWrite(BACKEND.dataPath, next) }).then(function () {
        state.doc = doc
        state.raw = next
        state.loadError = ''
        render()
      })
    })
  }
  function reload(silent) {
    return fetchRaw().then(function (raw) {
      if (raw === null) {
        state.doc = { schema: 'dsh-urllib/v1', updatedAt: '', items: [] }
        state.raw = null
      } else {
        state.doc = parseDoc(raw)
        state.raw = raw
      }
      state.loadError = ''
      if (!silent) render()
    }).catch(function (e) {
      state.loadError = e && e.message ? e.message : String(e)
      render()
    })
  }

  // ---------- 小工具 ----------
  function newId() { return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '') } catch (e) { return '' }
  }
  function parseTags(s) {
    var out = []
    String(s || '').split(/[,，\s]+/).forEach(function (t) {
      t = t.trim()
      if (t && out.indexOf(t) < 0) out.push(t)
    })
    return out.slice(0, 12)
  }
  function allTags() {
    var seen = {}
    state.doc.items.forEach(function (it) {
      (it.tags || []).forEach(function (t) { if (t) seen[t] = (seen[t] || 0) + 1 })
    })
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b) })
      .map(function (t) { return { tag: t, n: seen[t] } })
  }
  function toast(msg, kind) {
    var box = $('toast')
    box.textContent = msg
    box.className = 'ul-toast show' + (kind ? ' ul-toast-' + kind : '')
    clearTimeout(box._t)
    box._t = setTimeout(function () { box.className = 'ul-toast' }, 2400)
  }
  function copyText(text) {
    function legacy() {
      var ta = el('textarea', { readonly: true, style: 'position:fixed;top:-1000px;left:0' })
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) { ok = false }
      document.body.removeChild(ta)
      return ok
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true }, function () { return legacy() })
    }
    return Promise.resolve(legacy())
  }
  // iframe 里 window.open 可能被拦，兜底走 <a target=_blank> 点击
  function openExternal(url) {
    var w = null
    try { w = window.open(url, '_blank', 'noopener') } catch (e) { w = null }
    if (w) return true
    try {
      var a = el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', style: 'display:none' })
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      return true
    } catch (e) { return false }
  }

  // ---------- UI 偏好 ----------
  function loadUi() {
    try {
      var p = JSON.parse(localStorage.getItem(UI_KEY) || '{}')
      if (p.sort) state.sort = p.sort
      if (p.theme === 'light' || p.theme === 'dark' || p.theme === 'auto') state.theme = p.theme
    } catch (e) { /* 忽略 */ }
  }
  function saveUi() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ sort: state.sort, theme: state.theme })) } catch (e) { /* 忽略 */ }
  }

  // ---------- 打开 / 计数 ----------
  function openItem(it) {
    if (!openExternal(it.url)) { toast('浏览器拦下了弹窗，请手动复制链接', 'bad'); return }
    mutate(function (doc) {
      var t = doc.items.filter(function (x) { return x.id === it.id })[0]
      if (!t) return
      t.opens = (Number(t.opens) || 0) + 1
      t.lastOpenedAt = new Date().toISOString()
    }).catch(function (e) { toast('计数写入失败：' + e.message, 'bad') })
  }

  // ---------- 渲染 ----------
  function visibleItems() {
    var q = state.query.trim().toLowerCase()
    var list = state.doc.items.filter(function (it) {
      if (state.tag && (it.tags || []).indexOf(state.tag) < 0) return false
      if (state.color && colorOf(it) !== state.color) return false
      if (!q) return true
      return (String(it.title || '') + ' ' + it.url + ' ' + String(it.note || '') + ' ' + (it.tags || []).join(' '))
        .toLowerCase().indexOf(q) >= 0
    })
    var sort = state.sort
    list.sort(function (a, b) {
      if (sort === 'opens') return (Number(b.opens) || 0) - (Number(a.opens) || 0)
      if (sort === 'added') return String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
      if (sort === 'name') return String(a.title || a.url).localeCompare(String(b.title || b.url))
      var ao = a.lastOpenedAt || '', bo = b.lastOpenedAt || ''
      if (ao !== bo) return bo.localeCompare(ao)
      return String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
    })
    return list
  }

  function tagChip(t, n, active, onClick) {
    return el('button', { type: 'button', class: 'ul-chip' + (active ? ' ul-chip-on' : ''), title: t, onclick: onClick },
      [t + (n ? ' ' + n : '')])
  }

  // ---------- 卡片颜色（在编辑对话框里选；不选就是默认无色）----------
  var CARD_COLORS = ['red', 'yellow', 'blue', 'purple']
  var COLOR_NAMES = { red: '红', yellow: '黄', blue: '蓝', purple: '紫', none: '默认' }
  function colorOf(it) {
    return CARD_COLORS.indexOf(it.color) >= 0 ? it.color : 'none'
  }
  function buildSwatches() {
    var box = $('fColor')
    clear(box)
    var opts = [{ v: 'none', label: '默认' }].concat(CARD_COLORS.map(function (c) { return { v: c, label: COLOR_NAMES[c] } }))
    opts.forEach(function (o) {
      box.appendChild(el('button', {
        type: 'button',
        class: 'ul-swatch' + (state.editingColor === o.v ? ' ul-swatch-on' : ''),
        'data-c': o.v,
        onclick: function () { state.editingColor = o.v; buildSwatches() }
      }, [el('span', { class: 'ul-swatchDot' }), o.label]))
    })
  }

  function itemCard(it) {
    var tags = (it.tags || []).filter(Boolean)
    var c = colorOf(it)
    return el('div', { class: 'ul-card', 'data-c': c }, [
      el('div', { class: 'ul-cardTop' }, [
        el('span', { class: 'ul-dot', title: '卡片颜色：' + (COLOR_NAMES[c] || c) }),
        el('a', {
          class: 'ul-cardTitle', href: it.url, target: '_blank', rel: 'noreferrer noopener', title: it.url,
          onclick: function (e) { e.preventDefault(); openItem(it) }
        }, [it.title || hostOf(it.url) || it.url]),
        el('span', { class: 'ul-host', text: hostOf(it.url) })
      ]),
      el('div', { class: 'ul-url', text: it.url }),
      it.note ? el('div', { class: 'ul-note', text: it.note }) : null,
      tags.length
        ? el('div', { class: 'ul-tags' }, tags.map(function (t) {
            return el('span', {
              class: 'ul-tag' + (state.tag === t ? ' ul-tag-on' : ''), title: '按此标签筛选',
              onclick: function () { state.tag = state.tag === t ? '' : t; render() }
            }, [t])
          }))
        : null,
      el('div', { class: 'ul-actions' }, [
        el('button', { type: 'button', class: 'ul-btn ul-btnGo', title: '用系统默认浏览器打开这个网址', onclick: function () { openItem(it) } }, ['🌐 用浏览器打开']),
        el('button', { type: 'button', class: 'ul-btn ul-btnCopy', title: '复制链接', onclick: function () {
          copyText(it.url).then(function (ok) { toast(ok ? '已复制链接' : '复制失败，请手动选中', ok ? 'ok' : 'bad') })
        } }, ['复制']),
        el('button', { type: 'button', class: 'ul-btn ul-btnGhost', onclick: function () { openEditor(it) } }, ['编辑']),
        el('button', { type: 'button', class: 'ul-btn ul-btnDanger', onclick: function () {
          if (!window.confirm('删除「' + (it.title || it.url) + '」？此操作不可恢复。')) return
          mutate(function (doc) {
            doc.items = doc.items.filter(function (x) { return x.id !== it.id })
          }).then(function () { toast('已删除', 'ok') }).catch(function (e) { toast('删除失败：' + e.message, 'bad') })
        } }, ['删除']),
        it.opens ? el('span', { class: 'ul-opens', text: '打开 ' + it.opens + ' 次' }) : null
      ])
    ])
  }

  function render() {
    var items = visibleItems()
    document.title = '网址库 · ' + state.doc.items.length

    if ($('q').value !== state.query) $('q').value = state.query
    $('sort').value = state.sort
    $('theme').value = state.theme

    var tagsBox = $('tagbar')
    clear(tagsBox)
    var tags = allTags()
    if (tags.length) {
      tagsBox.appendChild(tagChip('全部', state.doc.items.length, state.tag === '', function () { state.tag = ''; render() }))
      tags.forEach(function (x) {
        tagsBox.appendChild(tagChip(x.tag, x.n, state.tag === x.tag, function () {
          state.tag = state.tag === x.tag ? '' : x.tag; render()
        }))
      })
    }

    // 颜色筛选条：只在真的用到颜色时才出现，且只列出当前存在的颜色
    var colorBox = $('colorbar')
    clear(colorBox)
    var use = {}
    state.doc.items.forEach(function (it) { var c = colorOf(it); use[c] = (use[c] || 0) + 1 })
    var hasColor = CARD_COLORS.some(function (c) { return use[c] })
    if (!hasColor && state.color) state.color = ''      // 颜色被改没了，别把筛选卡死
    colorBox.style.display = hasColor ? '' : 'none'
    if (hasColor) {
      colorBox.appendChild(el('span', { class: 'ul-colorLabel', text: '颜色' }))
      colorBox.appendChild(el('button', {
        type: 'button', class: 'ul-chip' + (state.color === '' ? ' ul-chip-on' : ''),
        onclick: function () { state.color = ''; render() }
      }, ['全部']))
      CARD_COLORS.concat(['none']).forEach(function (c) {
        if (!use[c]) return
        colorBox.appendChild(el('button', {
          type: 'button',
          class: 'ul-chip ul-chipColor' + (state.color === c ? ' ul-chip-on' : ''),
          'data-c': c,
          title: '只看「' + COLOR_NAMES[c] + '」卡片',
          onclick: function () { state.color = state.color === c ? '' : c; render() }
        }, [el('span', { class: 'ul-chipDot' }), COLOR_NAMES[c] + ' ' + use[c]]))
      })
    }

    // 统计
    $('stat').textContent = state.doc.items.length + ' 条 · 显示 ' + items.length +
      (state.tag ? ' · 标签「' + state.tag + '」' : '') +
      (state.color ? ' · 颜色「' + COLOR_NAMES[state.color] + '」' : '') +
      (state.doc.updatedAt ? ' · 更新于 ' + state.doc.updatedAt.replace('T', ' ').slice(0, 19) : '')

    var grid = $('grid')
    clear(grid)
    if (state.loadError) {
      grid.appendChild(el('div', { class: 'ul-empty' }, [
        el('strong', { text: '读取失败' }),
        el('div', { class: 'ul-emptySub', text: state.loadError }),
        el('div', { class: 'ul-emptySub', text: '数据文件：' + BACKEND.dataPath })
      ]))
    } else if (!state.doc.items.length) {
      grid.appendChild(el('div', { class: 'ul-empty' }, [
        el('strong', { text: '还没有收录任何网址' }),
        el('div', { class: 'ul-emptySub', text: '点右上角「添加网址」，或者直接让 DSH 把资料收进来：' }),
        el('div', { class: 'ul-path', text: BACKEND.dataPath })
      ]))
    } else if (!items.length) {
      grid.appendChild(el('div', { class: 'ul-empty' }, [el('strong', { text: '没有匹配的网址' })]))
    } else {
      items.forEach(function (it) { grid.appendChild(itemCard(it)) })
    }

    $('extBadge').style.display = state.external ? '' : 'none'
    $('btnCard').style.display = BACKEND.mode === 'dsh' ? '' : 'none'
    $('modeHint').textContent = (BACKEND.mode === 'dsh' ? '工作台内' : '独立运行') + ' · ' + BACKEND.dataPath
  }

  // ---------- 添加 / 编辑 ----------
  function openEditor(it) {
    state.editing = it || null
    $('dlgTitle').textContent = it ? '编辑网址' : '添加网址'
    $('fUrl').value = it ? it.url : ''
    $('fTitle').value = it ? (it.title || '') : ''
    $('fNote').value = it ? (it.note || '') : ''
    $('fTags').value = it ? (it.tags || []).join(', ') : ''
    state.editingColor = it ? colorOf(it) : 'none'
    buildSwatches()
    var dl = $('tagList')
    clear(dl)
    allTags().forEach(function (x) { dl.appendChild(el('option', { value: x.tag })) })
    $('dlgErr').textContent = ''
    $('dlg').classList.add('show')
    setTimeout(function () { $('fUrl').focus() }, 30)
  }
  function closeEditor() {
    state.editing = null
    $('dlg').classList.remove('show')
  }
  function submitEditor() {
    var url = $('fUrl').value.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) { $('dlgErr').textContent = '请填 http/https 链接'; return }
    var title = $('fTitle').value.trim() || hostOf(url) || url
    var note = $('fNote').value.trim()
    var tags = parseTags($('fTags').value)
    var color = state.editingColor
    var editing = state.editing
    var applyColor = function (x) {
      if (color && color !== 'none') x.color = color
      else delete x.color
    }
    mutate(function (doc) {
      if (editing) {
        doc.items.forEach(function (x) {
          if (x.id !== editing.id) return
          x.url = url; x.title = title; x.note = note; x.tags = tags
          applyColor(x)
        })
      } else {
        var item = {
          id: newId(), url: url, title: title, note: note, tags: tags,
          opens: 0, addedAt: new Date().toISOString(), lastOpenedAt: ''
        }
        applyColor(item)
        doc.items.push(item)
      }
    }).then(function () {
      closeEditor()
      toast(editing ? '已保存' : '已添加', 'ok')
    }).catch(function (e) { $('dlgErr').textContent = e.message })
  }

  // ---------- 导出 ----------
  function exportJson() {
    var text = JSON.stringify(state.doc, null, 2) + '\n'
    var blob = new Blob([text], { type: 'application/json' })
    var a = el('a', { href: URL.createObjectURL(blob), download: 'library.json' })
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(function () { URL.revokeObjectURL(a.href) }, 1000)
    toast('已导出 library.json', 'ok')
  }

  // ---------- 导入 ----------
  // 比对用「归一化 URL」：只去掉首尾空白、统一小写、去掉结尾的斜杠。
  // 同域名不同路径必须算成不同条目——x6d.com/ 和 x6d.com/i-wz-29961.html
  // 指向的是不同内容，导入时不能互相吞掉。
  var imp = { rows: [], picked: {}, mode: 'skip' }

  function normUrl(u) {
    return String(u === null || u === undefined ? '' : u).trim().toLowerCase().replace(/\/+$/, '')
  }

  function parseImportText(text) {
    var raw = String(text === null || text === undefined ? '' : text).replace(/^\uFEFF/, '').trim()
    if (!raw) throw new Error('内容是空的')
    var data
    try { data = JSON.parse(raw) } catch (e) { throw new Error('不是合法的 JSON：' + e.message) }
    var arr
    if (Array.isArray(data)) arr = data
    else if (data && typeof data === 'object' && Array.isArray(data.items)) arr = data.items
    else if (data && typeof data === 'object' && typeof data.url === 'string') arr = [data]
    else throw new Error('认不出这个 JSON：既不是 {items:[…]}，也不是数组，也不是单条网址')
    if (!arr.length) throw new Error('里面一条网址都没有')
    var rows = []
    arr.forEach(function (x, i) {
      var row = { key: i, src: x, ok: false, why: '', item: null, dup: false }
      if (!x || typeof x !== 'object' || Array.isArray(x)) { row.why = '不是一条网址记录'; rows.push(row); return }
      var url = typeof x.url === 'string' ? x.url.trim() : ''
      if (!url) { row.why = '缺少 url'; rows.push(row); return }
      if (!/^https?:\/\/\S+$/i.test(url)) { row.why = '不是 http/https 链接'; rows.push(row); return }
      var tags = []
      if (Array.isArray(x.tags)) {
        x.tags.forEach(function (t) {
          if (typeof t === 'string' && t.trim() && tags.indexOf(t.trim()) < 0) tags.push(t.trim())
        })
      }
      row.ok = true
      row.item = {
        url: url,
        title: (typeof x.title === 'string' && x.title.trim()) ? x.title.trim() : (hostOf(url) || url),
        note: typeof x.note === 'string' ? x.note : '',
        tags: tags,
        color: CARD_COLORS.indexOf(x.color) >= 0 ? x.color : ''
      }
      rows.push(row)
    })
    return rows
  }

  function openImport() {
    imp = { rows: [], picked: {}, mode: 'skip' }
    $('impText').value = ''
    $('impFileName').textContent = '未选择文件'
    $('impSummary').textContent = ''
    $('impErr').textContent = ''
    $('impTools').style.display = 'none'
    $('impList').style.display = 'none'
    clear($('impList'))
    $('impMode').value = 'skip'
    $('impGo').textContent = '导入选中的 0 条'
    $('impGo').disabled = true
    $('imp').classList.add('show')
  }

  function closeImport() { $('imp').classList.remove('show') }

  function analyzeImport(text) {
    $('impErr').textContent = ''
    $('impSummary').textContent = ''
    var rows
    try {
      rows = parseImportText(text)
    } catch (e) {
      imp.rows = []; imp.picked = {}
      $('impTools').style.display = 'none'
      $('impList').style.display = 'none'
      clear($('impList'))
      $('impGo').textContent = '导入选中的 0 条'
      $('impGo').disabled = true
      $('impErr').textContent = e.message
      return
    }
    var have = {}
    state.doc.items.forEach(function (it) { have[normUrl(it.url)] = true })
    imp.rows = rows
    imp.picked = {}
    var nNew = 0, nDup = 0, nBad = 0
    rows.forEach(function (r) {
      if (!r.ok) { nBad++; return }
      r.dup = !!have[normUrl(r.item.url)]
      if (r.dup) nDup++
      else { nNew++; imp.picked[r.key] = true }
    })
    $('impSummary').textContent = '解析到 ' + rows.length + ' 条：新增 ' + nNew +
      ' · 已存在 ' + nDup + (nBad ? ' · 不合格 ' + nBad : '')
    $('impTools').style.display = ''
    $('impList').style.display = ''
    renderImportList()
  }

  function renderImportList() {
    var box = $('impList')
    clear(box)
    imp.rows.forEach(function (r) {
      var row = el('div', { class: 'ul-impRow' + (r.ok ? '' : ' ul-impRowOff') })
      if (r.ok) {
        var cb = el('input', { type: 'checkbox' })
        cb.checked = !!imp.picked[r.key]
        cb.addEventListener('change', function () {
          if (cb.checked) imp.picked[r.key] = true
          else delete imp.picked[r.key]
          updateImportCount()
        })
        row.appendChild(cb)
        row.appendChild(el('span', { class: 'ul-impTitle', title: r.item.title, text: r.item.title }))
        row.appendChild(el('span', { class: 'ul-impUrl', title: r.item.url, text: r.item.url }))
        row.appendChild(el('span', { class: 'ul-impTags', text: (r.item.tags || []).join(' ') }))
        row.appendChild(el('span', {
          class: 'ul-impBadge ' + (r.dup ? 'ul-impBadgeDup' : 'ul-impBadgeNew'),
          text: r.dup ? '已存在' : '新增'
        }))
      } else {
        row.appendChild(el('span', { class: 'ul-impTitle', text: (r.src && typeof r.src.url === 'string') ? r.src.url : '(无法识别)' }))
        row.appendChild(el('span', { class: 'ul-impBadge ul-impBadgeBad', text: r.why }))
      }
      box.appendChild(row)
    })
    updateImportCount()
  }

  function updateImportCount() {
    var n = imp.rows.filter(function (r) { return r.ok && imp.picked[r.key] }).length
    $('impGo').textContent = '导入选中的 ' + n + ' 条'
    $('impGo').disabled = n === 0
  }

  function pickImport(mode) {
    imp.picked = {}
    imp.rows.forEach(function (r) {
      if (!r.ok) return
      if (mode === 'all' || (mode === 'new' && !r.dup)) imp.picked[r.key] = true
    })
    renderImportList()
  }

  function doImport() {
    var picked = imp.rows.filter(function (r) { return r.ok && imp.picked[r.key] })
    if (!picked.length) { toast('没有选中任何条目', 'bad'); return }
    var mode = imp.mode
    var stats = { added: 0, updated: 0 }
    $('impErr').textContent = ''
    mutate(function (doc) {
      var byUrl = {}
      doc.items.forEach(function (it) { byUrl[normUrl(it.url)] = it })
      picked.forEach(function (r) {
        var key = normUrl(r.item.url)
        var hit = byUrl[key]
        if (hit) {
          if (mode === 'update') {
            hit.title = r.item.title
            hit.note = r.item.note
            hit.tags = r.item.tags
            if (r.item.color) hit.color = r.item.color
            stats.updated++
          }
          return
        }
        var it = {
          id: newId(), url: r.item.url, title: r.item.title, note: r.item.note,
          tags: r.item.tags, opens: 0,
          addedAt: new Date().toISOString(), lastOpenedAt: ''
        }
        if (r.item.color) it.color = r.item.color
        doc.items.push(it)
        byUrl[key] = it
        stats.added++
      })
    }).then(function () {
      closeImport()
      toast('导入完成：新增 ' + stats.added + ' 条' +
        (stats.updated ? '，更新 ' + stats.updated + ' 条' : ''), 'ok')
    }).catch(function (e) { $('impErr').textContent = '写入失败：' + e.message })
  }

  function bindImport() {
    $('btnImport').addEventListener('click', openImport)
    $('impCancel').addEventListener('click', closeImport)
    $('impPick').addEventListener('click', function () { $('fileImport').click() })
    $('fileImport').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]
      if (!f) return
      $('impFileName').textContent = f.name + '（' + Math.max(1, Math.round(f.size / 1024)) + ' KB）'
      var fr = new FileReader()
      fr.onload = function () { analyzeImport(String(fr.result || '')) }
      fr.onerror = function () { $('impErr').textContent = '文件读不出来' }
      fr.readAsText(f, 'utf-8')
      e.target.value = ''
    })
    $('impParse').addEventListener('click', function () { analyzeImport($('impText').value) })
    $('impAll').addEventListener('click', function () { pickImport('all') })
    $('impNone').addEventListener('click', function () { pickImport('none') })
    $('impNew').addEventListener('click', function () { pickImport('new') })
    $('impMode').addEventListener('change', function (e) { imp.mode = e.target.value })
    $('impGo').addEventListener('click', doImport)
    $('imp').addEventListener('keydown', function (e) { if (e.key === 'Escape') closeImport() })
  }

  // ---------- 在工作台侧边栏种一张项目卡（只有 dsh 宿主下可用）----------
  function addWorktableCard() {
    if (BACKEND.mode !== 'dsh') { toast('独立模式下无法写入工作台数据，请在工作台内打开本页再点', 'bad'); return }
    var raw = null
    try { raw = localStorage.getItem(WT_KEY) } catch (e) { toast('本页无法访问 localStorage', 'bad'); return }
    var doc = {}
    try { doc = raw ? JSON.parse(raw) : {} } catch (e) { doc = {} }
    var layouts = Array.isArray(doc.layouts) ? doc.layouts : []
    var spec = {
      id: CARD_ID, title: '网址库', icon: '🔗', left: null, top: null,
      main: [{ id: 'p1', title: '网址库', min: 200, content: { kind: 'iframe', url: location.pathname, title: '网址库' } }],
      leftWidth: { default: 260, min: 160, max: 480 },
      chatWidth: { default: 360, min: 240, max: 600 },
      topHeight: { default: 200, min: 120, max: 480 },
      topHeightRatio: 0.35, chatSide: 'right', chatFullHeight: false
    }
    doc.layouts = layouts.filter(function (l) { return !l || l.id !== CARD_ID }).concat([spec])
    try { localStorage.setItem(WT_KEY, JSON.stringify(doc)) } catch (e) { toast('写入工作台数据失败：' + e.message, 'bad'); return }
    toast('已写入，按 F5 刷新后侧边栏出现「网址库」卡片', 'ok')
  }

  // ---------- 事件 ----------
  function bind() {
    $('q').addEventListener('input', function (e) { state.query = e.target.value; render() })
    $('sort').addEventListener('change', function (e) { state.sort = e.target.value; saveUi(); render() })
    $('theme').addEventListener('change', function (e) { state.theme = e.target.value; saveUi(); applyTheme() })
    $('btnAdd').addEventListener('click', function () { openEditor(null) })
    $('btnStandalone').addEventListener('click', function () {
      if (!openExternal(location.href)) toast('浏览器拦下了弹窗，请复制地址栏手动打开', 'bad')
    })
    $('btnReload').addEventListener('click', function () {
      reload().then(function () { toast('已从磁盘重新载入', 'ok') })
    })
    $('btnExport').addEventListener('click', exportJson)
    bindImport()
    $('btnCard').addEventListener('click', addWorktableCard)
    $('dlgOk').addEventListener('click', submitEditor)
    $('dlgCancel').addEventListener('click', closeEditor)
    $('extBadge').addEventListener('click', function () {
      state.external = false
      reload().then(function () { toast('已载入外部更新', 'ok') })
    })
    $('dlg').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeEditor()
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitEditor()
    })
  }

  // ---------- 轮询与心跳 ----------
  function poll() {
    if (document.hidden) return
    fetchRaw().then(function (raw) {
      if (raw === null || raw === state.raw) return
      if ($('dlg').classList.contains('show') || $('imp').classList.contains('show')) { state.external = true; render(); return }
      state.external = false
      state.raw = raw
      try { state.doc = parseDoc(raw) } catch (e) { return }
      render()
      toast('检测到外部更新，已自动载入', 'ok')
    }).catch(function () { /* 轮询失败不打扰用户 */ })
  }
  // 心跳：不受 visibility 影响，让本地服务知道页面还开着（后台标签会被浏览器降频到约每分钟一次，
  // 服务端 180 秒的自灭阈值仍然安全）
  function ping() {
    if (!BACKEND || BACKEND.mode !== 'local') return
    try { fetch('/api/ping', { cache: 'no-store' }).catch(function () {}) } catch (e) { /* 服务已退出，忽略 */ }
  }

  // ---------- 主题 ----------
  // 页面自带两套配色（默认浅色=白）。'auto' = 跟随工作台宿主：只读宿主背景色算亮度，
  // 亮就用浅色、暗就用深色，这样配色成套、不会出现深底配浅色按钮的错配。
  function hostWindow() {
    try {
      if (window.parent && window.parent !== window) {
        var d = window.parent.document
        if (d && d.documentElement) return window.parent
      }
    } catch (e) { /* 跨域，读不到 */ }
    return null
  }
  function luminanceOf(cssColor) {
    if (!cssColor) return null
    var probe = document.createElement('span')
    probe.style.color = ''
    probe.style.color = cssColor
    if (!probe.style.color) return null          // 浏览器不认识这个值
    probe.style.display = 'none'
    document.body.appendChild(probe)
    var computed = window.getComputedStyle(probe).color
    document.body.removeChild(probe)
    var m = /^rgba?\(([^)]+)\)/.exec(computed)
    if (!m) return null
    var p = m[1].split(',').map(function (x) { return parseFloat(x) })
    if (p.length < 3 || p.some(function (x) { return isNaN(x) })) return null
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255
  }
  function resolvedTheme() {
    if (state.theme === 'light' || state.theme === 'dark') return state.theme
    var w = hostWindow()
    if (!w) return 'light'
    try {
      var bg = w.getComputedStyle(w.document.documentElement).getPropertyValue('--dsw-alias-bg-base')
      var lum = luminanceOf(bg.trim())
      return lum === null ? 'light' : (lum > 0.5 ? 'light' : 'dark')
    } catch (e) { return 'light' }
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-ul-theme', resolvedTheme())
  }
  function watchHostTheme() {
    var w = hostWindow()
    if (!w) return
    try {
      new MutationObserver(function () { if (state.theme === 'auto') applyTheme() })
        .observe(w.document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    } catch (e) { /* 主题跟随失败不影响使用 */ }
  }

  // ---------- 启动 ----------
  loadUi()
  applyTheme()
  bind()
  watchHostTheme()
  resolveBackend().then(function (b) {
    BACKEND = b
    reload()
  }).catch(function (e) {
    BACKEND = { mode: 'local', fileApi: '/api/file?path=', writeApi: '/api/write', dataPath: '(未知)', backupPath: '(未知)' }
    state.loadError = e && e.message ? e.message : String(e)
    bindFallback()
    render()
  })

  function bindFallback() {
    $('modeHint').textContent = '后端未就绪，点「刷新」重试'
  }

  setInterval(poll, POLL_MS)
  setInterval(ping, PING_MS)
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll() })
})()
