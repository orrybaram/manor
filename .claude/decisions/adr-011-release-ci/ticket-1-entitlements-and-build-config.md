---
title: Add macOS entitlements and update build config
status: done
priority: high
assignee: haiku
blocked_by: []
---

# Add macOS entitlements and update build config

## Tasks

1. Create `build/entitlements.mac.plist` with the entitlements needed for a notarized Electron app with node-pty:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
</dict>
</plist>
```

2. Update `package.json` build config — add to the `"mac"` section:

```json
"hardenedRuntime": true,
"gatekeeperAssess": false,
"entitlements": "build/entitlements.mac.plist",
"entitlementsInherit": "build/entitlements.mac.plist"
```

## Files to touch
- `build/entitlements.mac.plist` — new file
- `package.json` — update mac build config
