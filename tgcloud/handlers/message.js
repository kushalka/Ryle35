// handlers/message.js — runs on each `message` update. Any message gets a short
// inline-mode hint plus a button that drops the user straight into inline mode
// in the current chat (Telegram inserts our @username into the input field).

import { api, BotApiError } from 'sdk';

export default async function (message) {
  try {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: 'Для поиска введи @Ryle35_bot',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔎 Поиск', switch_inline_query_current_chat: '' },
        ]],
      },
    });
  } catch (e) {
    // В группах без права писать (и при флуд-лимите) каждый message валил хендлер:
    // 403/420/429 — норма (420/429 — флуд-лимит), глотаем; прочее — реальная
    // ошибка, пусть падает.
    if (!(e instanceof BotApiError && (e.code === 403 || e.code === 420 || e.code === 429))) throw e;
    console.log('sendMessage skipped:', e.code, e.description);
  }
}
