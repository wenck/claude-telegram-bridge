# Claude Telegram Bridge

A small, single-user Telegram interface to Claude Code. It long-polls Telegram, queues text tasks, preserves a Claude session, streams brief tool-progress messages, and returns Claude's final response. Telegram buttons let the user approve tool permissions and answer finite-choice questions.

## Security warning

Claude Code can read and change files, execute commands, and otherwise act on the host with the bridge process's privileges. This bridge only accepts private-chat messages from one numeric Telegram user ID, but it is not a sandbox. Protect the bot token and state directory. Prefer a dedicated Telegram bot, account, OS user, and machine or container with access only to the files you intend to expose.

## Prerequisites

- Node.js 20 or newer
- Claude Code installed and authenticated (`claude` should run successfully)
- A Telegram account and bot

## Telegram setup

1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, and follow its prompts. Keep the returned token secret.
2. Find your numeric Telegram user ID using a reputable ID-info bot, or send your new bot a message and inspect `https://api.telegram.org/bot<TOKEN>/getUpdates`. Use the `message.from.id` number—not a username or chat title.
3. Do not add the bot to groups. The bridge requires both sender ID and private chat ID to match the allowlisted ID.

## Install and configure

```sh
git clone https://github.com/wenck/claude-telegram-bridge.git
cd claude-telegram-bridge
npm ci
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Secret token issued by BotFather |
| `ALLOWED_TELEGRAM_USER_ID` | Yes | The sole allowed numeric Telegram user ID |
| `BRIDGE_STATE_DIR` | No | State directory; defaults to `.claude-telegram-bridge` under the current user's home |
| `CLAUDE_WORKDIR` | No | Directory Claude works in; defaults to the process working directory |
| `CLAUDE_EXECUTABLE` | No | Claude Code executable name or path; defaults to `claude` |

Start in the foreground:

```sh
npm start
```

### PM2 deployment

Install PM2 and start the bridge from the repository directory so `.env` is found:

```sh
npm install --global pm2
pm2 start bridge.js --name claude-telegram-bridge
pm2 save
pm2 startup
```

Follow the command printed by `pm2 startup`. After changing `.env`, restart with `pm2 restart claude-telegram-bridge --update-env`.

## Commands

- `/start`, `/help` — usage summary
- `/new` — discard the previous Claude context and start fresh
- `/status` — show busy/idle state, queue length, session ID, and configured executable
- `/cancel` — request cancellation of the running task

Other text is queued as a Claude task. Photos, files, group chats, and multiple users are not supported.

## Permission and choice buttons

When Claude requests a protected tool action, the bot presents **allow once**, **allow for this task/always**, and **deny** buttons. Persistent approval is offered only when the Claude SDK supplies a settings suggestion; otherwise approval applies to the current task. Pending permission buttons expire when the process restarts. Claude may also return a structured finite choice, which the bridge renders as buttons and feeds back into the same session.

Only approve actions you understand. Permission controls reduce accidental access; they do not turn Claude Code into a sandbox.

## State

The bridge persists Telegram offsets, queued jobs, pending choices, and the Claude session ID in `state.json` inside `BRIDGE_STATE_DIR`. The directory and file are created with owner-only permissions. Back it up only if needed and never publish it: session IDs and conversation/task metadata are sensitive.

## Dry run

```sh
npm run dry-run
```

Dry-run mode requires no token or user ID, performs no Telegram calls, writes only to the ignored `.dry-run-state` directory, polls once, and exits. To choose another disposable state location, set `BRIDGE_STATE_DIR` when invoking `bridge.js` directly.

## Limitations

- One allowlisted user and private chat only
- Text input only; no attachments or group support
- One sequential queue and one persisted Claude conversation
- Long polling rather than webhooks
- A 30-minute active-work timeout and 100-turn cap per task
- Host security ultimately depends on the bridge process account, Claude configuration, and the permissions you approve

## License

MIT
