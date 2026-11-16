// The relay half of the NakliOS outside door. It listens on 127.0.0.1 only, holds no tokens and no state beyond open
// connections, and forwards each program's request to the one NakliOS tab connected on /host. The tab decides every
// request (sys/host/door.mjs); the relay only refuses requests a web page could have sent.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const maxBody = 1 << 20

// At most this many program requests wait for the tab at once; more get EBUSY, so a local process cannot exhaust the
// relay's memory with slow requests.
const maxWaiting = 64

// closeBusy tells a second NakliOS tab (or a process posing as one) that the relay already has its tab.
const closeBusy websocket.StatusCode = 4001

// Origins allowed to connect as the NakliOS tab. Loopback dev origins only with --dev, because any local page could
// otherwise take the host side and read the programs' tokens.
func hostOriginAllowed(origin string, dev bool) bool {
	if origin == "https://naklios.dev" {
		return true
	}
	if !dev {
		return false
	}
	for _, prefix := range []string{"http://127.0.0.1:", "http://localhost:"} {
		if rest, ok := strings.CutPrefix(origin, prefix); ok && rest != "" && strings.Trim(rest, "0123456789") == "" {
			return true
		}
	}
	return false
}

type relay struct {
	port    int
	dev     bool
	timeout time.Duration

	mu      sync.Mutex
	host    *websocket.Conn
	hostCtx context.Context
	waiting map[string]chan json.RawMessage
	slots   chan struct{} // one per program request in flight, taken before the body is read

	// Chrome answers WebSocket pings in its network process, so a tab whose page is hung still answers them; three
	// unanswered requests in a row mark the tab dead instead.
	missed int
}

func newRelay(port int, dev bool) *relay {
	return &relay{port: port, dev: dev, timeout: 300 * time.Second, waiting: map[string]chan json.RawMessage{}, slots: make(chan struct{}, maxWaiting)}
}

func (r *relay) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/host", r.serveHost)
	mux.HandleFunc("/v1/", r.serveClient)
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// DNS rebinding: a page on an attacker's domain that resolves to 127.0.0.1 sends its own Host header.
		if req.Host != fmt.Sprintf("127.0.0.1:%d", r.port) && req.Host != fmt.Sprintf("localhost:%d", r.port) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, req)
	})
}

func (r *relay) serveHost(w http.ResponseWriter, req *http.Request) {
	if !hostOriginAllowed(req.Header.Get("Origin"), r.dev) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	// The Origin was checked above against an exact list; the library's own same-host check would refuse naklios.dev.
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxBody)
	ctx := req.Context()
	// The first tab keeps the relay until it disconnects: a newcomer cannot take over a working session and collect
	// requests, and two open tabs do not take turns knocking each other off.
	r.mu.Lock()
	if r.host != nil {
		r.mu.Unlock()
		conn.Close(closeBusy, "another NakliOS tab holds the door")
		return
	}
	r.host, r.hostCtx, r.missed = conn, ctx, 0
	r.mu.Unlock()
	// A socket that stops answering pings (a crashed tab, a process that only holds the connection) is dropped; a
	// hung page is caught by the missed-request count in forward.
	go func() {
		tick := time.NewTicker(15 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pctx)
				cancel()
				if err != nil {
					conn.CloseNow()
					return
				}
			}
		}
	}()
	defer func() {
		r.mu.Lock()
		if r.host == conn {
			r.host = nil
		}
		r.mu.Unlock()
		conn.CloseNow()
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg struct {
			ID    string          `json:"id"`
			Reply json.RawMessage `json:"reply"`
		}
		if json.Unmarshal(data, &msg) != nil || msg.ID == "" {
			continue
		}
		r.mu.Lock()
		ch := r.waiting[msg.ID]
		delete(r.waiting, msg.ID)
		r.mu.Unlock()
		if ch != nil {
			ch <- msg.Reply
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (r *relay) serveClient(w http.ResponseWriter, req *http.Request) {
	// Browsers always send Origin on cross-site requests; programs (curl, Emacs url.el, this CLI) send none.
	if req.Header.Get("Origin") != "" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "code": "EINVAL", "message": "POST only"})
		return
	}
	// The cap counts requests from the moment they arrive, so slow bodies cannot pile up outside it.
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"payload": `{"ok":false,"code":"EBUSY","message":"too many requests are waiting for NakliOS"}`})
		return
	}
	op := strings.TrimPrefix(req.URL.Path, "/v1/")
	switch op {
	case "pair-start", "pair", "search", "describe", "call":
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "code": "EINVAL", "message": "unknown operation"})
		return
	}
	// A body that arrives slower than this is cut off, so a slow client cannot hold a goroutine open.
	http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Second))
	raw, err := io.ReadAll(io.LimitReader(req.Body, maxBody+1))
	if err != nil || len(raw) > maxBody {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"ok": false, "code": "EINVAL", "message": "body too large"})
		return
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if !json.Valid(raw) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "code": "EINVAL", "message": "body must be JSON"})
		return
	}
	reply, err := r.forward(req.Context(), op, raw)
	if errors.Is(err, errBusy) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"payload": `{"ok":false,"code":"EBUSY","message":"too many requests are waiting for NakliOS"}`})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"payload": fmt.Sprintf(`{"ok":false,"code":"ENOHOST","message":%q}`, err.Error())})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(reply)
}

var errNoHost = errors.New("NakliOS is not open, or its outside door is off (Settings → AI)")
var errBusy = errors.New("too many waiting requests")

// forward sends one request to the tab and waits for its answer. The tab's answer is passed through as it is; it is
// signed by the tab, so the relay could not alter it unnoticed anyway.
func (r *relay) forward(ctx context.Context, op string, body json.RawMessage) (json.RawMessage, error) {
	idBytes := make([]byte, 12)
	rand.Read(idBytes)
	id := hex.EncodeToString(idBytes)
	ch := make(chan json.RawMessage, 1)
	r.mu.Lock()
	host, hostCtx := r.host, r.hostCtx
	if host == nil {
		r.mu.Unlock()
		return nil, errNoHost
	}
	if len(r.waiting) >= maxWaiting {
		r.mu.Unlock()
		return nil, errBusy
	}
	r.waiting[id] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.waiting, id); r.mu.Unlock() }()
	msg, _ := json.Marshal(map[string]any{"id": id, "op": op, "body": body})
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err := host.Write(wctx, websocket.MessageText, msg)
	cancel()
	if err != nil {
		return nil, errNoHost
	}
	// The program stopped waiting (it disconnected, or the relay's limit passed): tell the tab, so a call that has
	// not started yet starts nothing. Best effort, on its own short deadline.
	abandon := func() {
		note, _ := json.Marshal(map[string]any{"abandon": id})
		actx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		host.Write(actx, websocket.MessageText, note)
		cancel()
	}
	select {
	case reply := <-ch:
		r.mu.Lock()
		if r.host == host {
			r.missed = 0
		}
		r.mu.Unlock()
		return reply, nil
	case <-hostCtx.Done():
		return nil, errNoHost
	case <-ctx.Done():
		abandon()
		return nil, ctx.Err()
	case <-time.After(r.timeout):
		abandon()
		r.mu.Lock()
		if r.host == host {
			if r.missed++; r.missed >= 3 {
				host.CloseNow()
			}
		}
		r.mu.Unlock()
		return json.RawMessage(`{"payload":"{\"ok\":false,\"code\":\"ETIMEOUT\",\"message\":\"NakliOS did not answer in time\"}"}`), nil
	}
}

func (r *relay) listen() (net.Listener, error) {
	return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", r.port))
}
