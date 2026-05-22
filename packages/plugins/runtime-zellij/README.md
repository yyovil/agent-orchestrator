# @aoagents/ao-plugin-runtime-zellij

Runtime plugin for executing AO agent sessions in [Zellij](https://zellij.dev/).

This plugin mirrors the tmux runtime shape: it creates one named background
Zellij session per AO session, launches the agent command in that session,
keeps an interactive shell alive after the agent exits, supports `ao send`,
output capture, liveness checks, and exposes `zellij attach <session>` attach
info.

## Opt in

```yaml
defaults:
  runtime: zellij
```

or per project:

```yaml
projects:
  my-project:
    runtime: zellij
```

Zellij must be installed and available on `PATH` for the `ao start`/`ao spawn`
process.
