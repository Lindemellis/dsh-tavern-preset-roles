import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyPresetRoles } from './transform.js'

export const name = 'dsh-tavern-preset-roles'
export const inject = ['llm']

// dsh-tavern 的请求血缘标记（lib/domain/request-lineage.js）。复制请求时标记跟着走。
const HANDLED = Symbol.for('dsh-tavern.request-handled')
const PROJECTED = 'foreground-projection'
const FULL_TEMPLATE = 'full-template'
const OURS = 'preset-roles'

function handledBy(request, stage) {
  return request !== null && typeof request === 'object' && Array.isArray(request[HANDLED]) && request[HANDLED].includes(stage)
}

function mark(request, stage) {
  const previous = Array.isArray(request[HANDLED]) ? request[HANDLED] : []
  return { ...request, [HANDLED]: Object.freeze(previous.concat(stage)) }
}

export function apply(ctx, config = {}) {
  const tavernLib = String(config.tavernLib || '')
  const dataRoot = String(config.dataRoot || '')
  if (config.enabled === false) return
  if (!tavernLib || !dataRoot) {
    console.warn('dsh-tavern-preset-roles: 缺少 tavernLib / dataRoot 配置，插件不生效')
    return
  }
  const options = {
    phases: { front: config.front !== false, middle: config.middle !== false, back: config.back !== false },
    systemPosition: config.systemPosition
  }

  // 只读地复用 dsh-tavern 自己的模块：宏解析与原生对话存储，保证文本与它发出的一字不差。
  let modules = null
  async function load() {
    modules ??= Promise.all([
      import(pathToFileURL(path.join(tavernLib, 'domain', 'runtime-presets.js')).href),
      import(pathToFileURL(path.join(tavernLib, 'domain', 'native-conversation-storage.js')).href)
    ]).then(([presets, storage]) => ({
      resolve: presets.resolveRuntimePresetMacros,
      storage: storage.createNativeConversationStorage({ dataRoot })
    }))
    return await modules
  }

  const cache = new Map() // chatId -> { version, chat }
  async function chatForSession(sessionId) {
    const links = JSON.parse(await fs.readFile(path.join(dataRoot, 'sessions.json'), 'utf8'))
    const chatId = links[sessionId]
    if (!chatId) return null
    const { storage } = await load()
    const version = await storage.version(chatId)
    if (version === null) return null // 旧格式对话，不处理
    const cached = cache.get(chatId)
    if (cached && cached.version === version) return cached.chat
    const read = await storage.read(chatId)
    const chat = read?.chat
    if (!chat) return null
    // 只留需要的字段，不把整段聊天记录留在内存里。
    const slim = { mode: chat.mode, requestMode: chat.requestMode, cardName: chat.cardName, macroState: chat.macroState, runtimePresetSnapshot: chat.runtimePresetSnapshot }
    cache.set(chatId, { version, chat: slim })
    return slim
  }

  async function rewrite(request) {
    const chat = await chatForSession(String(request.sessionId || ''))
    if (!chat || !['story', 'script'].includes(chat.mode || 'story') || chat.requestMode === 'sillytavern') return null
    if (!chat.runtimePresetSnapshot) return null
    const { resolve } = await load()
    const snapshot = resolve(chat.runtimePresetSnapshot, { charName: chat.cardName, macroState: chat.macroState }).snapshot
    return applyPresetRoles(request, snapshot, options)
  }

  // prepend：排在 dsh-tavern 的钩子外层，在 full-template（EJS）渲染之前改写；
  // 之后 dsh-tavern 照常对改写结果做模板渲染、记录请求日志。
  ctx.on('llm/stream', (request, next) => {
    if (request?.purpose !== undefined || !request?.sessionId || !handledBy(request, PROJECTED) ||
      handledBy(request, OURS) || handledBy(request, FULL_TEMPLATE)) return next()
    return (async function * () {
      let result = null
      try { result = await rewrite(request) }
      catch (error) { console.warn('dsh-tavern-preset-roles: 改写失败，按原请求发送：', String(error?.message || error)) }
      if (result === null) { yield * next(); return }
      if (config.debug) console.info('dsh-tavern-preset-roles:', JSON.stringify(result.report))
      yield * ctx.llm.stream(mark(result.request, OURS))
    })()
  }, { global: true, prepend: true })
}
