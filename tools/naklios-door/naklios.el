;;; naklios.el --- Call NakliOS app commands from Emacs  -*- lexical-binding: t; -*-

;; Part of the NakliOS outside door (tools/naklios-door). Needs `naklios-door serve' running, NakliOS open with
;; Settings → AI → "Let programs on this computer … use NakliOS commands" on, and a key from
;; `naklios-door pair emacs' (saved to ~/.config/naklios/door-emacs.key).

;;; Commentary:
;; M-x naklios-call      pick a command (completion over search), give its input as JSON, see the answer.
;; (naklios-search "notes")                       → list of command briefs
;; (naklios-describe "notes.list.read")           → one command with its input schema
;; (naklios-call-command "notes.list.read" '((list . "shopping")))  → the answer as an alist
;;
;; Each request is signed with the key (HMAC-SHA256 over operation, time, nonce and payload) and each answer must be
;; signed by NakliOS with the same key, so the key never crosses the relay and a stand-in for NakliOS is detected.

;;; Code:

(require 'json)
(require 'url)
(require 'url-http)

(defgroup naklios nil "Call NakliOS app commands." :group 'tools)
(defcustom naklios-port 7461 "Port of `naklios-door serve' on 127.0.0.1." :type 'integer)
(defcustom naklios-client "emacs" "Name this program was paired under." :type 'string)

(defun naklios--key ()
  (let ((file (expand-file-name (format "~/.config/naklios/door-%s.key" naklios-client))))
    (unless (file-readable-p file)
      (user-error "No NakliOS key; run in a shell: naklios-door pair %s" naklios-client))
    (let ((key (base64-decode-string (with-temp-buffer (insert-file-contents file) (string-trim (buffer-string))) t)))
      (unless (= (length key) 32) (user-error "The key file %s is damaged; pair again" file))
      key)))

(defun naklios--hmac (key message)
  "HMAC-SHA256 of MESSAGE (a string, taken as UTF-8) under KEY (32 raw bytes), as lowercase hex."
  (let* ((block (concat key (make-string (- 64 (length key)) 0)))
         (pad (lambda (byte) (apply #'unibyte-string (mapcar (lambda (c) (logxor c byte)) (string-to-list block)))))
         (inner (secure-hash 'sha256 (concat (funcall pad #x36) (encode-coding-string message 'utf-8)) nil nil t)))
    (secure-hash 'sha256 (concat (funcall pad #x5c) inner))))

(defun naklios--http (op body)
  "POST BODY (an alist) to /v1/OP. Return (STATUS . OUTER-ALIST)."
  (let* ((url-proxy-services nil) ; the key-signed request must never go to a proxy from http_proxy
         (url-request-method "POST")
         (url-request-extra-headers '(("Content-Type" . "application/json")))
         (url-request-data (encode-coding-string (json-encode body) 'utf-8))
         (buffer (condition-case nil
                     (url-retrieve-synchronously (format "http://127.0.0.1:%d/v1/%s" naklios-port op) t t 330)
                   (error nil))))
    (unless buffer (user-error "naklios-door is not running; start it with: naklios-door serve"))
    (with-current-buffer buffer
      (let ((status (bound-and-true-p url-http-response-status)))
        (goto-char (point-min))
        (re-search-forward "\r?\n\r?\n" nil t)
        (let ((text (decode-coding-string (buffer-substring-no-properties (point) (point-max)) 'utf-8)))
          (kill-buffer buffer)
          (cons status (condition-case nil
                           (let ((json-object-type 'alist) (json-array-type 'list) (json-key-type 'symbol)) (json-read-from-string text))
                         (error (user-error "naklios-door answered %s: %s" status (string-trim text))))))))))

(defun naklios--signed (op inner)
  "Send INNER (an alist) as a signed OP request and return the verified answer as an alist."
  (let* ((key (naklios--key))
         (payload (json-encode inner))
         (ts (truncate (* 1000 (float-time))))
         (nonce (substring (secure-hash 'sha256 (format "%s %s %s" (random t) (float-time) (emacs-pid))) 0 32))
         (mac (naklios--hmac key (format "%s\n%d\n%s\n%s" op ts nonce payload)))
         (outer (cdr (naklios--http op `((client . ,naklios-client) (ts . ,ts) (nonce . ,nonce) (payload . ,payload) (mac . ,mac)))))
         (answer (alist-get 'payload outer))
         (sig (alist-get 'mac outer))
         (out (and (stringp answer)
                   (let ((json-object-type 'alist) (json-array-type 'list) (json-key-type 'symbol)) (json-read-from-string answer)))))
    (cond ((not out) (user-error "NakliOS: the answer carried no payload"))
          ((not sig) (if (eq (alist-get 'ok out) t)
                         (user-error "NakliOS: an unsigned answer claimed success; something other than NakliOS answered")
                       (cons '(verified . :json-false) (assq-delete-all 'verified out))))
          ((not (string= sig (naklios--hmac key (concat "reply\n" nonce "\n" answer))))
           (user-error "NakliOS: the answer's signature is wrong; something other than NakliOS answered"))
          (t out))))

(defun naklios-search (query)
  "Command briefs matching QUERY."
  (let ((out (naklios--signed "search" `((query . ,query)))))
    (if (eq (alist-get 'ok out) t) (alist-get 'results out)
      (user-error "NakliOS: %s" (alist-get 'message out)))))

(defun naklios-describe (name)
  "The command NAME with its input schema."
  (naklios--signed "describe" `((name . ,name))))

(defun naklios-call-command (name input &optional ask)
  "Run command NAME with INPUT (an alist). With ASK, NakliOS may ask the person instead of answering ECONSENT."
  (naklios--signed "call" `((name . ,name) (input . ,(or input (make-hash-table))) (ask . ,(if ask t :json-false)))))

;;;###autoload
(defun naklios-call (name input-json)
  "Pick a NakliOS command NAME, give INPUT-JSON, and show the answer."
  (interactive
   (let* ((names (mapcar (lambda (c) (alist-get 'name c)) (naklios-search "")))
          (name (completing-read "NakliOS command: " names nil t))
          (schema (alist-get 'input (alist-get 'command (naklios-describe name)))))
     (list name (read-string (format "Input JSON (%s): " (json-encode (or schema "{}"))) "{}"))))
  (let* ((input (let ((json-object-type 'alist)) (json-read-from-string input-json)))
         (out (naklios-call-command name input)))
    (with-current-buffer (get-buffer-create "*NakliOS*")
      (erase-buffer)
      (insert (json-encode out))
      (json-pretty-print-buffer)
      (display-buffer (current-buffer)))
    out))

(provide 'naklios)
;;; naklios.el ends here
