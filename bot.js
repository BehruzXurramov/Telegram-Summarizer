import { Telegraf } from "telegraf";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_MARKDOWN_SAFE_LIMIT = 3900;

const OWNER_WELCOME_MESSAGE = [
  "Telegram Summarizer is ready.",
  "Available commands:",
  "/status - runtime health report",
  "/flush - summarize the current buffer into a daily chunk",
  "/daily - send the daily summary immediately",
  "/weekly - send the weekly summary immediately",
  "/ping - quick liveness check",
].join("\n");

const UNAUTHORIZED_MESSAGE =
  "This bot is private and only available to the project owner.";

function splitIntoChunks(text, maxLength = TELEGRAM_MESSAGE_LIMIT) {
  if (!text) {
    return [];
  }

  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);

    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }

    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function formatErrorNotification({ context, message, stack }) {
  return [
    "Telegram Summarizer Error",
    `Context: ${context}`,
    `Message: ${message}`,
    "",
    "Stack:",
    stack || "No stack trace available.",
  ].join("\n");
}

export function createControlBot({
  token,
  ownerTelegramId,
  onStatusRequested,
  onDailySummaryRequested,
  onWeeklySummaryRequested,
  onFlushRequested,
}) {
  const bot = new Telegraf(token);

  function isOwner(ctx) {
    return Number(ctx.from?.id) === ownerTelegramId;
  }

  async function sendPlainText(text, chatId = ownerTelegramId) {
    for (const chunk of splitIntoChunks(text)) {
      await bot.telegram.sendMessage(chatId, chunk, {
        disable_web_page_preview: true,
      });
    }
  }

  async function sendReport(text) {
    if (!text) {
      return;
    }

    // We try MarkdownV2 first for nicer summaries, then fall back to plain text
    // so formatting issues never block delivery.
    if (text.length <= TELEGRAM_MARKDOWN_SAFE_LIMIT) {
      try {
        await bot.telegram.sendMessage(ownerTelegramId, text, {
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        });
        return;
      } catch (error) {
        await notifyError({
          context: "Sending MarkdownV2 report",
          message:
            error instanceof Error ? error.message : "Unknown Telegram send error",
          stack: error instanceof Error ? error.stack : "No stack trace available.",
        });
      }
    }

    await sendPlainText(text);
  }

  async function notifyError(errorDetails) {
    try {
      await sendPlainText(formatErrorNotification(errorDetails));
    } catch (error) {
      console.error("Failed to send bot error notification:", error);
    }
  }

  async function handleOwnerCommand(ctx, action) {
    if (!isOwner(ctx)) {
      await ctx.reply(UNAUTHORIZED_MESSAGE);
      return;
    }

    try {
      const response = await action();

      if (response) {
        await ctx.reply(response, {
          disable_web_page_preview: true,
        });
      }
    } catch (error) {
      await notifyError({
        context: `Handling bot command ${ctx.message?.text || "unknown"}`,
        message: error instanceof Error ? error.message : "Unknown command error",
        stack: error instanceof Error ? error.stack : "No stack trace available.",
      });
      await ctx.reply("The request failed, but the error was reported.");
    }
  }

  bot.catch(async (error, ctx) => {
    await notifyError({
      context: `Bot middleware failure on update ${ctx.updateType}`,
      message: error instanceof Error ? error.message : "Unknown bot middleware error",
      stack: error instanceof Error ? error.stack : "No stack trace available.",
    });
  });

  bot.start((ctx) =>
    handleOwnerCommand(ctx, async () => OWNER_WELCOME_MESSAGE),
  );

  bot.command("ping", (ctx) =>
    handleOwnerCommand(ctx, async () => "Bot is alive and listening."),
  );

  bot.command("status", (ctx) =>
    handleOwnerCommand(ctx, async () => onStatusRequested()),
  );

  bot.command("flush", (ctx) =>
    handleOwnerCommand(ctx, async () => onFlushRequested()),
  );

  bot.command("daily", (ctx) =>
    handleOwnerCommand(ctx, async () => onDailySummaryRequested()),
  );

  bot.command("weekly", (ctx) =>
    handleOwnerCommand(ctx, async () => onWeeklySummaryRequested()),
  );

  async function launch() {
    // Commands are registered mainly for convenience when you open the bot
    // manually and want a quick operational action.
    await bot.telegram.setMyCommands([
      { command: "status", description: "Show runtime health information" },
      { command: "flush", description: "Summarize the current message buffer" },
      { command: "daily", description: "Trigger the daily summary now" },
      { command: "weekly", description: "Trigger the weekly summary now" },
      { command: "ping", description: "Quick bot liveness check" },
    ]);

    // bot.launch() starts long-polling internally.  We intentionally do NOT
    // await it because the returned promise only settles when polling stops
    // (i.e. on shutdown), which would block the rest of the startup sequence.
    // Errors are forwarded to the console so they are never silently swallowed.
    bot.launch({
      dropPendingUpdates: true,
    }).catch((error) => {
      console.error(
        `[${new Date().toISOString()}] [ERROR] Telegraf polling crashed:`,
        error,
      );
    });

    // Give Telegraf a moment to delete the webhook and start its first poll
    // cycle so the bot is responsive by the time we continue.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  async function stop(reason = "stop") {
    bot.stop(reason);
  }

  return {
    launch,
    stop,
    sendPlainText,
    sendReport,
    notifyError,
  };
}
