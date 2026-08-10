# Claude Telegram Bridge

**English** | [简体中文](README.zh-CN.md)

A small, self-hosted Telegram interface to [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It accepts text from one allowlisted user in a private chat, runs Claude Code on the host, and returns the result to Telegram.

## Features

- Private, single-user access enforced with a numeric Telegram user ID
- Sequential, persistent task queue and one resumable Claude conversation
- Short progress messages for tool calls; these are removed after the final answer
- Telegram buttons for tool permission decisions and finite-choice questions
- Long responses split to fit Telegram, with MarkdownV2 conversion and plain-text fallback
- Persisted update offset, queue, choices, and Claude session across restarts
- `/new`, `/status`, and `/cancel` controls
- A network-free dry-run smoke test

This project supports text messages only. It does **not** support attachments, photos, groups, or multiple users.

## How it works

```text
your private Telegram chat
  → Telegram Bot API long polling (getUpdates)
  → sender and private-chat ID check
  → persisted FIFO queue
  → Claude Agent SDK / local Claude Code executable
  → permission or choice buttons when needed
  → split, formatted Telegram response
```

Only one task runs at a time. New text is appended to the queue. The first task creates a Claude session; later tasks resume it until `/new` reaches the front of the queue. The bot stores the Telegram update offset so acknowledged updates are not normally processed again after restart.

## Security warning and threat model

**This bridge is remote command-capable access to its host, not a sandbox.** Claude Code can read and modify files, run commands, and use credentials reachable by the bridge process. Telegram authorization reduces who can submit tasks, and permission prompts reduce accidental actions, but neither contains a compromised Telegram account, leaked bot token, malicious prompt, dependency, or incorrectly approved command.

- Use a dedicated bot. Prefer a dedicated OS user and an isolated machine/container with only the required files and credentials.
- Set `CLAUDE_WORKDIR` narrowly. Do not run the bridge as an administrator or expose sensitive home directories.
- Keep `.env`, logs, backups, and the state directory private. Revoke a leaked token through BotFather and replace it immediately.
- Anyone who controls the allowed Telegram account can control the bridge. Telegram bots do not provide end-to-end encryption.
- Review every permission request. “Always allow” may update Claude local settings when the SDK offers that option and can affect future work.
- Do not run a second poller with the same bot token; it can consume updates or cause HTTP 409 conflicts.

## Prerequisites

- Linux or macOS (the commands below use a POSIX shell)
- **Node.js 20 or newer** and npm (`node --version`, `npm --version`)
- Claude Code installed and authenticated
- A Telegram account and a new Telegram bot
- Git

### Install and verify Claude Code

Follow the current [official Claude Code setup instructions](https://docs.anthropic.com/en/docs/claude-code/setup). Then authenticate interactively and verify that the executable works under the **same OS account** that will run the bridge:

```sh
claude --version
claude
```

Complete the login flow and send a harmless test request, then exit Claude. If `claude` is installed at a nonstandard path, obtain it with `command -v claude` and later set `CLAUDE_EXECUTABLE` to that absolute path. A login performed as another OS user may not be available to the service account.

## Create and secure the Telegram bot

1. Open the verified [@BotFather](https://t.me/BotFather) account, send `/newbot`, and follow the prompts.
2. Save the returned token in a password manager. Treat it as a password; do not post it, commit it, or paste it into browser URLs.
3. In BotFather, use `/setprivacy` and keep privacy mode **enabled**. Do not add this bot to groups. The bridge independently requires both `message.from.id` and the private `message.chat.id` to equal the allowlisted ID, but privacy mode is useful defense in depth.
4. Open a private conversation with the new bot and send a message such as `hello`.

### Obtain your numeric Telegram user ID safely

Use the numeric `message.from.id`, not a username, bot ID, phone number, or chat title. Two reasonable methods are:

- Ask a reputable ID-information bot for your ID. This discloses your basic Telegram profile to that third-party bot.
- Query your own bot with the script below after sending it a private message. The token is read without terminal echo and is not placed in the command line or browser history:

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

Select the result whose `chat.type` is `private`. Hidden input avoids screen and shell-history leakage, but the token is briefly available to same-user/root process inspection; use a trusted host and close the shell afterward. Do not run the bridge while using `getUpdates`, because two consumers compete for updates.

## Install

```sh
git clone https://github.com/wenck/claude-telegram-bridge.git
cd claude-telegram-bridge
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` with a local editor and obvious values of your own:

```dotenv
TELEGRAM_BOT_TOKEN=<BOT_TOKEN_FROM_BOTFATHER>
ALLOWED_TELEGRAM_USER_ID=<YOUR_NUMERIC_TELEGRAM_USER_ID>

# Optional
# BRIDGE_STATE_DIR=/path/to/private/bridge-state
# CLAUDE_WORKDIR=/path/to/project
# CLAUDE_EXECUTABLE=/path/to/claude
```

Do not include quotes unless they are part of the intended value. The repository ignores `.env`, state, keys, credentials, and common logs, but verify before sharing or committing files.

## Environment variable reference

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes (except dry run) | none | Secret Bot API token issued by BotFather. Whitespace at both ends is trimmed. |
| `ALLOWED_TELEGRAM_USER_ID` | Yes (except dry run) | none | Sole authorized numeric user ID, compared as text. Private chat ID must equal it too. |
| `BRIDGE_STATE_DIR` | No | `.claude-telegram-bridge` in the running user's home | Directory containing `state.json`; relative values resolve from the process working directory. |
| `CLAUDE_WORKDIR` | No | process working directory | Claude's working directory; relative values resolve from the process working directory. |
| `CLAUDE_EXECUTABLE` | No | `claude` | Claude Code executable name or path. |
| `BRIDGE_DRY_RUN` | Internal/testing | unset | Set to `1` to disable real Telegram calls and credential requirements. |
| `BRIDGE_DRY_RUN_ONCE` | Internal/testing | unset | Set to `1` with dry-run mode to poll once and exit. |

Because `dotenv` loads `.env` from the process working directory, start the application from the repository directory (including under PM2).

## Run in the foreground

```sh
npm start
```

Expected output resembles this (the actual allowed ID is printed):

```text
Claude Telegram bridge started for allowed user <YOUR_NUMERIC_USER_ID>
```

Send `/start` in the bot's private chat, then send a harmless task. Stop with <kbd>Ctrl</kbd>+<kbd>C</kbd>; the bridge requests cancellation, waits briefly, flushes state, and exits.

## Production deployment with PM2 (optional)

PM2 keeps the process running and can restore it at boot. Install it, then run these commands **from the repository directory**:

```sh
npm install --global pm2
pm2 start bridge.js --name claude-telegram-bridge
pm2 status
pm2 logs claude-telegram-bridge
```

Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to leave the log view without stopping the process. Configure boot restoration:

```sh
pm2 save
pm2 startup
```

Run the platform-specific command printed by `pm2 startup`, then run `pm2 save` again if instructed. Useful operations:

```sh
pm2 restart claude-telegram-bridge
pm2 restart claude-telegram-bridge --update-env  # after changing .env
pm2 status
pm2 logs claude-telegram-bridge --lines 100
pm2 stop claude-telegram-bridge
```

PM2 must run as the same OS user that owns the Claude authentication and intended files. Avoid `sudo pm2` unless that separation is deliberate.

## Bot commands, queue, and session behavior

| Command | Behavior |
| --- | --- |
| `/start` or `/help` | Show the in-chat usage summary. |
| `/new` | Enqueue a session reset. When it reaches the front, the old Claude context is discarded; queued work before it still uses the old context. |
| `/status` | Report busy/idle, total persisted queue length, session ID (or not started), and configured executable. Treat screenshots as sensitive. |
| `/cancel` | Request cancellation of the **currently running** task. It does not clear queued tasks or reset the conversation. |

Any other nonempty text—including an unknown slash command—is a prompt. Jobs run FIFO, one at a time. A received/queued status message changes to “Working on it…” and is removed after completion. Failures and cancellations leave the conversation active. On restart, persisted queued jobs resume; an interrupted running job may therefore be attempted again.

Each task is capped at 100 Claude turns and 30 minutes of **active** Claude work. Time waiting for a permission button is paused. `/cancel` is cooperative and may not stop an external side effect already started.

## Permission and choice buttons

For a protected tool request, the bridge shows the tool and available details with:

- **Allow once**: permit that invocation only.
- **Allow for current task**: shown when the SDK supplies a session-level settings suggestion.
- **Always allow**: shown when the SDK supplies a local-settings suggestion; it may persist in Claude settings beyond this bridge task.
- **Deny**: reject the action while allowing Claude to try a safer alternative.

The exact labels in the bot are currently Chinese. Only approve actions you understand. Permission prompts awaiting a click expire on process restart and their keyboards are cleared.

When Claude returns the bridge's structured finite-choice format, the bot displays 2–8 buttons. Selecting one queues the selected value into the same Claude conversation. Pending choices are persisted, although an old choice may no longer be useful after a session reset.

## State, permissions, and reset

State is stored at `<BRIDGE_STATE_DIR>/state.json` (default: `$HOME/.claude-telegram-bridge/state.json`). The bridge creates the directory with mode `0700` and new state files with mode `0600`. Existing parent-directory permissions, backups, ACLs, and privileged users remain outside its control.

The file contains Telegram offsets, queued prompts and metadata, pending choices/permissions, and the Claude session ID. It does not intentionally store the bot token, but its contents are sensitive. Never publish it.

To completely reset bridge state, first stop every instance, then move the directory aside:

```sh
pm2 stop claude-telegram-bridge  # omit if running in foreground
mv "$HOME/.claude-telegram-bridge" "$HOME/.claude-telegram-bridge.backup"
```

Use your configured path instead if `BRIDGE_STATE_DIR` is set. **This discards the session, queue, choices, permissions recorded by the bridge, and update offset. Unconsumed Telegram updates still retained by Telegram could be seen again.** This does not remove permissions persisted by Claude Code itself. Restart only after reviewing/removing the backup securely.

## Dry run

```sh
npm run dry-run
```

This package script needs no token or user ID, makes no Telegram calls, writes only to the ignored `.dry-run-state` directory, polls once, and exits. It validates startup, not Claude authentication or a real end-to-end request. To select another disposable location, invoke `bridge.js` directly with `BRIDGE_DRY_RUN=1`, `BRIDGE_DRY_RUN_ONCE=1`, and `BRIDGE_STATE_DIR`.

## Updating

Read upstream changes before deploying, then from a clean checkout:

```sh
pm2 stop claude-telegram-bridge  # omit for foreground use
git pull --ff-only
npm ci
npm run check
pm2 restart claude-telegram-bridge --update-env  # or: npm start
```

Do not overwrite `.env` or state. Back up sensitive state only when necessary and protect the backup like the original.

## Troubleshooting

- **Missing token/user ID:** ensure `.env` exists in the directory from which the process starts, both required values are nonempty, and PM2 was restarted with `--update-env`.
- **Bot ignores messages:** initiate the private chat, verify the numeric `message.from.id`, and ensure no username was used. Groups and other users are deliberately ignored without a reply.
- **Telegram 401 Unauthorized:** the token is wrong or revoked. Generate/retrieve a valid token through BotFather and update `.env`.
- **Telegram 409 Conflict:** another `getUpdates` client or webhook is active for this token. Stop duplicate bridge/PM2 instances and ID-discovery scripts. If a webhook was configured elsewhere, remove it intentionally via the Bot API before restarting this long-polling bridge.
- **Network/timeouts:** confirm the host can reach `api.telegram.org`. Poll errors are logged and retried after three seconds.
- **`claude` not found:** run `command -v claude` as the service user and set `CLAUDE_EXECUTABLE` to the resulting path.
- **Claude authentication or permission failure:** run `claude` interactively as the same OS user, verify `CLAUDE_WORKDIR` exists and is accessible, and inspect the bot's permission request or PM2 logs.
- **PM2 starts but `.env` is missed:** check `pm2 status`/`pm2 logs`, delete and recreate the app from the repository directory if its working directory is wrong, and use `--update-env` after edits.
- **Markdown/entity or long-message errors:** the bridge converts MarkdownV2, splits near 4,000 characters, and retries parse/length failures as plain text. Check logs if delivery still fails; very unusual Unicode/escaping or Telegram API failures may still prevent a response.
- **Repeated task after restart:** the running job remains at the queue head until completion, so abrupt termination can replay it. Check for side effects before allowing it to continue.
- **Old buttons do nothing:** permission buttons expire after restart; choices can become stale. Send a new instruction or use `/new` when appropriate.
- **No boot restart:** run the exact command emitted by `pm2 startup`, then `pm2 save`, under the intended OS user.

## Limitations

- Exactly one allowlisted user in a private chat
- Text input only; no files, photos, voice, groups, or multi-user routing
- One FIFO queue and one persisted Claude conversation
- Long polling only; no webhook mode or Telegram transport encryption beyond HTTPS
- 100-turn limit and 30-minute active-work timeout per task
- Progress posting is best-effort; final delivery depends on Telegram availability
- No sandbox, transaction/rollback system, or guarantee that cancellation reverses side effects

## License

[MIT](LICENSE)
