import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { Api, TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/NewMessage.js";
import { StringSession } from "telegram/sessions/index.js";
import { createControlBot } from "./bot.js";
import {
  buildDailySummaryPrompt,
  buildPartialSummaryPrompt,
  buildWeeklySummaryPrompt,
} from "./prompts.js";

const SCHEDULE_POLL_INTERVAL_MS = 30_000;
const TELEGRAM_CONNECTION_RETRIES = 5;
const TELEGRAM_CONNECTION_MAX_RETRIES = 10;
const TELEGRAM_CONNECTION_BASE_DELAY_MS = 5_000;
const TELEGRAM_CONNECTION_MAX_DELAY_MS = 60_000;
const PARTIAL_FLUSH_CHARACTER_LIMIT = 120_000;
const BUFFER_HARD_CAP_CHARACTERS = 500_000;
const AI_RETRY_ATTEMPTS = 3;
const AI_RETRY_DELAY_MS = 15_000;
const AI_DAILY_REQUEST_LIMIT = 16;
const ERROR_REPORT_WINDOW_MS = 60_000;
const ERROR_REPORT_MAX_PER_WINDOW = 5;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const DAILY_SCHEDULE = { hour: 21, minute: 0 };
const WEEKLY_SCHEDULE = { weekday: "Sun", hour: 21, minute: 5 };

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readRequiredNumberEnv(name) {
  const value = Number(readRequiredEnv(name));

  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be a valid integer`);
  }

  return value;
}

const config = Object.freeze({
  apiId: readRequiredNumberEnv("API_ID"),
  apiHash: readRequiredEnv("API_HASH"),
  sessionString: readRequiredEnv("SESSION"),
  geminiApiKey: readRequiredEnv("GEMINI_API_KEY"),
  botToken: readRequiredEnv("BOT_API_KEY"),
  ownerTelegramId: readRequiredNumberEnv("MY_TELEGRAM_ID"),
  reportTimeZone: process.env.REPORT_TIMEZONE?.trim() || "Asia/Tashkent",
});

// All summary state intentionally stays in memory so the app remains simple
// and avoids persisting personal message data to disk.
const state = {
  startedAt: new Date(),
  dailyMessageBuffer: {},
  dailyPartialSummaries: [],
  weeklyDailySummaries: [],
  dailyCharacterCount: 0,
  weeklyCharacterCount: 0,
  chatInfoCache: new Map(),
  workflow: Promise.resolve(),
  flushQueued: false,
  schedulerHandle: null,
  shuttingDown: false,
  errorReportTimestamps: [],
  aiDailyRequestCount: 0,
  aiDailyRequestResetKey: null,
  stats: {
    capturedMessages: 0,
    partialFlushes: 0,
    aiRequests: 0,
    aiRequestsSkipped: 0,
    errorCount: 0,
    errorsSuppressed: 0,
    messagesDropped: 0,
  },
  schedulerState: {
    lastDailyRunKey: null,
    lastWeeklyRunKey: null,
  },
};

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

const telegramClient = new TelegramClient(
  new StringSession(config.sessionString),
  config.apiId,
  config.apiHash,
  {
    connectionRetries: TELEGRAM_CONNECTION_RETRIES,
  },
);

const controlBot = createControlBot({
  token: config.botToken,
  ownerTelegramId: config.ownerTelegramId,
  onStatusRequested: buildStatusReport,
  onDailySummaryRequested: () =>
    enqueueWorkflow("manual daily summary", async () => {
      await runDailySummary("manual");
      return "Daily summary request completed.";
    }),
  onWeeklySummaryRequested: () =>
    enqueueWorkflow("manual weekly summary", async () => {
      await runWeeklySummary("manual");
      return "Weekly summary request completed.";
    }),
  onFlushRequested: () =>
    enqueueWorkflow("manual buffer flush", async () => {
      const summary = await flushCurrentBufferToPartialSummary("manual flush");
      return summary
        ? "Current message buffer was summarized into an intermediate daily chunk."
        : "There were no buffered messages to summarize.";
  }),
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function mergeMessageBuffers(primaryBuffer, secondaryBuffer) {
  const mergedBuffer = { ...primaryBuffer };

  for (const [chatId, chatPayload] of Object.entries(secondaryBuffer)) {
    if (!mergedBuffer[chatId]) {
      mergedBuffer[chatId] = chatPayload;
      continue;
    }

    mergedBuffer[chatId] = {
      ...mergedBuffer[chatId],
      ...chatPayload,
      chat_info: mergedBuffer[chatId].chat_info || chatPayload.chat_info,
    };
  }

  return mergedBuffer;
}

function formatError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || "No stack trace available.",
    };
  }

  return {
    name: "UnknownError",
    message: typeof error === "string" ? error : JSON.stringify(error),
    stack: "No stack trace available.",
  };
}

function isErrorReportingAllowed() {
  const now = Date.now();

  state.errorReportTimestamps = state.errorReportTimestamps.filter(
    (ts) => now - ts < ERROR_REPORT_WINDOW_MS,
  );

  if (state.errorReportTimestamps.length >= ERROR_REPORT_MAX_PER_WINDOW) {
    return false;
  }

  state.errorReportTimestamps.push(now);
  return true;
}

async function reportError(error, context) {
  state.stats.errorCount += 1;

  const details = formatError(error);
  const consoleMessage = `[${new Date().toISOString()}] ${context}\n${details.name}: ${details.message}\n${details.stack}`;

  console.error(consoleMessage);

  if (!isErrorReportingAllowed()) {
    state.stats.errorsSuppressed += 1;
    console.warn(
      `[${new Date().toISOString()}] Error notification suppressed (rate limit). Total suppressed: ${state.stats.errorsSuppressed}`,
    );
    return;
  }

  await controlBot.notifyError({
    context,
    message: details.message,
    stack: truncateText(details.stack, 2500),
  });
}

function enqueueWorkflow(label, task) {
  // Gemini requests and scheduled jobs are serialized through one queue so
  // partial flushes, daily summaries, and weekly summaries cannot overlap.
  const run = state.workflow.then(task);

  state.workflow = run.catch(async (error) => {
      await reportError(error, `Workflow failure: ${label}`);
    });

  return run;
}

function getBufferCharacterCount() {
  return JSON.stringify(state.dailyMessageBuffer).length;
}

function hasBufferedMessages() {
  return Object.keys(state.dailyMessageBuffer).length > 0;
}

function getTimeZoneParts(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.reportTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}h ${minutes}m ${seconds}s`;
}

function checkAndIncrementAiBudget() {
  const todayKey = getTimeZoneParts(new Date()).dateKey;

  if (state.aiDailyRequestResetKey !== todayKey) {
    state.aiDailyRequestResetKey = todayKey;
    state.aiDailyRequestCount = 0;
  }

  if (state.aiDailyRequestCount >= AI_DAILY_REQUEST_LIMIT) {
    return false;
  }

  state.aiDailyRequestCount += 1;
  return true;
}

async function generateTextWithRetry(prompt, reason) {
  let lastError = null;

  for (let attempt = 1; attempt <= AI_RETRY_ATTEMPTS; attempt += 1) {
    if (!checkAndIncrementAiBudget()) {
      state.stats.aiRequestsSkipped += 1;
      throw new Error(
        `Daily AI request limit reached (${AI_DAILY_REQUEST_LIMIT}/${AI_DAILY_REQUEST_LIMIT}). Skipping: ${reason}`,
      );
    }

    try {
      state.stats.aiRequests += 1;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });

      const text = response.text?.trim();

      if (!text) {
        throw new Error(`Gemini returned an empty response for ${reason}`);
      }

      return text;
    } catch (error) {
      lastError = error;

      if (attempt < AI_RETRY_ATTEMPTS) {
        await sleep(AI_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(
    `Gemini request failed for ${reason}: ${formatError(lastError).message}`,
  );
}

async function getChatInfoSnapshot(message) {
  const chatId = String(message.chatId);

  if (state.chatInfoCache.has(chatId)) {
    return state.chatInfoCache.get(chatId);
  }

  const fallbackChatInfo = {
    type: message.isPrivate ? "Private chat" : message.isGroup ? "Group" : "Channel",
    title: "Unknown chat",
    username: "",
    is_bot: false,
  };

  try {
    const chat = await message.getChat();
    const snapshot = {
      type: fallbackChatInfo.type,
      title:
        [chat?.firstName, chat?.lastName, chat?.title]
          .filter(Boolean)
          .join(" ")
          .trim() || fallbackChatInfo.title,
      username: chat?.username ? `@${chat.username}` : "",
      is_bot: Boolean(chat?.bot),
    };

    state.chatInfoCache.set(chatId, snapshot);
    return snapshot;
  } catch (error) {
    await reportError(error, `Reading Telegram chat metadata for chat ${chatId}`);
    state.chatInfoCache.set(chatId, fallbackChatInfo);
    return fallbackChatInfo;
  }
}

async function flushCurrentBufferToPartialSummary(reason) {
  if (!hasBufferedMessages()) {
    state.flushQueued = false;
    return null;
  }

  const bufferToSummarize = state.dailyMessageBuffer;
  state.dailyMessageBuffer = {};

  try {
    // The live buffer is swapped out before the AI call so new incoming messages
    // continue collecting safely while Gemini is working on the current chunk.
    const serializedBuffer = JSON.stringify(bufferToSummarize);
    const prompt = buildPartialSummaryPrompt(serializedBuffer);
    const summary = await generateTextWithRetry(
      prompt,
      `partial summary (${reason})`,
    );

    state.dailyPartialSummaries.push(summary);
    state.dailyCharacterCount += serializedBuffer.length;
    state.weeklyCharacterCount += serializedBuffer.length;
    state.stats.partialFlushes += 1;

    return summary;
  } catch (error) {
    state.dailyMessageBuffer = mergeMessageBuffers(
      bufferToSummarize,
      state.dailyMessageBuffer,
    );
    throw error;
  } finally {
    state.flushQueued = false;
  }
}

async function runDailySummary(trigger) {
  let summaryText = "";

  if (hasBufferedMessages()) {
    await flushCurrentBufferToPartialSummary(`${trigger} final flush`);
  }

  if (state.dailyPartialSummaries.length === 0) {
    summaryText =
      "Bugun sarhisob uchun yetarli yozishma topilmadi. Ertaga yanada boyroq kun bo'lsin.";
  } else if (state.dailyPartialSummaries.length === 1) {
    summaryText = state.dailyPartialSummaries[0];
  } else {
    const prompt = buildDailySummaryPrompt(
      JSON.stringify(state.dailyPartialSummaries),
    );
    summaryText = await generateTextWithRetry(
      prompt,
      `daily summary (${trigger})`,
    );
  }

  if (state.dailyPartialSummaries.length > 0) {
    state.weeklyDailySummaries.push(summaryText);
  }

  await controlBot.sendReport(
    `${summaryText}\n\nDaily input characters: ${state.dailyCharacterCount}`,
  );

  state.dailyPartialSummaries = [];
  state.dailyCharacterCount = 0;
}

async function runWeeklySummary(trigger) {
  if (state.weeklyDailySummaries.length === 0) {
    await controlBot.sendPlainText(
      "Weekly summary skipped because no daily summaries have been produced yet.",
    );
    return;
  }

  const prompt = buildWeeklySummaryPrompt(
    JSON.stringify(state.weeklyDailySummaries),
  );
  const summaryText = await generateTextWithRetry(
    prompt,
    `weekly summary (${trigger})`,
  );

  await controlBot.sendReport(
    `${summaryText}\n\nWeekly input characters: ${state.weeklyCharacterCount}`,
  );

  state.weeklyDailySummaries = [];
  state.weeklyCharacterCount = 0;
  state.chatInfoCache.clear();
}

function buildStatusReport() {
  const uptime = formatDuration(Date.now() - state.startedAt.getTime());
  const now = getTimeZoneParts(new Date());

  return [
    "Telegram Summarizer Status",
    `Time zone: ${config.reportTimeZone}`,
    `Current local time: ${now.dateKey} ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`,
    `Uptime: ${uptime}`,
    `Telegram connected: ${telegramClient.connected ? "yes" : "no"}`,
    `Buffered chats: ${Object.keys(state.dailyMessageBuffer).length}`,
    `Buffered characters: ${getBufferCharacterCount()}`,
    `Daily partial summaries: ${state.dailyPartialSummaries.length}`,
    `Weekly stored daily summaries: ${state.weeklyDailySummaries.length}`,
    `Captured messages: ${state.stats.capturedMessages}`,
    `Messages dropped (buffer cap): ${state.stats.messagesDropped}`,
    `Partial flushes: ${state.stats.partialFlushes}`,
    `AI requests today: ${state.aiDailyRequestCount}/${AI_DAILY_REQUEST_LIMIT}`,
    `AI requests total: ${state.stats.aiRequests}`,
    `AI requests skipped (limit): ${state.stats.aiRequestsSkipped}`,
    `Errors observed: ${state.stats.errorCount}`,
    `Error notifications suppressed: ${state.stats.errorsSuppressed}`,
    `Cached chats: ${state.chatInfoCache.size}`,
  ].join("\n");
}

async function handleIncomingMessage(event) {
  try {
    const message = event.message;
    const text = message?.message?.trim();

    if (!text) {
      return;
    }

    // Drop messages if the buffer is extremely large (AI flush failures).
    if (getBufferCharacterCount() >= BUFFER_HARD_CAP_CHARACTERS) {
      state.stats.messagesDropped += 1;
      return;
    }

    const chatId = String(message.chatId);

    if (!state.dailyMessageBuffer[chatId]) {
      state.dailyMessageBuffer[chatId] = {
        chat_info: await getChatInfoSnapshot(message),
      };
    }

    state.dailyMessageBuffer[chatId][String(message.id)] =
      message.out ? `[ME] ${text}` : text;
    state.stats.capturedMessages += 1;

    if (
      getBufferCharacterCount() >= PARTIAL_FLUSH_CHARACTER_LIMIT &&
      !state.flushQueued
    ) {
      state.flushQueued = true;

      void enqueueWorkflow("automatic partial flush", async () => {
        await flushCurrentBufferToPartialSummary("buffer limit");
      });
    }
  } catch (error) {
    await reportError(error, "Handling incoming Telegram message");
  }
}

async function checkSchedules() {
  // We poll once per interval and use date keys to guarantee each report runs
  // at most once per scheduled minute.
  const now = getTimeZoneParts(new Date());

  if (
    now.hour === DAILY_SCHEDULE.hour &&
    now.minute === DAILY_SCHEDULE.minute &&
    state.schedulerState.lastDailyRunKey !== now.dateKey
  ) {
    state.schedulerState.lastDailyRunKey = now.dateKey;

    void enqueueWorkflow("scheduled daily summary", async () => {
      await runDailySummary("schedule");
    });
  }

  if (
    now.weekday === WEEKLY_SCHEDULE.weekday &&
    now.hour === WEEKLY_SCHEDULE.hour &&
    now.minute === WEEKLY_SCHEDULE.minute &&
    state.schedulerState.lastWeeklyRunKey !== now.dateKey
  ) {
    state.schedulerState.lastWeeklyRunKey = now.dateKey;

    void enqueueWorkflow("scheduled weekly summary", async () => {
      await runWeeklySummary("schedule");
    });
  }
}

async function connectTelegramClient() {
  for (
    let attempt = 1;
    attempt <= TELEGRAM_CONNECTION_MAX_RETRIES && !state.shuttingDown;
    attempt += 1
  ) {
    try {
      await telegramClient.connect();
      // Keep the account from looking artificially active just because the
      // summarizer process is connected in the background.
      await telegramClient.invoke(new Api.account.UpdateStatus({ offline: true }));
      return true;
    } catch (error) {
      await reportError(
        error,
        `Connecting the Telegram user client (attempt ${attempt}/${TELEGRAM_CONNECTION_MAX_RETRIES})`,
      );

      if (attempt < TELEGRAM_CONNECTION_MAX_RETRIES) {
        const delay = Math.min(
          TELEGRAM_CONNECTION_BASE_DELAY_MS * 2 ** (attempt - 1),
          TELEGRAM_CONNECTION_MAX_DELAY_MS,
        );
        await sleep(delay);
      }
    }
  }

  console.error(
    `[${new Date().toISOString()}] Exhausted all ${TELEGRAM_CONNECTION_MAX_RETRIES} connection attempts. Exiting.`,
  );
  process.exit(1);
}

async function launchBot() {
  try {
    await controlBot.launch();
  } catch (error) {
    await reportError(error, "Launching the Telegram control bot");
  }
}

async function shutdown(signal) {
  if (state.shuttingDown) {
    return;
  }

  state.shuttingDown = true;

  // Force-kill the process if graceful cleanup hangs.
  const forceExitTimer = setTimeout(() => {
    console.error(
      `[${new Date().toISOString()}] Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms. Forcing exit.`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  if (state.schedulerHandle) {
    clearInterval(state.schedulerHandle);
    state.schedulerHandle = null;
  }

  try {
    await controlBot.sendPlainText(`Shutdown signal received: ${signal}`);
  } catch {
    // Ignore shutdown-notification errors.
  }

  try {
    await telegramClient.disconnect();
  } catch (error) {
    await reportError(error, "Disconnecting the Telegram client");
  }

  try {
    await controlBot.stop(signal);
  } catch (error) {
    await reportError(error, "Stopping the Telegram control bot");
  }

  process.exit(0);
}

process.on("unhandledRejection", (error) => {
  void reportError(error, "Unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
  void reportError(error, "Uncaught exception").finally(() => {
    void shutdown("uncaughtException");
  });
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

async function start() {
  if (state.shuttingDown) {
    return;
  }

  await launchBot();
  const telegramConnected = await connectTelegramClient();

  if (!telegramConnected || state.shuttingDown) {
    return;
  }

  // The GramJS client listens passively; outgoing summary work is handled by
  // the separate control bot.
  telegramClient.addEventHandler(handleIncomingMessage, new NewMessage({}));

  state.schedulerHandle = setInterval(() => {
    void checkSchedules();
  }, SCHEDULE_POLL_INTERVAL_MS);

  await controlBot.sendPlainText(
    [
      "Telegram summarizer is online.",
      `Time zone: ${config.reportTimeZone}`,
      `Daily summary: ${String(DAILY_SCHEDULE.hour).padStart(2, "0")}:${String(DAILY_SCHEDULE.minute).padStart(2, "0")}`,
      `Weekly summary: ${WEEKLY_SCHEDULE.weekday} ${String(WEEKLY_SCHEDULE.hour).padStart(2, "0")}:${String(WEEKLY_SCHEDULE.minute).padStart(2, "0")}`,
    ].join("\n"),
  );

  await checkSchedules();
}

start().catch(async (error) => {
  await reportError(error, "Application startup");
});
