# Eroded transmission

One giant CRT in dark space. A recovered ship log types itself into its green screen while tiny stars drift behind the monitor. The early access email signup lives inside the terminal. There is no navigation, conventional hero, feature grid, or footer.

The landing page is a standalone Go app using only the standard library. It embeds
the HTML template, CSS, JavaScript, fonts, and vector assets into one binary and
adds signups directly to a configured Mailgun mailing list.

## Run

Install Go **1.22 or newer**, create the mailing list in Mailgun, then:

```sh
cd landing
export MAILGUN_API_KEY='your-private-api-key'
export MAILGUN_LIST_ADDRESS='alpha@mg.example.com'
go run .
```

Open http://localhost:8080. The app requires the two Mailgun values at startup;
the API key must allow mailing list management, rather than only sending messages.
No Mailgun request is made until a visitor submits the signup form.

To build a binary that can run from any directory:

```sh
go build -trimpath -o eroded-landing .
./eroded-landing
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAILGUN_API_KEY` | Required | Private API key with mailing list access. |
| `MAILGUN_LIST_ADDRESS` | Required | Address of an existing Mailgun list. |
| `HTTP_ADDR` | `:8080` | HTTP listen address. |
| `MAILGUN_API_BASE_URL` | `https://api.mailgun.net/v3` | Use `https://api.eu.mailgun.net/v3` for an EU list. HTTPS is required. |
| `PUBLIC_URL` | Request host | Optional canonical origin, such as `https://eroded.example.com`, for signup origin checks. |
| `SIGNUP_RATE_LIMIT` | `5` | Maximum signup attempts per client IP per minute, per process. |
| `TRUSTED_PROXY_CIDRS` | None | Comma-separated proxy IP networks whose `X-Forwarded-For` chain can determine the client IP. |

`.env.example` documents the settings. The app reads environment variables directly;
it does not automatically load a `.env` file. For a local shell, copy the example
to `.env`, fill in the values, then export them:

```sh
set -a
. ./.env
set +a
go run .
```

For public deployment, terminate HTTPS at your reverse proxy and set `PUBLIC_URL`.
If the proxy is on the same machine, `HTTP_ADDR=127.0.0.1:8080` binds only to
loopback, and `TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128` enables its forwarded client
addresses. Forwarded headers from other peers are ignored.

## Container

```sh
docker build -t eroded-landing .
docker run --rm --env-file .env -p 8080:8080 eroded-landing
```

The final image contains the static Go binary and TLS certificate roots, runs as
an unprivileged user, and requires no application files or writable disk.

## Behavior

- Green phosphor glow, gentle flicker, scanlines, curved glass, a rolling scan band, and an industrial monitor enclosure.
- The terminal heading uses the custom Eroded wordmark in phosphor green; its fractured E also appears in the browser favicon. The year counter sits inline to the right of the logo, wrapping below it on narrow screens.
- The original homepage's swept-wing vessel is rebuilt as a local, flat-shaded 3D mesh in `ship-model.js`. `ship-flight.js` renders it with transparent WebGL behind the CRT, with green windows, warm engine bells, and short exhaust plumes. The first pass appears at the visible left edge as “you awake on your ship.” starts typing, triggered by the line rather than a fixed timer. Passes last 14–18 seconds with 35–65 seconds of quiet between them, alternating direction and occasionally using the lower edge. Paths fit the exposed space around the monitor, leaving the CLI unobstructed.
- Flybys render at most 30 frames per second, cap pixel density at 1.5, and stop drawing between passes and in hidden tabs. Reduced motion disables flybys. If WebGL is unavailable, the terminal and stars continue normally. No external library or model download is required.
- The vessel shader gives the hull a dark metal finish, cold directional highlights, a teal rim light, and warm engine light across nearby panels. Windows stay emissive; exhaust uses additive blending and a subtle engine pulse that pauses with the flight.
- The kernel takes 2.4 seconds to load, with an ASCII progress bar, then pauses briefly before hull checks and cryosleep recovery. Hidden tabs pause the loader; reduced motion bypasses it.
- The ship clock beside the logo begins at **2089**. After the three-line cryosleep wake-up preamble, it accelerates to the signed 64-bit maximum, **9,223,372,036,854,775,807**, holds there for 175 milliseconds, then wraps to **-9,223,372,036,854,775,808** for another 175 milliseconds. It settles on **-1**, the unknown-year sentinel, and resumes the CLI. The sequence takes 3.6 seconds total, twice as fast as the original. BigInt and `BigInt.asIntN(64, ...)` preserve the exact boundary and two's-complement wrap. The accessible clock description explains that the actual year is unknown. Hidden tabs preserve progress; reduced motion settles immediately on **-1** before revealing the complete log.
- An eight-line transmission keeps the boot preamble, “you awake on your ship,” “the stars you know are gone,” oxygen at 23% and fuel at 3%, “explore. mine. trade. survive,” and another surviving voice. Compact paragraph spacing leaves room for the early access prompt.
- After the final line, the terminal opens early access signup with an `your_email >` prompt pinned to the bottom of the CLI. The transmission scrolls independently above it. Enter an email and press Enter (or the bracketed Enter control) to submit it to Mailgun through the Go app. The terminal acknowledges successful subscriptions; failures retain the address and enable retry. There are no bezel controls. Incoming ambient messages pause while the field has focus.
- Visitors can scroll back without being dragged to the latest line. Only the latest ambient message remains visible, and typing/timers/effects pause when the tab is hidden.
- Reduced-motion preferences disable animation, reveal the complete log immediately, and stop ambient messages. Screen readers get the entire transcript without character-by-character announcements.
- Without JavaScript, the complete log remains readable and the signup works as a normal HTML form submission.

## Signup

`POST /signup` accepts a URL-encoded form containing one `email` field. The server
validates the address and adds it to the configured list through Mailgun's
[member API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/mailing-lists/post-lists-string:list_address-members),
with `subscribed=true` and `upsert=true`. Submitting an existing address therefore
updates its subscription instead of creating a duplicate. This is direct signup;
the app does not send an email confirmation link.

JavaScript requests receive JSON. Normal HTML submissions redirect to the page
after success, or render an error with the address preserved when Mailgun is
unavailable. Success is reported only after Mailgun returns a matching subscribed
member. Requests have bounded bodies, origin checks, per-IP rate limits, and a
10-second upstream timeout. The API key stays on the server; addresses and Mailgun
response bodies are not logged. The app does not store signups locally.

Mailgun stores the subscriber list. Future announcements sent to the list should
include Mailgun's `%mailing_list_unsubscribe_url%` link so the signup's unsubscribe
promise works. See [Mailgun mailing lists](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/mailing-lists).

`GET /healthz` returns `ok` without contacting Mailgun. The process shuts down
gracefully on SIGINT or SIGTERM. Static routes serve only the embedded page assets;
Go source, configuration files, and directory listings are not exposed.

## Assets and verification

`assets/fonts/SourceCodePro-Regular.ttf` is an unmodified local Source Code Pro font, accompanied by its SIL Open Font License. `eroded-logo.svg`, `favicon.svg`, and `grain.svg` are local vector assets. The wordmark and favicon use the outlined artwork from `../assets/branding/`, with the wordmark's view box trimmed for placement in the header. The vessel uses procedural 3D geometry and WebGL; the remaining appearance and motion come from CSS and DOM elements.

Run these nonvisual checks from `landing/`:

```sh
gofmt -l *.go
go test -race ./...
go vet ./...
node --check script.js
node script_test.mjs
```

Tests mock Mailgun without making external requests and cover successful signup,
invalid and oversized requests, rejected and malformed upstream responses,
duplicates, origin checks, proxy handling, rate limits, normal HTML submissions,
and embedded asset serving. JavaScript tests use plain objects to check pending
signup, successful receipts, failure retries, and network errors without a browser
or rendering. Visual review belongs to the user under the project’s `AGENTS.md`.
