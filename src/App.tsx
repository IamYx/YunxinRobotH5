import { ClipboardEvent, FormEvent, useEffect, useRef, useState } from 'react'
import { ChatItem, DEFAULT_ROBOTS, LoginForm, Robot, fetchHistoryForRobots, formatFileSize, getCurrentAccountId, login, logout, sendFileToRobots, sendTextToRobots, setActiveRobots } from './nim'
import './styles.css'

const emptyForm: LoginForm = { appkey: '', accountId: '', token: '' }
const inputPlaceholder = '输入 @ 选择机器人；Enter 换行，Shift + Enter 发送'

function formatTime(time: number) {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getMentionedRobots(text: string, robots: Robot[]) {
  const validRobots = robots.filter((robot) => robot.accountId.trim())
  return validRobots.filter((robot) => {
    const names = [robot.name, robot.accountId].filter(Boolean).map((item) => escapeRegExp(item.trim()))
    return names.some((name) => new RegExp(`@${name}(?=\\s|$|[，,。.!！?？:：;；])`).test(text))
  })
}

function pickMentionedRobots(text: string, robots: Robot[]) {
  const validRobots = robots.filter((robot) => robot.accountId.trim())
  const mentioned = getMentionedRobots(text, robots)
  return mentioned.length > 0 ? mentioned : validRobots
}

function makeMentionPrefix(robots: Robot[]) {
  return robots.map((robot) => `@${robot.name || robot.accountId}`).join(' ') + (robots.length > 0 ? ' ' : '')
}

function isSameMessage(a: ChatItem, b: ChatItem) {
  if (a.id && b.id && a.id === b.id) return true
  if (a.role !== b.role) return false
  if (a.robotAccountId !== b.robotAccountId) return false
  if ((a.kind || 'text') !== (b.kind || 'text')) return false
  if (a.text !== b.text) return false
  if ((a.fileName || '') !== (b.fileName || '')) return false
  if ((a.fileSize || 0) !== (b.fileSize || 0)) return false
  return Math.abs(a.time - b.time) <= 5000
}

function mergeMessages(oldMessages: ChatItem[], incoming: ChatItem[]) {
  const merged = [...oldMessages]
  incoming.forEach((message) => {
    const index = merged.findIndex((item) => isSameMessage(item, message))
    if (index >= 0) {
      merged[index] = { ...merged[index], ...message, status: message.status || merged[index].status }
    } else {
      merged.push(message)
    }
  })
  return merged
}

export default function App() {
  const [form, setForm] = useState<LoginForm>(emptyForm)
  const [loggedIn, setLoggedIn] = useState(false)
  const [status, setStatus] = useState('未登录')
  const [messages, setMessages] = useState<ChatItem[]>([])
  const [draft, setDraft] = useState('')
  const [robots, setRobots] = useState<Robot[]>(DEFAULT_ROBOTS)
  const [loading, setLoading] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [waitingReply, setWaitingReply] = useState(false)
  const [configOpen, setConfigOpen] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem('yunxinRobotH5:lastLogin')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        setForm({ appkey: parsed.appkey || '', accountId: parsed.accountId || '', token: parsed.token || '' })
      } catch {
        // ignore
      }
    }

    const savedRobots = localStorage.getItem('yunxinRobotH5:robots')
    if (savedRobots) {
      try {
        const parsedRobots = JSON.parse(savedRobots)
        if (Array.isArray(parsedRobots) && parsedRobots.length > 0) {
          setRobots(parsedRobots)
          setActiveRobots(parsedRobots)
        }
      } catch {
        // ignore
      }
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const textarea = inputRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror) return

    mirror.textContent = draft || inputPlaceholder
    const maxHeight = Math.min(window.innerHeight * 0.34, 220)
    const nextHeight = Math.min(Math.max(mirror.scrollHeight, 48), maxHeight)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = mirror.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [draft, loggedIn])

  const robotSummary = robots
    .filter((robot) => robot.accountId.trim())
    .map((robot) => `${robot.name || robot.accountId}（${robot.accountId}）`)
    .join('、')

  const displayedMessages = [...messages].sort((a, b) => a.time - b.time)

  async function handleLogin(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setStatus('登录中...')
    try {
      await login(form, {
        onStatus: setStatus,
        onMessage: (items) => {
          setMessages((old) => mergeMessages(old, items))
          setWaitingReply(false)
        }
      })
      setLoggedIn(true)
      setStatus('正在加载历史消息...')
      const history = await fetchHistoryForRobots(robots.filter((robot) => robot.accountId.trim()), 50)
      setMessages(history.length > 0
        ? mergeMessages([], history)
        : [{ id: `sys-${Date.now()}`, role: 'system', text: '登录成功，暂无历史消息。现在输入一条消息即可开始聊天。', time: Date.now() }]
      )
      setStatus('已登录')
      setConfigOpen(false)
    } catch (error: any) {
      setStatus(error?.message || `登录失败：${error?.code || '未知错误'}`)
    } finally {
      setLoading(false)
    }
  }

  async function handleLogout() {
    setLoading(true)
    await logout()
    setLoggedIn(false)
    setMessages([])
    setWaitingReply(false)
    setConfigOpen(true)
    setStatus('未登录')
    setLoading(false)
  }

  function getTargetRobotsByDraft() {
    return pickMentionedRobots(draft, robots)
  }

  async function handleSend(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || loading) return

    const now = Date.now()
    const userMessage: ChatItem = {
      id: `user-${now}`,
      role: 'user',
      text,
      time: now,
      status: 'sending'
    }
    const mentionedRobots = getMentionedRobots(text, robots)
    const nextDraft = makeMentionPrefix(mentionedRobots)
    setMessages((old) => [...old, userMessage])
    setDraft(nextDraft)
    setLoading(true)
    setWaitingReply(true)

    try {
      const targetRobots = mentionedRobots.length > 0 ? mentionedRobots : robots.filter((robot) => robot.accountId.trim())
      const isMentionSend = mentionedRobots.length > 0
      const results = await sendTextToRobots(text, targetRobots)
      const failed = results.filter((item) => item.status === 'rejected')
      const success = results.filter((item) => item.status === 'fulfilled')
      const allFailed = targetRobots.length > 0 && success.length === 0
      setMessages((old) => old.map((item) => item.id === userMessage.id ? { ...item, status: allFailed ? 'failed' : 'sent' } : item))
      const targetText = targetRobots.map((robot) => robot.name || robot.accountId).join('、')
      setStatus(failed.length ? `发送完成，目标：${targetText}，成功 ${success.length} 个，失败 ${failed.length} 个` : `${isMentionSend ? '已单独发送给' : '已分别发送给'} ${targetText}`)
    } catch (error: any) {
      setMessages((old) => old.map((item) => item.id === userMessage.id ? { ...item, status: 'failed' } : item))
      setStatus(error?.message || '发送失败')
      setWaitingReply(false)
    } finally {
      setLoading(false)
    }
  }

  async function handleFileChange(file?: File) {
    if (!file || loading) return
    const mentionedRobots = getMentionedRobots(draft, robots)
    const targetRobots = mentionedRobots.length > 0 ? mentionedRobots : getTargetRobotsByDraft()
    const now = Date.now()
    const isImage = file.type.startsWith('image/')
    const localPreviewUrl = isImage ? URL.createObjectURL(file) : undefined
    const userMessage: ChatItem = {
      id: `file-${now}`,
      role: 'user',
      kind: isImage ? 'image' : 'file',
      text: file.name,
      fileName: file.name,
      fileUrl: localPreviewUrl,
      fileSize: file.size,
      time: now,
      status: 'sending'
    }
    setMessages((old) => [...old, userMessage])
    setDraft(makeMentionPrefix(mentionedRobots))
    setLoading(true)
    setWaitingReply(true)

    try {
      const results = await sendFileToRobots(file, targetRobots)
      const failed = results.filter((item) => item.status === 'rejected')
      const success = results.filter((item) => item.status === 'fulfilled')
      const allFailed = targetRobots.length > 0 && success.length === 0
      const targetText = targetRobots.map((robot) => robot.name || robot.accountId).join('、')
      setMessages((old) => old.map((item) => item.id === userMessage.id ? { ...item, status: allFailed ? 'failed' : 'sent' } : item))
      setStatus(failed.length
        ? `文件发送完成，目标：${targetText}，成功 ${success.length} 个，失败 ${failed.length} 个`
        : `文件已发送给 ${targetText}`)
    } catch (error: any) {
      setMessages((old) => old.map((item) => item.id === userMessage.id ? { ...item, status: 'failed' } : item))
      setStatus(error?.message || '文件发送失败')
      setWaitingReply(false)
    } finally {
      setLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function handleDraftChange(value: string) {
    setDraft(value)
    setMentionOpen(value.endsWith('@'))
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (!imageItem) return
    const file = imageItem.getAsFile()
    if (!file) return
    event.preventDefault()
    const ext = file.type.split('/')[1] || 'png'
    const namedFile = new File([file], file.name || `paste-image-${Date.now()}.${ext}`, { type: file.type })
    void handleFileChange(namedFile)
  }

  function insertMention(robot: Robot) {
    const mention = `@${robot.name || robot.accountId} `
    const next = draft.endsWith('@') ? `${draft.slice(0, -1)}${mention}` : `${draft}${draft.endsWith(' ') || !draft ? '' : ' '}${mention}`
    setDraft(next)
    setMentionOpen(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  function updateRobot(index: number, patch: Partial<Robot>) {
    const next = robots.map((robot, idx) => idx === index ? { ...robot, ...patch } : robot)
    setRobots(next)
    setActiveRobots(next)
    localStorage.setItem('yunxinRobotH5:robots', JSON.stringify(next))
  }

  function resetRobots() {
    setRobots(DEFAULT_ROBOTS)
    setActiveRobots(DEFAULT_ROBOTS)
    localStorage.setItem('yunxinRobotH5:robots', JSON.stringify(DEFAULT_ROBOTS))
  }

  return (
    <main className="page">
      {loggedIn && !configOpen && <button type="button" className="configToggle" onClick={() => setConfigOpen(true)}>配置</button>}

      {configOpen && loggedIn && <button type="button" className="configMask" aria-label="关闭配置" onClick={() => setConfigOpen(false)} />}

      <section className={`panel sidebar ${configOpen ? 'configOpen' : 'configClosed'}`}>
        <div className="brand">
          <div className="logo">YX</div>
          <div>
            <h1>云信三机器人 H5</h1>
            <p>Web SDK V10 / 点对点文本消息</p>
          </div>
        </div>

        {!loggedIn ? (
          <form className="loginForm" onSubmit={handleLogin}>
            <label>
              <span>AppKey</span>
              <input value={form.appkey} onChange={(e) => setForm({ ...form, appkey: e.target.value })} placeholder="请输入云信 AppKey" />
            </label>
            <label>
              <span>登录账号 accid</span>
              <input value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} placeholder="例如 user001" />
            </label>
            <label>
              <span>静态 Token</span>
              <input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="账号对应 token" />
            </label>
            <button disabled={loading}>{loading ? '登录中...' : '登录'}</button>
          </form>
        ) : (
          <div className="accountBox">
            <span>当前账号</span>
            <strong>{getCurrentAccountId()}</strong>
            <button onClick={handleLogout} disabled={loading}>退出登录</button>
            <button type="button" className="mobileOnly ghostButton" onClick={() => setConfigOpen(false)}>收起</button>
          </div>
        )}

        <div className="statusBox">{status}</div>

        <div className="robots">
          <div className="robotsTitle">
            <h2>机器人账号</h2>
            <button type="button" className="ghostButton" onClick={resetRobots}>重置</button>
          </div>
          {robots.map((robot, index) => (
            <div className="robotEditor" key={index}>
              <i style={{ background: robot.color }} />
              <input value={robot.name} onChange={(e) => updateRobot(index, { name: e.target.value })} placeholder={`机器人${index + 1}名称`} />
              <input value={robot.accountId} onChange={(e) => updateRobot(index, { accountId: e.target.value })} placeholder={`机器人${index + 1}账号`} />
            </div>
          ))}
        </div>
      </section>

      <section className="panel chat">
        <header className="chatHeader">
          <div>
            <h2>聚合聊天窗口</h2>
            <p>未 @ 时消息会分别投递给 {robotSummary || '已配置的机器人'}；输入 @机器人名称 或 @机器人账号 时，只会单独发给被 @ 的机器人。</p>
          </div>
        </header>

        <div className="messageList">
          {displayedMessages.length === 0 && <div className="empty">登录后开始聊天</div>}
          {displayedMessages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              {message.role === 'robot' && <div className="avatar">{message.robotName?.slice(-1) || '机'}</div>}
              <div className="bubble">
                <div className="meta">
                  <strong>{message.role === 'user' ? '我' : message.role === 'system' ? '系统' : `${message.robotName}（${message.robotAccountId}）`}</strong>
                  <span>{formatTime(message.time)}</span>
                </div>
                {message.kind === 'image' ? (
                  <a className="imageCard" href={message.fileUrl || '#'} target="_blank" rel="noreferrer" onClick={(event) => { if (!message.fileUrl) event.preventDefault() }}>
                    {message.fileUrl ? <img src={message.fileUrl} alt={message.fileName || message.text || '图片'} /> : <span className="imagePlaceholder">图片上传中</span>}
                    <em>{message.fileName || message.text}</em>
                  </a>
                ) : message.kind === 'file' ? (
                  <a className="fileCard" href={message.fileUrl || '#'} target="_blank" rel="noreferrer" onClick={(event) => { if (!message.fileUrl) event.preventDefault() }}>
                    <span className="fileIcon">FILE</span>
                    <span>
                      <strong>{message.fileName || message.text || '文件消息'}</strong>
                      <em>{formatFileSize(message.fileSize)}</em>
                    </span>
                  </a>
                ) : (
                  <p>{message.text}</p>
                )}
                {message.status && <em>{message.status === 'sending' ? '发送中' : message.status === 'failed' ? '发送失败' : '已发送'}</em>}
              </div>
            </article>
          ))}
          <div ref={bottomRef} />
        </div>

        <form className="composer" onSubmit={handleSend}>
          {waitingReply && (
            <div className="replyLoading">
              <span className="loadingAvatar">AI</span>
              <strong>机器人正在回复</strong>
              <i />
              <i />
              <i />
            </div>
          )}
          {mentionOpen && (
            <div className="mentionPicker">
              {robots.filter((robot) => robot.accountId.trim()).map((robot) => (
                <button type="button" key={robot.accountId} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(robot)}>
                  <i style={{ background: robot.color }} />
                  <span>{robot.name || robot.accountId}</span>
                  <em>{robot.accountId}</em>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="fileButton" disabled={!loggedIn || loading} onClick={() => fileInputRef.current?.click()}>文件</button>
          <div ref={mirrorRef} className="textareaMirror" aria-hidden="true" />
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onPaste={handlePaste}
            onFocus={() => setMentionOpen(draft.endsWith('@'))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMentionOpen(false)
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                if (!loading && draft.trim()) void handleSend(e)
              }
            }}
            disabled={!loggedIn || loading}
            placeholder={loggedIn ? inputPlaceholder : '请先登录'}
          />
          <input ref={fileInputRef} className="hiddenFileInput" type="file" onChange={(e) => handleFileChange(e.target.files?.[0])} />
          <button disabled={!loggedIn || loading || !draft.trim()}>发送</button>
        </form>
      </section>
    </main>
  )
}
