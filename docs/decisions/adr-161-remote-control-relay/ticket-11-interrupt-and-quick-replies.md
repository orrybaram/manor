---
title: Interrupt and quick replies
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Interrupt and quick replies

The remote surface can act, and the client cannot reach the two actions that matter on a
phone.

**Interrupt.** `guardedSend` in `electron/remote-control/server.ts` already reads
`body.interrupt`, audits it as its own field, and passes it through to the route.
`src/remote-client/main.ts` never sets it. Stopping an agent that has gone wrong is the
single highest-value thing to be able to do from away from the desk, and today the only
available action is typing text.

**Quick replies.** A session in `requires_input` is usually sitting on a permission
prompt whose answer is `1`, `2`, `y`, or Enter. Getting there now means a phone keyboard,
then a confirmation sheet quoting the text `1`. That is the wrong amount of ceremony for
the most common interaction, and it is the reason a glance at the phone still ends with
"I will deal with it when I get back".

**This ticket's premise about interrupt was wrong.** `body.interrupt` is not "please
interrupt" — `/sessions/send` interrupts unconditionally, because ending the turn is how a
prompt gets injected, and the field only overrides the key sequence used. With `text`
required there was no way to express "just stop" at all. So interrupt landed as a new
route, `POST /sessions/interrupt`, allowlisted as a write and gated identically. Quick
replies did turn out to be pure client work.

Both are writes and both keep every existing gate: the device capability, `confirmed:
true` in the request, and an audit line.

- A **Stop** control in the detail view, shown when the device holds the send capability
  and the session is `working` or `thinking`. Its confirmation says what interrupting
  means, not what text is being sent.
- A row of quick replies above the composer when the session is `requires_input`:
  `1`, `2`, `3`, `y`, `n`, and Enter/continue. Tapping one goes through `confirmSend`
  like anything else — the sheet is what makes a stolen token still have to mean it — but
  the sheet for a one-character reply can be a single tap rather than a paragraph.
- Do not infer the prompt's options by parsing scrollback. A wrong guess about which
  option is "allow" is a security bug wearing a convenience hat. Show fixed keys and let
  the user read the transcript above them.
- The audit line must distinguish an interrupt from a send (it already has the field) and
  a quick reply is an ordinary send — no third category.

Tests: an interrupt from a device without the capability is rejected and audited; an
interrupt without `confirmed: true` is rejected; a quick reply produces exactly the same
audit shape as a typed send of the same text; the Stop control is absent for a read-only
device.

## Files to touch

- `src/remote-client/main.ts` — Stop control, quick-reply row, confirmation copy.
- `src/remote-client/styles.css` — both.
- `electron/remote-control/__tests__/server.test.ts` — interrupt gating cases.
