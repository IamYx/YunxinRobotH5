# 云信三机器人聊天 H5

基于云信 Web SDK V10 的 H5 示例：登录用户在一个聚合聊天窗口发消息，每条消息会分别发送给 3 个固定机器人账号，三个机器人点对点回复后统一展示在窗口中。

## 机器人账号

页面左侧支持直接编辑 3 个机器人账号和名称，配置会保存到浏览器 `localStorage`。

默认值写在 `src/nim.ts`：

- `robot001`：机器人一
- `robot002`：机器人二
- `robot003`：机器人三

## 运行

```bash
npm install
npm run dev
```

浏览器访问终端输出的地址，输入：

- AppKey
- 登录用户 accid
- 登录用户静态 Token

## 构建

```bash
npm run build
```

构建产物在 `dist/`。

## 说明

1. 本项目只实现前端 H5，不包含服务端注册账号、生成 Token、机器人业务逻辑。
2. 三个机器人账号需要在云信侧已创建，并且具备自动回复能力，或者由你的服务端/机器人进程使用对应账号登录后监听并回复消息。
3. 发送使用 `V2NIMMessageCreator.createTextMessage` 构造文本消息，使用 `V2NIMMessageService.sendMessage(message, conversationId)` 发送点对点消息。
4. 接收使用 `V2NIMMessageService.on('onReceiveMessages', callback)` 监听机器人回复。
