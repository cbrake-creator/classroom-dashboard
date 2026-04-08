# Canon XC Protocol — API Reference for Dashboard Integration

## Base URL Pattern
```
http://<camera-ip>/-wvhttp-01-/<command>[?<parameters>]
```

## Authentication
HTTP Basic Auth if User Access Control enabled: `Authorization: Basic <base64(username:password)>`

## Key Endpoints
- **info.cgi** — Health/status polling (pan, tilt, zoom, power, tracking, errors)
- **control.cgi** — PTZ, presets, auto-tracking toggle
- **video.cgi?w=1** — MJPEG multipart live stream
- **image.cgi?w=1** — Single JPEG snapshot
- **standby.cgi?cmd=on|off** — Power standby/wake
- **open.cgi / claim.cgi / yield.cgi / close.cgi** — Session management

## Livescope Status Codes
| Code | Meaning |
|------|---------|
| 0 | Success |
| 301 | No camera control right (in use) |
| 302 | Camera not available |
| 303 | Camera not controllable |
| 403 | Invalid parameter |
| 404 | Operation timeout |
| 501 | Unknown session ID |
| 503 | Too many clients |
| 507 | Insufficient privilege |
| 509 | Standby |
| 510 | Switching to standby |
| 511 | Switching to active |

## PTZ Control Notes
- Set `c.1.pt.ramp.mode=acceldeccel` for programmatic control
- Revert to `c.1.pt.ramp.mode=ramp` for manual operator control
- Use `w` param for video streams, NOT deprecated `v` param

## Supported Models
CR-N700, CR-N500, CR-N400, CR-N350, CR-N300, CR-N100, CR-X300
