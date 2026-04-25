# Troubleshooting

## The Helper Is Missing Or Not Executable

Reinstall the helper from the package:

```bash
node scripts/setup-helper.mjs --runtime
```

Or build the macOS helper locally:

```bash
node scripts/build-native.mjs --output ~/.pi/agent/helpers/pi-computer-use/bridge
```

Linux does not need a native build; setup copies `native/linux/bridge.mjs` to the helper path.

Confirm the helper exists:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

## macOS Permissions Still Fail

Grant both permissions to the helper:

```text
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required permissions:

- Accessibility
- Screen Recording

If macOS still denies access:

1. Remove the helper from the permission list.
2. Add it again.
3. Restart Pi.
4. Retry `screenshot`.

## Non-Interactive Setup Fails

Permission setup requires an interactive Pi session because macOS permission panes are user-controlled.

Start Pi interactively, grant permissions, then retry the non-interactive workflow.

## Linux/X11 Prerequisites Fail

Linux support currently requires an X11/Xorg session and external X11 tools. On Ubuntu/Debian-style systems, install:

```bash
sudo apt update
sudo apt install wmctrl xdotool imagemagick x11-utils x11-apps
```

If the helper reports `DISPLAY is not set`, start Pi from an interactive graphical X11 session. If it reports a Wayland session, log out and choose an Xorg/X11 session at the desktop login screen.

The Linux backend is currently coordinate-based. Semantic AX refs like `@e1`, ref-first actions, and `set_text({ ref, text })` are not implemented yet on Linux.

## Browser Windows Are Refused

Check the effective config:

```text
/computer-use
```

If `browser_use` is disabled, enable it in one of:

```text
~/.pi/agent/extensions/pi-computer-use.json
.pi/computer-use.json
```

Example:

```json
{
  "browser_use": true
}
```

## Strict AX Mode Blocks An Action

Strict AX mode blocks:

- raw pointer events
- raw keyboard events
- foreground focus fallbacks
- cursor takeover
- non-AX browser bootstrap

Use AX refs from the latest `screenshot`, open a dedicated browser window manually, or disable strict AX mode for workflows that require raw event fallback.

## Coordinates Are Rejected As Stale

Coordinates are valid only for the latest screenshot state. Call `screenshot` again and retry with the new `captureId`.

## An AX Ref Is Missing Or Stale

AX refs are scoped to the latest semantic state. Call `screenshot` or `wait` to refresh the target list.

The bridge attempts stale-ref recovery for compatible role, label, capability, and position matches, but not every stale ref can be safely recovered.

## Screenshot Or Window Capture Fails

Confirm:

- On macOS, Screen Recording is granted.
- On Linux, you are running under X11/Xorg and have `wmctrl`, `xdotool`, `xprop`, and ImageMagick/X11 screenshot tools installed.
- The target app has an open, controllable window.
- The window is not closed or hidden between `screenshot` and action.
- You are running on macOS or Linux/X11.

If the target is ambiguous, call `screenshot` with both app and window title:

```ts
screenshot({ app: "TextEdit", windowTitle: "Untitled" })
```
