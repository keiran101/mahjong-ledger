/* 麻将记账 · 前端（原生 JS，零构建，手机优先） */
const $ = (s) => document.querySelector(s)
const $$ = (s) => Array.from(document.querySelectorAll(s))
const SEATS = ['E', 'S', 'W', 'N']
const SN = { E: '东', S: '南', W: '西', N: '北' }
const COLORS = { E: '#c0453a', S: '#b8862f', W: '#2f7d68', N: '#3a6493' }
const HORSE_TILES = (() => {
  const a = []
  for (const suit of ['万', '条', '筒']) for (let n = 1; n <= 9; n++) a.push(`${n}${suit}`)
  return a.concat(['东风', '南风', '西风', '北风', '红中', '发财', '白板'])
})()

/** 本局摸马张数：有鬼 4 张、没鬼（硬胡）6 张。规则由服务端下发，缺省兜底。 */
function horseMax(hasGhost) {
  const c = S.rules?.horseCount
  if (c && typeof c === 'object') return Number(hasGhost ? c.withGhost : c.withoutGhost) || (hasGhost ? 4 : 6)
  return hasGhost ? 4 : 6
}
function freshForm() {
  return { winner: null, pattern: null, hasGhost: true, horses: new Array(horseMax(true)).fill(''), gangEvents: [] }
}

const S = {
  code: null, identity: null, data: null, rules: null,
  form: null, preview: null, editTarget: null, timer: null,
}

const fmt = (v) => { const n = Number(v); return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0' }
const seatLabel = (s) => S.data?.players?.[s]?.nickname || `${SN[s]}家`
const fmtTime = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.remove('hidden')
  clearTimeout(el._t)
  el._t = setTimeout(() => el.classList.add('hidden'), 2400)
}

/** 按钮忙碌态：保留文字、前置旋转指示器、禁用重复提交，结束后恢复原禁用状态 */
async function busy(btn, label, fn) {
  if (!btn || btn.disabled) return
  const old = btn.innerHTML
  const wasDisabled = btn.disabled
  btn.disabled = true
  btn.setAttribute('aria-busy', 'true')
  btn.textContent = label
  try { return await fn() }
  finally {
    btn.disabled = wasDisabled
    btn.removeAttribute('aria-busy')
    btn.innerHTML = old
  }
}

/* 发布环境下分享链接带 sharecode 凭据，改写 URL 与请求时都必须保留 */
function withShare(u) {
  const sc = new URLSearchParams(location.search).get('sharecode')
  if (!sc) return u
  return `${u}${u.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(sc)}`
}
function roomUrl(code) {
  const u = new URL(location.href)
  u.searchParams.set('room', code)
  u.searchParams.delete('me')
  return u.pathname + u.search
}
function homeUrl() {
  const u = new URL(location.href)
  u.searchParams.delete('room')
  u.searchParams.delete('me')
  return u.pathname + (u.search || '')
}

async function api(path, body) {
  const r = await fetch(withShare(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j
  try { j = await r.json() } catch { throw new Error('服务返回异常') }
  if (!r.ok) throw new Error(j.error || '请求失败')
  return j
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制到剪贴板')
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); toast('已复制到剪贴板') } catch { toast('复制失败，请长按选择文字') }
    ta.remove()
  }
}

function show(view) {
  $$('.view').forEach((v) => v.classList.add('hidden'))
  $(`#view-${view}`).classList.remove('hidden')
}

function switchTab(tab) {
  $$('#panels .panel').forEach((p) => p.classList.add('hidden'))
  $(`#panel-${tab}`).classList.remove('hidden')
  $$('#tabbar button').forEach((b) => {
    const on = b.dataset.tab === tab
    b.classList.toggle('active', on)
    b.setAttribute('aria-selected', String(on))
  })
  window.scrollTo(0, 0)
}

/* ---------- 启动 / 房间 ---------- */

async function init() {
  bind()
  initLLM()
  const qs = new URLSearchParams(location.search)
  const code = (qs.get('room') || '').trim().toUpperCase()
  if (!code) return show('home')
  try {
    const d = await api(`/api/rooms/${code}`)
    S.code = code
    S.data = d
    S.rules = d.rules
    const me = (qs.get('me') || '').toUpperCase()
    const id = (me && SEATS.includes(me)) ? me : localStorage.getItem(`mj_id_${code}`)
    if (id && SEATS.includes(id)) {
      S.identity = id
      localStorage.setItem(`mj_id_${code}`, id)
      await enterMain()
    } else {
      renderIdentity()
      show('identity')
    }
  } catch (e) {
    toast(`打不开房间：${e.message}`)
    history.replaceState(null, '', homeUrl())
    show('home')
  }
}

async function openRoom(code) {
  const d = await api(`/api/rooms/${code}`)
  S.code = code
  S.data = d
  S.rules = d.rules
  history.replaceState(null, '', roomUrl(code))
  const id = localStorage.getItem(`mj_id_${code}`)
  if (id && SEATS.includes(id)) {
    S.identity = id
    await enterMain()
  } else {
    renderIdentity()
    show('identity')
  }
}

function renderIdentity() {
  $('#identity-room').textContent = `${S.data.name} · 房间 ${S.code}`
  $('#identity-list').innerHTML = SEATS.map((s) =>
    `<button type="button" class="seat-btn" data-seat="${s}"><span class="seat-name">${seatLabel(s)}</span><small>${SN[s]}家</small></button>`).join('')
  $$('#identity-list .seat-btn').forEach((b) => {
    b.onclick = () => {
      S.identity = b.dataset.seat
      localStorage.setItem(`mj_id_${S.code}`, S.identity)
      enterMain()
    }
  })
}

async function enterMain() {
  S.form = freshForm()
  renderScoreForm()
  renderAll(S.data)
  show('main')
  switchTab('board')
  clearInterval(S.timer)
  S.timer = setInterval(() => {
    if (!$('#preview-modal').classList.contains('hidden')) return
    if (!$('#edit-modal').classList.contains('hidden')) return
    if (!$('#llm-modal').classList.contains('hidden')) return
    if (!$('#vision-modal').classList.contains('hidden')) return
    loadData(true)
  }, 4000)
}

async function loadData(silent) {
  if (!S.code) return
  try {
    const d = await api(`/api/rooms/${S.code}`)
    S.data = d
    S.rules = d.rules
    renderAll(d)
  } catch (e) {
    if (!silent) toast(e.message)
  }
}

function renderAll(d) {
  renderBoard(d)
  renderRecords(d)
  renderSettle(d)
  renderStats(d)
  updateHints(d)
}

function updateHints(d) {
  updateHorseHint()
}

/* ---------- 看板 ---------- */

function scoreCells(net, dealer) {
  return SEATS.map((s) => {
    const v = Number(net[s]) || 0
    const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'
    const money = v * (S.data?.unitPrice ?? 1)
    const name = seatLabel(s)
    const aria = `${SN[s]}家 ${name} ${v > 0 ? '赢' : v < 0 ? '输' : '平'} ${Math.abs(v)} 分${s === dealer ? '，本局庄家' : ''}`
    return `<div class="score-cell ${s === dealer ? 'dealer' : ''}" data-seat="${s}" role="group" aria-label="${escHtml(aria)}">
      <div class="nm" title="${escHtml(name)}"><b>${SN[s]}</b>${escHtml(name)}</div>
      <div class="val ${cls}">${fmt(v)}</div>
      <div class="money">${fmt(money)} 元</div>
    </div>`
  }).join('')
}

function recordHtml(e, compact) {
  const inp = e.payload?.input || {}
  const net = e.net || {}
  const netRow = SEATS.map((s) => {
    const v = Number(net[s]) || 0
    return `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${SN[s]} ${fmt(v)}</span>`
  }).join('')
  return `<div class="record ${e.isVoided ? 'voided' : ''}">
    <div class="r-top"><span>第 ${e.roundNo} 局 · ${fmtTime(e.createdAt)}</span><span>${e.author || '—'} 记</span></div>
    <div class="r-main">${seatLabel(inp.winner)} ${inp.pattern || '胡牌'} ${inp.hasGhost ? '有鬼' : '硬胡'}
      ${e.isCorrected ? '<span class="badge manual">已手改</span>' : ''}
      ${e.isVoided ? '<span class="badge">已作废</span>' : ''}</div>
    <div class="r-net">${netRow}</div>
    ${compact || e.isVoided ? '' : `<div class="r-actions">
      <button data-edit="${e.id}">手改</button>
      <button class="danger" data-void="${e.id}">作废</button></div>`}
  </div>`
}

function renderBoard(d) {
  $('#top-name').textContent = d.name
  $('#top-code').textContent = `房间 ${d.code} · 我是 ${seatLabel(S.identity)}`
  $('#board-rounds').textContent = `${d.stats.rounds} 局`
  $('#score-board').innerHTML = scoreCells(d.net, d.dealer)
  $('#dealer-group').innerHTML = SEATS.map((s) =>
    `<button type="button" data-seat="${s}" class="${s === d.dealer ? 'active' : ''}" aria-pressed="${s === d.dealer}">${SN[s]}家</button>`).join('')
  $$('#dealer-group button').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/rooms/${S.code}/dealer`, { dealer: b.dataset.seat })
        await loadData()
        toast(`庄家已设为 ${seatLabel(b.dataset.seat)}`)
      } catch (e) { toast(e.message) }
    }
  })
  const recent = d.events.filter((e) => e.type === 'score' && !e.isVoided).slice(0, 5)
  $('#recent-list').innerHTML = recent.length
    ? recent.map((e) => recordHtml(e, true)).join('')
    : `<div class="empty"><span class="empty-title">还没有记录</span>这桌刚开，记完第一局这里会列出每局明细。<br><button class="btn btn-outline" type="button" data-goto-score>去记第一局</button></div>`
}

/* ---------- 记分表单 ---------- */

/** 摸马录入框：张数随有无鬼变（有鬼 4 / 没鬼 6），切换时保留已填马牌、按需补框或截断 */
function renderHorseRows() {
  const f = S.form
  const n = horseMax(f.hasGhost)
  const prev = Array.isArray(f.horses) ? f.horses : []
  f.horses = Array.from({ length: n }, (_, i) => prev[i] || '')
  const row = $('#horse-row')
  row.classList.toggle('six', n > 4)
  row.innerHTML = f.horses.map((v, i) =>
    `<select data-i="${i}" aria-label="第 ${i + 1} 张摸马牌，留空表示未中"><option value="">未中</option>${HORSE_TILES.map((t) =>
      `<option value="${t}" ${v === t ? 'selected' : ''}>${t}</option>`).join('')}</select>`).join('')
  $$('#horse-row select').forEach((sel) => {
    sel.onchange = () => { f.horses[Number(sel.dataset.i)] = sel.value }
  })
  updateHorseHint()
}

/** 摸马提示统一管理：庄家（马牌起点）+ 本局摸马张数，供渲染与定时刷新共用 */
function updateHorseHint() {
  const f = S.form
  if (!f) return
  const n = horseMax(f.hasGhost)
  const dealer = S.data?.dealer
  const prefix = dealer ? `庄家 ${SN[dealer]} · ` : ''
  $('#horse-hint').textContent = `${prefix}${f.hasGhost ? '有鬼' : '没鬼(硬胡)'}摸 ${n} 张 · 中马选牌`
}

function renderScoreForm() {
  const f = S.form
  $('#winner-group').innerHTML = SEATS.map((s) =>
    `<button type="button" class="seat-btn ${f.winner === s ? 'active' : ''}" data-seat="${s}" aria-pressed="${f.winner === s}"><span class="seat-name">${seatLabel(s)}</span><small>${SN[s]}家</small></button>`).join('')
  $$('#winner-group .seat-btn').forEach((b) => {
    b.onclick = () => {
      f.winner = b.dataset.seat
      $$('#winner-group .seat-btn').forEach((x) => {
        x.classList.toggle('active', x === b)
        x.setAttribute('aria-pressed', String(x === b))
      })
    }
  })

  $('#pattern-groups').innerHTML = S.rules.patterns.map((g) =>
    `<div class="pgroup">
      <div class="pgroup-head"><span>第 ${g.times} 档</span><b>有鬼 ${g.withGhost} / 硬胡 ${g.withoutGhost}</b></div>
      <div class="chips">${g.patterns.map((p) =>
        `<button type="button" class="chip ${f.pattern === p ? 'active' : ''}" data-pattern="${p}" aria-pressed="${f.pattern === p}">${p}</button>`).join('')}</div>
    </div>`).join('')
  $$('#pattern-groups .chip').forEach((b) => {
    b.onclick = () => {
      f.pattern = b.dataset.pattern
      $$('#pattern-groups .chip').forEach((x) => {
        x.classList.toggle('active', x === b)
        x.setAttribute('aria-pressed', String(x === b))
      })
    }
  })

  $$('#ghost-switch button').forEach((b) => {
    const on = (b.dataset.ghost === 'true') === f.hasGhost
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
    b.onclick = () => {
      f.hasGhost = b.dataset.ghost === 'true'
      $$('#ghost-switch button').forEach((x) => {
        x.classList.toggle('active', x === b)
        x.setAttribute('aria-pressed', String(x === b))
      })
      renderHorseRows() // 有无鬼切换时，摸马张数 4↔6 实时变化
    }
  })

  renderHorseRows()

  $('#gang-list').innerHTML = ''
  f.gangEvents = []
}

function addGang() {
  const row = document.createElement('div')
  row.className = 'gang-item'
  row.innerHTML = `
    <select class="g-type" aria-label="杠的类型"><option value="an">暗杠</option><option value="bu">补杠</option><option value="dian">点杠</option></select>
    <select class="g-by" aria-label="杠牌者">${SEATS.map((s) => `<option value="${s}">${seatLabel(s)}</option>`).join('')}</select>
    <select class="g-from" disabled aria-label="点杠的放杠者">${SEATS.map((s) => `<option value="${s}">${seatLabel(s)}放</option>`).join('')}</select>
    <button class="gang-del" type="button" aria-label="删除这条杠">×</button>`
  $('#gang-list').appendChild(row)
  row.querySelector('.g-type').onchange = (e) => {
    row.querySelector('.g-from').disabled = e.target.value !== 'dian'
  }
  row.querySelector('.gang-del').onclick = () => row.remove()
}

function collectGang() {
  S.form.gangEvents = $$('#gang-list .gang-item').map((row) => {
    const type = row.querySelector('.g-type').value
    const g = { type, by: row.querySelector('.g-by').value }
    if (type === 'dian') g.from = row.querySelector('.g-from').value
    return g
  })
}

async function doPreview() {
  const f = S.form
  if (!f.winner) return toast('先选谁胡了')
  if (!f.pattern) return toast('先报一个胡型')
  collectGang()
  return busy($('#btn-preview'), '计算中…', async () => {
    try {
      const r = await api(`/api/rooms/${S.code}/preview`, {
        winner: f.winner,
        pattern: f.pattern,
        hasGhost: f.hasGhost,
        horses: f.horses.filter(Boolean),
        gangEvents: f.gangEvents,
      })
      S.preview = r
      S.previewSource = 'manual'
      showPreview(r.detail, r.input)
    } catch (e) { toast(e.message) }
  })
}

function kv(k, v) {
  return `<div class="kv"><span>${k}</span><span>${v}</span></div>`
}

function netFrom(sel) {
  const o = {}
  $$(sel + ' input').forEach((i) => { o[i.dataset.seat] = Number(i.value || 0) })
  return o
}

function bindNetEdit(container, sumEl) {
  const update = () => {
    const n = netFrom(container)
    const sum = SEATS.reduce((a, s) => a + (Number(n[s]) || 0), 0)
    const el = $(sumEl)
    el.textContent = `四家合计 ${fmt(sum)} ${sum === 0 ? '✓ 账平' : '（必须为 0，已禁止落账）'}`
    el.style.color = sum === 0 ? 'var(--neg)' : 'var(--danger)'
    if (container === '#preview-net') $('#btn-confirm').disabled = sum !== 0
    if (container === '#edit-net') $('#btn-edit-save').disabled = sum !== 0
  }
  $$(container + ' input').forEach((i) => { i.oninput = update })
  update()
}

function showPreview(d, input) {
  const horse = d.horseHits.length
    ? d.horseHits.map((h) => `${h.tile}→${seatLabel(h.seat)}${h.winnerSelf ? '(本人不计)' : ''}`).join('、')
    : '无'
  let html = kv('胡法', `<b>${d.tierName}</b>（${d.hasGhost ? '有鬼' : '硬胡'}）`)
  html += kv('档位基数', `<b class="hl">${d.base} 分</b>`)
  html += kv('三家各付', `${d.zimoPerLoser} 分，赢家收 ${d.zimoPerLoser * 3} 分`)
  html += kv(`摸马 ${d.horseCount ?? ''} 张`, horse)
  if (d.gangLines.length) html += kv('杠分', d.gangLines.join('；'))
  $('#preview-detail').innerHTML = html
  $('#preview-net').innerHTML = SEATS.map((s) =>
    `<label><span>${seatLabel(s)}</span><input type="number" inputmode="numeric" data-seat="${s}" value="${d.perPlayer[s]}"></label>`).join('')
  bindNetEdit('#preview-net', '#preview-sum')
  $('#preview-modal').classList.remove('hidden')
}

async function confirmScore() {
  const net = netFrom('#preview-net')
  const sum = SEATS.reduce((a, s) => a + (Number(net[s]) || 0), 0)
  if (sum !== 0) return toast('四家分数之和必须为 0')
  const { input, detail } = S.preview
  const changed = SEATS.some((s) => Number(net[s]) !== detail.perPlayer[s])
  const body = {
    ...input,
    author: seatLabel(S.identity),
    ...(changed ? { manualOverride: net } : {}),
  }
  return busy($('#btn-confirm'), '落账中…', async () => {
    try {
      await api(`/api/rooms/${S.code}/events`, body)
      $('#preview-modal').classList.add('hidden')
      S.form = freshForm()
      renderScoreForm()
      await loadData()
      switchTab('board')
      toast('已记入账本')
    } catch (e) { toast(e.message) }
  })
}

/* ---------- 记录 / 手改 / 作废 ---------- */

function renderRecords(d) {
  const list = d.events.filter((e) => e.type === 'score')
  $('#records-count').textContent = `${d.stats.rounds} 局有效`
  $('#records-list').innerHTML = list.length
    ? list.map((e) => recordHtml(e, false)).join('')
    : `<div class="empty"><span class="empty-title">还没有记录</span>记完一局后，这里可以手改或作废任意一局。<br><button class="btn btn-outline" type="button" data-goto-score>去记第一局</button></div>`
  $$('#records-list [data-edit]').forEach((b) => { b.onclick = () => openEdit(Number(b.dataset.edit)) })
  $$('#records-list [data-void]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('确定作废这一局吗？分数会重新计算。')) return
      try {
        await api(`/api/rooms/${S.code}/events/${b.dataset.void}/void`, { author: seatLabel(S.identity) })
        await loadData()
        toast('已作废')
      } catch (e) { toast(e.message) }
    }
  })
}

function openEdit(id) {
  const e = S.data.events.find((x) => x.id === id)
  if (!e) return
  S.editTarget = id
  $('#edit-net').innerHTML = SEATS.map((s) =>
    `<label><span>${seatLabel(s)}</span><input type="number" inputmode="numeric" data-seat="${s}" value="${e.net[s]}"></label>`).join('')
  bindNetEdit('#edit-net', '#edit-sum')
  $('#edit-modal').classList.remove('hidden')
}

async function saveEdit() {
  const net = netFrom('#edit-net')
  const sum = SEATS.reduce((a, s) => a + (Number(net[s]) || 0), 0)
  if (sum !== 0) return toast('四家分数之和必须为 0')
  try {
    await api(`/api/rooms/${S.code}/events/${S.editTarget}/correct`, { net, author: seatLabel(S.identity) })
    $('#edit-modal').classList.add('hidden')
    await loadData()
    toast('已保存手改')
  } catch (e) { toast(e.message) }
}

/* ---------- 结算 ---------- */

function buildSettleText(d) {
  const lines = []
  lines.push(`🀄 ${d.name} · 结算`)
  lines.push(`房间 ${d.code}　共 ${d.stats.rounds} 局　底分 2`)
  lines.push('────────────')
  SEATS.forEach((s) => {
    const v = Number(d.net[s]) || 0
    lines.push(`${SN[s]}家 ${seatLabel(s)}　${fmt(v)} 分（${fmt(v * d.unitPrice)} 元）`)
  })
  lines.push('────────────')
  if (!d.settlement.length) lines.push('四家持平，无需转账')
  else d.settlement.forEach((t) => lines.push(`${seatLabel(t.from)} → ${seatLabel(t.to)}　${t.amount} 元`))
  return lines.join('\n')
}

function renderSettle(d) {
  $('#settle-net').innerHTML = scoreCells(d.net, d.dealer)
  $('#settle-transfers').innerHTML = d.settlement.length
    ? d.settlement.map((t) =>
      `<div class="transfer"><div class="who">${seatLabel(t.from)} <span class="muted">→</span> ${seatLabel(t.to)}</div><div class="amt">${t.amount} 元</div></div>`).join('')
    : `<div class="empty"><span class="empty-title">四家持平，无需转账</span>当前没有需要相互结算的差额。</div>`
  $('#settle-card').textContent = buildSettleText(d)
}

/* ---------- 统计 ---------- */

function renderStats(d) {
  const st = d.stats
  $('#stats-ranking').innerHTML = st.ranking.map((s, i) => {
    const v = Number(d.net[s]) || 0
    return `<div class="stat-row">
      <div class="rank">${i + 1}</div>
      <div class="info"><b>${seatLabel(s)}</b><small>胡 ${st.wins[s]} 次 · 胜率 ${st.winRate[s]}%</small></div>
      <div class="total" style="color:${v > 0 ? 'var(--pos)' : v < 0 ? 'var(--neg)' : 'var(--muted)'}">${fmt(v)}</div>
    </div>`
  }).join('')

  $('#stats-table').innerHTML = `<table><tr><th>玩家</th><th>胡牌</th><th>胜率</th><th>净分</th></tr>${SEATS.map((s) =>
    `<tr><td>${seatLabel(s)}</td><td>${st.wins[s]}</td><td>${st.winRate[s]}%</td><td>${fmt(d.net[s])}</td></tr>`).join('')}</table>`

  const trend = st.trend
  if (!trend.length) {
    $('#stats-chart').innerHTML = `<div class="empty"><span class="empty-title">还没有走势</span>记满一局后这里会出现四家分数曲线。</div>`
    return
  }
  const W = 340, H = 180, pad = 26
  const all = trend.flatMap((t) => SEATS.map((s) => t[s]))
  let min = Math.min(0, ...all), max = Math.max(0, ...all)
  if (max === min) max = min + 10
  const m = (max - min) * 0.1
  min -= m; max += m
  const x = (i) => pad + (trend.length === 1 ? (W - 2 * pad) / 2 : i * (W - 2 * pad) / (trend.length - 1))
  const y = (v) => H - pad - (v - min) * (H - 2 * pad) / (max - min)
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet">`
  svg += `<line x1="${pad}" y1="${y(0)}" x2="${W - pad}" y2="${y(0)}" stroke="#ddd" stroke-dasharray="3 3"/>`
  SEATS.forEach((s) => {
    const pts = trend.map((t, i) => `${x(i)},${y(t[s])}`).join(' ')
    svg += `<polyline points="${pts}" fill="none" stroke="${COLORS[s]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
  })
  trend.forEach((t, i) => {
    if (trend.length <= 8 || i % Math.ceil(trend.length / 6) === 0 || i === trend.length - 1) {
      svg += `<text x="${x(i)}" y="${H - 6}" font-size="9" fill="#999" text-anchor="middle">${t.round}</text>`
    }
  })
  svg += '</svg>'
  svg += `<div class="legend">${SEATS.map((s) => `<span><i style="background:${COLORS[s]}"></i>${SN[s]}家</span>`).join('')}</div>`
  if (trend.length === 1) svg += `<div class="state-note">目前只有 1 局数据，显示为单点；继续记分后连成曲线。</div>`
  $('#stats-chart').innerHTML = svg
}

/* ---------- 语音 / LLM 记分 ---------- */
/* 铁律：LLM 只把口述抽成字段，分数一律由服务端计分引擎算，前端只做核对与确认 */

const VS = { parsed: null, llm: null, rec: null, recording: false }
const Vision = { cfg: null, draft: null, form: null }
const SPECIALS = [
  { id: 'none', name: '普通自摸' },
  { id: 'qianggang', name: '抢杠胡' },
  { id: 'gangkai', name: '杠上开花' },
  { id: 'haidi', name: '海底捞月' },
  { id: 'tian', name: '天胡' },
  { id: 'di', name: '地胡' },
]

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

async function initLLM() {
  try { VS.llm = await api('/api/llm-config') } catch { VS.llm = null }
  try { Vision.cfg = await api('/api/vlm-config') } catch { Vision.cfg = null }
  updateLlmBadge()
  updateVlmBadge()
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (SR) $('#btn-mic').classList.remove('hidden')
  else $('#voice-tip').textContent = '此浏览器不支持网页内识别，请用手机输入法的「语音输入」把话变成文字'
}

function updateLlmBadge() {
  const c = VS.llm
  const el = $('#llm-badge')
  if (!c) { el.textContent = '状态未知'; return }
  if (c.source === 'env') el.textContent = c.configured ? 'LLM · 服务端配置' : '规则模式'
  else if (c.configured) el.textContent = `LLM · ${c.model}`
  else el.textContent = '规则模式 · 点设置接 LLM'
}

function updateVlmBadge() {
  const el = $('#vlm-badge')
  if (!el) return
  const c = Vision.cfg
  if (!c) { el.textContent = '状态未知'; return }
  if (c.configured) el.textContent = `Qwen3.7 · ${c.model}`
  else el.textContent = '未配置 · 点设置填通义 Key'
}

function openLlmModal() {
  const c = VS.llm
  if (c) {
    $('#llm-provider').value = c.provider || 'deepseek'
    $('#llm-base').value = c.baseUrl || ''
    $('#llm-model').value = c.model || ''
    $('#llm-status').textContent = c.source === 'env'
      ? '当前密钥由服务端环境变量提供，页面内不可修改。'
      : (c.hasKey ? '已保存密钥（不回显）' : '尚未填写 API Key')
  }
  $('#llm-key').value = ''
  $('#vlm-key').value = ''
  const v = Vision.cfg
  if (v) {
    $('#vlm-status').textContent = v.source === 'env'
      ? `拍照识别由环境变量配置 · ${v.model}`
      : (v.configured ? `已就绪 · ${v.model}（${v.source === 'llm' ? '共用通义 Key' : '独立 Key'}）` : '尚未配置通义千问 Key，拍照识别不可用')
  }
  $('#llm-modal').classList.remove('hidden')
}

function llmFormBody(extra = {}) {
  return {
    provider: $('#llm-provider').value,
    baseUrl: $('#llm-base').value.trim(),
    model: $('#llm-model').value.trim(),
    apiKey: $('#llm-key').value.trim(),
    ...extra,
  }
}

async function saveLlm(extra) {
  const off = extra && extra.enabled === false
  try {
    VS.llm = await api('/api/llm-config', llmFormBody(extra || {}))
    updateLlmBadge()
    const vlmKey = $('#vlm-key').value.trim()
    if (vlmKey) {
      Vision.cfg = await api('/api/vlm-config', { apiKey: vlmKey })
    } else {
      try { Vision.cfg = await api('/api/vlm-config') } catch { /* ignore */ }
    }
    updateVlmBadge()
    $('#llm-status').textContent = off ? '已停用，现在只用规则模式' : '已保存'
    toast(off ? '已停用 LLM' : 'LLM 配置已保存')
    if (!off) $('#llm-modal').classList.add('hidden')
  } catch (e) { $('#llm-status').textContent = `保存失败：${e.message}` }
}

async function testLlm() {
  $('#llm-status').textContent = '正在测试…'
  try {
    VS.llm = await api('/api/llm-config', llmFormBody())
    updateLlmBadge()
    const t = await api('/api/llm-config/test', {})
    $('#llm-status').textContent = `连接成功 · ${t.model} · ${t.ms}ms · 回复「${t.sample}」`
  } catch (e) { $('#llm-status').textContent = `连接失败：${e.message}` }
}

function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return toast('此浏览器不支持，请用输入法语音输入')
  if (VS.recording) { try { VS.rec.stop() } catch {} return }
  const rec = new SR()
  rec.lang = 'zh-CN'
  rec.continuous = false
  rec.interimResults = false
  rec.maxAlternatives = 1
  rec.onstart = () => {
    VS.recording = true
    $('#btn-mic').textContent = '正在听…再点结束'
    $('#btn-mic').classList.add('recording')
  }
  rec.onresult = (e) => {
    const said = e.results[0][0].transcript
    const ta = $('#voice-text')
    ta.value = (ta.value ? ta.value.replace(/[，,。；;\s]+$/, '') + '，' : '') + said
  }
  rec.onerror = (e) => toast(`识别失败：${e.error}（可改用输入法语音输入）`)
  rec.onend = () => {
    VS.recording = false
    $('#btn-mic').textContent = '🎤 点一下说话'
    $('#btn-mic').classList.remove('recording')
  }
  VS.rec = rec
  try { rec.start() } catch (e) { toast('无法启动麦克风：' + e.message) }
}

async function doParse() {
  const text = $('#voice-text').value.trim()
  if (!text) return toast('先说一句，例如「东家自摸鸡胡，有鬼」')
  return busy($('#btn-parse'), '解析中…', async () => {
    try {
      const r = await api(`/api/rooms/${S.code}/parse`, { text })
      VS.parsed = r
      renderVoiceResult(r)
    } catch (e) {
      toast(e.message)
      $('#voice-result').classList.add('hidden')
    }
  })
}

function renderVoiceResult(r) {
  const box = $('#voice-result')
  const mode = r.mode === 'llm' ? 'LLM 解析' : '规则模式'
  const warn = r.warnings.length
    ? `<div class="voice-warn">⚠ ${r.warnings.map(escHtml).join('<br>⚠ ')}</div>` : ''
  const cells = scoreCells(r.detail.perPlayer, S.data?.dealer)
  box.innerHTML = `
    <div class="voice-mode">${mode} · 只抽取字段，分数由计分引擎计算</div>
    <div class="parse-lines">${r.notes.map((n) => `<div class="parse-line">${escHtml(n)}</div>`).join('')}</div>
    ${warn}
    <div class="section-title"><span>四家净分</span><span class="muted small">已过零和校验</span></div>
    <div class="score-board">${cells}</div>
    <div class="voice-row voice-actions">
      <button id="btn-voice-adjust" class="btn btn-outline" type="button">手动调整</button>
      <button id="btn-voice-confirm" class="btn btn-primary" type="button">确认落账</button>
    </div>`
  box.classList.remove('hidden')
  $('#btn-voice-adjust').onclick = fillFormFromParsed
  $('#btn-voice-confirm').onclick = confirmParsed
}

function fillFormFromParsed() {
  const r = VS.parsed
  if (!r) return
  const inp = r.input
  S.form = {
    winner: inp.winner,
    pattern: inp.pattern,
    hasGhost: inp.hasGhost,
    horses: Array.from({ length: horseMax(inp.hasGhost) }, (_, i) => inp.horses[i] || ''),
    gangEvents: [],
  }
  renderScoreForm()
  inp.gangEvents.forEach((g) => {
    addGang()
    const row = $$('#gang-list .gang-item').pop()
    row.querySelector('.g-type').value = g.type
    row.querySelector('.g-by').value = g.by
    const fromSel = row.querySelector('.g-from')
    fromSel.disabled = g.type !== 'dian'
    if (g.type === 'dian') fromSel.value = g.from
  })
  collectGang()
  $('#voice-result').classList.add('hidden')
  toast('已回填到下方表单，改完点「计算并预览」')
}

async function confirmParsed() {
  const r = VS.parsed
  if (!r) return
  return busy($('#btn-voice-confirm'), '落账中…', async () => {
    try {
      await api(`/api/rooms/${S.code}/events`, {
        ...r.input,
        author: seatLabel(S.identity),
      })
      VS.parsed = null
      $('#voice-result').classList.add('hidden')
      $('#voice-text').value = ''
      S.form = freshForm()
      renderScoreForm()
      await loadData()
      switchTab('board')
      toast('已记入账本')
    } catch (e) { toast(e.message) }
  })
}

/* ---------- 拍照认牌 ---------- */
/* 铁律：VLM 只出牌面草稿；易错项全部进核对弹窗；确认后才走 scoreRound */

function tileOptions(selected, emptyLabel) {
  const empty = emptyLabel != null ? `<option value="">${escHtml(emptyLabel)}</option>` : ''
  return empty + HORSE_TILES.map((t) =>
    `<option value="${t}" ${t === selected ? 'selected' : ''}>${t}</option>`).join('')
}

function chipBtn(label, on, attrs) {
  return `<button type="button" class="chip ${on ? 'active' : ''}" aria-pressed="${on}" ${attrs}>${escHtml(label)}</button>`
}

async function compressImage(file) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择照片')
  let bmp
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }) }
  catch { bmp = await createImageBitmap(file) }
  const max = 1600
  let w = bmp.width, h = bmp.height
  if (w > max || h > max) {
    const s = max / Math.max(w, h)
    w = Math.round(w * s)
    h = Math.round(h * s)
  }
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d').drawImage(bmp, 0, 0, w, h)
  if (bmp.close) bmp.close()
  return c.toDataURL('image/jpeg', 0.72)
}

async function onVisionFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  return busy($('#btn-vision'), '识别中…', async () => {
    try {
      const image = await compressImage(file)
      const r = await api(`/api/rooms/${S.code}/vision`, {
        image,
        photographer: S.identity,
      })
      if (r.detail || r.draft?.perPlayer) throw new Error('识别通道返回了分数，已拒绝')
      openVisionModal(r.draft)
    } catch (err) { toast(err.message) }
  })
}

function openVisionModal(draft) {
  Vision.draft = draft
  const n = horseMax(draft.hasGhost !== false)
  Vision.form = {
    winner: draft.winner || S.identity,
    hand: Array.isArray(draft.hand) ? draft.hand.slice() : [],
    melds: (draft.melds || []).map((m) => ({
      kind: m.kind || 'peng',
      tiles: (m.tiles || []).slice(),
      from: m.from || '',
    })),
    horses: Array.from({ length: n }, (_, i) => (draft.horses || [])[i] || ''),
    ghostTile: draft.ghostTile || '',
    hasGhost: draft.hasGhost !== false,
    special: draft.special || 'none',
    pattern: draft.pattern || '',
    extraGangs: [],
  }
  S.previewSource = 'vision'
  renderVisionForm()
  $('#vision-modal').classList.remove('hidden')
}

function renderVisionForm() {
  const f = Vision.form
  const d = Vision.draft
  if (!f) return
  $('#vision-desc').textContent = (d && (d.description || d.notes?.join('\n'))) || '（无文字描述）'
  const warns = d?.warnings || []
  const box = $('#vision-warn')
  box.innerHTML = warns.map((w) => `⚠ ${escHtml(w)}`).join('<br>')
  box.classList.toggle('hidden', !warns.length)

  const seatBtns = SEATS.map((s) =>
    `<button type="button" class="seat-btn ${f.winner === s ? 'active' : ''}" data-v-winner="${s}" aria-pressed="${f.winner === s}"><span class="seat-name">${escHtml(seatLabel(s))}</span><small>${SN[s]}家</small></button>`).join('')

  const handChips = f.hand.map((t, i) =>
    `<span class="tile-chip">${escHtml(t)}<button type="button" data-del-hand="${i}" aria-label="删除 ${escHtml(t)}">×</button></span>`).join('')

  const meldHtml = f.melds.map((m, i) => {
    const shown = (m.tiles || []).map((t, ti) => {
      const heng = d?.melds?.[i]?.orients?.[ti] === 'heng'
      return `<span class="${heng ? 'heng' : ''}">${escHtml(t)}${heng ? '(横)' : ''}</span>`
    }).join(' ')
    return `<div class="meld-card" data-meld="${i}">
      <div class="meld-tiles">${shown || '（无牌）'}</div>
      <div class="gang-item">
        <select class="g-type" data-meld-kind="${i}" aria-label="副露类型">
          <option value="peng" ${m.kind === 'peng' ? 'selected' : ''}>碰（不计分）</option>
          <option value="dian" ${m.kind === 'dian' ? 'selected' : ''}>点杠</option>
          <option value="bu" ${m.kind === 'bu' ? 'selected' : ''}>补杠</option>
          <option value="an" ${m.kind === 'an' ? 'selected' : ''}>暗杠</option>
        </select>
        <select class="g-from" data-meld-from="${i}" ${m.kind !== 'dian' ? 'disabled' : ''} aria-label="放杠者">
          <option value="">放杠者</option>
          ${SEATS.filter((s) => s !== f.winner).map((s) =>
            `<option value="${s}" ${m.from === s ? 'selected' : ''}>${escHtml(seatLabel(s))}放</option>`).join('')}
        </select>
        <button class="gang-del" type="button" data-del-meld="${i}" aria-label="删除这组副露">×</button>
      </div>
    </div>`
  }).join('') || `<p class="muted small">没有识别到副露。若有杠请点下方添加。</p>`

  const extraGang = (f.extraGangs || []).map((g, i) =>
    `<div class="gang-item">
      <select data-xg-type="${i}" aria-label="杠的类型">
        <option value="an" ${g.type === 'an' ? 'selected' : ''}>暗杠</option>
        <option value="bu" ${g.type === 'bu' ? 'selected' : ''}>补杠</option>
        <option value="dian" ${g.type === 'dian' ? 'selected' : ''}>点杠</option>
      </select>
      <select data-xg-by="${i}" aria-label="杠牌者">${SEATS.map((s) =>
        `<option value="${s}" ${g.by === s ? 'selected' : ''}>${escHtml(seatLabel(s))}</option>`).join('')}</select>
      <select data-xg-from="${i}" ${g.type !== 'dian' ? 'disabled' : ''} aria-label="放杠者">${SEATS.map((s) =>
        `<option value="${s}" ${g.from === s ? 'selected' : ''}>${escHtml(seatLabel(s))}放</option>`).join('')}</select>
      <button class="gang-del" type="button" data-del-xg="${i}" aria-label="删除这条杠">×</button>
    </div>`).join('')

  const nHorse = horseMax(f.hasGhost)
  f.horses = Array.from({ length: nHorse }, (_, i) => f.horses[i] || '')
  const horseHtml = `<div class="horse-row ${nHorse > 4 ? 'six' : ''}">${f.horses.map((v, i) =>
    `<select data-v-horse="${i}" aria-label="第 ${i + 1} 张马">${tileOptions(v, '未中')}</select>`).join('')}</div>`

  const ghostBtns = `
    <div class="seg" id="vision-ghost">
      <button type="button" data-v-ghost="true" class="${f.hasGhost ? 'active' : ''}" aria-pressed="${f.hasGhost}">有鬼</button>
      <button type="button" data-v-ghost="false" class="${!f.hasGhost ? 'active' : ''}" aria-pressed="${!f.hasGhost}">硬胡（无鬼 ×2）</button>
    </div>
    <label class="field" style="margin-top:8px"><span>本局鬼牌（翻牌+1，不知道可留空）</span>
      <select id="vision-ghost-tile">${tileOptions(f.ghostTile, '不知道 / 不填')}</select>
    </label>`

  const specialHtml = `<div class="chips">${SPECIALS.map((s) =>
    chipBtn(s.name, f.special === s.id, `data-v-special="${s.id}"`)).join('')}</div>`

  const patternHtml = (S.rules?.patterns || []).map((g) =>
    `<div class="pgroup">
      <div class="pgroup-head"><span>第 ${g.times} 档</span><b>有鬼 ${g.withGhost} / 硬胡 ${g.withoutGhost}</b></div>
      <div class="chips">${g.patterns.map((p) =>
        chipBtn(p, f.pattern === p, `data-v-pattern="${p}"`)).join('')}</div>
    </div>`).join('')

  $('#vision-form').innerHTML = `
    <div class="vision-block">
      <div class="section-title"><span>1 · 谁胡了</span><span class="vision-reason">默认拍照人</span></div>
      <div class="seat-grid">${seatBtns}</div>
    </div>
    <div class="vision-block">
      <div class="section-title"><span>2 · 手牌</span><span class="vision-reason">相同牌张数易错</span></div>
      <div class="tile-chips">${handChips}</div>
      <div class="tile-add">
        <select id="vision-add-hand">${tileOptions('', '＋ 加一张手牌')}</select>
      </div>
    </div>
    <div class="vision-block">
      <div class="section-title"><span>3 · 副露 / 杠</span><span class="vision-reason">横竖、点杠补杠暗杠易混</span></div>
      ${meldHtml}
      <div class="section-title"><span>其他人的杠</span></div>
      <div id="vision-extra-gangs">${extraGang}</div>
      <button id="btn-vision-add-gang" class="btn btn-outline btn-block" type="button">＋ 添加一条杠</button>
    </div>
    <div class="vision-block">
      <div class="section-title"><span>4 · 摸马</span><span class="vision-reason">马区可能划错行</span></div>
      ${horseHtml}
    </div>
    <div class="vision-block">
      <div class="section-title"><span>5 · 有无鬼</span><span class="vision-reason">鬼牌长得像普通牌</span></div>
      ${ghostBtns}
    </div>
    <div class="vision-block">
      <div class="section-title"><span>6 · 特殊胡</span><span class="vision-reason">牌面上没有这些信息</span></div>
      ${specialHtml}
    </div>
    <div class="vision-block">
      <div class="section-title"><span>7 · 胡法档位</span><span class="vision-reason">由牌面建议，请再核对</span></div>
      <div class="pattern-groups">${patternHtml}</div>
    </div>`

  bindVisionForm()
}

function bindVisionForm() {
  const f = Vision.form
  $$('#vision-form [data-v-winner]').forEach((b) => {
    b.onclick = () => { f.winner = b.dataset.vWinner; renderVisionForm() }
  })
  $$('#vision-form [data-del-hand]').forEach((b) => {
    b.onclick = () => { f.hand.splice(Number(b.dataset.delHand), 1); renderVisionForm() }
  })
  const addHand = $('#vision-add-hand')
  if (addHand) addHand.onchange = () => {
    if (!addHand.value) return
    f.hand.push(addHand.value)
    renderVisionForm()
  }
  $$('#vision-form [data-meld-kind]').forEach((sel) => {
    sel.onchange = () => {
      const m = f.melds[Number(sel.dataset.meldKind)]
      if (m) m.kind = sel.value
      renderVisionForm()
    }
  })
  $$('#vision-form [data-meld-from]').forEach((sel) => {
    sel.onchange = () => {
      const m = f.melds[Number(sel.dataset.meldFrom)]
      if (m) m.from = sel.value
    }
  })
  $$('#vision-form [data-del-meld]').forEach((b) => {
    b.onclick = () => { f.melds.splice(Number(b.dataset.delMeld), 1); renderVisionForm() }
  })
  const addG = $('#btn-vision-add-gang')
  if (addG) addG.onclick = () => {
    f.extraGangs.push({ type: 'an', by: f.winner || 'E', from: '' })
    renderVisionForm()
  }
  $$('#vision-form [data-xg-type]').forEach((sel) => {
    sel.onchange = () => {
      const g = f.extraGangs[Number(sel.dataset.xgType)]
      if (g) g.type = sel.value
      renderVisionForm()
    }
  })
  $$('#vision-form [data-xg-by]').forEach((sel) => {
    sel.onchange = () => {
      const g = f.extraGangs[Number(sel.dataset.xgBy)]
      if (g) g.by = sel.value
    }
  })
  $$('#vision-form [data-xg-from]').forEach((sel) => {
    sel.onchange = () => {
      const g = f.extraGangs[Number(sel.dataset.xgFrom)]
      if (g) g.from = sel.value
    }
  })
  $$('#vision-form [data-del-xg]').forEach((b) => {
    b.onclick = () => { f.extraGangs.splice(Number(b.dataset.delXg), 1); renderVisionForm() }
  })
  $$('#vision-form [data-v-horse]').forEach((sel) => {
    sel.onchange = () => { f.horses[Number(sel.dataset.vHorse)] = sel.value }
  })
  $$('#vision-form [data-v-ghost]').forEach((b) => {
    b.onclick = () => { f.hasGhost = b.dataset.vGhost === 'true'; renderVisionForm() }
  })
  const gt = $('#vision-ghost-tile')
  if (gt) gt.onchange = () => {
    f.ghostTile = gt.value
    if (f.ghostTile) f.hasGhost = f.hand.includes(f.ghostTile)
    renderVisionForm()
  }
  $$('#vision-form [data-v-special]').forEach((b) => {
    b.onclick = () => {
      f.special = b.dataset.vSpecial
      const hit = SPECIALS.find((s) => s.id === f.special)
      if (hit && hit.id !== 'none') f.pattern = hit.name
      renderVisionForm()
    }
  })
  $$('#vision-form [data-v-pattern]').forEach((b) => {
    b.onclick = () => { f.pattern = b.dataset.vPattern; renderVisionForm() }
  })
}

function collectVisionInput() {
  const f = Vision.form
  if (!f?.winner) throw new Error('请确认谁胡了')
  if (!f.pattern) throw new Error('请确认胡法档位')
  const gangEvents = []
  for (const m of f.melds) {
    if (m.kind === 'peng') continue
    if (!['dian', 'bu', 'an'].includes(m.kind)) continue
    const g = { type: m.kind, by: f.winner }
    if (m.kind === 'dian') {
      if (!m.from) throw new Error('点杠请选择放杠者')
      g.from = m.from
    }
    gangEvents.push(g)
  }
  for (const g of f.extraGangs) {
    if (g.type === 'dian' && !g.from) throw new Error('点杠请选择放杠者')
    const row = { type: g.type, by: g.by }
    if (g.type === 'dian') row.from = g.from
    gangEvents.push(row)
  }
  return {
    winner: f.winner,
    pattern: f.pattern,
    hasGhost: f.hasGhost,
    horses: f.horses.filter(Boolean),
    gangEvents,
  }
}

async function confirmVisionAndScore() {
  let input
  try { input = collectVisionInput() } catch (e) { return toast(e.message) }
  return busy($('#btn-vision-score'), '计算中…', async () => {
    try {
      const r = await api(`/api/rooms/${S.code}/preview`, input)
      S.preview = r
      S.previewSource = 'vision'
      $('#vision-modal').classList.add('hidden')
      showPreview(r.detail, r.input)
    } catch (e) { toast(e.message) }
  })
}

/* ---------- 事件绑定 ---------- */

function bind() {
  $('#btn-create').onclick = () => busy($('#btn-create'), '创建中…', async () => {
    const nicknames = $$('.nn').map((i) => i.value)
    try {
      const r = await api('/api/rooms', { name: $('#new-name').value, nicknames })
      await openRoom(r.code)
    } catch (e) { toast(e.message) }
  })
  $('#btn-join').onclick = () => busy($('#btn-join'), '加入中…', async () => {
    const code = $('#join-code').value.trim().toUpperCase()
    if (!code) return toast('请输入房间码')
    try { await openRoom(code) } catch (e) { toast(e.message) }
  })
  $('#join-code').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-join').click() }
  $('#btn-identity-back').onclick = () => {
    history.replaceState(null, '', homeUrl())
    S.code = null
    show('home')
  }

  $$('#tabbar button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab) })
  $('#btn-goto-score').onclick = () => switchTab('score')
  $('#btn-add-gang').onclick = addGang
  $('#btn-preview').onclick = doPreview
  $('#btn-preview-back').onclick = () => {
    $('#preview-modal').classList.add('hidden')
    if (S.previewSource === 'vision' && Vision.form) $('#vision-modal').classList.remove('hidden')
  }
  $('#btn-confirm').onclick = confirmScore
  $('#btn-edit-cancel').onclick = () => $('#edit-modal').classList.add('hidden')
  $('#btn-edit-save').onclick = saveEdit
  $('#btn-copy-link').onclick = () => copyText(location.href)
  $('#btn-copy-settle').onclick = () => copyText($('#settle-card').textContent)

  $('#btn-parse').onclick = doParse
  $('#btn-mic').onclick = toggleMic
  $('#btn-voice-settings').onclick = openLlmModal
  $('#btn-vision').onclick = () => {
    if (!Vision.cfg?.configured) {
      toast('请先在设置里填入通义千问 API Key')
      openLlmModal()
      return
    }
    $('#vision-file').click()
  }
  $('#vision-file').onchange = onVisionFile
  $('#btn-vision-retake').onclick = () => {
    $('#vision-modal').classList.add('hidden')
    $('#vision-file').value = ''
    $('#vision-file').click()
  }
  $('#btn-vision-score').onclick = confirmVisionAndScore
  $('#btn-llm-close').onclick = () => $('#llm-modal').classList.add('hidden')
  $('#btn-llm-save').onclick = () => saveLlm()
  $('#btn-llm-disable').onclick = () => saveLlm({ enabled: false })
  $('#btn-llm-test').onclick = testLlm
  $('#llm-provider').onchange = () => {
    const p = VS.llm?.presets?.[$('#llm-provider').value]
    if (p && p.baseUrl) {
      $('#llm-base').value = p.baseUrl
      $('#llm-model').value = p.model
    }
  }
  $('#voice-text').onkeydown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doParse()
  }
  // 空状态里的「去记第一局」用事件委托，避免每次重绘重新绑定
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-goto-score]')) switchTab('score')
  })
}

init()
