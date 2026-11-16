package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// start runs a relay on a free loopback port and returns its base URL.
func start(t *testing.T, dev bool) (*relay, string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	r := newRelay(port, dev)
	r.timeout = 2 * time.Second
	srv := &http.Server{Handler: r.handler()}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return r, fmt.Sprintf("http://127.0.0.1:%d", port)
}

func send(t *testing.T, base, op, body string, headers map[string]string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, base+"/v1/"+op, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	json.Unmarshal(raw, &out)
	// Answers are {payload, mac?}; tests read the payload.
	if p, ok := out["payload"].(string); ok {
		inner := map[string]any{}
		json.Unmarshal([]byte(p), &inner)
		inner["_mac"] = out["mac"]
		return res.StatusCode, inner
	}
	return res.StatusCode, out
}

// fakeHost connects as the NakliOS tab and answers each request with answer(request).
func fakeHost(t *testing.T, base, origin string, answer func(map[string]any) any) (*websocket.Conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(base, "http", "ws", 1)+"/host", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			req := map[string]any{}
			json.Unmarshal(data, &req)
			reply, _ := json.Marshal(map[string]any{"id": req["id"], "reply": answer(req)})
			conn.Write(context.Background(), websocket.MessageText, reply)
		}
	}()
	t.Cleanup(func() { conn.CloseNow() })
	return conn, nil
}

func TestNoHostAnswersENOHOST(t *testing.T) {
	_, base := start(t, false)
	status, out := send(t, base, "search", `{"query":"notes"}`, nil)
	if status != http.StatusServiceUnavailable || out["code"] != "ENOHOST" {
		t.Fatalf("got %d %v", status, out)
	}
}

func TestClientRequestWithOriginIsRefused(t *testing.T) {
	_, base := start(t, false)
	status, _ := send(t, base, "search", `{}`, map[string]string{"Origin": "https://evil.example"})
	if status != http.StatusForbidden {
		t.Fatalf("a request a web page sent must be refused, got %d", status)
	}
}

func TestForeignHostHeaderIsRefused(t *testing.T) {
	_, base := start(t, false)
	req, _ := http.NewRequest(http.MethodPost, base+"/v1/search", strings.NewReader(`{}`))
	req.Host = "attacker.example:7461" // DNS rebinding sends the attacker's host name
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("got %d", res.StatusCode)
	}
}

func TestHostOriginRules(t *testing.T) {
	_, base := start(t, false)
	if _, err := fakeHost(t, base, "https://evil.example", func(map[string]any) any { return nil }); err == nil {
		t.Fatal("a foreign origin must not connect as the host")
	}
	if _, err := fakeHost(t, base, "http://127.0.0.1:8961", func(map[string]any) any { return nil }); err == nil {
		t.Fatal("a loopback origin connects only with --dev")
	}
	if _, err := fakeHost(t, base, "https://naklios.dev.evil.example", func(map[string]any) any { return nil }); err == nil {
		t.Fatal("a look-alike origin must not connect")
	}
	_, devBase := start(t, true)
	if _, err := fakeHost(t, devBase, "http://127.0.0.1:8961", func(map[string]any) any { return nil }); err != nil {
		t.Fatalf("--dev accepts a loopback origin: %v", err)
	}
	if _, err := fakeHost(t, devBase, "http://127.0.0.1:8961.evil", func(map[string]any) any { return nil }); err == nil {
		t.Fatal("a loopback look-alike must not connect")
	}
}

func TestForwardsOpTokenAndBodyAndReturnsTheReply(t *testing.T) {
	_, base := start(t, false)
	got := make(chan map[string]any, 1)
	if _, err := fakeHost(t, base, "https://naklios.dev", func(req map[string]any) any {
		got <- req
		return map[string]any{"payload": `{"ok":true}`, "mac": "abc"}
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	status, out := send(t, base, "search", `{"client":"cli","payload":"{}"}`, nil)
	if status != 200 || out["ok"] != true || out["_mac"] != "abc" {
		t.Fatalf("the tab's signed answer passes through unchanged: got %d %v", status, out)
	}
	req := <-got
	body, _ := req["body"].(map[string]any)
	if req["op"] != "search" || body["client"] != "cli" || req["token"] != nil {
		t.Fatalf("host received %v", req)
	}
}

func TestSilentHostTimesOut(t *testing.T) {
	r, base := start(t, false)
	r.timeout = 200 * time.Millisecond
	if _, err := fakeHost(t, base, "https://naklios.dev", func(map[string]any) any { select {} }); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	_, out := send(t, base, "call", `{"name":"x.y"}`, nil)
	if out["code"] != "ETIMEOUT" {
		t.Fatalf("got %v", out)
	}
}

func TestRejectsBadRequests(t *testing.T) {
	_, base := start(t, false)
	if status, _ := send(t, base, "delete", `{}`, nil); status != http.StatusNotFound {
		t.Fatalf("unknown op: %d", status)
	}
	if status, _ := send(t, base, "call", `not json`, nil); status != http.StatusBadRequest {
		t.Fatalf("bad json: %d", status)
	}
	res, _ := http.Get(base + "/v1/search")
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", res.StatusCode)
	}
}

func TestFirstHostKeepsTheRelay(t *testing.T) {
	_, base := start(t, false)
	answered := make(chan string, 4)
	if _, err := fakeHost(t, base, "https://naklios.dev", func(map[string]any) any { answered <- "first"; return map[string]any{"payload": `{"ok":true}`} }); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	second, err := fakeHost(t, base, "https://naklios.dev", func(map[string]any) any { answered <- "second"; return map[string]any{"payload": `{"ok":true}`} })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, readErr := second.Read(ctx)
	if websocket.CloseStatus(readErr) != closeBusy {
		t.Fatalf("a second tab is refused with 4001, got %v", readErr)
	}
	send(t, base, "search", `{}`, nil)
	if who := <-answered; who != "first" {
		t.Fatalf("the first tab still answers, got %s", who)
	}
}

// silentHost connects as the tab, never answers, and passes every message it receives to the channel.
func silentHost(t *testing.T, base string) chan map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(base, "http", "ws", 1)+"/host", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://naklios.dev"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	got := make(chan map[string]any, 256)
	go func() {
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			m := map[string]any{}
			json.Unmarshal(data, &m)
			got <- m
		}
	}()
	time.Sleep(50 * time.Millisecond)
	return got
}

func TestAbandonReachesTheHostWhenTheProgramLeaves(t *testing.T) {
	_, base := start(t, false)
	got := silentHost(t, base)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/call", strings.NewReader(`{}`))
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Fatal("the request should time out on the client side")
	}
	first := <-got
	select {
	case second := <-got:
		if second["abandon"] != first["id"] {
			t.Fatalf("expected abandon of %v, got %v", first["id"], second)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the tab never heard that the program left")
	}
}

func TestWaitingRequestsAreCapped(t *testing.T) {
	r, base := start(t, false)
	r.timeout = 3 * time.Second
	silentHost(t, base)
	done := make(chan int, maxWaiting+1)
	for i := 0; i < maxWaiting; i++ {
		go func() {
			res, err := http.Post(base+"/v1/call", "application/json", strings.NewReader(`{}`))
			if err == nil {
				res.Body.Close()
			}
			done <- 0
		}()
	}
	time.Sleep(300 * time.Millisecond)
	status, out := send(t, base, "call", `{}`, nil)
	if status != http.StatusServiceUnavailable || out["code"] != "EBUSY" {
		t.Fatalf("request %d over the cap gets EBUSY, got %d %v", maxWaiting+1, status, out)
	}
}

// The same vector is checked in sys/host/test/door.test.mjs, so the tab and the CLI show the same code.
func TestPairingCodeVector(t *testing.T) {
	c, h := make([]byte, 65), make([]byte, 65)
	c[0], h[0] = 4, 4
	for i := 1; i < 65; i++ {
		c[i], h[i] = 1, 2
	}
	if got := pairingCode(c, h); got != "U7ES-8S2H" {
		t.Fatalf("pairing code %s", got)
	}
}

// A pairing answered by something that does not hold the agreed key is refused, and nothing is saved.
func TestPairingRefusesAnUnsignedSuccess(t *testing.T) {
	_, base := start(t, false)
	// A valid key of the impostor's own: it cannot sign step 2 with the key the program derives from its exchange.
	imp, _ := ecdh.P256().GenerateKey(rand.Reader)
	impPub := base64.RawURLEncoding.EncodeToString(imp.PublicKey().Bytes())
	if _, err := fakeHost(t, base, "https://naklios.dev", func(req map[string]any) any {
		if req["op"] == "pair-start" {
			return map[string]any{"payload": `{"ok":true,"pairing":"p1","pub":"` + impPub + `"}`}
		}
		return map[string]any{"payload": `{"ok":true,"client":"x"}`, "mac": "00"}
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	var port int
	fmt.Sscanf(base, "http://127.0.0.1:%d", &port)
	out := pairProgram(port, "x", strings.NewReader("y\n"))
	if out["ok"] == true || out["code"] != "EAUTH" || !strings.Contains(fmt.Sprint(out["message"]), "not signed with the agreed key") {
		t.Fatalf("an answer not signed with the agreed key must be refused, got %v", out)
	}
}

// A tab that answers pings but never answers requests (a hung page) is dropped after three timeouts in a row.
func TestHungTabIsDroppedAfterThreeTimeouts(t *testing.T) {
	r, base := start(t, false)
	r.timeout = 100 * time.Millisecond
	silentHost(t, base)
	for i := 0; i < 3; i++ {
		if _, out := send(t, base, "call", `{}`, nil); out["code"] != "ETIMEOUT" {
			t.Fatalf("request %d: %v", i+1, out)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if _, out := send(t, base, "call", `{}`, nil); out["code"] != "ENOHOST" {
		t.Fatalf("after three timeouts the tab is dropped, got %v", out)
	}
}
