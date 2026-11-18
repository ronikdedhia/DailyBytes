import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { validWebhookSecret } from '../bot/bot.service';
import { botService } from '../bot';
import { sendHtml } from '../bot/telegram-api';

const router = Router();

/**
 * POST /api/telegram/webhook: Telegram delivers every message to the bot here.
 * Authenticated by the secret token set with setWebhook. Answers at once
 * (Telegram retries slow webhooks) and replies with a separate sendMessage.
 */
router.post('/telegram/webhook', (req: Request, res: Response) => {
  if (!validWebhookSecret(req.header('x-telegram-bot-api-secret-token'))) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });

  const message = req.body?.message;
  if (!message?.chat || message.chat.type !== 'private' || typeof message.text !== 'string') return;
  const chat = {
    chatId: String(message.chat.id),
    username: message.chat.username,
    firstName: message.chat.first_name,
  };
  botService
    .handleMessage(chat, message.text.slice(0, 500))
    .then((reply) => sendHtml(chat.chatId, reply))
    .catch((err) => {
      logger.error(`❌ [bot] update failed: ${err.message}`);
      return sendHtml(chat.chatId, 'Something went wrong. Please try again in a minute.');
    });
});

export default router;
