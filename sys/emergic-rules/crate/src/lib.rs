//! NakliOS's WebAssembly door onto Emergic's common rules (`emergic-rules`, owned by Emergic).
//! It adds no rules of its own: each operation calls the crate and turns the answer into JSON.
//!
//! ABI: the page writes a UTF-8 JSON request `{ "op": ..., ... }` into memory from `alloc`, calls
//! `run(ptr, len)`, and gets back a packed `(ptr << 32) | len` pointing at a UTF-8 JSON reply,
//! `{ "ok": <value> }` or `{ "error": "<text>" }`. The page frees both buffers with `dealloc`.

use chrono::{NaiveDate, NaiveDateTime};
use emergic_rules::dates::{due, due_in_mail, has_time_words, when};
use emergic_rules::{closes, promises_in, Closed, Direction, Mail, Promise, Reply};
use serde::Deserialize;
use serde_json::{json, Value};

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from `alloc` (or a `run` reply) and be freed once.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

/// # Safety
/// `ptr..ptr+len` must be a buffer from `alloc` holding the request.
#[no_mangle]
pub unsafe extern "C" fn run(ptr: *const u8, len: usize) -> u64 {
    let input = std::slice::from_raw_parts(ptr, len);
    let reply = match std::str::from_utf8(input).map_err(|e| e.to_string()).and_then(answer) {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error }),
    };
    let mut bytes = reply.to_string().into_bytes();
    bytes.shrink_to_fit();
    let (out, out_len) = (bytes.as_mut_ptr(), bytes.len());
    std::mem::forget(bytes);
    ((out as u64) << 32) | out_len as u64
}

fn day(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s.get(..10).unwrap_or(s), "%Y-%m-%d").map_err(|_| format!("not a YYYY-MM-DD day: {s}"))
}

fn moment(s: &str) -> Result<NaiveDateTime, String> {
    let s = s.get(..16).unwrap_or(s);
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").map_err(|_| format!("not a YYYY-MM-DDTHH:MM moment: {s}"))
}

fn dated(found: Option<(NaiveDate, bool)>) -> Value {
    found.map_or(Value::Null, |(d, inferred)| json!({ "due": d.to_string(), "inferred": inferred }))
}

fn direction_word(d: Direction) -> &'static str {
    match d {
        Direction::IOwe => "i_owe",
        Direction::OwedToMe => "owed_to_me",
    }
}

fn closed_word(c: Closed) -> &'static str {
    match c {
        Closed::Replied => "replied",
        Closed::Answered => "answered",
        Closed::Done => "done",
        Closed::Dropped => "dropped",
    }
}

/// UTF-16 offset of a byte offset, so a page can slice the body string it passed in.
fn utf16_at(body: &str, byte: usize) -> usize {
    body.get(..byte).map_or(0, |s| s.encode_utf16().count())
}

#[derive(Deserialize)]
struct MailIn {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: Vec<String>,
    #[serde(default)]
    reply_to: String,
    #[serde(default)]
    body: String,
    sent_on: String,
}

#[derive(Deserialize)]
struct PromiseIn {
    direction: String,
    #[serde(default)]
    who: String,
    #[serde(default)]
    what: String,
    due: String,
    #[serde(default)]
    inferred: bool,
}

#[derive(Deserialize)]
struct ReplyIn {
    #[serde(default)]
    from: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    draft: bool,
}

fn field<'a>(v: &'a Value, name: &str) -> Result<&'a Value, String> {
    v.get(name).ok_or_else(|| format!("missing field {name}"))
}

fn text<'a>(v: &'a Value, name: &str) -> Result<&'a str, String> {
    field(v, name)?.as_str().ok_or_else(|| format!("field {name} must be a string"))
}

fn answer(request: &str) -> Result<Value, String> {
    let r: Value = serde_json::from_str(request).map_err(|e| format!("request is not JSON: {e}"))?;
    match text(&r, "op")? {
        "due" => Ok(dated(due(text(&r, "words")?, day(text(&r, "day")?)?))),
        "due_in_mail" => Ok(dated(due_in_mail(text(&r, "sentence")?, day(text(&r, "sent")?)?))),
        "has_time_words" => Ok(json!(has_time_words(text(&r, "words")?))),
        "when" => Ok(when(text(&r, "words")?, moment(text(&r, "now")?)?)
            .map_or(Value::Null, |m| json!(m.format("%Y-%m-%dT%H:%M").to_string()))),
        "promises_in" => {
            let m: MailIn = serde_json::from_value(field(&r, "mail")?.clone()).map_err(|e| format!("mail: {e}"))?;
            let to: Vec<&str> = m.to.iter().map(String::as_str).collect();
            let mail = Mail { from: &m.from, to: &to, reply_to: &m.reply_to, body: &m.body, sent_on: day(&m.sent_on)? };
            let found = promises_in(&mail, text(&r, "me")?);
            Ok(Value::Array(
                found
                    .into_iter()
                    .map(|p| {
                        json!({
                            "direction": direction_word(p.direction), "who": p.who, "what": p.what,
                            "due": p.due.to_string(), "inferred": p.inferred,
                            "quote_start": utf16_at(&m.body, p.quote_span.start),
                            "quote_end": utf16_at(&m.body, p.quote_span.end),
                        })
                    })
                    .collect(),
            ))
        }
        "closes" => {
            let p: PromiseIn = serde_json::from_value(field(&r, "promise")?.clone()).map_err(|e| format!("promise: {e}"))?;
            let direction = match p.direction.as_str() {
                "i_owe" => Direction::IOwe,
                "owed_to_me" => Direction::OwedToMe,
                other => return Err(format!("promise.direction must be i_owe or owed_to_me, not {other}")),
            };
            let promise = Promise { direction, who: p.who, what: p.what, due: day(&p.due)?, inferred: p.inferred, quote_span: 0..0 };
            let reply: ReplyIn = serde_json::from_value(field(&r, "reply")?.clone()).map_err(|e| format!("reply: {e}"))?;
            let closed = closes(&promise, &Reply { from: &reply.from, body: &reply.body, draft: reply.draft }, text(&r, "me")?);
            Ok(closed.map_or(Value::Null, |c| json!(closed_word(c))))
        }
        "closed_from_word" => Ok(Closed::from_word(text(&r, "word")?).map_or(Value::Null, |c| json!(closed_word(c)))),
        other => Err(format!("unknown op {other}")),
    }
}
