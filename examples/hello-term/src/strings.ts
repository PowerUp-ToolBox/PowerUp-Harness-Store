/**
 * Everything hello-term prints in the app's language, `HARNESS_LOCALE` (`en` or `zh-CN`). A small
 * inline table is enough for a reference Harness; a larger one would load a catalog per locale.
 * The commands `/model` and `/quit` stay in English in both languages: they are what the User types.
 */
import type { Locale } from '@harness-store/sdk';

export interface Strings {
  /** Printed under the banner: how to use the loop. */
  readonly hint: string;
  /** The Workspace line printed at startup, when the User chose a folder. */
  readonly workspace: (path: string) => string;
  /** What `/model` prints for a Model Slot no model is bound to. */
  readonly unbound: string;
  /** A message could not be answered because no model is bound to `slot`. */
  readonly slotUnbound: (slot: string) => string;
  /** Any other error from the Model Gateway, or no answer from it at all. */
  readonly gatewayError: (message: string) => string;
  /** Printed on `/quit`, Ctrl-C or end of input. */
  readonly bye: string;
}

const EN: Strings = {
  hint: 'Type a message and press Enter. /model shows the model of each Model Slot, /quit exits.',
  workspace: (path) => `Workspace: ${path}`,
  unbound: 'unbound: bind a model on the Models page of Harness Store',
  slotUnbound: (slot) =>
    `No model is bound to the Model Slot "${slot}". Bind one on the Models page of Harness Store, then send your message again.`,
  gatewayError: (message) => `The Model Gateway could not answer: ${message}`,
  bye: 'Bye.',
};

const ZH_CN: Strings = {
  hint: '输入消息后按 Enter。/model 显示每个模型槽位的模型，/quit 退出。',
  workspace: (path) => `工作目录：${path}`,
  unbound: '未绑定：请在 Harness Store 的模型页绑定一个模型',
  slotUnbound: (slot) =>
    `模型槽位“${slot}”还没有绑定模型。请在 Harness Store 的模型页绑定一个，然后重新发送消息。`,
  gatewayError: (message) => `Model Gateway 无法回答：${message}`,
  bye: '再见。',
};

export function stringsFor(locale: Locale): Strings {
  return locale === 'zh-CN' ? ZH_CN : EN;
}
