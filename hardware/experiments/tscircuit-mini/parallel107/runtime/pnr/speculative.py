"""Bounded parallel proposals with deterministic serial, validated commits."""
from concurrent.futures import ThreadPoolExecutor

def evaluate_batch(jobs, snapshot, propose, commit, workers=2):
    """All proposals read snapshot; commit returns a new immutable state or None.

    Rejected/stale proposals are returned for ordinary serial routing. Nothing
    mutates a shared board in worker threads. Stable order makes runs repeatable.
    """
    current=snapshot;accepted=[];retry=[];events=[]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures=[pool.submit(propose,job,snapshot) for job in jobs]
        for job,future in zip(jobs,futures):
            try:
                proposal=future.result()
                updated=commit(job,snapshot,current,proposal)
                if updated is None:retry.append(job);status='serial_retry'
                else:current=updated;accepted.append(job);status='committed'
                events.append(dict(job=job,status=status))
            except Exception as ex:
                retry.append(job);events.append(dict(job=job,status='serial_retry',error=repr(ex)))
    return current,accepted,retry,events
