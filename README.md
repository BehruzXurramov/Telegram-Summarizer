# My Telegram Summarizer

A private Telegram summarizer that listens to your own account with GramJS, builds daily and weekly summaries with Gemini 2.5 Flash, and delivers the results through a private Telegram bot.

*This project is open to improvements and fresh ideas. If you build a better version, feel free to fork it, improve it, and open a pull request. I would be happy to review and merge useful contributions. And if you like the project, giving it a star would mean a lot.*

## Highlights

- Stable runtime with guarded async flows and global error reporting
- Error notifications delivered to your Telegram bot
- Daily and weekly summaries kept in memory only
- Safer GramJS usage with a single persistent client and cached chat lookups
- Manual bot commands for `/status`, `/flush`, `/daily`, `/weekly`, and `/ping`
- Git-ready project structure with a private `.env`

## Environment Variables

Create a `.env` file with:

```env
API_ID=your_telegram_api_id
API_HASH=your_telegram_api_hash
SESSION=your_saved_gramjs_session
GEMINI_API_KEY=your_google_ai_studio_key
BOT_API_KEY=your_telegram_bot_token
MY_TELEGRAM_ID=your_numeric_telegram_user_id
REPORT_TIMEZONE=Asia/Tashkent
```

## Commands

```bash
npm run session
npm run check
npm start
```

## Bot Commands

- `/status` shows runtime health details
- `/flush` converts the current message buffer into an intermediate daily summary chunk
- `/daily` triggers the daily summary immediately
- `/weekly` triggers the weekly summary immediately
- `/ping` confirms that the bot is alive

## Scheduling

- Daily summary: every day at `21:00`
- Weekly summary: every Sunday at `21:05`
- Time zone: `REPORT_TIMEZONE`, defaulting to `Asia/Tashkent`

## Notes

- The bot is private and only responds to the owner account.
- If Telegram MarkdownV2 formatting fails, the app falls back to plain text instead of crashing.
- Summaries are not persisted to disk. Runtime memory is used intentionally.
