"use strict";

// CRT effects run locally. Signup posts only to this site's Go server.
(() => {
  const starfield = document.getElementById("starfield");
  if (starfield) {
    const stars = document.createDocumentFragment();
    for (let i = 0; i < 180; i += 1) {
      const star = document.createElement("span");
      star.className = "star";
      const properties = {
        "--x": `${Math.random() * 100}%`,
        "--y": `${Math.random() * 100}%`,
        "--size": `${i % 9 === 0 ? 2.8 : i % 3 === 0 ? 1.8 : 1.3}px`,
        "--opacity": (0.55 + Math.random() * 0.45).toFixed(2),
        "--duration": `${55 + Math.random() * 65}s`,
        "--twinkle": `${5 + Math.random() * 8}s`,
        "--delay": `${-Math.random() * 100}s`,
      };
      Object.entries(properties).forEach(([name, value]) => {
        star.style.setProperty(name, value);
      });
      stars.append(star);
    }
    starfield.append(stars);
  }

  const transmission = document.getElementById("transmission");
  const scrollback = document.getElementById("scrollback");
  const carrier = document.getElementById("carrier-state");
  const channel = document.getElementById("return-channel");
  const form = document.getElementById("return-address-form");
  if (!transmission || !scrollback || !carrier || !channel || !form) return;

  const input = document.getElementById("return-address");
  const transmit = document.getElementById("transmit");
  const response = document.getElementById("response");
  const clock = document.getElementById("ship-clock");
  const yearDisplay = document.getElementById("ship-year");
  const clockDescription = document.getElementById("clock-description");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const startYear = 2089;
  // Explicit two's-complement wrapping; JavaScript Numbers cannot represent
  // the final increments at the signed 64-bit boundary exactly.
  const maximumYear = (1n << 63n) - 1n;
  const overflowYear = BigInt.asIntN(64, maximumYear + 1n);
  const endYear = -1n; // Unknown-year sentinel after the clock fails.
  const clockDuration = 3600;
  const clockLimitHold = 175;
  const clockOverflowHold = 175;
  const kernelDuration = 2400;
  const yearFormat = new Intl.NumberFormat("en-US");
  const endYearLabel = yearFormat.format(endYear);
  const endYearDescription = yearFormat.format(endYear);
  const records = Array.from(transmission.querySelectorAll(".log-line"), (node) => ({
    node,
    text: node.textContent,
    delay: Number(node.dataset.delay) || 0,
  }));

  // Expose the whole recovered log to screen readers once, rather than announcing
  // every character of its visual typing effect.
  const accessibleLog = document.createElement("div");
  accessibleLog.className = "sr-only";
  accessibleLog.textContent = records.map((record) => record.text).join("\n");
  transmission.before(accessibleLog);
  transmission.setAttribute("aria-hidden", "true");

  let index = 0;
  let character = 0;
  let typingTimer = null;
  let kernelStarted = false;
  let kernelLoaded = false;
  let kernelElapsed = 0;
  let kernelLastTick = null;
  let ambientTimer = null;
  let clockTimer = null;
  let clockStarted = false;
  let clockFinished = false;
  let clockElapsed = 0;
  let clockLastTick = null;
  let finished = false;
  let acknowledged = form.dataset.subscribed === "true";
  let submitting = false;
  let followTail = true;
  let ambientIndex = 0;
  const ambientNodes = [];
  const ambientMessages = [
    "> station beacon repeating. stock is finite.",
    "> helm program waiting for a destination.",
    "> automatic reply received. origin unresolved.",
    "> life support is still drawing power.",
    "> unidentified signal at sector edge.",
    "\u201cstill there?\u201d",
  ];

  function suspended() {
    return document.hidden;
  }

  function revealShip() {
    const canvas = document.getElementById("ship-flight");
    if (!canvas || canvas.dataset.wakeRevealed === "true") return;
    canvas.dataset.wakeRevealed = "true";
    canvas.dispatchEvent(new Event("entropy:ship-awake"));
  }

  function updateCarrier() {
    carrier.textContent = acknowledged
      ? "early access signup accepted."
      : submitting
        ? "transmitting signup..."
        : finished
          ? "early access signup open."
          : clockStarted && !clockFinished
            ? "RECONSTRUCTING SHIP CLOCK"
            : kernelStarted && !kernelLoaded
              ? "LOADING KERNEL"
              : "RECOVERING SIGNAL";
  }

  function follow() {
    if (followTail) scrollback.scrollTop = scrollback.scrollHeight;
  }

  function stopTimers() {
    window.clearTimeout(typingTimer);
    window.clearTimeout(ambientTimer);
    window.clearTimeout(clockTimer);
    typingTimer = null;
    ambientTimer = null;
    clockTimer = null;
    clockLastTick = null;
    kernelLastTick = null;
  }

  function tickKernel() {
    typingTimer = null;
    if (suspended() || finished || kernelLoaded) return;
    const now = window.performance.now();
    if (kernelLastTick !== null) kernelElapsed += now - kernelLastTick;
    kernelLastTick = now;
    const progress = Math.min(1, kernelElapsed / kernelDuration);
    const blocks = Math.floor(progress * 10);
    const record = records[0];
    record.node.textContent = `loading kernel [${"#".repeat(blocks)}${".".repeat(10 - blocks)}] ${Math.floor(progress * 100)}%`;
    follow();
    if (progress === 1) {
      kernelLoaded = true;
      kernelLastTick = null;
      record.node.textContent = record.text;
      record.node.classList.remove("is-typing");
      index = 1;
      updateCarrier();
      typingTimer = window.setTimeout(typeNext, record.delay);
    } else {
      typingTimer = window.setTimeout(tickKernel, 120);
    }
  }

  function startKernel() {
    kernelStarted = true;
    kernelLastTick = window.performance.now();
    records[0].node.hidden = false;
    records[0].node.classList.add("is-typing");
    updateCarrier();
    tickKernel();
  }

  function finishClock() {
    window.clearTimeout(clockTimer);
    clockTimer = null;
    clockLastTick = null;
    clockFinished = true;
    clockElapsed = clockDuration;
    yearDisplay.textContent = endYearLabel;
    clockDescription.textContent = `Ship year ${endYearDescription}. Signed 64-bit clock overflow. Actual year unknown. Cryosleep has ended.`;
    clock.classList.remove("is-advancing");
    clock.classList.add("is-awake");
  }

  function tickClock() {
    clockTimer = null;
    if (suspended() || finished || clockFinished) return;
    const now = window.performance.now();
    if (clockLastTick !== null) clockElapsed += now - clockLastTick;
    clockLastTick = now;
    const progress = Math.min(1, clockElapsed / (clockDuration - clockLimitHold - clockOverflowHold));
    // A curved exponential ramp lets the first years register before the
    // digits race through centuries and beyond. Hold the exact positive limit
    // briefly before one final increment wraps the clock into negative years.
    const animatedYear = BigInt(Math.round(
      startYear * Math.exp(Math.log(Number(maximumYear) / startYear) * progress ** 1.75),
    ));
    const year = clockElapsed >= clockDuration - clockOverflowHold ? overflowYear
      : progress === 1 ? maximumYear
        : animatedYear < maximumYear ? animatedYear : maximumYear - 1n;
    yearDisplay.textContent = yearFormat.format(year);
    if (clockElapsed >= clockDuration) {
      finishClock();
      updateCarrier();
      typingTimer = window.setTimeout(typeNext, 650);
    } else {
      clockTimer = window.setTimeout(tickClock, 32);
    }
  }

  function startClock() {
    clockStarted = true;
    clockLastTick = window.performance.now();
    clockDescription.textContent = `Cryosleep is ending. The ship clock is advancing from year ${startYear} toward its signed 64-bit limit.`;
    clock.classList.add("is-advancing");
    updateCarrier();
    clockTimer = window.setTimeout(tickClock, 32);
  }

  function scheduleAmbient() {
    if (!finished || acknowledged || suspended() || document.activeElement === input || reducedMotion.matches || ambientTimer !== null) return;
    ambientTimer = window.setTimeout(() => {
      ambientTimer = null;
      if (suspended() || acknowledged || document.activeElement === input || reducedMotion.matches) return;
      const node = document.createElement("p");
      node.className = "log-line system";
      node.textContent = ambientMessages[ambientIndex % ambientMessages.length];
      ambientIndex += 1;
      transmission.append(node);
      ambientNodes.push(node);
      // Keep one incoming line so idle traffic cannot crowd out the signup.
      if (ambientNodes.length > 1) ambientNodes.shift().remove();
      follow();
      scheduleAmbient();
    }, 28000);
  }

  function completeTransmission() {
    window.clearTimeout(typingTimer);
    typingTimer = null;
    kernelLoaded = true;
    kernelElapsed = kernelDuration;
    kernelLastTick = null;
    finishClock();
    records.forEach(({ node, text }) => {
      node.hidden = false;
      node.textContent = text;
      node.classList.remove("is-typing");
    });
    revealShip();
    index = records.length;
    finished = true;
    channel.hidden = false;
    form.hidden = acknowledged;
    input.disabled = acknowledged || submitting;
    transmit.disabled = acknowledged || submitting;
    updateCarrier();
    follow();
    scheduleAmbient();
  }

  function typeNext() {
    typingTimer = null;
    if (suspended() || finished) return;
    if (index === 0 && !kernelLoaded) {
      startKernel();
      return;
    }
    // The wake-up preamble finishes before the clock runs away. All remaining
    // CLI output waits until the clock settles on its exact final year.
    if (index === 3 && !clockFinished) {
      startClock();
      return;
    }
    const record = records[index];
    if (!record) {
      completeTransmission();
      return;
    }
    record.node.hidden = false;
    record.node.classList.add("is-typing");
    const startingLine = character === 0;
    const systemLine = record.node.classList.contains("system");
    character = Math.min(record.text.length, character + (systemLine ? 3 : 2));
    record.node.textContent = record.text.slice(0, character);
    if (startingLine && record.node.hasAttribute("data-ship-reveal")) revealShip();
    follow();
    if (character === record.text.length) {
      record.node.classList.remove("is-typing");
      character = 0;
      index += 1;
      typingTimer = window.setTimeout(typeNext, record.delay);
    } else {
      typingTimer = window.setTimeout(typeNext, systemLine ? 12 : 24);
    }
  }

  function resume() {
    if (suspended()) return;
    if (finished) scheduleAmbient();
    else if (kernelStarted && !kernelLoaded) {
      if (typingTimer === null) {
        kernelLastTick = window.performance.now();
        typingTimer = window.setTimeout(tickKernel, 120);
      }
    } else if (clockStarted && !clockFinished) {
      if (clockTimer === null) {
        clockLastTick = window.performance.now();
        clockTimer = window.setTimeout(tickClock, 32);
      }
    } else if (typingTimer === null) typingTimer = window.setTimeout(typeNext, 80);
  }

  // Reading older lines turns off automatic scrolling until the visitor returns
  // to the bottom. Text selection also holds the viewport in place.
  scrollback.addEventListener("scroll", () => {
    followTail = scrollback.scrollHeight - scrollback.scrollTop - scrollback.clientHeight < 48;
  }, { passive: true });
  scrollback.addEventListener("pointerdown", () => { followTail = false; });

  input.addEventListener("focus", () => {
    window.clearTimeout(ambientTimer);
    ambientTimer = null;
  });
  input.addEventListener("blur", () => {
    scheduleAmbient();
  });

  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("tab-asleep", document.hidden);
    if (document.hidden) stopTimers();
    else resume();
  });

  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) {
      stopTimers();
      completeTransmission();
    } else {
      resume();
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!finished || acknowledged || submitting) return;
    input.value = input.value.trim();
    if (!form.reportValidity()) return;

    submitting = true;
    stopTimers();
    input.disabled = true;
    transmit.disabled = true;
    form.setAttribute("aria-busy", "true");
    response.textContent = "";
    updateCarrier();

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 18000);
    try {
      const reply = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams({ email: input.value }),
        signal: controller.signal,
      });
      let result;
      try {
        result = await reply.json();
      } catch {
        throw new Error("signup is temporarily unavailable. please try again.");
      }
      if (!reply.ok || result.ok !== true) {
        throw new Error(result.message || "signup is temporarily unavailable. please try again.");
      }

      acknowledged = true;
      followTail = true;
      const receipt = document.createElement("p");
      receipt.className = "log-line bright";
      receipt.textContent = "your_email > [accepted]";
      form.before(receipt);
      input.value = "";
      form.hidden = true;
      carrier.hidden = true;
      document.getElementById("channel-note").hidden = true;
      response.textContent = result.message;
      follow();
    } catch (error) {
      response.textContent = error.name === "AbortError"
        ? "signup timed out. please try again."
        : error.name === "TypeError"
          ? "connection lost. please try again."
          : error.message;
    } finally {
      window.clearTimeout(timeout);
      submitting = false;
      form.removeAttribute("aria-busy");
      input.disabled = acknowledged;
      transmit.disabled = acknowledged;
      if (!acknowledged) {
        input.focus();
        scheduleAmbient();
      }
      updateCarrier();
    }
  });

  // Without JavaScript the server-rendered form works as a normal HTML POST.
  // With JavaScript, wait until the recovered transmission finishes.
  input.disabled = true;
  transmit.disabled = true;
  document.body.classList.toggle("tab-asleep", document.hidden);

  if (reducedMotion.matches) {
    completeTransmission();
  } else {
    channel.hidden = true;
    records.forEach(({ node }) => {
      node.hidden = true;
      node.textContent = "";
    });
    resume();
  }
})();
