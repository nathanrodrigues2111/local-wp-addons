# Cloudflare Tunnel — a Local (LocalWP) add-on

Expose a Local site on a **public `trycloudflare.com` URL** with one click. Perfect for:

- **OAuth callbacks** (Instagram/TikTok/YouTube feed connections need a public redirect URI)
- **Webhooks** from external services
- Quickly sharing work-in-progress with someone

Uses Cloudflare **quick tunnels** — no Cloudflare account or login required.

## The URL-rewrite trick

A tunnel alone isn't enough: WordPress redirects visitors back to its `home`/`siteurl`
(`your-site.local`), which doesn't exist outside your machine. So the add-on (optionally,
on by default) **points `home`/`siteurl` at the tunnel URL while the tunnel runs** and
**restores them when it stops** (also when the site stops or Local quits).

## Requirements

- The site must be **running**.
- `cloudflared` binary. One-line install (Linux):

```bash
curl -L -o ~/.local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  && chmod +x ~/.local/bin/cloudflared
```

macOS: `brew install cloudflared` · Windows: `winget install Cloudflare.cloudflared`

The add-on looks in `~/.local/bin`, the usual system paths, and `PATH`.

## Usage

1. Start your site → **Tools → Cloudflare Tunnel**.
2. Leave "Point WordPress URLs at the tunnel" checked → **Start tunnel**.
3. Copy the `https://<random>.trycloudflare.com` URL — it serves your site publicly.
4. **Stop tunnel** when done — site URLs are restored automatically.

## Install

```bash
git clone https://github.com/nathanrodrigues2111/local-wp-addons.git
cd local-wp-addons/local-addon-cloudflare-tunnel
npm install --legacy-peer-deps
npm run build
ln -s "$(pwd)" ~/.config/Local/addons/local-addon-cloudflare-tunnel   # Linux
```

Enable it under **Local → Add-ons**, relaunch Local.

## Notes

- Quick-tunnel URLs are random and change per tunnel session.
- If URL restore ever fails (e.g. site was stopped mid-tunnel), the error message includes
  the exact `wp option update` commands to fix it manually.

## License

MIT
