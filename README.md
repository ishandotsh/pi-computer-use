# pi-computer-use

<p align="center">
  <img src="./assets/logo/logo3.png" width="50%" alt="pi-computer-use">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@injaneity/pi-computer-use"><img alt="npm" src="https://img.shields.io/npm/v/@injaneity/pi-computer-use?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/github/license/injaneity/pi-computer-use?style=flat-square"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%2FX11-lightgrey?style=flat-square">
  <a href="https://github.com/injaneity/pi-computer-use/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/injaneity/pi-computer-use/ci.yml?branch=main&style=flat-square"></a>
</p>

Codex-style computer use for [Pi](https://pi.dev/) on macOS and Linux/X11.

`pi-computer-use` gives Pi agents a computer-use surface for visible desktop windows. On macOS it prefers Accessibility (AX) targets such as `@e1`, returns semantic state after every action, and attaches screenshots only when AX coverage is too weak for reliable operation. On Linux it currently provides an X11 coordinate-based MVP for screenshots, window selection, pointer actions, scrolling, and keyboard input.

## Table of Contents

- [Quick Start](#quick-start)
- [Linux/X11 Prerequisites](#linuxx11-prerequisites)
- [What It Adds to Pi](#what-it-adds-to-pi)
- [Examples](#examples)
- [How It Works](#how-it-works)
- [Documentation](#documentation)
- [Development & Benchmarks](#development--benchmarks)
- [Release & Install Notes](#release--install-notes)
- [License](#license)
- [See Also](#see-also)

## Quick Start

Install the Pi package:

```bash
pi install git:github.com/injaneity/pi-computer-use#v0.2.0
```

On macOS, start Pi in interactive mode. On the first session, grant macOS permissions to:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required macOS permissions:

- Accessibility
- Screen Recording

On Linux, make sure you are running an X11/Xorg session and install the system prerequisites in [Linux/X11 Prerequisites](#linuxx11-prerequisites). No Linux desktop permission prompt is expected.

Then call `screenshot` first in a Pi session. It selects the controlled window and returns the latest state. On macOS this may include AX refs such as `@e1`; on Linux, use coordinates from the returned screenshot.

```ts
screenshot({ app: "Safari" })
click({ ref: "@e1" })
set_text({ ref: "@e2", text: "hello" })
```

Linux coordinate example:

```ts
screenshot({ app: "Firefox" })
click({ x: 320, y: 180, captureId: "..." })
type_text({ text: "hello from Linux/X11" })
```

Use `/computer-use` in Pi to inspect the effective config and config sources.

## Linux/X11 Prerequisites

The Linux helper is a Node.js script that drives an X11 desktop through standard command-line tools. Install these before using the package on Ubuntu/Debian-style systems:

```bash
sudo apt update
sudo apt install wmctrl xdotool imagemagick x11-utils x11-apps
```

The install/runtime setup checks for these tools and prints a clear hint if anything is missing. `npm install`/`pi install` does not install operating-system packages for you.

Linux support requires an X11 session with `DISPLAY` set. If your desktop login screen offers a choice, select an Xorg/X11 session instead of Wayland.

## What It Adds to Pi

- Public tools: `screenshot`, `click`, `double_click`, `move_mouse`, `drag`, `scroll`, `keypress`, `type_text`, `set_text`, `wait`, `computer_actions`.
- AX target refs in tool results on macOS, with capabilities such as `canSetValue`, `canPress`, `canFocus`, `canScroll`, and `adjust`.
- Ref-first actions on macOS such as `click({ ref: "@eN" })`, `scroll({ ref: "@eN" })`, and `set_text({ ref: "@eN", text })`.
- Coordinate-based actions on macOS and Linux/X11 using coordinates from the latest screenshot.
- Batched actions through `computer_actions`, with one post-action state update plus per-action execution metadata.
- Execution metadata that reports `stealth` for background-safe AX paths and `default` for focus/raw-event fallbacks.
- Full pointer and keyboard primitive coverage for common GUI flows, with AX-first equivalents where available on macOS.
- Browser-aware targeting, including isolated browser window preference where appropriate on macOS.
- Optional strict AX mode for macOS background-safe operation without foreground focus, raw pointer events, raw keyboard events, or cursor takeover.
- Official QA benchmark harness in [`benchmarks/`](./benchmarks/README.md).

## Examples

Prefer AX refs over coordinates when a matching target exists. This is primarily the macOS workflow:

```ts
click({ ref: "@e1" })
scroll({ ref: "@e3", scrollY: 600 })
```

Use coordinates from the latest screenshot when there is no suitable AX target or when running on Linux/X11:

```ts
click({ x: 320, y: 180, captureId: "..." })
```

Replace text through AX value semantics on macOS:

```ts
set_text({ ref: "@e2", text: "https://example.com" })
keypress({ keys: ["Enter"] })
```

Type through foreground keyboard events on Linux/X11:

```ts
click({ x: 320, y: 180, captureId: "..." })
type_text({ text: "https://example.com" })
keypress({ keys: ["Enter"] })
```

Batch obvious actions when no intermediate inspection is needed:

```ts
computer_actions({
  captureId: "...",
  actions: [
    { type: "click", ref: "@e1" },
    { type: "set_text", ref: "@e2", text: "https://example.com" },
    { type: "keypress", keys: ["Enter"] }
  ]
})
```

Linux/X11 batch example:

```ts
computer_actions({
  captureId: "...",
  actions: [
    { type: "click", x: 320, y: 180 },
    { type: "type_text", text: "https://example.com" },
    { type: "keypress", keys: ["Enter"] }
  ]
})
```

See [docs/usage.md](./docs/usage.md) for the full workflow and tool patterns.

## How It Works

`pi-computer-use` has three pieces:

1. The Pi extension in [`extensions/computer-use.ts`](./extensions/computer-use.ts) registers the public tools and `/computer-use` command.
2. The TypeScript bridge in [`src/bridge.ts`](./src/bridge.ts) manages the current window, capture IDs, AX refs when available, fallback policy, batching, and execution metadata.
3. A platform helper implements the desktop protocol:
   - macOS: the native Swift helper in [`native/macos/bridge.swift`](./native/macos/bridge.swift) talks to Accessibility, ScreenCaptureKit, AppKit, and CoreGraphics.
   - Linux/X11: the Node.js helper in [`native/linux/bridge.mjs`](./native/linux/bridge.mjs) talks to X11 through `wmctrl`, `xdotool`, `xprop`, and ImageMagick/X11 screenshot tools.

The macOS result is semantic-first GUI control: Pi sees useful AX targets first, falls back to screenshots only when needed, and reports whether each action stayed background-safe. The Linux/X11 backend currently provides a coordinate-first fallback surface for common desktop automation tasks.

## Documentation

- [Usage guide](./docs/usage.md): tool workflow, AX refs, text input, browser flows, batching, and strict AX mode.
- [Configuration](./docs/configuration.md): config files, environment overrides, browser control, and stealth mode.
- [Development](./docs/development.md): local setup, helper builds, validation, release signing notes, and PR workflow.
- [Troubleshooting](./docs/troubleshooting.md): permissions, helper setup, stale refs, browser refusal, Linux/X11 prerequisites, and strict mode errors.
- [Benchmarks](./benchmarks/README.md): benchmark commands, metrics, regression policy, and local comparison workflow.
- [Contributing](./CONTRIBUTING.md): issue-first contribution rules and PR checklist.

## Development & Benchmarks

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
```

Run the local checkout in Pi without loading another installed copy:

```bash
pi --no-extensions -e .
```

Run the default QA benchmark:

```bash
npm run benchmark:qa
```

Run the wider benchmark that may open apps:

```bash
npm run benchmark:qa:full
```

## Release & Install Notes

The package is published on npm as `@injaneity/pi-computer-use`.

```bash
npm install @injaneity/pi-computer-use
npm install @injaneity/pi-computer-use@0.2.0
```

Pi installs should pin a GitHub release tag:

```bash
pi install git:github.com/injaneity/pi-computer-use#v0.2.0
pi install -l git:github.com/injaneity/pi-computer-use#v0.2.0
pi install /absolute/path/to/pi-computer-use
```

Remove:

```bash
pi remove git:github.com/injaneity/pi-computer-use#v0.2.0
npm remove @injaneity/pi-computer-use
```

For a different release, replace `v0.2.0` or `0.2.0` with the version you want to pin.

## Screenshots

![pi-computer-use screenshot](./assets/reference/img.jpg)

## License

MIT

## See Also

- [Pi](https://pi.dev/)
- [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai)
