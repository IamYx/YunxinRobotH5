import NIM from 'nim-web-sdk-ng/dist/v2/NIM_BROWSER_SDK'

export type LoginForm = {
  appkey: string
  accountId: string
  token: string
}

export type Robot = {
  accountId: string
  name: string
  color: string
}

export type ChatItem = {
  id: string
  role: 'user' | 'robot' | 'system'
  kind?: 'text' | 'file' | 'image'
  robotAccountId?: string
  robotName?: string
  text: string
  time: number
  status?: 'sending' | 'sent' | 'failed'
  fileName?: string
  fileUrl?: string
  fileSize?: number
  imageWidth?: number
  imageHeight?: number
}

export const DEFAULT_ROBOTS: Robot[] = [
  { accountId: 'robot001', name: '机器人一', color: '#4f46e5' },
  { accountId: 'robot002', name: '机器人二', color: '#0891b2' },
  { accountId: 'robot003', name: '机器人三', color: '#16a34a' }
]

let activeRobots: Robot[] = DEFAULT_ROBOTS

export function setActiveRobots(robots: Robot[]) {
  activeRobots = robots.filter((robot) => robot.accountId.trim())
}

let nim: any = null
let currentAccountId = ''

export function getCurrentAccountId() {
  return currentAccountId
}

export function getRobotByAccount(accountId = '') {
  return activeRobots.find((robot) => robot.accountId === accountId)
}

export function makeP2PConversationId(accountId: string) {
  const util = nim?.V2NIMConversationIdUtil
  if (util?.p2pConversationId) return util.p2pConversationId(accountId)
  return `${currentAccountId}|1|${accountId}`
}

function getPeerFromConversationId(conversationId = '') {
  const parts = conversationId.split('|')
  if (parts.length >= 3 && parts[1] === '1') {
    return parts[0] === currentAccountId ? parts[2] : parts[0]
  }
  return ''
}

function normalizeMessage(message: any): ChatItem | null {
  const conversationId = message?.conversationId || ''
  const senderId = message?.senderId || message?.from || message?.fromAccount || getPeerFromConversationId(conversationId)
  const receiverId = message?.receiverId || message?.to || message?.toAccount
  const peerId = senderId === currentAccountId ? (receiverId || getPeerFromConversationId(conversationId)) : senderId
  const robot = getRobotByAccount(peerId)
  if (!robot) return null

  const attachment = message?.attachment || message?.attach || message?.body?.attachment
  const messageType = message?.messageType ?? message?.type
  const isImage = messageType === 1 || Boolean(attachment?.url && attachment?.width && attachment?.height)
  const isFile = messageType === 6 || Boolean(attachment?.url && attachment?.name && !isImage)

  return {
    id: message?.messageClientId || message?.clientId || `${senderId}-${Date.now()}-${Math.random()}`,
    role: senderId === currentAccountId ? 'user' : 'robot',
    kind: isImage ? 'image' : isFile ? 'file' : 'text',
    robotAccountId: robot.accountId,
    robotName: robot.name,
    text: isImage ? (attachment?.name || '[图片]') : isFile ? (attachment?.name || '[文件]') : (message?.text || message?.body?.text || '[非文本消息]'),
    time: message?.createTime || message?.time || Date.now(),
    status: 'sent',
    fileName: attachment?.name,
    fileUrl: attachment?.url,
    fileSize: attachment?.size,
    imageWidth: attachment?.width,
    imageHeight: attachment?.height
  }
}

export async function login(form: LoginForm, callbacks: {
  onStatus?: (text: string) => void
  onMessage?: (items: ChatItem[]) => void
}) {
  const appkey = form.appkey.trim()
  const accountId = form.accountId.trim()
  const token = form.token.trim()
  if (!appkey || !accountId || !token) throw new Error('AppKey、账号、Token 都不能为空')

  currentAccountId = accountId
  nim = NIM.getInstance({
    appkey,
    apiVersion: 'v2',
    debugLevel: 'debug',
    enableV2CloudConversation: true
  }, {})

  nim.V2NIMLoginService.on('onLoginStatus', (status: any) => callbacks.onStatus?.(`登录状态：${status}`))
  nim.V2NIMLoginService.on('onConnectStatus', (status: any) => callbacks.onStatus?.(`连接状态：${status}`))
  nim.V2NIMLoginService.on('onLoginFailed', (error: any) => callbacks.onStatus?.(`登录失败：${error?.code || ''}`))
  nim.V2NIMLoginService.on('onKickedOffline', () => callbacks.onStatus?.('账号已被踢下线'))

  nim.V2NIMMessageService.on('onReceiveMessages', (messages: any[] = []) => {
    const list = messages.map(normalizeMessage).filter(Boolean) as ChatItem[]
    if (list.length > 0) callbacks.onMessage?.(list)
  })

  await nim.V2NIMLoginService.login(accountId, token, {
    forceMode: false,
    authType: 0,
    timeout: 45000,
    retryCount: 3
  })

  localStorage.setItem('yunxinRobotH5:lastLogin', JSON.stringify({ appkey, accountId, token }))
  callbacks.onStatus?.('已登录')
}

export async function logout() {
  if (!nim) return
  try {
    await nim.V2NIMLoginService.logout()
  } finally {
    nim = null
    currentAccountId = ''
    localStorage.removeItem('yunxinRobotH5:lastLogin')
  }
}

export async function fetchHistoryForRobots(robots: Robot[], limit = 50) {
  if (!nim) return []
  setActiveRobots(robots)
  const results = await Promise.allSettled(robots.filter((robot) => robot.accountId.trim()).map(async (robot) => {
    const conversationId = makeP2PConversationId(robot.accountId.trim())
    const result = await nim.V2NIMMessageService.getMessageListEx({
      conversationId,
      limit,
      direction: 0
    })
    const rawMessages = Array.isArray(result) ? result : result?.messages || result?.messageList || []
    return rawMessages.map(normalizeMessage).filter(Boolean) as ChatItem[]
  }))

  const list = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  const byId = new Map<string, ChatItem>()
  list.forEach((item) => byId.set(item.id, item))
  return dedupeOutgoingMessages(Array.from(byId.values()).sort((a, b) => a.time - b.time))
}

function dedupeOutgoingMessages(messages: ChatItem[]) {
  const kept: ChatItem[] = []
  messages.forEach((message) => {
    if (message.role !== 'user') {
      kept.push(message)
      return
    }

    const duplicate = kept.some((item) => {
      if (item.role !== 'user') return false
      const closeTime = Math.abs(item.time - message.time) <= 5000
      const sameContent = item.kind === message.kind
        && item.text === message.text
        && (item.fileName || '') === (message.fileName || '')
        && (item.fileSize || 0) === (message.fileSize || 0)
      return closeTime && sameContent
    })

    if (!duplicate) kept.push(message)
  })
  return kept
}

export async function sendTextToRobots(text: string, robots: Robot[]) {
  if (!nim) throw new Error('请先登录')
  const content = text.trim()
  const targetRobots = robots.filter((robot) => robot.accountId.trim())
  if (!content || targetRobots.length === 0) return []

  setActiveRobots(targetRobots)
  const results: PromiseSettledResult<Robot>[] = []
  for (const robot of targetRobots) {
    try {
      const message = nim.V2NIMMessageCreator.createTextMessage(content)
      const conversationId = makeP2PConversationId(robot.accountId.trim())
      await nim.V2NIMMessageService.sendMessage(message, conversationId)
      results.push({ status: 'fulfilled', value: robot })
    } catch (reason) {
      results.push({ status: 'rejected', reason })
    }
  }

  return results
}

export type SendFileResult = {
  robot: Robot
  message: any
  attachment?: any
  url?: string
}

export async function sendFileToRobots(file: File, robots: Robot[]) {
  if (!nim) throw new Error('请先登录')
  const targetRobots = robots.filter((robot) => robot.accountId.trim())
  if (!file || targetRobots.length === 0) return []

  setActiveRobots(targetRobots)
  const isImage = file.type.startsWith('image/')
  const results: PromiseSettledResult<SendFileResult>[] = []
  for (const robot of targetRobots) {
    try {
      const message = isImage
        ? nim.V2NIMMessageCreator.createImageMessage(file, file.name)
        : nim.V2NIMMessageCreator.createFileMessage(file, file.name)
      const conversationId = makeP2PConversationId(robot.accountId.trim())
      const result = await nim.V2NIMMessageService.sendMessage(message, conversationId)
      const sentMessage = result?.message || result || message
      const attachment = sentMessage?.attachment || sentMessage?.attach || sentMessage?.body?.attachment
      results.push({ status: 'fulfilled', value: { robot, message: sentMessage, attachment, url: attachment?.url } })
    } catch (reason) {
      results.push({ status: 'rejected', reason })
    }
  }

  return results
}

export function formatFileSize(size?: number) {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
