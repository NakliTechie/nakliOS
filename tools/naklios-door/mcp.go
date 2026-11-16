// `naklios-door mcp`: a Model Context Protocol server on stdin/stdout, so an AI client (Claude Code, Codex, any MCP
// client) can use NakliOS app commands. It is one more client of the outside door: it signs each request with the
// paired program's key exactly as the CLI does, and accepts only answers signed by NakliOS.
//
// It offers three tools rather than one per command, because the catalog is large and changes as apps open: the
// model searches, reads one command's input, then calls it (the Cloudflare code-mode pattern the rail uses).
// Transport: newline-delimited JSON-RPC 2.0 (MCP stdio). Nothing but protocol messages is written to stdout.
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

const maxMCPLine = 4 << 20

// MCP protocol revisions this server speaks; the first is offered when the client asks for one it does not know.
var mcpVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func mcpTools() []map[string]any {
	str := map[string]any{"type": "string"}
	return []map[string]any{
		{
			"name":        "naklios_search",
			"title":       "Find NakliOS app commands",
			"description": "Find commands that NakliOS apps offer (Notes, Calendar, Reckon, KanZen, Draft and others) by words, e.g. \"notes list\" or \"calendar events\". Returns up to 20 commands with name, description, app, scope and whether it is destructive. Use naklios_describe for a command's input.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"query": str}, "additionalProperties": false},
			"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
		},
		{
			"name":        "naklios_describe",
			"title":       "Describe one NakliOS command",
			"description": "Return one command's input schema, by the exact name naklios_search gave (e.g. \"notes.list.read\").",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"name": str}, "required": []string{"name"}, "additionalProperties": false},
			"annotations": map[string]any{"readOnlyHint": true, "openWorldHint": false},
		},
		{
			"name":  "naklios_call",
			"title": "Run a NakliOS command",
			"description": "Run one command with its input. Reads run at once. A change runs only if the person allowed changes to that app on this visit; otherwise the answer is ECONSENT (set ask:true to let NakliOS ask the person, who may be away). " +
				"Commands that are hard to undo are always refused: the person starts those in NakliOS.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
				"name":  str,
				"input": map[string]any{"type": "object", "description": "The command's input, as naklios_describe gives it."},
				"ask":   map[string]any{"type": "boolean", "description": "Let NakliOS show the person a dialog instead of answering ECONSENT. Default false."},
			}, "required": []string{"name"}, "additionalProperties": false},
			"annotations": map[string]any{"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
		},
	}
}

// mcpServer answers one stdio session. Each request runs on its own goroutine (a call can wait minutes for the
// person); writes are serialized.
type mcpServer struct {
	port   int
	client string
	out    io.Writer
	mu     sync.Mutex
	wg     sync.WaitGroup
}

func serveMCP(in io.Reader, out io.Writer, port int, client string) {
	s := &mcpServer{port: port, client: client, out: out}
	reader := bufio.NewReaderSize(in, 64*1024)
	for {
		line, err := readLine(reader)
		if len(line) > 0 {
			s.dispatch(line)
		}
		if err != nil {
			break
		}
	}
	s.wg.Wait()
}

func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		buf = append(buf, chunk...)
		if len(buf) > maxMCPLine {
			// Drain the rest of this line and report it as one bad message.
			for isPrefix && err == nil {
				_, isPrefix, err = r.ReadLine()
			}
			return []byte(`{"jsonrpc":"2.0","method":"__too_large__"}`), err
		}
		if err != nil || !isPrefix {
			return buf, err
		}
	}
}

func (s *mcpServer) write(v any) {
	data, _ := json.Marshal(v)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.out.Write(append(data, '\n'))
}

func (s *mcpServer) reply(id json.RawMessage, result any) {
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (s *mcpServer) fail(id json.RawMessage, code int, message string) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	s.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
}

func (s *mcpServer) dispatch(line []byte) {
	var msg rpcMessage
	if err := json.Unmarshal(line, &msg); err != nil || msg.JSONRPC != "2.0" {
		s.fail(nil, -32700, "parse error: expected one JSON-RPC 2.0 message per line")
		return
	}
	notification := len(msg.ID) == 0
	switch msg.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(msg.Params, &p)
		version := mcpVersions[0]
		for _, v := range mcpVersions {
			if v == p.ProtocolVersion {
				version = v
			}
		}
		s.reply(msg.ID, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "naklios-door", "title": "NakliOS", "version": version},
			"instructions": "NakliOS app commands. Search with naklios_search, read a command's input with naklios_describe, " +
				"then run it with naklios_call. Needs `naklios-door serve` running, NakliOS open with the outside door on, " +
				"and this program paired (`naklios-door pair " + s.client + "`).",
		})
	case "ping":
		if !notification {
			s.reply(msg.ID, map[string]any{})
		}
	case "tools/list":
		s.reply(msg.ID, map[string]any{"tools": mcpTools()})
	case "tools/call":
		if notification {
			return
		}
		s.wg.Add(1)
		go func() { defer s.wg.Done(); s.reply(msg.ID, s.callTool(msg.Params)) }()
	default:
		if notification {
			return // notifications/initialized, notifications/cancelled and others need no answer
		}
		s.fail(msg.ID, -32601, "method not found: "+msg.Method)
	}
}

// callTool returns an MCP CallToolResult. Refusals from NakliOS are tool errors (isError), not protocol errors, so
// the model sees the reason and can act on it.
func (s *mcpServer) callTool(raw json.RawMessage) map[string]any {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return toolResult(map[string]any{"ok": false, "code": "EINVAL", "message": "bad tools/call params"})
	}
	if p.Arguments == nil {
		p.Arguments = map[string]any{}
	}
	ops := map[string]string{"naklios_search": "search", "naklios_describe": "describe", "naklios_call": "call"}
	op, ok := ops[p.Name]
	if !ok {
		return toolResult(map[string]any{"ok": false, "code": "EINVAL", "message": "unknown tool " + p.Name})
	}
	body := map[string]any{}
	switch op {
	case "search":
		q, _ := p.Arguments["query"].(string)
		body["query"] = q
	case "describe":
		body["name"] = p.Arguments["name"]
	case "call":
		body["name"] = p.Arguments["name"]
		input, _ := p.Arguments["input"].(map[string]any)
		if input == nil {
			input = map[string]any{}
		}
		body["input"] = input
		ask, _ := p.Arguments["ask"].(bool)
		body["ask"] = ask
	}
	key, err := loadKey(s.client)
	if err != nil {
		return toolResult(map[string]any{"ok": false, "code": "ENOKEY", "message": err.Error()})
	}
	return toolResult(signed(s.port, op, s.client, key, body))
}

func toolResult(out map[string]any) map[string]any {
	text, _ := json.MarshalIndent(out, "", " ")
	ok, _ := out["ok"].(bool)
	return map[string]any{"content": []map[string]any{{"type": "text", "text": string(text)}}, "structuredContent": out, "isError": !ok}
}
