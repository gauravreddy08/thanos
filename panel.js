// The Project Thanos panel: the toolbar icon opens it at the top right of the page, and it
// stays (across pages too) until its × is pressed.
//
// One slide-to-snap bar: Highlights Mode on the left, Thanos Mode on the right. Drag the
// block, click the bar, or use the arrow keys. Thanos Mode turns the whole panel deep
// purple, sends one shimmer across it, and pops the grinning head into the corner.

(() => {
  let host = null;
  let render = null;

  function open() {
    if (host) return;
    host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <link rel="stylesheet" href="${chrome.runtime.getURL("panel.css")}">
      <div class="panel">
        <div class="main">
          <div class="bar" role="switch" tabindex="0" aria-label="Thanos Mode">
            <div class="fill"></div>
            <div class="thumb"></div>
          </div>
          <div class="ends"><span class="highlights">Highlights Mode</span><span class="thanos">Thanos Mode</span></div>
          <div class="hint">hold ⌃⌥ to ask · double-tap ⌃⌥ to clear</div>
        </div>
        <button class="close" title="Close" aria-label="Close">×</button>
        <img class="sticker" src="${chrome.runtime.getURL("icons/thanos-sticker.png")}" alt="">
        <div class="shimmer"></div>
      </div>`;
    host.className = "jl-panel-host";
    document.documentElement.append(host);

    const panel = root.querySelector(".panel");
    const toggle = root.querySelector(".bar");
    const shimmer = root.querySelector(".shimmer");
    const isOn = () => panel.classList.contains("on");

    render = (effect, animate) => {
      const on = effect === "thanos";
      toggle.style.setProperty("--pos", on ? 1 : 0);
      panel.classList.toggle("on", on);
      toggle.setAttribute("aria-checked", on);
      if (on && animate) {
        shimmer.classList.remove("go");
        void shimmer.offsetWidth; // restart the sweep
        shimmer.classList.add("go");
      }
    };
    const set = (on) => {
      render(on ? "thanos" : "highlight", true);
      chrome.storage.local.set({ effect: on ? "thanos" : "highlight" });
    };

    chrome.storage.local.get({ effect: "highlight" }).then(({ effect }) => {
      render(effect, false);
      requestAnimationFrame(() => panel.classList.add("in"));
    });

    let drag = null;
    const posAt = (x) => {
      const box = toggle.getBoundingClientRect();
      return Math.min(1, Math.max(0, (x - box.left - 24) / (box.width - 48)));
    };
    toggle.addEventListener("pointerdown", (e) => {
      toggle.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, moved: false };
      toggle.classList.add("dragging");
    });
    toggle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
      if (drag.moved) toggle.style.setProperty("--pos", posAt(e.clientX));
    });
    toggle.addEventListener("pointerup", (e) => {
      if (!drag) return;
      toggle.classList.remove("dragging");
      // A drag goes where the block was let go; a click flips it.
      const on = drag.moved ? posAt(e.clientX) > 0.5 : !isOn();
      drag = null;
      if (on === isOn()) render(on ? "thanos" : "highlight", false);
      else set(on);
    });
    toggle.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const target = { ArrowRight: true, End: true, ArrowLeft: false, Home: false }[e.key];
      if (e.key === " " || e.key === "Enter") set(!isOn());
      else if (target !== undefined && target !== isOn()) set(target);
    });

    root.querySelector(".close").addEventListener("click", () => {
      chrome.storage.local.set({ panelOpen: false });
      close();
    });
  }

  function close() {
    if (!host) return;
    const leaving = host;
    host = null;
    render = null;
    leaving.shadowRoot.querySelector(".panel").classList.remove("in");
    setTimeout(() => leaving.remove(), 250);
  }

  chrome.storage.local.get({ panelOpen: false }).then(({ panelOpen }) => panelOpen && open());

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "panel") return;
    const opening = !host;
    chrome.storage.local.set({ panelOpen: opening });
    if (opening) open();
    else close();
  });

  // Opened, closed, or switched in another tab.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.effect) render?.(changes.effect.newValue, false);
    if (changes.panelOpen) {
      if (changes.panelOpen.newValue) open();
      else close();
    }
  });
})();
