// Google's Thanos snap, for any page: in Thanos Mode, what goes crumbles into dust.
//
// One screenshot of the visible page is taken when a question starts. Each piece that
// disappears is cut out of it, its pixels scattered across layers (pixels further right go
// to later layers, so it peels away left to right), and the layers drift off and fade. The
// real element is hidden underneath at the same moment, so the layout never moves.
// Anything off-screen, or past the per-question budget, simply fades.

const ThanosDust = (() => {
  const LAYERS = 16;
  const SMALL_LAYERS = 8; // for tiny pieces: a word, a separator
  const DRIFT_S = 1.3;

  let shot = null;

  // Hides our own UI for the instant of the screenshot, so it doesn't end up in the dust.
  async function capture() {
    shot = null;
    const root = document.documentElement;
    root.classList.add("jl-capturing");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const reply = await chrome.runtime.sendMessage({ type: "capture" }).catch(() => null);
    root.classList.remove("jl-capturing");
    if (!reply?.dataUrl) return;
    const image = new Image();
    image.src = reply.dataUrl;
    await image.decode();
    shot = {
      image,
      x: scrollX,
      y: scrollY,
      scale: image.naturalWidth / innerWidth,
      budget: innerWidth * innerHeight * 2, // CSS px² of dust per question
    };
  }

  // Crumbles the element (or spans) if it's on screen; false means "just fade it".
  function crumble(target) {
    if (!shot || scrollX !== shot.x || scrollY !== shot.y) return false;
    const boxes = target instanceof Element ? [target.getBoundingClientRect()] : target.flatMap((s) => [...s.getClientRects()]);
    const visible = boxes
      .map((r) => ({
        left: Math.max(0, r.left),
        top: Math.max(0, r.top),
        right: Math.min(innerWidth, r.right),
        bottom: Math.min(innerHeight, r.bottom),
      }))
      .filter((r) => r.right - r.left >= 2 && r.bottom - r.top >= 2);
    if (!visible.length) return false;
    const area = visible.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
    if (area > shot.budget) return false;
    shot.budget -= area;
    const delay = Math.random() * 0.25;
    visible.forEach((r) => burst(r, delay));
    return true;
  }

  function burst(r, delay) {
    const width = Math.ceil(r.right - r.left);
    const height = Math.ceil(r.bottom - r.top);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const s = shot.scale;
    context.drawImage(shot.image, r.left * s, r.top * s, width * s, height * s, 0, 0, width, height);
    const source = context.getImageData(0, 0, width, height).data;

    const count = width * height < 4000 ? SMALL_LAYERS : LAYERS;
    const layers = Array.from({ length: count }, () => new ImageData(width, height));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // Near-white is page background: leave it out so only the ink turns to dust.
        if (source[i] > 244 && source[i + 1] > 244 && source[i + 2] > 244) continue;
        const layer = Math.min(count - 1, Math.floor((count * (Math.random() + (2 * x) / width)) / 3));
        layers[layer].data.set(source.subarray(i, i + 4), i);
      }
    }

    layers.forEach((data, n) => {
      const piece = document.createElement("canvas");
      piece.width = width;
      piece.height = height;
      piece.getContext("2d").putImageData(data, 0, 0);
      piece.className = "jl-dust";
      const wait = delay + (1.1 * n) / count;
      Object.assign(piece.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${width}px`,
        height: `${height}px`,
        transition: `transform ${DRIFT_S}s ease-out ${wait}s, opacity ${DRIFT_S}s ease-out ${wait}s, filter ${DRIFT_S}s ease-out ${wait}s`,
      });
      document.documentElement.append(piece);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const angle = 2 * Math.PI * (Math.random() - 0.5) * 0.35;
          piece.style.transform = `rotate(${12 * (Math.random() - 0.5)}deg) translate(${70 * Math.cos(angle)}px, ${-30 + 50 * Math.sin(angle)}px)`;
          piece.style.opacity = "0";
          piece.style.filter = "blur(1.5px)";
        })
      );
      setTimeout(() => piece.remove(), (wait + DRIFT_S + 0.2) * 1000);
    });
  }

  return { capture, crumble, forget: () => (shot = null) };
})();
