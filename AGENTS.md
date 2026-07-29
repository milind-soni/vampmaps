# Agent Instructions

<!-- revyl:agents:start -->
## Revyl — run this app on a cloud device

Use the Revyl CLI to build, run, and verify app changes on a cloud device.
Revyl viewer URLs are live device streams — share them with the user as soon
as you have one.

On a local machine the CLI opens the live viewer in the user's browser
automatically when the session is ready (check "opened_browser" in the
handshake; --no-open disables it). ALWAYS also post viewer_url as a clickable
markdown link — that is the fallback on cloud VMs — and never try to open a
browser yourself.

One-time setup (ephemeral shells may lack the CLI):

```bash
if ! command -v revyl >/dev/null 2>&1; then
  REVYL_NO_MODIFY_PATH=1 sh -c 'curl -fsSL https://revyl.com/install.sh | sh'
  export PATH="$HOME/.revyl/bin:$PATH"
fi
revyl auth status || revyl auth login --token "$REVYL_API_KEY"
```

Dev loop (run from the app directory containing .revyl/config.yaml):

```bash
# Start in the background. Returns JSON as soon as the simulator is watchable;
# the build keeps running behind it. Share viewer_url with the user right away.
revyl dev --remote --detach --json

# Watch the build until the app is installed and launched.
revyl dev status            # state: building -> idle; last_rebuild.status: running -> success
revyl dev logs --build --follow

# After each code change:
revyl dev rebuild --wait --json
```

Verify like a user (separate short-lived commands; never in the loop terminal):

```bash
revyl device screenshot --out screen.png
revyl device validation -s 0 "<expected user-visible outcome>" --json
revyl device report --session-id <session-id> --json
```

Auth: when .revyl/config.yaml has an auth_bypass section, sessions launch
authenticated automatically (launch vars + deep link are applied for you). If
the app ever shows a logged-out state mid-session (expired token), re-mint the
launch vars with this repo's own mint script (if it has one), then re-fire the
auth deep link:

```bash
revyl dev auth refresh
```

Stop with `revyl dev stop` when done. Never paste launch-var values or
tokens into code, logs, screenshots, or PRs — reference key names only.
<!-- revyl:agents:end -->
