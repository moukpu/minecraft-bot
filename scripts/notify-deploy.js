'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true
});

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TG_ADMIN_ID;
const elapsedSeconds = Math.max(0, Number(process.argv[2] || 0));
const commitSha = String(process.argv[3] || '').trim();
const commitMessage = String(process.argv.slice(4).join(' ') || '').trim();

if (!token || !chatId) {
  console.error('Не найдены TELEGRAM_TOKEN или TG_ADMIN_ID в .env');
  process.exit(1);
}

function formatDuration(totalSeconds) {
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const parts = [];

  if (hours) parts.push(`${hours} ч`);
  if (minutes) parts.push(`${minutes} мин`);
  if (seconds || !parts.length) parts.push(`${seconds} сек`);

  return parts.join(' ');
}

const shortSha = commitSha ? commitSha.slice(0, 7) : 'неизвестен';
const commitLine = commitMessage
  ? `${shortSha} ${commitMessage}`
  : shortSha;

const text = [
  '✅ Бот готов',
  `⏱ Время загрузки: ${formatDuration(elapsedSeconds)}`,
  `🧩 Коммит: ${commitLine}`
].join('\n');

async function main() {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram вернул ${response.status}: ${body.slice(0, 300)}`);
  }

  console.log(text.replace(/\n/g, ' | '));
}

main().catch(error => {
  console.error('Не удалось отправить уведомление о деплое:', error.message);
  process.exit(1);
});
