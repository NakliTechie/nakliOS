package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// signingHost is a fake NakliOS tab that checks each request's signature with key and signs its answers, as
// sys/host/door.mjs does. answer gets the op and the inner payload.
func signingHost(t *testing.T, base string, key []byte, answer func(op string, inner map[string]any) map[string]any) {
	t.Helper()
	sign := func(text string) string {
		m := hmac.New(sha256.New, key)
		m.Write([]byte(text))
		return hex.EncodeToString(m.Sum(nil))
	}
	if _, err := fakeHost(t, base, "https://naklios.dev", func(req map[string]any) any {
		op, _ := req["op"].(string)
		b, _ := req["body"].(map[string]any)
		payload, _ := b["payload"].(string)
		nonce, _ := b["nonce"].(string)
		ts, _ := b["ts"].(float64)
		if b["mac"] != sign(fmt.Sprintf("%s\n%d\n%s\n%s", op, int64(ts), nonce, payload)) {
			return map[string]any{"payload": `{"ok":false,"code":"EAUTH","message":"bad signature"}`}
		}
		inner := map[string]any{}
		json.Unmarshal([]byte(payload), &inner)
		out, _ := json.Marshal(answer(op, inner))
		return map[string]any{"payload": string(out), "mac": sign("reply\n" + nonce + "\n" + string(out))}
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
}

func pairedHome(t *testing.T, client string) []byte {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 7)
	}
	dir := filepath.Join(home, ".config", "naklios")
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "door-"+client+".key"), []byte(base64.RawURLEncoding.EncodeToString(key)+"\n"), 0o600)
	return key
}

// session runs serveMCP over pipes and returns a function that sends one line and reads one answer.
func session(t *testing.T, port int, client string) (func(line string) map[string]any, func(line string)) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	go func() { serveMCP(inR, outW, port, client); outW.Close() }()
	t.Cleanup(func() { inW.Close() })
	reader := bufio.NewReader(outR)
	send := func(line string) { io.WriteString(inW, line+"\n") }
	ask := func(line string) map[string]any {
		send(line)
		done := make(chan map[string]any, 1)
		go func() {
			text, _ := reader.ReadString('\n')
			out := map[string]any{}
			json.Unmarshal([]byte(text), &out)
			done <- out
		}()
		select {
		case out := <-done:
			return out
		case <-time.After(5 * time.Second):
			t.Fatalf("no answer to %s", line)
			return nil
		}
	}
	return ask, send
}

func portOf(base string) int { var p int; fmt.Sscanf(base, "http://127.0.0.1:%d", &p); return p }

func TestMCPHandshakeAndToolList(t *testing.T) {
	_, base := start(t, false)
	ask, send := session(t, portOf(base), "agent")
	init := ask(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`)
	result, _ := init["result"].(map[string]any)
	if result["protocolVersion"] != "2025-06-18" || result["capabilities"].(map[string]any)["tools"] == nil {
		t.Fatalf("initialize: %v", init)
	}
	old := ask(`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}`)
	if old["result"].(map[string]any)["protocolVersion"] != "2024-11-05" {
		t.Fatalf("an older supported revision is kept: %v", old)
	}
	unknown := ask(`{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}`)
	if unknown["result"].(map[string]any)["protocolVersion"] != mcpVersions[0] {
		t.Fatalf("an unknown revision gets the newest: %v", unknown)
	}
	send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`) // no answer expected
	list := ask(`{"jsonrpc":"2.0","id":4,"method":"tools/list"}`)
	var names []string
	for _, tool := range list["result"].(map[string]any)["tools"].([]any) {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "naklios_search,naklios_describe,naklios_call" {
		t.Fatalf("tools: %v (a notification must not produce an answer line)", names)
	}
	if ping := ask(`{"jsonrpc":"2.0","id":5,"method":"ping"}`); ping["result"] == nil {
		t.Fatalf("ping: %v", ping)
	}
	if bad := ask(`{"jsonrpc":"2.0","id":6,"method":"resources/list"}`); bad["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatalf("unknown method: %v", bad)
	}
	if parse := ask(`not json`); parse["error"].(map[string]any)["code"].(float64) != -32700 {
		t.Fatalf("parse error: %v", parse)
	}
}

func TestMCPToolsCallNakliOSSigned(t *testing.T) {
	_, base := start(t, false)
	key := pairedHome(t, "agent")
	seen := make(chan map[string]any, 4)
	signingHost(t, base, key, func(op string, inner map[string]any) map[string]any {
		seen <- map[string]any{"op": op, "inner": inner}
		if op == "call" {
			return map[string]any{"ok": false, "code": "ECONSENT", "message": "not allowed this visit"}
		}
		return map[string]any{"ok": true, "results": []any{map[string]any{"name": "notes.list.read"}}}
	})
	ask, _ := session(t, portOf(base), "agent")
	found := ask(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"naklios_search","arguments":{"query":"notes"}}}`)
	r := found["result"].(map[string]any)
	if r["isError"] != false || !strings.Contains(r["content"].([]any)[0].(map[string]any)["text"].(string), "notes.list.read") {
		t.Fatalf("search: %v", found)
	}
	if got := <-seen; got["op"] != "search" || got["inner"].(map[string]any)["query"] != "notes" {
		t.Fatalf("host saw %v", got)
	}
	called := ask(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"naklios_call","arguments":{"name":"notes.list.add","input":{"list":"x"}}}}`)
	cr := called["result"].(map[string]any)
	if cr["isError"] != true || cr["structuredContent"].(map[string]any)["code"] != "ECONSENT" {
		t.Fatalf("a refusal is a tool error the model can read: %v", called)
	}
	if got := <-seen; got["inner"].(map[string]any)["ask"] != false {
		t.Fatalf("calls default to ask:false: %v", got)
	}
}

func TestMCPRefusesForgedAnswersAndMissingKeys(t *testing.T) {
	_, base := start(t, false)
	pairedHome(t, "agent")
	other := make([]byte, 32) // a host that does not hold the program's key
	signingHost(t, base, other, func(string, map[string]any) map[string]any { return map[string]any{"ok": true} })
	ask, _ := session(t, portOf(base), "agent")
	out := ask(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"naklios_search","arguments":{}}}`)
	if out["result"].(map[string]any)["structuredContent"].(map[string]any)["code"] != "EAUTH" {
		t.Fatalf("an answer not signed with the program's key is refused: %v", out)
	}
	ask2, _ := session(t, portOf(base), "nobody")
	missing := ask2(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"naklios_search","arguments":{}}}`)
	if missing["result"].(map[string]any)["structuredContent"].(map[string]any)["code"] != "ENOKEY" {
		t.Fatalf("no key: an answer, not an exit: %v", missing)
	}
	if unknown := ask2(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rm_rf","arguments":{}}}`); unknown["result"].(map[string]any)["isError"] != true {
		t.Fatalf("unknown tool: %v", unknown)
	}
}
