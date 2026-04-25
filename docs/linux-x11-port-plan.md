# Linux/X11 Port Plan

## Goal

Add an Ubuntu/X11 backend for the existing `pi-computer-use` JSON helper protocol, starting with coordinate-based actions:

- `listApps`
- `listWindows`
- `getFrontmost`
- `screenshot`
- `mouseClick`
- `scrollWheel`
- `keyPress`

Wayland is explicitly out of scope for this phase.

## Backend choice

Use a Node.js Linux helper for the first X11 implementation: `native/linux/bridge.mjs`.

Rationale:

- The TypeScript runtime already talks to helpers over newline-delimited JSON; Node can implement that protocol directly.
- No native compile step is needed for the MVP.
- Packaging is simpler than C++/Rust/Python because Node is already required by Pi and this package.
- X11 operations can initially delegate to mature command-line tools, then be replaced with direct Xlib/XCB/AT-SPI bindings later if needed.

Alternatives considered:

- C++/Xlib: strongest long-term option, but slower to build and adds native dependency/linking complexity.
- Python: fast to prototype, but introduces Python runtime/module packaging concerns.
- Rust: good long-term option, but still adds compile/toolchain overhead.

## Phase 1: coordinate-only X11 MVP

System dependencies:

- `wmctrl` for window enumeration.
- `xdotool` for focus, mouse, scroll, and keyboard input.
- ImageMagick `import`, or fallback `xwd` + ImageMagick `convert`, for window screenshots.
- X11 session with `DISPLAY` set.

Implemented protocol behavior:

- `checkPermissions`: returns true for both permission flags on Linux/X11.
- `listApps`: groups `wmctrl -lpxG` windows by pid.
- `listWindows`: maps `wmctrl -lpxG` rows to the existing helper window shape.
- `getFrontmost`: uses `xdotool getwindowfocus` plus `wmctrl` metadata.
- `screenshot`: captures a window to PNG and returns `{ pngBase64, width, height, scaleFactor: 1 }`.
- `mouseClick`, `mouseMove`, `mouseDrag`: activate the window and send pointer events through `xdotool`.
- `scrollWheel`: moves to the point and sends X11 scroll button clicks.
- `keyPress`, `typeText`: sends keyboard input through `xdotool`.
- AX commands: return empty/false stubs until AT-SPI is added.

## Phase 2: harden the X11 MVP

- Detect missing dependencies at setup/runtime and produce install hints, e.g.:
  - `sudo apt install wmctrl xdotool imagemagick x11-apps`
- Validate geometry alignment across common Ubuntu window managers.
- Add integration smoke tests that run only when `DISPLAY` and dependencies are present.
- Decide if screenshots should include window decorations consistently, then adjust coordinate mapping accordingly.
- Improve app naming from `WM_CLASS` and desktop metadata.
- Add Linux-specific docs and troubleshooting.

## Phase 3: semantic refs through AT-SPI

Implement the semantic subset equivalent to macOS AX using AT-SPI2 over D-Bus:

- `axListTargets`
- `axPressElement`
- `axFocusElement`
- `focusedElement`
- `setValue`
- `axScrollElement`
- `axScrollAtPoint`

Likely backend options for this phase:

- Keep the Node helper and call a small Python/pyatspi sidecar.
- Replace the helper with a compiled C++/Rust backend using AT-SPI D-Bus directly.

The preferred production direction is probably C++/Rust once the protocol and behavior stabilize, but the Node helper is best for the initial port.
