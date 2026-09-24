// Relays the hotkey to the page, streams Jev answers from the local jev-lens server, and
// forwards recorded questions for transcription. Fetches run here rather than in the
// content script so page CSPs and Chrome's local-network checks (site -> 127.0.0.1)
// don't apply.

const SERVER = "http://127.0.0.1:8765";

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-lens" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jev") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async ({ path, body }) => {
    try {
      const response = await fetch(SERVER + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        const results = lines.filter(Boolean).map((line) => JSON.parse(line));
        if (results.length) port.postMessage({ results });
      }
      port.postMessage({ done: true });
    } catch (error) {
      if (!controller.signal.aborted) port.postMessage({ error: String(error) });
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "transcribe") return;
  const { audio, mime, prompt } = message;
  fetch(`${SERVER}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio, mime, prompt }),
  })
    .then((response) => response.json())
    .then(sendResponse, (error) => sendResponse({ error: String(error) }));
  return true; // answer asynchronously
});
