// Keep Telegram's wire API at this boundary. The application owns and drains
// handler promises, so a slow map request does not block every other user.
export function telegramTransport(client, { logger = console } = {}) {
  return {
    on(kind, handler) {
      client.on(kind, context => {
        void handler(context.update[kind]).catch(() => {
          logger.error('An update handler failed.');
        });
      });
    },
    sendMessage(chatId, text, options = {}) {
      return client.api.sendMessage({ chat_id: chatId, text, ...options });
    },
    answerCallbackQuery(id, options = {}) {
      return client.api.answerCallbackQuery({ callback_query_id: id, ...options });
    },
    editMessageReplyMarkup(markup, options) {
      return client.api.editMessageReplyMarkup({ ...options, reply_markup: markup });
    }
  };
}
