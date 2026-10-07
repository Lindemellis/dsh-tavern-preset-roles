import { randomUUID } from 'node:crypto'

// DSH Tavern 把运行时预设分成前/中/后三段，并且固定角色：
//   前段 → 拼进原生 system 消息；中段 → 本轮 foreground-frame 里的写作规则；后段 → user。
// 这里把每段条目从原位置剪出来，按预设里写的 role 重新作为独立消息放回：
//   前段放在原生 system 的位置（DSH 自己的 system 材料按 systemPosition 放在前或后），
//   中段按条目的 injection_depth 插进对话，后段按顺序追加在末尾。
// 任何一处对不上就返回 null，调用方原样放行，不让请求失败。

const NATIVE_SYSTEM_PLUGIN = '@deepseek-ai/dsh-system-prompt'
const PLUGIN = 'dsh-tavern-preset-roles'
const DEFAULT_DEPTH = 4

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.map(block => block?.type === 'text' ? str(block.text) : '').join('')
}

function textOnly(message) {
  return Array.isArray(message?.content) && message.content.length > 0 &&
    message.content.every(block => block?.type === 'text' || block?.type === 'reasoning')
}

function withText(message, text, sectionName) {
  const others = Array.isArray(message.content) ? message.content.filter(block => block?.type === 'reasoning') : []
  return {
    ...message,
    content: [...others, { type: 'text', text }],
    source: { ...message.source, sections: text ? [{ name: sectionName, text }] : [] }
  }
}

function role(value) {
  return value === 'user' || value === 'assistant' ? value : 'system'
}

// 依次在 body 里找到每段文本并剪掉，返回剩余部分；有一段找不到就返回 null。
function cutAll(body, texts, separator = '\n\n') {
  const pieces = []
  let cursor = 0
  for (const text of texts) {
    const index = body.indexOf(text, cursor)
    if (index < 0) return null
    pieces.push(body.slice(cursor, index))
    cursor = index + text.length
  }
  pieces.push(body.slice(cursor))
  return pieces.map(piece => piece.replace(/^\n+|\n+$/g, '')).filter(Boolean).join(separator)
}

function cutLast(body, text) {
  const index = body.lastIndexOf(text)
  if (index < 0) return null
  return (body.slice(0, index).replace(/\n+$/, '') + '\n\n' + body.slice(index + text.length).replace(/^\n+/, '')).replace(/^\n+|\n+$/g, '')
}

function presetMessage(entry, phase, text, request) {
  const messageRole = role(entry.role)
  const reasoning = messageRole === 'assistant' && needsReasoningCarrier(request) ? [{ type: 'reasoning', text: ' ' }] : []
  return {
    id: PLUGIN + '-' + phase + '-' + randomUUID(),
    role: messageRole,
    content: [...reasoning, { type: 'text', text }],
    source: {
      kind: 'plugin', plugin: PLUGIN, form: 'preset-role',
      sections: [{ name: 'tavern:runtime-preset-' + phase, text }],
      entryId: str(entry.id || entry.entryKey), entryName: str(entry.name)
    }
  }
}

// 和 dsh-tavern 的 projectDeepSeekThinkingPassback 一致：DeepSeek 思考模式要求每条
// assistant 历史都带 reasoning_content，没有真实思考内容时用一个空白占位。
function needsReasoningCarrier(request) {
  return /^deepseek(?:-|$)/i.test(str(request?.provider)) && str(request?.reasoningEffort) !== 'off'
}

function isChatMessage(message) {
  return (message.role === 'user' && message.source?.kind === 'user') ||
    (message.role === 'assistant' && message.source?.kind === 'model')
}

function depthOf(entry, compatibilityEntries) {
  const source = compatibilityEntries.find(item => item && (item.entryKey === entry.id || (entry.source?.identifier && item.identifier === entry.source.identifier)))
  const depth = Number(source?.injectionDepth)
  return Number.isFinite(depth) && depth >= 0 ? depth : DEFAULT_DEPTH
}

/**
 * @param request   llm/stream 收到的、已经被 dsh-tavern 投影过的前台请求
 * @param snapshot  已解析宏的运行时预设快照（front/middle/back 各有 entries，条目带 role）
 * @param options   { phases: { front, middle, back }, systemPosition: 'after-front' | 'first' }
 * @returns { request, report } 或 null（结构对不上，原样放行）
 */
export function applyPresetRoles(request, snapshot, options = {}) {
  if (!request || !Array.isArray(request.messages) || !snapshot) return null
  const phases = { front: true, middle: true, back: true, ...(options.phases || {}) }
  const systemPosition = options.systemPosition === 'first' ? 'first' : 'after-front'
  const entriesOf = phase => (Array.isArray(snapshot[phase]?.entries) ? snapshot[phase].entries : [])
    .filter(entry => str(entry?.content).trim() !== '')
  const front = phases.front ? entriesOf('front') : []
  const middle = phases.middle ? entriesOf('middle') : []
  const back = phases.back ? entriesOf('back') : []
  if (front.length + middle.length + back.length === 0) return null

  let messages = request.messages.slice()
  let next = { ...request }
  const report = { front: 0, middle: 0, back: 0, skipped: [] }

  // 少数路径把 system 放在 request.system 上；统一成原生 system 消息再处理。
  if (typeof next.system === 'string' && next.system !== '' && !messages.some(m => m.role === 'system' && m.source?.plugin === NATIVE_SYSTEM_PLUGIN)) {
    messages.unshift({ role: 'system', content: [{ type: 'text', text: next.system }], source: { kind: 'plugin', plugin: NATIVE_SYSTEM_PLUGIN } })
    delete next.system
  }

  // ---------- 前段 ----------
  if (front.length > 0) {
    const index = messages.findIndex(m => m?.role === 'system' && m.source?.kind === 'plugin' && m.source.plugin === NATIVE_SYSTEM_PLUGIN)
    if (index < 0 || !textOnly(messages[index])) return null
    const remainder = cutAll(textOf(messages[index]), front.map(entry => str(entry.content)))
    if (remainder === null) return null
    const native = remainder ? [withText(messages[index], remainder, 'tavern:dsh-system')] : []
    const presetMessages = front.map(entry => presetMessage(entry, 'front', str(entry.content), request))
    const block = systemPosition === 'first' ? native.concat(presetMessages) : presetMessages.concat(native)
    messages.splice(index, 1, ...block)
    report.front = front.length
  }

  // ---------- 后段（先处理，避免中段插入改变末尾位置） ----------
  const backMessages = []
  for (const entry of back.slice().reverse()) {
    const text = str(entry.content)
    let found = false
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role !== 'user' || !textOnly(message) || !textOf(message).includes(text)) continue
      const rest = cutLast(textOf(message), text)
      if (rest === null) continue
      if (rest) messages[i] = withText(message, rest, 'tavern:preset-roles:remaining')
      else messages.splice(i, 1)
      found = true
      break
    }
    if (!found) { report.skipped.push('back:' + str(entry.id)); continue }
    backMessages.unshift(presetMessage(entry, 'back', text, request))
    report.back += 1
  }

  // ---------- 中段 ----------
  const compatibilityEntries = Array.isArray(snapshot.compatibilityPreset?.entries) ? snapshot.compatibilityPreset.entries : []
  const inserts = []
  for (const [order, entry] of middle.entries()) {
    const text = str(entry.content).trim()
    const frameIndex = messages.findIndex(m => m.role === 'user' && m.source?.form === 'foreground-frame' && textOnly(m) && textOf(m).includes(text))
    if (frameIndex < 0) { report.skipped.push('middle:' + str(entry.id)); continue }
    const rest = cutAll(textOf(messages[frameIndex]), [text])
    if (rest === null) { report.skipped.push('middle:' + str(entry.id)); continue }
    if (rest) messages[frameIndex] = withText(messages[frameIndex], rest, 'tavern:foreground:remaining')
    else messages.splice(frameIndex, 1)
    inserts.push({ order, depth: depthOf(entry, compatibilityEntries), message: presetMessage(entry, 'middle', text, request) })
    report.middle += 1
  }
  // 与 SillyTavern 一致：深的先插，同深度按原顺序。depth N = 插在倒数第 N 条对话消息之前。
  inserts.sort((a, b) => b.depth - a.depth || a.order - b.order)
  for (const item of inserts) {
    const chatIndices = messages.map((m, i) => isChatMessage(m) ? i : -1).filter(i => i >= 0)
    let at
    if (item.depth === 0 || chatIndices.length === 0) at = messages.length
    else at = chatIndices[Math.max(0, chatIndices.length - item.depth)]
    messages.splice(at, 0, item.message)
  }

  messages = messages.concat(backMessages)
  if (report.front + report.middle + report.back === 0) return null
  next.messages = messages
  return { request: next, report }
}
