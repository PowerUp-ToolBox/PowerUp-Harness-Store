/**
 * The chat page, as one HTML string with its CSS and script inline: there are no files to find at
 * runtime (the working directory is the Data Directory, not the Harness folder), and nothing is
 * loaded from anywhere but this origin.
 *
 * The page keeps the conversation and posts all of it to its own backend, `POST /chat`, reading
 * the answer as a stream of events from the response body (`EventSource` cannot POST). Its English
 * and Simplified Chinese strings are both here; it starts in `HARNESS_LOCALE`, which the server
 * writes into `<html lang>`, and the language menu switches it for this session.
 *
 * Stable element ids for tests and automation: `#message` (the input), `#send`, `#reply` (the
 * latest answer) and `#model` (the `provider/model` that wrote it).
 */
import type { Locale } from '@harness-store/sdk';

/** The page's script. Plain ES2022, no template literals, so it sits in the string below as is. */
const SCRIPT = String.raw`
const STRINGS = {
  en: {
    language: 'Language',
    empty: 'Ask anything. Your message goes to the model bound to the default Model Slot in Harness Store.',
    placeholder: 'Message the default Model Slot',
    send: 'Send',
    answeredBy: 'Answered by',
    slotUnbound: 'No model is bound to the Model Slot "default". Bind one on the Models page of Harness Store, then send your message again.',
    gatewayError: 'The Model Gateway could not answer: {message}',
    interrupted: 'The answer stopped before it was complete.',
  },
  'zh-CN': {
    language: '语言',
    empty: '随便问点什么。消息会发给你在 Harness Store 中为 default 模型槽位绑定的模型。',
    placeholder: '向 default 模型槽位发送消息',
    send: '发送',
    answeredBy: '回答模型',
    slotUnbound: '模型槽位“default”还没有绑定模型。请在 Harness Store 的模型页绑定一个，然后重新发送消息。',
    gatewayError: 'Model Gateway 无法回答：{message}',
    interrupted: '回答在完成之前中断了。',
  },
};

const root = document.documentElement;
const languageMenu = document.getElementById('locale');
const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('message');
const sendButton = document.getElementById('send');
const answered = document.getElementById('answered');
const modelName = document.getElementById('model');

let locale = Object.hasOwn(STRINGS, root.lang) ? root.lang : 'en';
/** The conversation so far: what /chat gets on every message. */
const history = [];

const t = (key) => STRINGS[locale][key];

function localize() {
  root.lang = locale;
  languageMenu.value = locale;
  for (const element of document.querySelectorAll('[data-text]')) {
    element.textContent = t(element.dataset.text);
  }
  input.placeholder = t('placeholder');
  input.setAttribute('aria-label', t('placeholder'));
  for (const bubble of log.querySelectorAll('[data-error]')) {
    bubble.textContent = errorText(bubble.dataset.error, bubble.dataset.message);
  }
}

function errorText(code, message) {
  if (code === 'slot_unbound') return t('slotUnbound');
  if (code === 'interrupted') return t('interrupted');
  // A function, so a $& or $' in the Provider's message is shown as written, not expanded.
  return t('gatewayError').replace('{message}', () => message);
}

function bubble(role, text) {
  document.getElementById('empty')?.remove();
  const element = document.createElement('div');
  element.className = 'bubble ' + role;
  element.textContent = text;
  log.append(element);
  log.scrollTop = log.scrollHeight;
  return element;
}

/** Calls handle(event, data) for every complete event in the stream of /chat. */
async function readEvents(response, handle) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data !== '') handle(event, JSON.parse(data));
    }
  }
}

async function send(text) {
  history.push({ role: 'user', content: text });
  bubble('user', text);
  document.getElementById('reply')?.removeAttribute('id');
  const reply = bubble('assistant', '');
  reply.id = 'reply';
  reply.setAttribute('aria-busy', 'true');
  sendButton.disabled = true;

  let answer = '';
  let outcome = { code: 'interrupted', message: '' };
  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      outcome = { code: body.error?.code ?? 'unknown', message: body.error?.message ?? String(response.status) };
    } else {
      await readEvents(response, (event, data) => {
        if (event === 'token') {
          answer += data.text;
          reply.textContent = answer;
          log.scrollTop = log.scrollHeight;
        } else if (event === 'done') {
          outcome = null;
          modelName.textContent = data.model;
          answered.hidden = false;
        } else if (event === 'error') {
          outcome = data;
        }
      });
    }
  } catch (error) {
    outcome = { code: 'unknown', message: error.message };
  }
  if (outcome === null) {
    history.push({ role: 'assistant', content: answer });
  } else {
    // An unanswered message leaves the conversation as it was before it.
    history.pop();
    reply.classList.add('error');
    reply.setAttribute('role', 'alert');
    reply.dataset.error = outcome.code;
    reply.dataset.message = outcome.message;
    reply.textContent = errorText(outcome.code, outcome.message);
  }
  reply.removeAttribute('aria-busy');
  sendButton.disabled = false;
  input.focus();
}

languageMenu.addEventListener('change', () => {
  locale = languageMenu.value;
  localize();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === '' || sendButton.disabled) return;
  input.value = '';
  void send(text);
});
localize();
input.focus();
`;

export function page(locale: Locale): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hello Web</title>
<link rel="icon" href="data:,">
<style>
  :root {
    color-scheme: light;
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    color: #1c1d21;
    background: #ffffff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #ffffff; }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 22px; border-bottom: 1px solid #e4e2dc;
  }
  .badge {
    width: 28px; height: 28px; border-radius: 7px; background: #0f766e; color: #ffffff;
    display: grid; place-items: center; font-size: 12px; font-weight: 700;
  }
  h1 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }
  header label { font-size: 12px; color: #45484f; display: flex; align-items: center; gap: 6px; }
  select {
    font: inherit; font-size: 12px; min-height: 28px; padding: 0 6px;
    border: 1px solid #cfcdc6; border-radius: 8px; background: #ffffff; color: inherit;
  }
  #log {
    flex: 1; min-height: 0; overflow: auto; padding: 22px;
    display: flex; flex-direction: column; gap: 12px;
  }
  #empty { margin: auto; max-width: 420px; text-align: center; color: #55585f; line-height: 1.5; }
  .bubble {
    max-width: 560px; padding: 10px 14px; border-radius: 12px;
    line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .bubble.user { align-self: flex-end; background: #1c1d21; color: #ffffff; }
  .bubble.assistant { align-self: flex-start; background: #f1f0ec; color: #1c1d21; }
  .bubble.assistant:empty::after { content: "…"; color: #8c8f96; }
  .bubble.error { background: #fdecea; color: #8f1f14; }
  footer { padding: 0 22px 18px; display: flex; flex-direction: column; gap: 8px; }
  #answered { margin: 0; font-size: 12px; color: #55585f; }
  #model { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #1c1d21; }
  form { display: flex; gap: 8px; }
  #message {
    flex: 1; min-height: 40px; padding: 0 12px; font: inherit; color: inherit;
    border: 1px solid #cfcdc6; border-radius: 10px;
  }
  #send {
    min-height: 40px; padding: 0 16px; font: inherit; font-weight: 600; border-radius: 10px;
    border: 1px solid #1c1d21; background: #1c1d21; color: #ffffff; cursor: pointer;
  }
  #send:disabled { opacity: 0.5; cursor: default; }
  :focus-visible { outline: 2px solid #2b59c3; outline-offset: 2px; }
</style>
</head>
<body>
<header>
  <span class="badge" aria-hidden="true">HW</span>
  <h1>Hello Web</h1>
  <label><span data-text="language"></span>
    <select id="locale">
      <option value="en">English</option>
      <option value="zh-CN">简体中文</option>
    </select>
  </label>
</header>
<main id="log" aria-live="polite">
  <p id="empty" data-text="empty"></p>
</main>
<footer>
  <p id="answered" hidden><span data-text="answeredBy"></span> <span id="model"></span></p>
  <form id="composer">
    <input id="message" autocomplete="off">
    <button id="send" type="submit" data-text="send"></button>
  </form>
</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
