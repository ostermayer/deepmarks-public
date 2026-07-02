# Deepmarks Android 2.0.5

This Android release fixes bookmark sync durability across mobile,
desktop, and extension saves:

- Saves are treated as complete only after the signed bookmark has been
  written to a durable retry queue.
- Temporary Deepmarks `/publish` or network failures retry in the
  background instead of surfacing sync errors to users.
- Native share-sheet saves keep their original capture time and remain
  pending when the signed event cannot be durably queued.
- Public, private, import, edit, archive-finalize, read-later, and delete
  bookmark mutations now use the same queued publish path.
- Browser extension saves also queue signed events for retry, including
  direct-relay mode when no relay accepts the event.
