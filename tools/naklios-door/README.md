# naklios-door

Programs on your computer (a shell, Emacs, native Lua, a bot) call NakliOS app commands, the same catalog apps and
Anvil scripts use. The door is optional: NakliOS works the same without it.

## Install

Download the binary for your machine from the
[naklios-door releases](https://github.com/NakliTechie/nakliOS/releases?q=naklios-door), check it against
`SHA256SUMS`, and put it on your PATH:

```bash
curl -fLO https://github.com/NakliTechie/nakliOS/releases/download/naklios-door-v0.1.0/naklios-door-darwin-arm64
chmod +x naklios-door-darwin-arm64 && mv naklios-door-darwin-arm64 ~/bin/naklios-door
```

Builds: macOS, Linux and Windows, each for arm64 and x86_64. Or build from source with Go:

```bash
cd tools/naklios-door && go build -o ~/bin/naklios-door .
```

## Use

1. In NakliOS, open Settings → AI and turn on "Let programs on this computer … use NakliOS commands". Until then
   NakliOS never connects to `127.0.0.1`.
2. Start the relay: `naklios-door serve` (it listens on `127.0.0.1:7461` only).
3. Pair a program once: `naklios-door pair cli`. It prints a code. Allow it in NakliOS only if the dialog shows the
   same code, then answer `y` in the terminal. The key goes to `~/.config/naklios/door-cli.key` (mode 0600).
4. Call:

```bash
naklios-door search notes list
naklios-door describe notes.list.read
naklios-door call notes.list.read '{"list":"shopping"}'
```

Every answer is JSON on stdout; the exit status is 1 when it has `"ok": false`.

Emacs: load `naklios.el`, pair it with `naklios-door pair emacs`, then `M-x naklios-call`.

### MCP (Claude Code, Codex, any MCP client)

`naklios-door mcp --client <name>` is an MCP server on stdin/stdout with three tools: `naklios_search`,
`naklios_describe` and `naklios_call`. Pair the name first (`naklios-door pair agent`), then register it:

```bash
claude mcp add naklios -- naklios-door mcp --client agent
codex mcp add naklios -- naklios-door mcp --client agent
```

It signs requests and checks answers exactly like the CLI. A refusal (`ECONSENT`, `EAUTH`) comes back as a tool
error the model can read.

## What a program can do

- Read app data at once after pairing.
- Change an app only after you allowed changes to that app on this visit. Otherwise the call returns `ECONSENT`, and
  `call --ask` lets NakliOS ask you instead.
- Never run a command that is hard to undo, even with `--ask`: those return `ECONSENT`; start them in NakliOS.
- Each pairing and call is one event in NakliOS History, under the caller `door:<name>`. Revoke a program in
  Settings → AI.

## How it is built

The relay holds no keys and no state. NakliOS (`sys/host/door.mjs`) dials out to `ws://127.0.0.1:7461/host`,
because a browser tab cannot accept connections, and decides every request. The key never crosses the relay.
Pairing is an ECDH P-256 exchange: both sides derive the key with HKDF and the same code from both public keys, so a
relay that swaps keys shows two different codes. The CLI also asks you to confirm the code in the terminal, because a
process posing as NakliOS could finish a pairing without showing any dialog. NakliOS keeps each key as a
non-extractable `CryptoKey` in IndexedDB. Each request carries a time (30-second window), a single-use nonce (kept
across tabs and reloads) and an HMAC-SHA256 over the operation, time, nonce and exact payload; each answer carries an
HMAC over the nonce and the reply, and the CLI and `naklios.el` accept only signed answers. The first NakliOS tab keeps
the relay, another tab waits, and the relay drops a tab that stops answering pings. The relay refuses any program request that carries an `Origin` header or a foreign
`Host` header, so a web page cannot use it, and accepts the NakliOS side only from `https://naklios.dev` (`--dev`
adds loopback origins).

Limits: a process that holds port 7461 (or connects as the NakliOS tab first) can see request contents and refuse
service, but it cannot read keys, forge answers, or reuse a request after 30 seconds. An unsigned refusal is marked
`"verified": false`; the call it refused may still run if that process passes it on within 30 seconds.
Tests: `go test ./...` here and `node sys/host/test/door.test.mjs`.
