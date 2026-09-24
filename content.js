// Jev Lens: ask a page a question; every sentence that doesn't answer it fades.
//
// Snap 1 (instant, no Jev): page chrome, references, navboxes, images and reference
// sections fade. Snap 2: every remaining sentence (or table row) is scored by Jev on its
// own, and fades the moment its score lands. Nothing is removed or display:none'd, so the
// layout never moves.

(() => {
  const KEEP = 0.5;
  const BEST_GUESS_FLOOR = 0.3;
  const BEST_GUESSES = 3;

  const PAGE_CHROME = [
    ".vector-header-container", ".vector-sticky-header", ".vector-column-start", ".vector-column-end",
    ".vector-page-titlebar", ".mw-body-header", ".vector-page-toolbar", ".vector-body-before-content",
    "#siteNotice", "#siteSub", "#contentSub", ".mw-indicators", "#catlinks", ".printfooter",
    ".mw-footer-container", ".mw-footer",
  ].join(",");

  const ARTICLE_NOISE = [
    "sup.reference", ".mw-editsection", ".navbox", ".navbox-styles", ".mw-references-wrap", ".references",
    ".reflist", ".refbegin", ".hatnote", ".shortdescription", ".side-box", ".ambox", ".metadata",
    ".authority-control", ".sistersitebox", ".portalbox", ".navigation-not-searchable", "#toc", ".toc",
    "figure", ".thumb", ".mw-file-description", "img", ".infobox-image",
  ].join(",");

  const SKIP_SECTIONS = new Set([
    "Notes", "References", "Citations", "Footnotes", "Sources", "Printed_sources", "Works_cited",
    "Bibliography", "Further_reading", "External_links", "See_also",
  ]);

  // Any other site: everything outside the main content fades, plus these inside it.
  const GENERIC_NOISE = [
    "header", "nav", "footer", "aside", "[role=banner]", "[role=navigation]", "[role=contentinfo]",
    "[role=complementary]", "img", "picture", "video", "svg", "iframe", "canvas", "button", "input", "select",
    "textarea",
  ].join(",");

  const BLOCKS = "p, li, dd, dt, h1, h2, h3, h4, h5, h6, caption, blockquote, figcaption, pre";

  // Periods that don't end a sentence: "Downey Jr. (born", "U.S. Army", "c. 1900".
  const ABBREVIATION = /(?:^|[\s(])(?:Jr|Sr|Dr|Mr|Mrs|Ms|St|Mt|Inc|Ltd|Co|Corp|vs|etc|No|Vol|Gen|Col|Lt|Sgt|Capt|Rev|Prof|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|c|ca|e\.g|i\.e|U\.S|[A-Z])\.$/;

  const HOLD_MS = 180; // Option held this long (alone) starts listening
  const DOUBLE_TAP_MS = 400;
  const PILL_LINGER_MS = 2500;

  let units = null; // [{id, text, spans, score, trivial}], built once per page
  let faded = [];
  let lensed = false; // snap 1 applied; stays on across questions until cleared
  let kept = []; // units kept by the last finished question
  let port = null;
  let run = 0; // ignores scores from a question that was superseded
  let pill = null;
  let pillTimer = null;
  let recognition = null;
  let holding = false;

  const wikipediaRoot = () =>
    document.querySelector("#mw-content-text > .mw-parser-output") || document.querySelector("#mw-content-text");

  const article = () =>
    wikipediaRoot() ||
    document.querySelector("main, [role=main]") ||
    (document.querySelectorAll("article").length === 1 && document.querySelector("article")) ||
    document.body;

  // ---------- snap 1 ----------

  function fadeElement(el) {
    if (!el.classList.contains("jl-gone")) {
      el.classList.add("jl-gone");
      faded.push(el);
    }
  }

  function skippedSections(root) {
    const out = [];
    for (const heading of root.querySelectorAll("h2[id]")) {
      if (!SKIP_SECTIONS.has(heading.id)) continue;
      const section = heading.closest("section");
      if (section && root.contains(section)) {
        out.push(section);
        continue;
      }
      // No <section> wrapper: take siblings up to the next h2.
      let el = heading.closest(".mw-heading") || heading;
      out.push(el);
      while ((el = el.nextElementSibling) && !(el.matches(".mw-heading2, h2") || el.querySelector("h2"))) out.push(el);
    }
    return out;
  }

  function snapOne(root) {
    if (root === wikipediaRoot()) {
      document.querySelectorAll(PAGE_CHROME).forEach(fadeElement);
      root.querySelectorAll(ARTICLE_NOISE).forEach(fadeElement);
      skippedSections(root).forEach(fadeElement);
      return;
    }
    for (let el = root; el && el !== document.body; el = el.parentElement) {
      for (const sibling of el.parentElement.children) {
        if (sibling !== el && sibling.tagName !== "SCRIPT" && sibling.tagName !== "STYLE") fadeElement(sibling);
      }
    }
    root.querySelectorAll(GENERIC_NOISE).forEach(fadeElement);
  }

  // ---------- units ----------

  function sentenceStarts(text) {
    const starts = [];
    const boundary = /[.!?]["'”’)\]]*\s+(?=["“(\[]?[A-Z0-9])/g;
    let match;
    while ((match = boundary.exec(text))) {
      if (text[match.index] === "." && ABBREVIATION.test(text.slice(Math.max(0, match.index - 7), match.index + 1))) continue;
      starts.push(match.index + match[0].length);
    }
    return starts;
  }

  function textNodesByBlock(root) {
    const groups = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue.trim() &&
        !node.parentElement.closest(".jl-gone, style, script, noscript, template, svg") &&
        node.parentElement.getClientRects().length
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    for (let node; (node = walker.nextNode()); ) {
      const parent = node.parentElement;
      // A table row is one unit, so "Spouses" stays attached to the names in the infobox.
      const block = parent.closest("tr") || parent.closest(BLOCKS) || parent;
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }
    return groups;
  }

  function splitIntoSpans(node, cuts, unitAt) {
    // cuts: offsets inside node.nodeValue where a new unit begins.
    const fragment = document.createDocumentFragment();
    const edges = [0, ...cuts, node.nodeValue.length];
    for (let i = 0; i < edges.length - 1; i++) {
      if (edges[i] === edges[i + 1]) continue;
      const span = document.createElement("span");
      span.className = "jl-s";
      span.textContent = node.nodeValue.slice(edges[i], edges[i + 1]);
      unitAt(edges[i]).spans.push(span);
      fragment.append(span);
    }
    node.replaceWith(fragment);
  }

  function buildUnits(root) {
    const out = [];
    const newUnit = () => {
      const unit = { id: out.length, text: "", spans: [], score: null };
      out.push(unit);
      return unit;
    };

    for (const [block, nodes] of textNodesByBlock(root)) {
      if (block.tagName === "TR") {
        const unit = newUnit();
        let cell = null;
        for (const node of nodes) {
          const nodeCell = node.parentElement.closest("td, th");
          unit.text += (cell && nodeCell !== cell ? ": " : "") + node.nodeValue;
          cell = nodeCell;
          splitIntoSpans(node, [], () => unit);
        }
        continue;
      }

      const full = nodes.map((n) => n.nodeValue).join("");
      const starts = [0, ...sentenceStarts(full)];
      const blockUnits = starts.map((start, i) => {
        const unit = newUnit();
        unit.text = full.slice(start, starts[i + 1] ?? full.length);
        return unit;
      });
      let offset = 0;
      for (const node of nodes) {
        const end = offset + node.nodeValue.length;
        const cuts = starts.filter((s) => s > offset && s < end).map((s) => s - offset);
        const nodeStart = offset;
        splitIntoSpans(node, cuts, (local) => {
          const at = nodeStart + local;
          let i = starts.length - 1;
          while (starts[i] > at) i--;
          return blockUnits[i];
        });
        offset = end;
      }
    }

    for (const unit of out) {
      unit.text = unit.text.replace(/\s+/g, " ").trim();
      unit.trivial = unit.text.replace(/[^\p{L}\p{N}]/gu, "").length < 3;
    }
    return out;
  }

  // ---------- snap 2 ----------

  function drop(unit) {
    const delay = `${Math.round(Math.random() * 180)}ms`;
    for (const span of unit.spans) {
      span.style.transitionDelay = delay;
      span.classList.add("jl-drop");
    }
  }

  function undrop(unit) {
    for (const span of unit.spans) span.classList.remove("jl-drop");
  }

  // Re-asking keeps the current view: each unit fades in or out as its new score lands,
  // so the page moves straight from one answer to the next.
  function ask(question) {
    if (!question) return;
    const id = ++run;
    port?.disconnect();
    showPill();
    pill.querySelector("input").value = question;

    const root = article();
    if (!lensed) {
      lensed = true;
      document.body.classList.add("jl-on");
      root.classList.add("jl-root");
      snapOne(root);
      units ??= buildUnits(root);
      units.filter((u) => u.trivial).forEach(drop);
    }
    const previous = kept;
    const scored = units.filter((u) => !u.trivial);
    scored.forEach((u) => (u.score = null));

    const started = performance.now();
    let landed = 0;
    setStatus(`Jev is reading ${scored.length} sentences`);

    port = chrome.runtime.connect({ name: "score" });
    port.onMessage.addListener((message) => {
      if (id !== run) return;
      if (message.error) {
        if (!previous.length) clear();
        setStatus("Can't reach Jev. Run: uv run jev-lens", true);
        return;
      }
      if (message.scores) {
        for (const { id: unitId, score } of message.scores) {
          units[unitId].score = score;
          if (score < KEEP) drop(units[unitId]);
          else undrop(units[unitId]);
        }
        landed += message.scores.length;
        setStatus(`Jev is reading ${scored.length - landed} of ${scored.length} sentences`);
      }
      if (message.done) finish(scored, previous, (performance.now() - started) / 1000);
    });
    port.postMessage({ question, units: scored.map((u) => ({ id: u.id, text: u.text })) });
  }

  function finish(scored, previous, seconds) {
    port?.disconnect();
    port = null;
    let label = "Kept";
    let result = scored.filter((u) => u.score >= KEEP);
    if (!result.length) {
      const best = [...scored].sort((a, b) => b.score - a.score).slice(0, BEST_GUESSES);
      if (!best.length || best[0].score < BEST_GUESS_FLOOR) {
        // Nothing here answers it: go back to what was on screen before this question.
        if (previous.length) previous.forEach(undrop);
        else clear();
        setStatus("Couldn't find that here", true);
        hidePill(PILL_LINGER_MS);
        return;
      }
      best.forEach(undrop);
      result = best;
      label = "Best guesses:";
    }
    kept = result;
    setStatus(`${label} ${kept.length} of ${scored.length} sentences · ${seconds.toFixed(1)}s`);
    hidePill(PILL_LINGER_MS);

    const first = kept.map((u) => u.spans[0]).filter(Boolean).sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )[0];
    const box = first?.getBoundingClientRect();
    if (box && (box.top < 80 || box.bottom > innerHeight)) {
      setTimeout(() => first.scrollIntoView({ behavior: "smooth", block: "center" }), 500);
    }
  }

  function clear() {
    run++;
    port?.disconnect();
    port = null;
    recognition?.abort();
    holding = false;
    lensed = false;
    kept = [];
    document.body.classList.remove("jl-on");
    document.querySelector(".jl-root")?.classList.remove("jl-root");
    faded.forEach((el) => el.classList.remove("jl-gone"));
    faded = [];
    units?.forEach(undrop);
    hidePill(0);
  }

  // ---------- pill ----------

  function setStatus(text, error = false) {
    if (!pill) return;
    const status = pill.querySelector(".jl-status");
    status.textContent = text;
    status.classList.toggle("jl-error", error);
  }

  function showPill() {
    clearTimeout(pillTimer);
    if (pill) return pill;
    pill = document.createElement("div");
    pill.className = "jl-pill";
    pill.innerHTML = `<span class="jl-dot"></span><div class="jl-body"><input placeholder="Ask this page…" spellcheck="false"><div class="jl-status"></div></div>`;
    document.documentElement.append(pill);
    requestAnimationFrame(() => pill?.classList.add("jl-in"));

    const input = pill.querySelector("input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ask(input.value.trim());
      if (e.key === "Escape") hidePill(0);
      e.stopPropagation();
    });
    return pill;
  }

  function hidePill(delay) {
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => {
      const leaving = pill;
      pill = null;
      if (!leaving) return;
      leaving.classList.remove("jl-in");
      setTimeout(() => leaving.remove(), 300);
    }, delay);
  }

  // ---------- push to talk (hold Option) ----------

  function startListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    holding = true;
    showPill();
    const input = pill.querySelector("input");
    input.value = "";
    if (!Recognition) {
      setStatus("No speech recognition here. Press ⌘⇧K to type", true);
      return;
    }
    pill.classList.add("jl-listening");
    setStatus("Listening… let go of ⌥ to ask");
    recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      if (pill) input.value = Array.from(e.results, (r) => r[0].transcript).join("");
    };
    recognition.onerror = (e) => {
      if (e.error === "not-allowed") setStatus("Mic blocked for this site", true);
    };
    recognition.onend = () => {
      recognition = null;
      if (!holding) submitSpoken();
    };
    recognition.start();
  }

  function stopListening() {
    holding = false;
    pill?.classList.remove("jl-listening");
    // Final words arrive before onend, which then submits.
    if (recognition) recognition.stop();
    else submitSpoken();
  }

  function submitSpoken() {
    const question = pill?.querySelector("input").value.trim();
    if (question) return ask(question);
    setStatus("Didn't catch that");
    hidePill(1200);
  }

  let altDownAt = 0;
  let holdTimer = null;
  let otherKey = false;
  let lastTapAt = 0;

  function optionReleased() {
    const heldFor = performance.now() - altDownAt;
    altDownAt = 0;
    clearTimeout(holdTimer);
    if (holding) return stopListening();
    if (otherKey || heldFor >= HOLD_MS) return;
    const now = performance.now();
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0;
      clear();
    } else {
      lastTapAt = now;
    }
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Alt") {
        if (e.repeat || altDownAt) return;
        altDownAt = performance.now();
        otherKey = false;
        holdTimer = setTimeout(startListening, HOLD_MS);
        return;
      }
      if (altDownAt && !holding) {
        // Option+letter types a character (å, ∑, …); that's not for us.
        otherKey = true;
        clearTimeout(holdTimer);
      }
      if (e.key === "Escape" && lensed) clear();
    },
    true
  );

  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && altDownAt) optionReleased();
  }, true);

  // Switching windows mid-hold never delivers the keyup.
  window.addEventListener("blur", () => {
    if (altDownAt) optionReleased();
  });

  // ⌘⇧K: type instead of talk.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "toggle") return;
    if (pill) return hidePill(0);
    showPill();
    setStatus("Type a question, then Enter");
    pill.querySelector("input").focus();
  });

  // Scripted runs (demo backup, testing): window.postMessage({jevLens: "ask", question: "..."}, "*")
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data?.jevLens) return;
    if (e.data.jevLens === "clear") clear();
    if (e.data.jevLens === "ask") ask(e.data.question);
  });
})();
