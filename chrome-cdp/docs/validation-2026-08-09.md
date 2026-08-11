# Chrome CDP live validation

Validated on 2026-08-11. Browser page contents, URLs beyond `about:blank`, target titles, credentials, and profile bytes were not recorded.

## Result

| Check | Result |
| --- | --- |
| Normal Chrome preserved | PASS — PID 766 remained running |
| Dedicated cold launch | PASS — headed Chrome PID 74796 |
| Warm helper reuse | PASS — reused PID 74796 |
| Spotlight/app launch reuse | PASS — process set and listener PID unchanged |
| Listener | PASS — `127.0.0.1:9333`, PID 74796 |
| CDP version/WebSocket | PASS — Chrome response, loopback host, port 9333 |
| Page policy | PASS — one existing page; warm reuse added no page |
| Dedicated profile | PASS — current UID 501, mode `0700`, stable inode |
| `agent-browser --cdp 9333` | PASS — returned `about:blank` |
| `agent-browser connect 9333` | PASS — connected and returned `about:blank` |
| Attached-session close | PASS — PID 74796 and CDP endpoint remained alive |
| `agent-browser --auto-connect` | NOT SUPPORTED — local 0.33.2 did not discover port 9333; explicit CDP works |
| Installed signature | PASS — deep strict verification |
| Spotlight discovery | PASS — bundle identifier resolved to `/Applications/Chrome CDP.app` |
| LaunchServices handlers | PASS — full `LSHandlers` hash unchanged by installer |

## Port selection

The initial 9222 baseline was already owned by normal Chrome PID 766 but returned HTTP 404 rather than a CDP version endpoint. The launcher did not terminate or restart that process. Production was moved to the free, fixed loopback port 9333, after which cold launch and warm reuse passed while PID 766 remained unchanged.

## Installation and recovery

The previous app was copied, manifested, signature-checked, and retained in backup directory `20260811T104142Z-85128`. The candidate was verified at its `/Applications` sibling stage, atomically swapped into place, strictly reverified, and indexed by Spotlight. Failed preflight stage candidates from earlier stopped attempts were moved into that backup's `failed-preflight-stages/` directory rather than deleted.

The installation uses ad-hoc signing and required no Apple ID or Developer certificate.

## Commands exercised

```bash
/usr/bin/swift run chrome-cdp-tests
/usr/bin/swift build -c release -Xswiftc -strict-concurrency=complete -Xswiftc -warnings-as-errors
./scripts/build.sh
./scripts/install.sh install
./scripts/verify.sh --app "/Applications/Chrome CDP.app" --installed
/usr/bin/open -a "Chrome CDP"
agent-browser --session chrome-cdp-validation --cdp 9333 get url
agent-browser --session chrome-cdp-verify-connect connect 9333 --json
agent-browser close --session chrome-cdp-validation
```
