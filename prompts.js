const BASE_RULES = `
GENERAL RULES:
- Use only the information that exists in the input.
- Do not invent facts, links, people, or outcomes.
- Keep the response under 4000 characters.
- Output in Uzbek.
- Prefer Latin script unless the source strongly suggests otherwise.
- Keep the structure clean, concise, and useful.
- Ignore spam, filler, repeated chatter, and low-value formalities.
- The user mostly cares about programming, startups, business opportunities, practical learning, meaningful news, and useful personal reminders.
- Do not expose raw JSON, chat IDs, or message IDs without context.
- Avoid raw URLs in the visible text.
- When referencing an important message, embed a single Telegram link naturally using:
  [short label](https://t.me/c/<chat_id>/<message_id>)
- Return Telegram MarkdownV2-compatible text when possible.
- Escape Telegram MarkdownV2 special characters correctly.
- If safe MarkdownV2 formatting becomes difficult, keep formatting minimal instead of producing broken markup.
`;

export function buildPartialSummaryPrompt(serializedMessages) {
  return `
You are preparing an intermediate summary of Telegram messages for one user.

INPUT FORMAT:
- The input is a JSON string.
- Top-level keys are chat IDs.
- Each chat contains:
  - chat_info
  - message_id: message_text pairs

TASK:
- Extract only the meaningful information.
- Focus on important ideas, opportunities, useful technical details, noteworthy plans, and valuable updates.
- Keep each point compact and practical.

RECOMMENDED SECTIONS:
- Muhim fikrlar
- Imkoniyatlar
- IT va texnologiya
- Yangiliklar
- Eslatmalar
- Boshqa muhim narsalar

EXTRA:
- Add a short light joke at the end under "Hazil".

${BASE_RULES}

CONTENT:
${serializedMessages}
`.trim();
}

export function buildDailySummaryPrompt(serializedPartialSummaries) {
  return `
You are combining multiple intermediate Telegram summaries into one polished daily report.

TASK:
- Merge overlapping points.
- Remove repetition completely.
- Keep only the most useful signals from the day.
- Produce a professional, easy-to-scan final daily summary.

RECOMMENDED SECTIONS:
- Muhim fikrlar
- Imkoniyatlar
- IT va texnologiya
- Yangiliklar
- Eslatmalar
- Boshqa muhim narsalar

EXTRA:
- End with "Kun hazili".

${BASE_RULES}

CONTENT:
${serializedPartialSummaries}
`.trim();
}

export function buildWeeklySummaryPrompt(serializedDailySummaries) {
  return `
You are analyzing several daily Telegram summaries to produce a sharp weekly report.

TASK:
- Identify repeated themes and long-term patterns.
- Highlight the most important opportunities.
- Show progress, momentum, blockers, or distractions.
- Prefer insight over description.

RECOMMENDED SECTIONS:
- Haftalik umumiy holat
- Asosiy g'oyalar va takrorlangan mavzular
- Eng muhim imkoniyatlar
- Progress
- Diqqat talab qiladigan narsalar
- Muhim eslatmalar

EXTRA:
- End with "Hafta hazili".

${BASE_RULES}

CONTENT:
${serializedDailySummaries}
`.trim();
}
