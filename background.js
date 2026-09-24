// Relays the hotkey to the page and talks to the APIs: Jev (TypeSafe) answers each node
// the page asks about, and OpenAI transcribes spoken questions. Calls run here rather than
// in the content script so page CSPs don't apply. Keys come from config.js.

try {
  importScripts("config.js");
} catch {
  // No config.js yet: the page shows how to add one.
}
const CONFIG = self.CONFIG ?? {};

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_IN_FLIGHT = 48;
const RETRIES = 3;

const RELEVANCE = {
  type: "noul",
  instructions: "Does `sentence` contain information that helps answer `question`?",
};

const COVERAGE = {
  type: "choice",
  instructions: "How much of `section` helps answer `question`?",
  criteria: {
    all: "All of `section` is what the question asks for, such as one card, result, or item that matches it.",
    none: "Nothing in `section` helps answer the question.",
    some:
      "Only part of `section` helps: it mixes relevant and irrelevant content, or it is a list or group " +
      "where some items match and others don't.",
  },
};

// Engine and voice come from config.js; the page reads them from storage.
chrome.storage.local.set({ engine: CONFIG.ENGINE ?? "tree", voice: CONFIG.VOICE ?? "gpt-4o-transcribe" });

// The toolbar icon opens the panel on the page, and shows Thanos grinning when he's on.
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "panel" }).catch(() => {});
});

const showIcon = (effect) => {
  const state = effect === "thanos" ? "on" : "off";
  chrome.action.setIcon({
    path: Object.fromEntries([16, 32, 48, 128].map((n) => [n, `icons/thanos-${state}-${n}.png`])),
  });
};
chrome.storage.local.get({ effect: "highlight" }).then(({ effect }) => showIcon(effect));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.effect) showIcon(changes.effect.newValue);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-lens" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
  }
});

// ---------- Jev ----------

let inFlight = 0;
const waiting = [];

async function withSlot(fn) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

class KeyError extends Error {}

async function systemOne(key, state, questions, signal) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(JEV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal,
    });
    if (response.ok) return (await response.json()).answers;
    if (response.status === 401 || response.status === 403) throw new KeyError("TypeSafe key was rejected");
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= RETRIES) throw new Error(`TypeSafe ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
  }
}

async function decide(key, question, node, signal) {
  if (node.kind === "branch") {
    const answers = await systemOne(key, { question, section: node.text }, { coverage: COVERAGE }, signal);
    return answers.coverage.probabilities;
  }
  const answers = await systemOne(key, { question, sentence: node.text }, { relevant: RELEVANCE }, signal);
  return { score: answers.relevant.noul };
}

// What a node Jev could not answer gets: keep a sentence, dig into a branch. A failure
// never hides a possible answer.
const failOpen = (node) => (node.kind === "branch" ? { all: 0, none: 0, some: 1 } : { score: 1 });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jev") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async ({ body }) => {
    const typesafeKey = CONFIG.TYPESAFE_API_KEY;
    if (!typesafeKey) return port.postMessage({ error: "Add TYPESAFE_API_KEY to the extension's config.js" });
    let keyRejected = false;
    await Promise.all(
      body.nodes.map((node) =>
        withSlot(async () => {
          if (controller.signal.aborted || keyRejected) return;
          let result;
          try {
            result = await decide(typesafeKey, body.question, node, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            if (error instanceof KeyError) {
              keyRejected = true;
              return port.postMessage({ error: error.message });
            }
            result = failOpen(node);
          }
          if (!controller.signal.aborted) port.postMessage({ results: [{ id: node.id, ...result }] });
        })
      )
    );
    if (!controller.signal.aborted && !keyRejected) port.postMessage({ done: true });
  });
});

// ---------- speech ----------
// `model` is the OpenAI transcription model picked in the popup (whisper-1,
// gpt-4o-mini-transcribe, gpt-4o-transcribe). "chrome" never gets here.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "transcribe") return;
  transcribe(message).then(sendResponse, (error) => sendResponse({ error: String(error) }));
  return true; // answer asynchronously
});

async function transcribe({ audio, model, title }) {
  if (!CONFIG.OPENAI_API_KEY) return { error: "no OPENAI_API_KEY in config.js" };
  const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "question.wav");
  form.append("model", model);
  form.append("prompt", `A spoken question about this web page: ${title}`);
  const response = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${CONFIG.OPENAI_API_KEY}` },
    body: form,
  });
  if (!response.ok) return { error: `OpenAI ${response.status}` };
  return { text: (await response.json()).text };
}
