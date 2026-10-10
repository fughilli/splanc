"""Bounded provisional epochs; authoritative acceptance gates stay with caller."""
from dataclasses import dataclass, field
from time import perf_counter

@dataclass
class EpochResult:
    state: object
    accepted: list = field(default_factory=list)
    rejected: list = field(default_factory=list)
    events: list = field(default_factory=list)
    native_calls: int = 0
    proxy_calls: int = 0
    elapsed_seconds: float = 0.0

def evaluate_epochs(state, edits, *, apply, proxy, native_gate, eligible, max_edits=4, emit=lambda event: None):
    """Immutable apply, fail-closed proxy, full native boundary, rollback/bisection.

 Caller gates MUST preserve original DRC, connectivity, width/entry, electrical
 and reference checks. Unsupported edits are checked alone. Rollback is not
 geometric repair; rejected edits may leave opens. No production bypass implied.
 """
    if type(max_edits) is not int or max_edits < 1:
        raise ValueError('max_edits must be a positive integer')
    started = perf_counter()
    result = EpochResult(state)

    def event(kind, **fields):
        value = dict(status=kind, **fields)
        result.events.append(value)
        emit(value)

    def reject(edit, reason):
        result.rejected.append(edit)
        event('rejected', edit=str(edit), reason=reason)

    def commit_batch(batch):
        if not batch:
            return
        base = result.state
        candidate = base
        retained = []
        for edit in batch:
            try:
                proposed = apply(candidate, edit)
                if eligible(edit):
                    result.proxy_calls += 1
                    if proxy(candidate, proposed, edit) is not True:
                        reject(edit, 'proxy_rejected')
                        continue
                candidate = proposed
                retained.append(edit)
                event('provisional', edit=str(edit), epoch_edits=len(retained))
            except Exception as exc:
                reject(edit, 'proposal_or_proxy_error: ' + repr(exc))
        if not retained:
            return
        result.native_calls += 1
        try:
            passed = native_gate(base, candidate) is True
        except Exception as exc:
            event('native_error', error=repr(exc), edits=len(retained))
            for edit in retained:
                reject(edit, 'native_error')
            return
        if passed:
            result.state = candidate
            result.accepted.extend(retained)
            event('accepted_epoch', edits=len(retained), native_calls=result.native_calls)
        elif len(retained) == 1:
            reject(retained[0], 'native_rejected')
        else:
            event('rollback_and_bisect', edits=len(retained))
            middle = len(retained) // 2
            commit_batch(retained[:middle])
            commit_batch(retained[middle:])
    pending = []
    for edit in edits:
        if not eligible(edit):
            commit_batch(pending)
            pending = []
            commit_batch([edit])
        else:
            pending.append(edit)
            if len(pending) == max_edits:
                commit_batch(pending)
                pending = []
    commit_batch(pending)
    result.elapsed_seconds = perf_counter() - started
    return result
