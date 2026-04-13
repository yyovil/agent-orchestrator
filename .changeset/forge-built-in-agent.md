---
"@aoagents/ao-core": patch
"@aoagents/ao-cli": patch
"@aoagents/ao-web": patch
"@aoagents/ao-plugin-agent-forge": patch
---

Add the built-in `forge` agent plugin and wire it through core session metadata, CLI agent detection, and web service registration so AO can spawn, restore, and introspect Forge-backed sessions.
