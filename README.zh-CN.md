# Claude Telegram Bridge

[English](README.md) | **简体中文**

这是一个小型、自托管的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Telegram 接口。它接收一名白名单用户在私聊中发送的文本，在主机上运行 Claude Code，并把结果返回 Telegram。

## 为什么不用 Claude 官方 Telegram 通道？

Claude 官方 Telegram 通道目前没有提供本项目实现的完整远程工作体验。本项目正是在实际测试并确认这些限制后开发的，并不是另一个简单的文本转发器。

| 能力 | 官方通道 | 本项目 |
| --- | --- | --- |
| 适配 Telegram 的 Markdown 渲染 | 没有形成可靠、完整的消息投递处理链 | 将回复转换成 MarkdownV2，自动拆分长消息，失败时回退为纯文本 |
| 将 Claude 的提问显示为 Telegram 按钮 | 不支持 | 将结构化问题转换成 2–8 个选项按钮，并把选择结果送回同一会话 |
| 在 Telegram 中远程审批工具权限 | 不支持 Telegram 原生审批控件 | Claude 请求权限时显示**仅允许本次**、**当前任务/始终允许**和**拒绝**按钮 |
| Claude 忙碌时连续发送多条消息 | 没有应用层持久化任务队列 | 将消息写入持久化 FIFO 队列，严格逐个安全执行 |
| 显示进度但不留下大量临时消息 | 没有同等的自动生命周期管理 | 显示简短工具进度，最终回答完成后自动删除状态和进度消息 |
| 重启后恢复会话与任务 | 没有同等的 Bridge 状态管理 | 持久保存 Claude 会话、Telegram 偏移量、任务队列、待选项和相关元数据 |

简单来说，本项目不是只做消息转发，而是把 Telegram 变成一个具备交互、授权、排队、进度反馈和生命周期管理能力的 Claude Code 远程客户端。

## 功能

- 通过 Telegram 数字用户 ID 强制实施私聊、单用户访问
- 持久化的顺序任务队列和一个可恢复的 Claude 对话
- 为工具调用发送简短进度消息，并在最终答复后删除
- 使用 Telegram 按钮处理工具授权和有限选项问题
- 拆分长回复以符合 Telegram 限制，转换 MarkdownV2，失败时回退为纯文本
- 重启后保留更新偏移量、队列、选项和 Claude 会话
- 提供 `/new`、`/status` 和 `/cancel` 控制命令
- 不访问网络的 dry-run 冒烟测试

本项目只支持文本消息，**不支持**附件、照片、群组或多用户。

## 工作原理

```text
你的 Telegram 私聊
  → Telegram Bot API 长轮询（getUpdates）
  → 检查发送者 ID 和私聊 ID
  → 持久化 FIFO 队列
  → Claude Agent SDK / 本机 Claude Code 可执行文件
  → 必要时显示授权或选项按钮
  → 拆分并格式化 Telegram 回复
```

同一时间只运行一个任务，新文本追加到队列。首个任务创建 Claude 会话，后续任务会恢复该会话，直到 `/new` 到达队首。机器人保存 Telegram 更新偏移量，因此重启后通常不会再次处理已确认的更新。

## 安全警告与威胁模型

**这个桥接程序相当于可远程执行命令的主机入口，并不是沙箱。** Claude Code 可以读取和修改文件、执行命令，并使用桥接进程能够访问的凭据。Telegram 身份校验降低了提交任务的人员范围，授权提示降低了误操作风险，但两者都无法隔离被盗的 Telegram 账户、泄露的机器人令牌、恶意提示词、恶意依赖或误批准的命令。

- 使用专用机器人。建议使用专用操作系统用户和隔离的机器/容器，只开放必要文件和凭据。
- 将 `CLAUDE_WORKDIR` 限制在尽可能小的范围。不要以管理员身份运行，也不要暴露敏感的主目录。
- 妥善保护 `.env`、日志、备份和状态目录。令牌泄露后应立即通过 BotFather 撤销并更换。
- 任何控制白名单 Telegram 账户的人都能控制此桥接程序。Telegram 机器人聊天并非端到端加密。
- 仔细审查每项授权请求。当 SDK 提供相应选项时，“始终允许”可能修改 Claude 本地设置，并影响之后的任务。
- 不要用同一个机器人令牌运行第二个轮询客户端，否则可能抢走更新或引发 HTTP 409 冲突。

## 前置要求

- Linux 或 macOS（下方命令使用 POSIX shell）
- **Node.js 20 或更高版本**及 npm（检查：`node --version`、`npm --version`）
- 已安装并完成身份验证的 Claude Code
- Telegram 账户和一个新建的 Telegram 机器人
- Git

### 安装并验证 Claude Code

按照最新的 [Claude Code 官方设置说明](https://docs.anthropic.com/en/docs/claude-code/setup)安装。然后在将要运行桥接程序的**同一操作系统账户**下交互式登录并验证：

```sh
claude --version
claude
```

完成登录流程，发送一条无害的测试请求，然后退出 Claude。如果 `claude` 安装在非标准位置，请运行 `command -v claude`，稍后把得到的绝对路径填入 `CLAUDE_EXECUTABLE`。其他操作系统用户完成的登录可能无法被服务账户使用。

## 创建并保护 Telegram 机器人

1. 打开已认证的 [@BotFather](https://t.me/BotFather)，发送 `/newbot` 并按提示操作。
2. 将返回的令牌保存在密码管理器中。把它当作密码，不要发布、提交到仓库，也不要粘贴进浏览器 URL。
3. 在 BotFather 中使用 `/setprivacy`，保持隐私模式**开启**。不要把机器人加入群组。桥接程序自身也要求 `message.from.id` 和私聊的 `message.chat.id` 都等于白名单 ID；隐私模式是额外防护。
4. 与新机器人打开私聊，发送一条消息，例如 `hello`。

### 安全获取 Telegram 数字用户 ID

应使用数字形式的 `message.from.id`，而不是用户名、机器人 ID、手机号或聊天标题。可采用以下方式：

- 向可信的 ID 查询机器人询问自己的 ID。这会向第三方机器人披露你的基本 Telegram 资料。
- 给自己的机器人发送私聊消息后，使用下方脚本查询。令牌输入不会在终端回显，也不会进入命令行或浏览器历史：

```sh
read -r -s -p 'Bot token: ' TELEGRAM_BOT_TOKEN; printf '\n'
export TELEGRAM_BOT_TOKEN
python3 - <<'PY'
import json, os, urllib.request
token = os.environ['TELEGRAM_BOT_TOKEN']
with urllib.request.urlopen(f'https://api.telegram.org/bot{token}/getUpdates') as response:
    updates = json.load(response)['result']
for update in updates:
    message = update.get('message') or update.get('edited_message')
    if message:
        print('from.id =', message['from']['id'], 'chat.type =', message['chat']['type'])
PY
unset TELEGRAM_BOT_TOKEN
```

选择 `chat.type` 为 `private` 的结果。隐藏输入可避免屏幕和 shell 历史泄露，但同一用户/root 仍可能在短时间内检查到进程环境；请在可信主机上操作并在之后关闭 shell。查询 `getUpdates` 时不要运行桥接程序，因为两个消费者会争抢更新。

## 安装

```sh
git clone https://github.com/wenck/claude-telegram-bridge.git
cd claude-telegram-bridge
npm ci
cp .env.example .env
chmod 600 .env
```

用本地编辑器编辑 `.env`，替换成你自己的值：

```dotenv
TELEGRAM_BOT_TOKEN=<BOT_TOKEN_FROM_BOTFATHER>
ALLOWED_TELEGRAM_USER_ID=<YOUR_NUMERIC_TELEGRAM_USER_ID>

# 可选
# BRIDGE_STATE_DIR=/path/to/private/bridge-state
# CLAUDE_WORKDIR=/path/to/project
# CLAUDE_EXECUTABLE=/path/to/claude
```

除非引号本身就是值的一部分，否则不要加引号。仓库会忽略 `.env`、状态、密钥、凭据和常见日志，但在共享或提交文件前仍应自行检查。

## 环境变量完整参考

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是（dry run 除外） | 无 | BotFather 签发的 Bot API 私密令牌；首尾空白会被移除。 |
| `ALLOWED_TELEGRAM_USER_ID` | 是（dry run 除外） | 无 | 唯一获准用户的数字 ID，以文本形式比较；私聊 ID 也必须与其相等。 |
| `BRIDGE_STATE_DIR` | 否 | 运行用户主目录内的 `.claude-telegram-bridge` | 包含 `state.json`；相对路径以进程工作目录为基准解析。 |
| `CLAUDE_WORKDIR` | 否 | 进程工作目录 | Claude 的工作目录；相对路径以进程工作目录为基准解析。 |
| `CLAUDE_EXECUTABLE` | 否 | `claude` | Claude Code 可执行文件名称或路径。 |
| `BRIDGE_DRY_RUN` | 内部/测试 | 未设置 | 设为 `1` 时禁止真实 Telegram 调用且不要求凭据。 |
| `BRIDGE_DRY_RUN_ONCE` | 内部/测试 | 未设置 | 与 dry-run 一起设为 `1` 时只轮询一次并退出。 |

由于 `dotenv` 从进程工作目录加载 `.env`，请从仓库目录启动应用，使用 PM2 时也一样。

## 前台运行

```sh
npm start
```

预期输出类似如下内容（实际会打印白名单 ID）：

```text
Claude Telegram bridge started for allowed user <YOUR_NUMERIC_USER_ID>
```

在机器人私聊中发送 `/start`，然后发送一个无害任务。按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 停止；程序会请求取消当前任务、短暂等待、写入状态后退出。

## 使用 PM2 生产部署（可选）

PM2 可保持进程运行并在开机时恢复。从**仓库目录**运行：

```sh
npm install --global pm2
pm2 start bridge.js --name claude-telegram-bridge
pm2 status
pm2 logs claude-telegram-bridge
```

按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 退出日志视图不会停止进程。配置开机恢复：

```sh
pm2 save
pm2 startup
```

执行 `pm2 startup` 输出的、与你平台相关的命令；如有提示，再运行一次 `pm2 save`。常用操作：

```sh
pm2 restart claude-telegram-bridge
pm2 restart claude-telegram-bridge --update-env  # 修改 .env 后
pm2 status
pm2 logs claude-telegram-bridge --lines 100
pm2 stop claude-telegram-bridge
```

PM2 必须以拥有 Claude 登录状态和目标文件的同一操作系统用户运行。除非有意做这种隔离，否则不要使用 `sudo pm2`。

## 机器人命令、队列和会话行为

| 命令 | 行为 |
| --- | --- |
| `/start` 或 `/help` | 显示聊天内使用说明。 |
| `/new` | 将重置会话操作加入队列。到达队首时丢弃旧 Claude 上下文；排在它之前的任务仍使用旧上下文。 |
| `/status` | 显示忙碌/空闲、持久化队列总长度、会话 ID（或尚未开始）以及配置的可执行文件。截图可能包含敏感信息。 |
| `/cancel` | 请求取消**当前运行的**任务，不会清空待处理任务或重置对话。 |

其他任何非空文本（包括未知的斜杠命令）都会成为提示词。任务按 FIFO 顺序逐个执行。已接收/排队状态消息会变成“Working on it…”，完成后删除。失败和取消不会结束当前对话。重启后会继续持久化的队列；因此被中断的运行任务可能再次执行。

每个任务最多 100 个 Claude 回合、30 分钟的 Claude **实际工作**时间；等待点击授权按钮时计时暂停。`/cancel` 是协作式取消，无法阻止或撤销已经开始的外部副作用。

## 授权与选项按钮

受保护工具请求会显示工具名称、可用详情和以下按钮：

- **仅本次允许**：只允许这一次调用。
- **当前任务允许**：SDK 提供会话级设置建议时显示。
- **始终允许**：SDK 提供本地设置建议时显示；可能持久写入 Claude 设置并影响之后的任务。
- **拒绝**：拒绝操作，但允许 Claude 尝试更安全的替代方案。

机器人当前显示的实际按钮标签为中文。只批准你理解的操作。等待点击的授权提示会在进程重启后失效，按钮也会被清除。

当 Claude 返回桥接程序规定的结构化有限选项时，机器人会显示 2–8 个按钮。点击后，选项值会作为新任务加入同一个 Claude 对话。待选项会持久保存，但会话重置后旧选项可能已无意义。

## 状态、权限与重置

状态位于 `<BRIDGE_STATE_DIR>/state.json`（默认 `$HOME/.claude-telegram-bridge/state.json`）。程序以 `0700` 模式创建目录，以 `0600` 模式创建新状态文件。已有父目录权限、备份、ACL 和特权用户不在其控制范围内。

文件包含 Telegram 偏移量、排队提示词及元数据、待处理选项/授权和 Claude 会话 ID。程序不会有意将机器人令牌写入其中，但其内容仍属敏感信息，绝不能发布。

若要完全重置桥接状态，先停止所有实例，再移走目录：

```sh
pm2 stop claude-telegram-bridge  # 前台运行时省略
mv "$HOME/.claude-telegram-bridge" "$HOME/.claude-telegram-bridge.backup"
```

如设置了 `BRIDGE_STATE_DIR`，请改用相应路径。**这会丢弃会话、队列、选项、桥接程序记录的授权以及更新偏移量；Telegram 仍保留的未消费更新可能再次出现。** 此操作不会移除 Claude Code 自身持久化的权限。检查并安全删除备份后再重启。

## Dry run

```sh
npm run dry-run
```

此脚本不需要令牌或用户 ID，不会调用 Telegram，只写入已被忽略的 `.dry-run-state` 目录，轮询一次后退出。它只验证启动，不能验证 Claude 身份认证或真实端到端请求。如需其他临时目录，可直接运行 `bridge.js`，同时设置 `BRIDGE_DRY_RUN=1`、`BRIDGE_DRY_RUN_ONCE=1` 和 `BRIDGE_STATE_DIR`。

## 更新

部署前先阅读上游变更，然后在干净的工作区中执行：

```sh
pm2 stop claude-telegram-bridge  # 前台运行时省略
git pull --ff-only
npm ci
npm run check
pm2 restart claude-telegram-bridge --update-env  # 或：npm start
```

不要覆盖 `.env` 或状态。仅在必要时备份敏感状态，并像保护原文件一样保护备份。

## 故障排查

- **缺少令牌/用户 ID：**确认启动目录中存在 `.env`，两个必填值非空，并使用 `--update-env` 重启 PM2。
- **机器人忽略消息：**先发起私聊，核对数字 `message.from.id`，不要使用用户名。程序会有意静默忽略群组和其他用户。
- **Telegram 401 Unauthorized：**令牌错误或已撤销。通过 BotFather 获取/生成有效令牌并更新 `.env`。
- **Telegram 409 Conflict：**同一令牌还有其他 `getUpdates` 客户端或 webhook。停止重复的桥接/PM2 实例和 ID 查询脚本；若其他系统配置过 webhook，应先有意通过 Bot API 删除，再重启此长轮询程序。
- **网络/超时：**确认主机可访问 `api.telegram.org`。轮询错误会写入日志，并在三秒后重试。
- **找不到 `claude`：**以服务用户运行 `command -v claude`，将结果写入 `CLAUDE_EXECUTABLE`。
- **Claude 身份验证或权限失败：**以同一操作系统用户交互运行 `claude`，确认 `CLAUDE_WORKDIR` 存在且可访问，并查看机器人授权请求或 PM2 日志。
- **PM2 已启动但未加载 `.env`：**查看 `pm2 status`/`pm2 logs`。若工作目录错误，从仓库目录删除并重新创建 PM2 应用；修改环境后使用 `--update-env`。
- **Markdown 实体或消息过长错误：**程序转换 MarkdownV2、在约 4,000 字符处拆分，并在解析/长度失败时以纯文本重试。若仍无法发送，请检查日志；异常 Unicode/转义或 Telegram API 故障仍可能导致失败。
- **重启后任务重复：**运行任务在完成前一直位于队首，异常终止可能导致重放。允许继续前先检查已有副作用。
- **旧按钮无响应：**授权按钮重启后过期，选项也可能失去时效。发送新指示，必要时使用 `/new`。
- **开机未恢复：**以预期操作系统用户执行 `pm2 startup` 输出的完整命令，然后运行 `pm2 save`。

## 限制

- 仅允许一名白名单用户进行私聊
- 只支持文本；不支持文件、照片、语音、群组或多用户路由
- 单个 FIFO 队列和一个持久化 Claude 对话
- 仅长轮询；无 webhook 模式，除 HTTPS 外无额外 Telegram 传输加密
- 每个任务最多 100 回合、30 分钟实际工作时间
- 进度消息是尽力发送；最终投递依赖 Telegram 可用性
- 没有沙箱、事务/回滚机制，也不保证取消能撤销副作用

## 许可证

[MIT](LICENSE)
