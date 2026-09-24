// Relays the hotkey to the page, and streams Jev scores from the local jev-lens server.
// The fetch runs here rather than in the content script so Chrome's CORS and
// local-network checks (wikipedia.org -> 127.0.0.1) don't apply.

const SERVER = "http://127.0.0.1:8765/score";

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-lens" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" }).catch(() => {});
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "score") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async (request) => {
    try {
      const response = await fetch(SERVER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
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
        const scores = lines.filter(Boolean).map((line) => JSON.parse(line));
        if (scores.length) port.postMessage({ scores });
      }
      port.postMessage({ done: true });
    } catch (error) {
      if (!controller.signal.aborted) port.postMessage({ error: String(error) });
    }
  });
});
