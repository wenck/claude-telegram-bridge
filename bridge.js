#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const telegramifyMarkdown = require('telegramify-markdown');

const DRY_RUN = process.env.BRIDGE_DRY_RUN === '1';
const DRY_RUN_ONCE = process.env.BRIDGE_DRY_RUN_ONCE === '1';
const STATE_DIR = path.resolve(process.env.BRIDGE_STATE_DIR || path.join(os.homedir(), '.claude-telegram-bridge'));
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WORKDIR = path.resolve(process.env.CLAUDE_WORKDIR || process.cwd());
const CLAUDE_BIN = process.env.CLAUDE_EXECUTABLE || 'claude';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const ALLOWED_USER_ID = process.env.ALLOWED_TELEGRAM_USER_ID?.trim();
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const SAVE_STATE_DEBOUNCE_MS = 100;
const SHUTDOWN_GRACE_MS = 5000;
// Belt-and-suspenders cap: TASK_TIMEOUT_MS is the wall-clock guard, MAX_TURNS
// stops a runaway loop (Claude endlessly re-invoking tools) before it burns
// through 30 minutes of tokens.
const MAX_TURNS = 100;
const agentSdkPromise = import('@anthropic-ai/claude-agent-sdk');

if (!DRY_RUN && (!TELEGRAM_BOT_TOKEN || !ALLOWED_USER_ID)) {
  console.error('TELEGRAM_BOT_TOKEN and ALLOWED_TELEGRAM_USER_ID are required.');
  process.exit(1);
}

const token = DRY_RUN ? 'dry-run' : TELEGRAM_BOT_TOKEN;
const apiBase = `https://api.telegram.org/bot${token}`;

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

function loadState() {
  try {
    return {
      offset: 0,
      sessionId: null,
      initialized: false,
      queue: [],
      pendingChoices: {},
      pendingPermissions: {},
      ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load state:', error.message);
    return {
      offset: 0,
      sessionId: null,
      initialized: false,
      queue: [],
      pendingChoices: {},
      pendingPermissions: {},
    };
  }
}

let state = loadState();
let processing = false;
let activeAbortController = null;
let activeJob = null;
let stopping = false;
const permissionWaiters = new Map();

// Debounced state persistence — coalesces bursts of saveState() calls into a
// single write. Force a synchronous flush from shutdown paths via flushState().
let saveTimer = null;
function saveStateNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveStateNow, SAVE_STATE_DEBOUNCE_MS);
  saveTimer.unref();
}
function flushState() {
  if (saveTimer) saveStateNow();
}

async function telegram(method, body = {}) {
  if (DRY_RUN) {
    console.log(`[dry-run] telegram(${method})`, JSON.stringify(body).slice(0, 200));
    if (method === 'sendMessage') return { message_id: Math.floor(Math.random() * 1e9) };
    if (method === 'getUpdates') { await new Promise((r) => setTimeout(r, 1000)); return []; }
    return {};
  }
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`${method} failed: ${data.description || response.status}`);
  }
  return data.result;
}

// Telegram's hard cap is 4096; leave ~96 chars of headroom for MarkdownV2
// escape bloat (backslashes added around punctuation can grow the payload).
function splitMessage(text, limit = 4000) {
  const chunks = [];
  let remaining = String(text || 'Done.');
  while (remaining.length > limit) {
    let index = remaining.lastIndexOf('\n', limit);
    if (index < limit / 2) index = remaining.lastIndexOf(' ', limit);
    if (index < limit / 2) index = limit;
    chunks.push(remaining.slice(0, index));
    remaining = remaining.slice(index).replace(/^\s+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendMessage(chatId, text) {
  const chunks = splitMessage(text);
  const sent = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const plainText = chunks[index];
    let formattedText;
    try {
      formattedText = telegramifyMarkdown(plainText, 'escape').trim();
    } catch (error) {
      console.error('Failed to convert Markdown; sending plain text:', error.message);
    }
    const body = formattedText
      ? { chat_id: chatId, text: formattedText, parse_mode: 'MarkdownV2' }
      : { chat_id: chatId, text: plainText };
    try {
      sent.push(await telegram('sendMessage', body));
    } catch (error) {
      if (!/can't parse entities|message is too long/i.test(error.message)) throw error;
      console.error('Formatted message failed; sending plain text:', error.message);
      sent.push(await telegram('sendMessage', { chat_id: chatId, text: plainText }));
    }
  }
  return sent;
}

// Delete the streamed tool-progress messages after the final reply lands.
// Fire-and-forget: a failed delete (e.g. user already deleted it) is harmless
// and must not block the queue advancing to the next job.
function deleteProgressMessages(job) {
  const ids = job?.progressMessageIds;
  if (!Array.isArray(ids) || !ids.length) return;
  for (const id of ids) {
    telegram('deleteMessage', { chat_id: job.chatId, message_id: id })
      .catch(() => {});
  }
  job.progressMessageIds = [];
}

async function deleteStatusMessage(job) {
  if (!job.ackMessageId) return;
  await telegram('deleteMessage', {
    chat_id: job.chatId,
    message_id: job.ackMessageId,
  }).catch((error) => console.error('Failed to delete status message:', error.message));
  delete job.ackMessageId;
  saveState();
}

function parseChoice(result) {
  const marker = '[[TELEGRAM_CHOICE]]';
  const index = result.indexOf(marker);
  if (index === -1) return null;
  try {
    const raw = result.slice(index + marker.length).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const choice = JSON.parse(raw);
    if (typeof choice.question !== 'string' || !Array.isArray(choice.options)) return null;
    const options = choice.options
      .filter((option) => option && typeof option.label === 'string' && typeof option.value === 'string')
      .slice(0, 8);
    if (options.length < 2) return null;
    return { question: choice.question.slice(0, 3500), options };
  } catch (error) {
    console.error('Failed to parse Telegram choice:', error.message);
    return null;
  }
}

async function sendChoice(job, choice) {
  const choiceId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const keyboard = choice.options.map((option, index) => ([{
    text: option.label.slice(0, 60),
    callback_data: `choice:${choiceId}:${index}`,
  }]));
  const message = await telegram('sendMessage', {
    chat_id: job.chatId,
    text: choice.question,
    reply_markup: { inline_keyboard: keyboard },
  });
  state.pendingChoices[choiceId] = {
    chatId: job.chatId,
    telegramMessageId: message.message_id,
    options: choice.options,
    createdAt: new Date().toISOString(),
  };
  saveState();
}

function describeToolRequest(toolName, input) {
  if (toolName === 'Bash') {
    const description = input.description ? `说明：${input.description}\n` : '';
    return `${description}命令：\n${String(input.command || '').slice(0, 2500)}`;
  }
  if (['Read', 'Write', 'Edit'].includes(toolName)) {
    return `文件：${String(input.file_path || '未知').slice(0, 2500)}`;
  }
  const serialized = JSON.stringify(input, null, 2);
  return `参数：\n${serialized.slice(0, 2500)}${serialized.length > 2500 ? '\n…' : ''}`;
}

// One-line summary of a running tool call for streaming progress. Kept short
// so each Telegram message is cheap and readable.
function summarizeToolUse(toolName, input) {
  if (toolName === 'Bash') {
    const desc = input?.description || String(input?.command || '').split('\n')[0].slice(0, 80);
    return `🔧 Bash: ${desc}`;
  }
  if (toolName === 'Read') return `📖 Read: ${input?.file_path || '?'}`;
  if (toolName === 'Write') return `✍️ Write: ${input?.file_path || '?'}`;
  if (toolName === 'Edit') return `✏️ Edit: ${input?.file_path || '?'}`;
  if (toolName === 'Grep') return `🔍 Grep: ${input?.pattern || '?'}`;
  if (toolName === 'Glob') return `🔍 Glob: ${input?.pattern || '?'}`;
  if (toolName === 'WebFetch') return `🌐 WebFetch: ${input?.url || '?'}`;
  if (toolName === 'WebSearch') return `🌐 WebSearch: ${input?.query || '?'}`;
  if (toolName === 'Task' || toolName === 'Agent') return `🤖 Agent: ${(input?.description || input?.prompt || '').slice(0, 80)}`;
  return `🔧 ${toolName}`;
}

// Pausable countdown. Used to enforce a 30-minute limit on *active* Claude
// work — the timer pauses while we're waiting on a Telegram permission click
// (which can legitimately take minutes) and resumes afterwards.
function createPausableTimer(totalMs, onExpire) {
  let remaining = totalMs;
  let startedAt = null;
  let handle = null;
  let paused = 0;
  let done = false;
  const arm = () => {
    if (done || paused > 0) return;
    startedAt = Date.now();
    handle = setTimeout(() => { done = true; onExpire(); }, Math.max(1, remaining));
    handle.unref();
  };
  return {
    start() { arm(); },
    pause() {
      if (done) return;
      if (paused === 0 && startedAt != null) {
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
        clearTimeout(handle);
        handle = null;
      }
      paused += 1;
    },
    resume() {
      if (done) return;
      paused = Math.max(0, paused - 1);
      if (paused === 0) arm();
    },
    stop() { done = true; clearTimeout(handle); handle = null; },
  };
}

async function requestPermission(job, toolName, input, options) {
  if (options.signal.aborted) throw options.signal.reason || new Error('Permission request cancelled');
  const permissionId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];
  const persistentSuggestions = suggestions.filter((suggestion) => suggestion.destination === 'localSettings');
  const sessionSuggestions = suggestions.filter((suggestion) => suggestion.destination === 'session');
  const rememberedSuggestions = persistentSuggestions.length ? persistentSuggestions : sessionSuggestions.slice(0, 1);
  const rememberLabel = persistentSuggestions.length ? '✅ 始终允许' : '🔁 当前任务允许';
  const text = [
    '🔐 Claude 请求授权',
    '',
    `操作：${toolName}`,
    describeToolRequest(toolName, input),
    options.decisionReason ? `\n原因：${options.decisionReason}` : '',
  ].filter(Boolean).join('\n');
  const buttons = [{ text: '1️⃣ 仅本次', callback_data: `permission:${permissionId}:once` }];
  if (rememberedSuggestions.length) {
    buttons.push({ text: rememberLabel, callback_data: `permission:${permissionId}:always` });
  }
  buttons.push({ text: '❌ 拒绝', callback_data: `permission:${permissionId}:deny` });
  const message = await telegram('sendMessage', {
    chat_id: job.chatId,
    text: text.slice(0, 3900),
    reply_markup: {
      inline_keyboard: [buttons],
    },
  });
  if (options.signal.aborted) {
    await telegram('editMessageReplyMarkup', {
      chat_id: job.chatId,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    throw options.signal.reason || new Error('Permission request cancelled');
  }

  state.pendingPermissions[permissionId] = {
    chatId: job.chatId,
    telegramMessageId: message.message_id,
    toolName,
    persistent: persistentSuggestions.length > 0,
    createdAt: new Date().toISOString(),
  };
  saveState();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      permissionWaiters.delete(permissionId);
      options.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      delete state.pendingPermissions[permissionId];
      saveState();
      telegram('editMessageReplyMarkup', {
        chat_id: job.chatId,
        message_id: message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
      reject(options.signal.reason || new Error('Permission request cancelled'));
    };
    permissionWaiters.set(permissionId, {
      finish(decision) {
        cleanup();
        if (decision === 'always') {
          resolve({ decision, suggestions: rememberedSuggestions });
        } else {
          resolve({ decision, suggestions: [] });
        }
      },
    });
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function newSession() {
  state.sessionId = null;
  state.initialized = false;
  saveState();
}

async function runClaude(prompt, job) {
  const abortController = new AbortController();
  activeAbortController = abortController;
  const { query } = await agentSdkPromise;
  let timedOut = false;
  let finalResult;
  let iterationError;
  const seenToolUseIds = new Set();
  // Track the Telegram message_ids of the streamed "🔧 …" progress lines so
  // we can delete them after the final reply lands — keeps the chat clean.
  const progressMessageIds = [];
  job.progressMessageIds = progressMessageIds;

  const timer = createPausableTimer(TASK_TIMEOUT_MS, () => {
    timedOut = true;
    abortController.abort(new Error('Claude task timed out'));
  });
  timer.start();

  const options = {
    cwd: WORKDIR,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    settingSources: ['user', 'project', 'local'],
    permissionMode: 'default',
    persistSession: true,
    abortController,
    maxTurns: MAX_TURNS,
    disallowedTools: ['AskUserQuestion'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: 'This request came from a private Telegram bridge. Work non-interactively. Never use AskUserQuestion or terminal prompts. Perform the requested task when safe, and put a concise user-facing answer in the final response. Do not try to call Telegram tools; the bridge delivers your final response. If you must ask the user to choose from a finite set before continuing, make the entire final response exactly [[TELEGRAM_CHOICE]] followed by one JSON object: {"question":"...","options":[{"label":"Button text","value":"meaning passed back to you"}]}. Provide 2 to 8 options. Do not use this format when you can safely proceed without clarification.',
    },
    canUseTool: async (toolName, input, permissionOptions) => {
      timer.pause();
      try {
        const { decision, suggestions } = await requestPermission(job, toolName, input, permissionOptions);
        if (decision === 'once') return { behavior: 'allow', updatedInput: input };
        if (decision === 'always') {
          return { behavior: 'allow', updatedInput: input, updatedPermissions: suggestions };
        }
        return {
          behavior: 'deny',
          message: 'The user denied this action in Telegram. Continue without it or propose a safer alternative.',
          interrupt: false,
        };
      } finally {
        timer.resume();
      }
    },
  };
  if (state.initialized && state.sessionId) options.resume = state.sessionId;

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        state.sessionId = message.session_id;
        state.initialized = true;
        saveState();
      }
      // Stream a one-line summary for each new tool call. Each summary is a
      // fresh Telegram message (no edits), so there is no risk of hitting the
      // per-message edit rate limit. Tool calls arrive far below Telegram's
      // 1 msg/sec/chat limit in practice; fire-and-forget so a slow post can
      // never stall the SDK iteration.
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block?.type === 'tool_use' && block.id && !seenToolUseIds.has(block.id)) {
            seenToolUseIds.add(block.id);
            const summary = summarizeToolUse(block.name, block.input);
            if (DRY_RUN) {
              console.log(`[dry-run] tool-use ${block.name}:`, summary);
            } else {
              sendMessage(job.chatId, summary).then((sentList) => {
                for (const s of sentList || []) {
                  if (s?.message_id) progressMessageIds.push(s.message_id);
                }
              }).catch((err) => {
                console.error('Failed to send tool-use progress:', err.message);
              });
            }
          }
        }
      }
      if (message.type === 'result') finalResult = message;
    }
  } catch (error) {
    iterationError = error;
  } finally {
    timer.stop();
    activeAbortController = null;
  }

  if (timedOut) throw new Error('Claude task timed out after 30 minutes of active work.');
  if (abortController.signal.aborted) throw new Error('Claude task cancelled.');
  if (finalResult?.session_id) {
    state.sessionId = finalResult.session_id;
    state.initialized = true;
    saveState();
  }
  if (finalResult?.subtype !== 'success') {
    const error = new Error(finalResult?.errors?.join('\n') || iterationError?.message || 'Claude task failed.');
    error.permissionDenials = finalResult?.permission_denials || [];
    throw error;
  }
  if (iterationError) throw iterationError;
  if (!finalResult) throw new Error('Claude finished without a result.');
  if (finalResult.is_error) {
    const error = new Error(finalResult.result || finalResult.errors?.join('\n') || 'Claude task failed.');
    error.permissionDenials = finalResult.permission_denials || [];
    throw error;
  }
  return finalResult.result || 'Done.';
}

async function processQueue() {
  if (processing || stopping) return;
  processing = true;
  try {
    while (state.queue.length && !stopping) {
      const job = state.queue[0];
      activeJob = job;
      if (job.type === 'new') {
        newSession();
        await sendMessage(job.chatId, 'Started a new Claude session. The previous context will no longer be used.');
        await deleteStatusMessage(job);
        state.queue.shift();
        saveState();
        activeJob = null;
        continue;
      }

      if (job.ackMessageId) {
        await telegram('editMessageText', {
          chat_id: job.chatId,
          message_id: job.ackMessageId,
          text: 'Working on it…',
        }).catch(() => {});
      }

      const typing = setInterval(() => {
        telegram('sendChatAction', { chat_id: job.chatId, action: 'typing' }).catch(() => {});
      }, 4000);
      typing.unref();
      await telegram('sendChatAction', { chat_id: job.chatId, action: 'typing' }).catch(() => {});

      try {
        const result = await runClaude(job.text, job);
        // Stop the typing heartbeat BEFORE sending the reply. Otherwise the
        // interval can fire once more between our sendMessage and the reply
        // actually landing, re-lighting "typing…" for another ~5s after the
        // user already sees the answer.
        clearInterval(typing);
        const choice = parseChoice(result);
        if (choice) await sendChoice(job, choice);
        else await sendMessage(job.chatId, result);
        await deleteStatusMessage(job);
        deleteProgressMessages(job);
      } catch (error) {
        clearInterval(typing);
        const cancelled = /cancelled|canceled|SIGTERM|SIGKILL/i.test(error.message);
        const denied = Array.isArray(error.permissionDenials) && error.permissionDenials.length > 0;
        let message;
        if (cancelled) {
          message = 'Task cancelled. The conversation is still active.';
        } else if (denied) {
          message = `The current task could not proceed because a required action was denied. The conversation is still active—reply with how you want to proceed.\n\n${error.message.slice(0, 2500)}`;
        } else {
          message = `The current task failed, but the conversation is still active. You can reply to retry or change the approach.\n\n${error.message.slice(0, 2500)}`;
        }
        await sendMessage(
          job.chatId,
          message,
        ).then(() => deleteStatusMessage(job))
          .catch((sendError) => console.error('Failed to report task error:', sendError.message));
      } finally {
        clearInterval(typing);
      }

      state.queue.shift();
      saveState();
      activeJob = null;
    }
  } finally {
    processing = false;
  }
}

async function handleMessage(message) {
  const userId = String(message.from?.id || '');
  const chatId = String(message.chat?.id || '');
  if (userId !== ALLOWED_USER_ID || chatId !== ALLOWED_USER_ID) return;
  const text = message.text?.trim();
  if (!text) {
    await sendMessage(chatId, 'Text messages are supported for now. File and photo support can be added later.');
    return;
  }

  const command = text.split(/\s+/, 1)[0].split('@', 1)[0].toLowerCase();
  if (command === '/start' || command === '/help') {
    await sendMessage(
      chatId,
      'Claude bridge is online. Send a task as normal text.\n\n/new — start a fresh context\n/status — show current status\n/cancel — stop the running task\n/help — show this message',
    );
    return;
  }
  if (command === '/status') {
    const status = activeJob ? 'busy' : 'idle';
    await sendMessage(
      chatId,
      `Status: ${status}\nQueued: ${state.queue.length}\nSession: ${state.sessionId || 'not started'}\nClaude executable: ${CLAUDE_BIN}`,
    );
    return;
  }
  if (command === '/cancel') {
    if (!activeAbortController) {
      await sendMessage(chatId, 'No task is currently running.');
    } else {
      activeAbortController.abort(new Error('Cancelled by user'));
      await sendMessage(chatId, 'Cancellation requested.');
    }
    return;
  }

  state.queue.push({
    id: crypto.randomUUID(),
    type: command === '/new' ? 'new' : 'prompt',
    chatId,
    messageId: message.message_id,
    text,
    createdAt: new Date().toISOString(),
  });
  saveState();

  const job = state.queue[state.queue.length - 1];
  if (state.queue.length > 1 || activeJob) {
    const sent = await sendMessage(chatId, `Queued. Position: ${state.queue.length}`)
      .catch((error) => console.error('Failed to acknowledge queued task:', error.message));
    if (sent?.[0]) job.ackMessageId = sent[0].message_id;
  } else {
    const sent = await sendMessage(chatId, 'Received. Working on it…')
      .catch((error) => console.error('Failed to acknowledge task:', error.message));
    if (sent?.[0]) job.ackMessageId = sent[0].message_id;
  }
  saveState();
  void processQueue();
}

async function handleCallbackQuery(query) {
  const userId = String(query.from?.id || '');
  if (userId !== ALLOWED_USER_ID) {
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Not authorized.' }).catch(() => {});
    return;
  }
  const permissionMatch = /^permission:([a-f0-9]{16}):(once|always|deny)$/.exec(query.data || '');
  if (permissionMatch) {
    const [, permissionId, decision] = permissionMatch;
    const pending = state.pendingPermissions[permissionId];
    const waiter = permissionWaiters.get(permissionId);
    if (!pending || !waiter) {
      if (pending) {
        delete state.pendingPermissions[permissionId];
        saveState();
        await telegram('editMessageReplyMarkup', {
          chat_id: pending.chatId,
          message_id: pending.telegramMessageId,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
      }
      await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'This permission request has expired.' }).catch(() => {});
      return;
    }
    const labels = {
      once: '已允许本次',
      always: pending.persistent ? '已始终允许此类操作' : '已允许当前任务内的同类操作',
      deny: '已拒绝',
    };
    delete state.pendingPermissions[permissionId];
    saveState();
    waiter.finish(decision);
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: labels[decision] }).catch(() => {});
    await telegram('deleteMessage', {
      chat_id: pending.chatId,
      message_id: pending.telegramMessageId,
    }).catch(() => {});
    return;
  }

  const match = /^choice:([a-f0-9]{16}):(\d+)$/.exec(query.data || '');
  if (!match) return;
  const [, choiceId, rawIndex] = match;
  const pending = state.pendingChoices[choiceId];
  const option = pending?.options?.[Number(rawIndex)];
  if (!pending || !option) {
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'This choice has expired.' }).catch(() => {});
    return;
  }

  await telegram('answerCallbackQuery', { callback_query_id: query.id, text: `Selected: ${option.label}` });
  await telegram('editMessageText', {
    chat_id: pending.chatId,
    message_id: pending.telegramMessageId,
    text: `${query.message?.text || 'Choice'}\n\nSelected: ${option.label}`,
  }).catch(() => {});
  delete state.pendingChoices[choiceId];

  state.queue.push({
    id: crypto.randomUUID(),
    type: 'prompt',
    chatId: pending.chatId,
    messageId: pending.telegramMessageId,
    text: `The user selected "${option.label}". The value of their selection is: ${option.value}. Continue the previous task using this choice.`,
    createdAt: new Date().toISOString(),
  });
  saveState();
  const job = state.queue[state.queue.length - 1];
  const sent = await sendMessage(pending.chatId, 'Choice received. Working on it…')
    .catch((error) => console.error('Failed to acknowledge choice:', error.message));
  if (sent?.[0]) job.ackMessageId = sent[0].message_id;
  saveState();
  void processQueue();
}

async function poll() {
  while (!stopping) {
    try {
      const updates = await telegram('getUpdates', {
        offset: state.offset,
        timeout: 50,
        allowed_updates: ['message', 'callback_query'],
      });
      for (const update of updates) {
        // Fire-and-forget: don't let a slow handler stall the poll loop or
        // delay subsequent updates. Handlers report their own errors.
        if (update.message) {
          handleMessage(update.message).catch((err) => console.error('handleMessage failed:', err.message));
        }
        if (update.callback_query) {
          handleCallbackQuery(update.callback_query).catch((err) => console.error('handleCallbackQuery failed:', err.message));
        }
        state.offset = update.update_id + 1;
        saveState();
      }
      if (DRY_RUN_ONCE) stopping = true;
    } catch (error) {
      if (!stopping) {
        console.error(new Date().toISOString(), error.message);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping on ${signal}`);
  if (activeAbortController) activeAbortController.abort(new Error(`Stopping on ${signal}`));
  // Wait for the queue to settle, then flush pending state and exit. Hard cap
  // at SHUTDOWN_GRACE_MS so we don't hang if something is stuck.
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (processing && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  try { flushState(); } catch (err) { console.error('Failed to flush state on shutdown:', err.message); }
  process.exit(0);
}

async function clearStalePermissionPrompts() {
  const stale = Object.values(state.pendingPermissions || {});
  state.pendingPermissions = {};
  saveState();
  await Promise.all(stale.map((pending) => telegram('editMessageReplyMarkup', {
    chat_id: pending.chatId,
    message_id: pending.telegramMessageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {})));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

console.log(DRY_RUN
  ? 'Claude Telegram bridge started in dry-run mode'
  : `Claude Telegram bridge started for allowed user ${ALLOWED_USER_ID}`);
saveState();
void clearStalePermissionPrompts().finally(() => {
  void processQueue();
  void poll();
});
