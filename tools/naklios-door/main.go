// naklios-door: the loopback relay and command-line client for the NakliOS outside door.
//
//	naklios-door serve [--port 7461] [--dev]      run the relay (NakliOS connects to it when Settings → AI turns the door on)
//	naklios-door pair <client>                    ask the person to allow this program; saves its token
//	naklios-door search [--client c] <words>      find app commands
//	naklios-door describe [--client c] <name>     one command's input
//	naklios-door call [--client c] [--ask] <name> [json-input]
//	naklios-door version
//
// Every answer is printed as JSON. The exit status is 1 when the answer has "ok": false.
package main

import (
	"bufio"
	"bytes"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const defaultPort = 7461

// version is set at release build time: -ldflags "-X main.version=0.1.0".
var version = "dev"

var clientName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  naklios-door serve [--port 7461] [--dev]
  naklios-door pair <client>
  naklios-door search [--client cli] <words…>
  naklios-door describe [--client cli] <command>
  naklios-door call [--client cli] [--ask] <command> [json-input]
  naklios-door version`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	port := fs.Int("port", defaultPort, "relay port on 127.0.0.1")
	client := fs.String("client", "cli", "the paired program's name")
	ask := fs.Bool("ask", false, "let NakliOS ask the person instead of refusing with ECONSENT")
	dev := fs.Bool("dev", false, "also accept a NakliOS tab served from a loopback dev origin")
	fs.Parse(args)
	rest := fs.Args()
	switch cmd {
	case "version", "--version":
		fmt.Println("naklios-door " + version)
	case "serve":
		serve(*port, *dev)
	case "pair":
		if len(rest) != 1 || !clientName.MatchString(rest[0]) {
			fatal("pair takes one client name: 1-32 lowercase letters, digits or hyphens, starting with a letter")
		}
		emit(pairProgram(*port, rest[0], os.Stdin))
	case "search":
		emit(signed(*port, "search", *client, map[string]any{"query": strings.Join(rest, " ")}))
	case "describe":
		if len(rest) != 1 {
			usage()
		}
		emit(signed(*port, "describe", *client, map[string]any{"name": rest[0]}))
	case "call":
		if len(rest) < 1 || len(rest) > 2 {
			usage()
		}
		input := map[string]any{}
		if len(rest) == 2 {
			if err := json.Unmarshal([]byte(rest[1]), &input); err != nil {
				fatal("input must be a JSON object: " + err.Error())
			}
		}
		emit(signed(*port, "call", *client, map[string]any{"name": rest[0], "input": input, "ask": *ask}))
	default:
		usage()
	}
}

func serve(port int, dev bool) {
	r := newRelay(port, dev)
	ln, err := r.listen()
	if err != nil {
		fatal(err.Error())
	}
	fmt.Fprintf(os.Stderr, "naklios-door: listening on 127.0.0.1:%d\n", port)
	srv := &http.Server{Handler: r.handler(), ReadHeaderTimeout: 10 * time.Second}
	fatal(srv.Serve(ln).Error())
}

func keyPath(client string) (string, error) {
	// One place on every OS, so the Emacs package and shell scripts find it: ~/.config/naklios.
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "naklios", "door-"+client+".key"), nil
}

func saveKey(client, key string) (string, error) {
	if raw, err := base64.RawURLEncoding.DecodeString(key); err != nil || len(raw) != 32 {
		return "", fmt.Errorf("the answer carried no valid key")
	}
	path, err := keyPath(client)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	// MkdirAll and WriteFile set modes only on creation; set them again for a folder or file that already existed.
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		return "", err
	}
	return path, os.Chmod(path, 0o600)
}

func loadKey(client string) []byte {
	if !clientName.MatchString(client) {
		fatal("bad --client name")
	}
	path, err := keyPath(client)
	if err != nil {
		fatal(err.Error())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		fatal(fmt.Sprintf("no key for %q; run: naklios-door pair %s", client, client))
	}
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(key) != 32 {
		fatal("the key file " + path + " is damaged; revoke the program in Settings → AI and pair again")
	}
	return key
}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O or 1/I, so the person can compare it at a glance

// pairingCode must match sys/host/door.mjs pairingCode: SHA-256 over a label and both public keys, 8 characters.
func pairingCode(pubC, pubH []byte) string {
	h := sha256.Sum256(append(append([]byte("naklios-door v1 code"), pubC...), pubH...))
	out := make([]byte, 0, 9)
	for i := 0; i < 8; i++ {
		if i == 4 {
			out = append(out, '-')
		}
		out = append(out, codeAlphabet[int(h[i])%len(codeAlphabet)])
	}
	return string(out)
}

// pairProgram runs the two-step pairing: an ECDH P-256 exchange (step 1), then the person's Allow in NakliOS
// (step 2). Both sides derive the key; it never crosses the relay. The person confirms in the terminal that NakliOS
// showed the same code, because a process posing as NakliOS could answer step 2 without showing any dialog.
func pairProgram(port int, client string, terminal io.Reader) map[string]any {
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return map[string]any{"ok": false, "code": "EFAIL", "message": err.Error()}
	}
	pubC := priv.PublicKey().Bytes()
	payload, _, failure := exchange(port, "pair-start", map[string]any{"client": client, "pub": base64.RawURLEncoding.EncodeToString(pubC)})
	if failure != nil {
		return failure
	}
	start := decode(payload)
	if ok, _ := start["ok"].(bool); !ok {
		return start
	}
	id, _ := start["pairing"].(string)
	pubText, _ := start["pub"].(string)
	pubH, err := base64.RawURLEncoding.DecodeString(pubText)
	if err != nil || id == "" {
		return map[string]any{"ok": false, "code": "EFAIL", "message": "the answer carried no pairing"}
	}
	theirs, err := ecdh.P256().NewPublicKey(pubH)
	if err != nil {
		return map[string]any{"ok": false, "code": "EAUTH", "message": "the answer carried an invalid public key"}
	}
	shared, err := priv.ECDH(theirs)
	if err != nil {
		return map[string]any{"ok": false, "code": "EAUTH", "message": err.Error()}
	}
	key, err := hkdf.Key(sha256.New, shared, append(append([]byte{}, pubC...), pubH...), "naklios-door v1 key", 32)
	if err != nil {
		return map[string]any{"ok": false, "code": "EFAIL", "message": err.Error()}
	}
	code := pairingCode(pubC, pubH)
	fmt.Fprintf(os.Stderr, "naklios-door: NakliOS will ask you to allow %q. Allow it only if it shows the code %s\n", client, code)
	answer, sig, failure := exchange(port, "pair", map[string]any{"pairing": id})
	if failure != nil {
		return failure
	}
	out := decode(answer)
	if ok, _ := out["ok"].(bool); !ok {
		return out
	}
	if sig == "" || !hmac.Equal([]byte(sig), []byte(mac(key, "pair\n"+id+"\n"+answer))) {
		return map[string]any{"ok": false, "code": "EAUTH", "message": "the pairing answer is not signed with the agreed key; something other than NakliOS answered"}
	}
	fmt.Fprintf(os.Stderr, "naklios-door: did NakliOS show the code %s, and did you allow it? [y/N] ", code)
	line, _ := bufio.NewReader(terminal).ReadString('\n')
	if strings.ToLower(strings.TrimSpace(line)) != "y" {
		return map[string]any{"ok": false, "code": "EDENIED", "message": "not confirmed; nothing was saved. If NakliOS lists this program in Settings → AI, revoke it."}
	}
	path, err := saveKey(client, base64.RawURLEncoding.EncodeToString(key))
	if err != nil {
		return map[string]any{"ok": false, "code": "EFAIL", "message": "paired, but the key could not be saved: " + err.Error()}
	}
	return map[string]any{"ok": true, "client": client, "keyFile": path}
}

func mac(key []byte, text string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(text))
	return hex.EncodeToString(m.Sum(nil))
}

// exchange posts body to /v1/op and returns the relay's answer {payload, mac?}.
func exchange(port int, op string, body any) (payload, sig string, failure map[string]any) {
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/%s", port, op), bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 330 * time.Second}).Do(req)
	if err != nil {
		return "", "", map[string]any{"ok": false, "code": "ENORELAY", "message": "the relay is not running; start it with: naklios-door serve"}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, maxBody))
	var answer struct {
		Payload string `json:"payload"`
		Mac     string `json:"mac"`
	}
	if json.Unmarshal(raw, &answer) != nil || answer.Payload == "" {
		return "", "", map[string]any{"ok": false, "code": "EFAIL", "message": strings.TrimSpace(string(raw))}
	}
	return answer.Payload, answer.Mac, nil
}

func decode(payload string) map[string]any {
	out := map[string]any{}
	if json.Unmarshal([]byte(payload), &out) != nil {
		return map[string]any{"ok": false, "code": "EFAIL", "message": "the answer is not JSON"}
	}
	return out
}

// signed sends one authenticated request and accepts only an answer signed with the same key. An unsigned answer is
// shown only when it is a refusal, marked unverified, because anything could have sent it.
func signed(port int, op, client string, body any) map[string]any {
	key := loadKey(client)
	inner, _ := json.Marshal(body)
	nb := make([]byte, 18)
	rand.Read(nb)
	nonce := base64.RawURLEncoding.EncodeToString(nb)
	ts := time.Now().UnixMilli()
	payload := string(inner)
	request := map[string]any{"client": client, "ts": ts, "nonce": nonce, "payload": payload,
		"mac": mac(key, fmt.Sprintf("%s\n%d\n%s\n%s", op, ts, nonce, payload))}
	answer, sig, failure := exchange(port, op, request)
	if failure != nil {
		return failure
	}
	out := decode(answer)
	if sig == "" {
		if ok, _ := out["ok"].(bool); ok {
			return map[string]any{"ok": false, "code": "EAUTH", "message": "an unsigned answer claimed success; something other than NakliOS answered"}
		}
		out["verified"] = false
		return out
	}
	if !hmac.Equal([]byte(sig), []byte(mac(key, "reply\n"+nonce+"\n"+answer))) {
		return map[string]any{"ok": false, "code": "EAUTH", "message": "the answer's signature is wrong; something other than NakliOS answered"}
	}
	return out
}

func emit(out map[string]any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	enc.Encode(out)
	if ok, _ := out["ok"].(bool); !ok {
		os.Exit(1)
	}
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "naklios-door: "+msg)
	os.Exit(1)
}
