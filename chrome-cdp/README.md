# Chrome CDP

## Production contract

- Google Chrome: `/Applications/Google Chrome.app`
- Profile: `$HOME/chrome-cdp-profile`
- CDP: `127.0.0.1:9222`
- Readiness timeout: 10 seconds; poll interval: 200 ms
- Launch lock: `$HOME/Library/Caches/Chrome CDP/launch.lock` with a 10-second timeout

## Safety boundaries

- CDP is loopback-only; no wildcard or LAN bind and no `--remote-allow-origins=*`.
- Chrome remains headed.
- The normal Chrome profile, default browser, and HTTP/HTTPS handlers remain unchanged.
- No credentials are stored.

## Development

From `/Users/david.david/Personal/ai/chrome-cdp`:

```bash
/usr/bin/swift test
/usr/bin/swift build -c release
```
