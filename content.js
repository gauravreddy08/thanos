// Project Thanos: ask a page a question out loud. In Thanos mode everything that doesn't
// answer it fades; in Highlight mode the answer lights up.
//
// Two engines (switch in the toolbar popup):
//  - tree (default): the page's text is collapsed into a tree of items. A wrapper with one
//    text-bearing child merges into it; where two or more text-bearing branches meet, that's
//    a node. Jev walks the tree from the top: keep the whole node, leave it out, or dig into
//    its children. A matching card stays whole, logo and all; prose ends at single sentences.
//  - sentences: every sentence (or table row) is scored on its own, all in parallel.
//
// Snap 1 (instant, no Jev) fades page chrome first. Fading never removes anything or uses
// display:none, so the layout never moves.

(() => {
  const KEEP = 0.5;
  const BEST_GUESS_FLOOR = 0.3;
  const BEST_GUESSES = 3;
  // Leave a node out only when Jev is sure: an extra dig costs one round (~0.2s), a wrong
  // drop loses the answer.
  const DROP_BRANCH = 0.8;
  const KEEP_BRANCH = 0.6;
  const KEEP_BRANCH_MAX_CHARS = 1500; // bigger than a card: dig instead of keeping wholesale
  const ASK_MAX_CHARS = 6000; // too long to show Jev whole: dig without asking
  const CARD_MAX_CHARS = 600;

  const HOLD_MS = 180; // Option held this long (alone) starts listening
  const DOUBLE_TAP_MS = 400;
  const PILL_LINGER_MS = 2500;

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

  // Any other site: everything outside the main content is skipped, plus these inside it.
  const GENERIC_NOISE = [
    "nav", "footer", "aside", "[role=navigation]", "[role=contentinfo]", "[role=complementary]",
    "button", "input", "select", "textarea",
  ].join(",");

  // The sentence engine can't keep a card's logo, so media just fades up front.
  const MEDIA = "img, picture, video, svg, iframe, canvas";

  const BLOCKS = "p, li, dd, dt, h1, h2, h3, h4, h5, h6, caption, blockquote, figcaption, pre";

  // Periods that don't end a sentence: "Downey Jr. (born", "U.S. Army", "c. 1900".
  const ABBREVIATION = /(?:^|[\s(])(?:Jr|Sr|Dr|Mr|Mrs|Ms|St|Mt|Inc|Ltd|Co|Corp|vs|etc|No|Vol|Gen|Col|Lt|Sgt|Capt|Rev|Prof|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|c|ca|e\.g|i\.e|U\.S|[A-Z])\.$/;

  const settings = { effect: "thanos", engine: "tree" };
  chrome.storage.local.get(settings).then((stored) => Object.assign(settings, stored));
  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, { newValue }] of Object.entries(changes)) if (key in settings) settings[key] = newValue;
    clear();
  });

  let root = null;
  let units = null; // [{id, text, spans, block, trivial, score}], built once per page
  let tree = null;
  let treeNodes = [];
  let snapped = []; // elements faded by snap 1
  const treeFaded = new Set(); // elements faded by tree decisions
  const highlighted = new Set();
  let active = false; // something on screen until cleared
  let kept = []; // what the last finished question kept (sentence engine: units)
  const ports = new Set();
  let run = 0; // ignores answers to a question that was superseded
  let pill = null;
  let pillTimer = null;

  const wikipediaRoot = () =>
    document.querySelector("#mw-content-text > .mw-parser-output") || document.querySelector("#mw-content-text");

  const article = () =>
    wikipediaRoot() ||
    document.querySelector("main, [role=main]") ||
    (document.querySelectorAll("article").length === 1 && document.querySelector("article")) ||
    document.body;

  // ---------- what to skip (snap 1) ----------

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

  function skipTargets(root) {
    if (root === wikipediaRoot()) {
      return [...document.querySelectorAll(PAGE_CHROME), ...root.querySelectorAll(ARTICLE_NOISE), ...skippedSections(root)];
    }
    const out = [];
    for (let el = root; el && el !== document.body; el = el.parentElement) {
      for (const sibling of el.parentElement.children) {
        if (sibling !== el && sibling.tagName !== "SCRIPT" && sibling.tagName !== "STYLE") out.push(sibling);
      }
    }
    return [...out, ...root.querySelectorAll(GENERIC_NOISE)];
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
        !node.parentElement.closest(".jl-skip, style, script, noscript, template, svg") &&
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
    const newUnit = (block) => {
      const unit = { id: out.length, text: "", spans: [], block, score: null };
      out.push(unit);
      return unit;
    };

    for (const [block, nodes] of textNodesByBlock(root)) {
      if (block.tagName === "TR") {
        const unit = newUnit(block);
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
        const unit = newUnit(block);
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
      if (!unit.trivial) unit.spans.forEach((span) => span.classList.add("jl-t"));
    }
    return out;
  }

  // ---------- tree ----------

  // Node: {id, el, items?, unit?, all, text}. `el` is the highest element that holds this
  // node and nothing else text-bearing, so fading it also takes its logo and borders.
  function buildTree(root, units) {
    const elements = new Map();
    const elementNode = (el) => {
      let node = elements.get(el);
      if (!node) {
        node = { el, kids: [], units: [] };
        elements.set(el, node);
        if (el !== root) elementNode(el.parentElement).kids.push(node);
      }
      return node;
    };
    for (const unit of units) if (!unit.trivial) elementNode(unit.block).units.push(unit);

    const nodes = [];
    const collapse = (n) => {
      const items = [...n.kids.map(collapse), ...n.units.map((unit) => ({ unit, el: null, all: [unit] }))];
      if (items.length === 1) {
        items[0].el = n.el; // a wrapper around a single item is part of that item
        return items[0];
      }
      return { el: n.el, items, all: items.flatMap((item) => item.all) };
    };
    const top = collapse(elementNode(root));
    const number = (node) => {
      node.id = nodes.length;
      node.text = node.all.map((u) => u.text).join(" ");
      nodes.push(node);
      node.items?.forEach(number);
    };
    number(top);
    return { top, nodes };
  }

  // ---------- visuals ----------

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

  function fadeEl(el) {
    if (!el || el.classList.contains("jl-gone")) return;
    el.classList.add("jl-gone");
    treeFaded.add(el);
  }

  function unfadeWithin(el) {
    for (const faded of treeFaded) {
      if (el.contains(faded)) {
        faded.classList.remove("jl-gone");
        treeFaded.delete(faded);
      }
    }
  }

  function highlightUnits(list) {
    for (const unit of list) {
      unit.spans.forEach((span) => span.classList.add("jl-hl"));
      highlighted.add(unit);
    }
  }

  function highlightBox(el) {
    el.classList.add("jl-hl-box");
    highlighted.add(el);
  }

  function clearHighlights() {
    for (const item of highlighted) {
      if (item instanceof Element) item.classList.remove("jl-hl-box");
      else item.spans.forEach((span) => span.classList.remove("jl-hl"));
    }
    highlighted.clear();
  }

  const thanos = () => settings.effect === "thanos";

  function snapOne() {
    document.body.classList.add("jl-on");
    root.classList.add("jl-root");
    const targets = [...document.querySelectorAll(".jl-skip")];
    if (settings.engine === "sentences") targets.push(...root.querySelectorAll(MEDIA));
    for (const el of targets) {
      if (!el.classList.contains("jl-gone")) {
        el.classList.add("jl-gone");
        snapped.push(el);
      }
    }
    if (settings.engine === "sentences") units.filter((u) => u.trivial).forEach(drop);
  }

  // ---------- Jev ----------

  // A card: small, and built from separate elements (name, blurb, tags) rather than a
  // paragraph's sentences. It is judged whole, never dug into.
  function isCard(node) {
    return node.text.length <= CARD_MAX_CHARS && node.items.some((item) => item.el);
  }

  function request(body, onResults, onDone, onError) {
    const port = chrome.runtime.connect({ name: "jev" });
    ports.add(port);
    port.onMessage.addListener((message) => {
      if (message.results) onResults(message.results);
      if (message.done || message.error) {
        ports.delete(port);
        port.disconnect();
        if (message.error) onError(message.error);
        else onDone();
      }
    });
    port.postMessage({ path: "/decide", body });
  }

  function closePorts() {
    ports.forEach((port) => port.disconnect());
    ports.clear();
  }

  function ask(question) {
    if (!question) return;
    const id = ++run;
    closePorts();
    showPill();
    pill.querySelector("input").value = question;

    if (!units) {
      root = article();
      skipTargets(root).forEach((el) => el.classList.add("jl-skip"));
      units = buildUnits(root);
      ({ top: tree, nodes: treeNodes } = buildTree(root, units));
    }
    if (thanos() && !active) snapOne();
    if (!thanos()) clearHighlights();
    active = true;

    const unreachable = () => {
      if (id !== run) return;
      if (!kept.length) clear();
      showPill();
      setStatus("Can't reach Jev. Run: uv run jev-lens", true);
    };
    if (settings.engine === "tree") askTree(question, id, unreachable);
    else askSentences(question, id, unreachable);
  }

  // Sentence engine: every sentence at once; each one fades (or lights up) as its score lands.
  function askSentences(question, id, unreachable) {
    const previous = kept;
    const scored = units.filter((u) => !u.trivial);
    const started = performance.now();
    let landed = 0;
    setStatus(`Jev is reading ${scored.length} sentences`);

    request(
      { question, nodes: scored.map((u) => ({ id: u.id, text: u.text, kind: "leaf" })) },
      (results) => {
        if (id !== run) return;
        for (const { id: unitId, score } of results) {
          const unit = units[unitId];
          unit.score = score;
          if (!thanos()) score >= KEEP && highlightUnits([unit]);
          else if (score < KEEP) drop(unit);
          else undrop(unit);
        }
        landed += results.length;
        setStatus(`Jev is reading ${scored.length - landed} of ${scored.length} sentences`);
      },
      () => {
        if (id !== run) return;
        let result = scored.filter((u) => u.score >= KEEP);
        let label = "Kept";
        if (!result.length) {
          const best = [...scored].sort((a, b) => b.score - a.score).slice(0, BEST_GUESSES);
          if (!best.length || best[0].score < BEST_GUESS_FLOOR) {
            // Nothing here answers it: go back to what was on screen before this question.
            if (thanos() && previous.length) previous.forEach(undrop);
            else if (!previous.length) clear();
            return notFound();
          }
          if (thanos()) best.forEach(undrop);
          else highlightUnits(best);
          result = best;
          label = "Best guesses:";
        }
        kept = result;
        done(`${label} ${kept.length} of ${scored.length} sentences`, started, kept.map((u) => u.spans[0]));
      },
      unreachable
    );
  }

  // Tree engine: walk from the top. Each answer that says "dig" sends that node's children
  // right away, so every branch of the page goes as deep as it needs, independently.
  function askTree(question, id, unreachable) {
    const found = [];
    let pending = 0;
    let asked = 0;
    const started = performance.now();

    const keepNode = (node) => {
      found.push(node);
      if (!thanos()) return node.unit ? highlightUnits(node.all) : highlightBox(node.el);
      if (node.el) unfadeWithin(node.el);
      node.all.forEach(undrop);
    };
    const leaveNode = (node) => {
      if (!thanos()) return;
      if (node.el) fadeEl(node.el);
      else node.all.forEach(drop);
    };
    const dug = [];
    const digNode = (node) => {
      dug.push(node);
      if (!thanos()) return;
      if (treeFaded.delete(node.el)) node.el.classList.remove("jl-gone");
      // Partly relevant: it stays, but whatever inside it holds no text (images, icons,
      // dividers, "·" separators) goes, at any depth. The children's own elements are
      // left to their own decisions.
      const itemEls = new Set(node.items.map((item) => item.el).filter(Boolean));
      const sweep = (el) => {
        for (const child of el.children) {
          if (itemEls.has(child) || child.matches(".jl-skip")) continue;
          if (!child.matches(".jl-t") && !child.querySelector(".jl-t")) fadeEl(child);
          else sweep(child);
        }
      };
      sweep(node.el);
    };

    const send = (nodes) => {
      const batch = [];
      const expand = (node) => {
        if (!node.unit && (node === tree || node.text.length > ASK_MAX_CHARS)) {
          digNode(node);
          node.items.forEach(expand);
        } else {
          batch.push(node);
        }
      };
      nodes.forEach(expand);
      if (!batch.length) return;
      pending++;
      asked += batch.length;
      request(
        { question, nodes: batch.map((n) => ({ id: n.id, text: n.text, kind: n.unit ? "leaf" : "branch" })) },
        (results) => {
          if (id !== run) return;
          const deeper = [];
          for (const result of results) {
            const node = treeNodes[result.id];
            if (node.unit) {
              if (result.score >= KEEP) keepNode(node);
              else leaveNode(node);
            } else if (result.none >= DROP_BRANCH) {
              leaveNode(node);
            } else if (isCard(node)) {
              // Digging into a card would judge "Cryptoseal", "San Francisco" and
              // "Summer 2011" one by one and leave it full of holes: keep or drop it whole.
              if (result.all >= result.none) keepNode(node);
              else leaveNode(node);
            } else if (result.all >= KEEP_BRANCH && node.text.length <= KEEP_BRANCH_MAX_CHARS) {
              keepNode(node);
            } else {
              digNode(node);
              deeper.push(...node.items);
            }
          }
          send(deeper);
          setStatus(`Jev asked about ${asked} parts of the page · kept ${found.length}`);
        },
        () => {
          if (id !== run || --pending) return;
          if (!found.length) {
            clear();
            return notFound();
          }
          // A node we dug into where nothing survived goes as a whole, borders and all.
          if (thanos()) {
            const keptUnits = new Set(found.flatMap((node) => node.all));
            for (const node of dug) if (node !== tree && !node.all.some((u) => keptUnits.has(u))) fadeEl(node.el);
          }
          kept = found;
          done(
            `Kept ${found.length} of ${asked} parts`,
            started,
            found.map((node) => node.el || node.all[0].spans[0])
          );
        },
        unreachable
      );
    };

    setStatus("Jev is reading the page");
    send([tree]);
  }

  function notFound() {
    showPill();
    setStatus("Couldn't find that here", true);
    hidePill(PILL_LINGER_MS);
  }

  function done(summary, started, targets) {
    setStatus(`${summary} · ${((performance.now() - started) / 1000).toFixed(1)}s`);
    hidePill(PILL_LINGER_MS);
    const first = targets.filter(Boolean).sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )[0];
    const box = first?.getBoundingClientRect();
    if (box && (box.top < 80 || box.bottom > innerHeight)) {
      setTimeout(() => first.scrollIntoView({ behavior: "smooth", block: "center" }), 500);
    }
  }

  function clear() {
    run++;
    closePorts();
    stopRecording(true);
    active = false;
    kept = [];
    document.body.classList.remove("jl-on");
    root?.classList.remove("jl-root");
    snapped.forEach((el) => el.classList.remove("jl-gone"));
    snapped = [];
    treeFaded.forEach((el) => el.classList.remove("jl-gone"));
    treeFaded.clear();
    units?.forEach(undrop);
    clearHighlights();
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
  // The audio is recorded and transcribed by gpt-4o-transcribe on release (much better with
  // accents and names than Chrome's recognizer). Chrome's recognizer still runs alongside
  // for the live preview in the pill.

  let holding = false;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let preview = null;

  async function startListening() {
    holding = true;
    showPill();
    const input = pill.querySelector("input");
    input.value = "";
    pill.classList.add("jl-listening");
    setStatus("Listening… let go of ⌥ to ask");

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      holding = false;
      pill?.classList.remove("jl-listening");
      setStatus("Mic blocked for this site", true);
      return;
    }
    if (!holding) return stopRecording(true); // let go while Chrome was asking for the mic

    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.start();

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Recognition) {
      preview = new Recognition();
      preview.lang = "en-US";
      preview.continuous = true;
      preview.interimResults = true;
      preview.onresult = (e) => {
        if (pill) input.value = Array.from(e.results, (r) => r[0].transcript).join("");
      };
      preview.onerror = () => {};
      preview.start();
    }
  }

  function stopRecording(discard) {
    holding = false;
    preview?.abort();
    preview = null;
    const rec = recorder;
    recorder = null;
    const tracks = stream?.getTracks() ?? [];
    stream = null;
    if (!rec || discard) {
      if (rec?.state === "recording") rec.stop();
      tracks.forEach((t) => t.stop());
      return null;
    }
    return new Promise((resolve) => {
      rec.onstop = () => {
        tracks.forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: rec.mimeType }));
      };
      rec.stop();
    });
  }

  async function stopListening() {
    pill?.classList.remove("jl-listening");
    const spoken = pill?.querySelector("input").value.trim();
    const recording = stopRecording(false);
    if (!recording) {
      if (pill && !spoken) {
        setStatus("Didn't catch that");
        hidePill(1200);
      }
      return;
    }
    setStatus("Transcribing…");
    const blob = await recording;
    const audio = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(blob);
    });
    const reply = await chrome.runtime
      .sendMessage({ type: "transcribe", audio, mime: blob.type, prompt: document.title })
      .catch(() => null);
    const question = reply?.text?.trim() || spoken;
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
      if (e.key === "Escape" && active) clear();
    },
    true
  );

  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "Alt" && altDownAt) optionReleased();
    },
    true
  );

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
