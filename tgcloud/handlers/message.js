// handlers/message.js — runs on each `message` update. Any message gets a short
// inline-mode hint plus a button that drops the user straight into inline mode
// in the current chat (Telegram inserts our @username into the input field).

import { api } from 'sdk';

export default async function (message) {
  await api.sendMessage({
    chat_id: message.chat.id,
    text: 'Для поиска введи @Ryle35_bot',
    reply_markup: {
      inline_keyboard: [[
        { text: '🔎 Поиск', switch_inline_query_current_chat: '' },
      ]],
    },
  });
}
