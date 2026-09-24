const defaults = { effect: "thanos", engine: "tree" };

chrome.storage.local.get(defaults).then((settings) => {
  for (const toggle of document.querySelectorAll(".toggle")) {
    const key = toggle.dataset.key;
    const buttons = toggle.querySelectorAll("button");
    const render = () => buttons.forEach((b) => b.classList.toggle("on", b.dataset.value === settings[key]));
    buttons.forEach((button) =>
      button.addEventListener("click", () => {
        settings[key] = button.dataset.value;
        chrome.storage.local.set({ [key]: settings[key] });
        render();
      })
    );
    render();
  }
});
