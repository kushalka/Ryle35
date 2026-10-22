// handlers/chosen_inline_result.js — пользователь отправил результат из инлайна:
// +1 к популярности поста. Ответов в этот update не отправляют.

import { bumpPost } from '../lib/booru.js';

export default async function (chosen) {
  const id = Number(chosen.result_id);
  if (!Number.isInteger(id) || id <= 0) return; // 'stub' заглушки сюда не доходит смыслом
  await bumpPost(id);
}
