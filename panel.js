// The Project Thanos panel: the toolbar icon opens it at the top right of the page, and it
// stays (across pages too) until its × is pressed.
//
// One slider: left is Highlight (Thanos off), right is Thanos (everything else
// disappears). Drag, click, or use the arrow keys; it snaps to an end, and reaching the
// right end sends a purple shimmer across the panel.

(() => {
  let host = null;

  function open() {
    if (host) return;
    host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const icon = (name) => chrome.runtime.getURL(`icons/${name}-128.png`);
    root.innerHTML = `
      <link rel="stylesheet" href="${chrome.runtime.getURL("panel.css")}">
      <div class="panel">
        <button class="close" title="Close" aria-label="Close">×</button>
        <div class="slider" role="slider" tabindex="0" aria-label="Thanos" aria-valuemin="0" aria-valuemax="1">
          <div class="track"><div class="fill"></div></div>
          <div class="thumb">
            <img class="off-face" src="${icon("thanos-off")}" alt="">
            <img class="on-face" src="${icon("thanos-on")}" alt="">
          </div>
        </div>
        <div class="labels"><span class="off">Highlight</span><span class="on">Thanos</span></div>
        <div class="hint">hold ⌥ to ask · double-tap ⌥ to clear</div>
        <div class="shimmer"></div>
      </div>`;
    document.documentElement.append(host);

    const panel = root.querySelector(".panel");
    const slider = root.querySelector(".slider");
    const shimmer = root.querySelector(".shimmer");
    const isOn = () => panel.classList.contains("on");

    const show = (pos) => {
      slider.style.setProperty("--pos", pos);
      slider.classList.toggle("grin", pos > 0.5);
    };
    const render = (effect, animate) => {
      const on = effect === "thanos";
      show(on ? 1 : 0);
      panel.classList.toggle("on", on);
      slider.setAttribute("aria-valuenow", on ? 1 : 0);
      slider.setAttribute("aria-valuetext", on ? "Thanos" : "Highlight");
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
      const box = slider.getBoundingClientRect();
      return Math.min(1, Math.max(0, (x - box.left) / box.width));
    };
    slider.addEventListener("pointerdown", (e) => {
      slider.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, moved: false, wasOn: isOn() };
      slider.classList.add("dragging");
    });
    slider.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
      if (drag.moved) show(posAt(e.clientX));
    });
    slider.addEventListener("pointerup", (e) => {
      if (!drag) return;
      slider.classList.remove("dragging");
      const on = drag.moved ? posAt(e.clientX) > 0.5 : !drag.wasOn;
      drag = null;
      if (on === isOn()) render(on ? "thanos" : "highlight", false);
      else set(on);
    });
    slider.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const target = { ArrowRight: true, ArrowUp: true, End: true, ArrowLeft: false, ArrowDown: false, Home: false }[e.key];
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
    leaving.shadowRoot?.querySelector(".panel")?.classList.remove("in");
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

  // Opened or closed in another tab.
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.panelOpen) return;
    if (changes.panelOpen.newValue) open();
    else close();
  });
})();
