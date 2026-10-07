import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./script.js", import.meta.url), "utf8");

// Plain objects model only the signup state; no browser or interface is rendered.
function signupHarness(fetch) {
  const nodes = new Map();
  const document = {
    hidden: false,
    activeElement: null,
    body: { classList: { toggle() {} } },
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: () => node(),
    addEventListener() {},
  };
  function node() {
    return {
      textContent: "", value: "", hidden: false, disabled: false,
      dataset: {}, listeners: {}, receipts: [], attributes: {},
      scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      classList: { add() {}, remove() {} },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      before(element) { this.receipts.push(element); },
      querySelectorAll: () => [],
      reportValidity: () => true,
      focus() { document.activeElement = this; },
    };
  }
  for (const id of ["transmission", "scrollback", "carrier-state", "return-channel", "return-address-form", "return-address", "transmit", "response", "ship-clock", "ship-year", "clock-description", "channel-note"]) {
    nodes.set(id, node());
  }
  const form = nodes.get("return-address-form");
  form.action = "https://eroded.example.com/signup";
  form.dataset.subscribed = "false";
  vm.runInNewContext(source, {
    document, fetch, AbortController, URLSearchParams,
    window: {
      matchMedia: () => ({ matches: true, addEventListener() {} }),
      setTimeout: () => 1,
      clearTimeout() {},
    },
  });
  const input = nodes.get("return-address");
  input.value = "  pilot+alpha@example.com  ";
  return {
    form, input,
    button: nodes.get("transmit"),
    response: nodes.get("response"),
    submit: () => form.listeners.submit({ preventDefault() {} }),
  };
}

const accepted = () => ({ ok: true, json: async () => ({ ok: true, message: "you're on the list." }) });

test("signup waits for the server before showing acceptance and prevents duplicate requests", async () => {
  let finish;
  let calls = 0;
  const pending = new Promise((resolve) => { finish = resolve; });
  const harness = signupHarness((url, options) => {
    calls++;
    assert.equal(url, "https://eroded.example.com/signup");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.body.get("email"), "pilot+alpha@example.com");
    return pending;
  });
  const submission = harness.submit();
  assert.equal(harness.input.disabled, true);
  assert.equal(harness.button.disabled, true);
  assert.equal(harness.form.hidden, false);
  assert.equal(harness.form.receipts.length, 0);
  await harness.submit();
  assert.equal(calls, 1);
  finish(accepted());
  await submission;
  assert.equal(harness.form.hidden, true);
  assert.equal(harness.input.value, "");
  assert.equal(harness.form.receipts[0].textContent, "your_email > [accepted]");
  assert.equal(harness.response.textContent, "you're on the list.");
});

test("failed signup preserves the email and allows a successful retry", async () => {
  let calls = 0;
  const harness = signupHarness(async () => ++calls === 1
    ? { ok: false, json: async () => ({ ok: false, message: "try again in a minute." }) }
    : accepted());
  await harness.submit();
  assert.equal(harness.form.hidden, false);
  assert.equal(harness.input.disabled, false);
  assert.equal(harness.button.disabled, false);
  assert.equal(harness.input.value, "pilot+alpha@example.com");
  assert.equal(harness.form.receipts.length, 0);
  assert.equal(harness.response.textContent, "try again in a minute.");
  await harness.submit();
  assert.equal(calls, 2);
  assert.equal(harness.form.hidden, true);
});

for (const failure of ["network", "timeout", "invalid response"]) {
  test(`${failure} leaves signup available without an accepted receipt`, async () => {
    const harness = signupHarness(async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return { ok: true, json: async () => { throw new SyntaxError("not JSON"); } };
    });
    await harness.submit();
    assert.equal(harness.form.hidden, false);
    assert.equal(harness.input.disabled, false);
    assert.equal(harness.input.value, "pilot+alpha@example.com");
    assert.equal(harness.form.receipts.length, 0);
    assert.match(harness.response.textContent, /please try again/);
    assert.equal(harness.form.attributes["aria-busy"], undefined);
  });
}
