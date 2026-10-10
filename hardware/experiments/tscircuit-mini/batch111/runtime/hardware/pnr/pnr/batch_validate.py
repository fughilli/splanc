"""Native-gated batch commit with bounded binary conflict isolation."""
from concurrent.futures import ThreadPoolExecutor

def evaluate(jobs,base,propose,validate,workers=2):
    """validate(current, [(job,proposal),...]) returns certified state or None.

    No proposed state becomes current until validate succeeds. Failed groups are
    bisected against the latest certified state; failed leaves retry serially.
    """
    ready=[];retry=[];events=[];calls=0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures=[pool.submit(propose,j,base) for j in jobs]
        for job,future in zip(jobs,futures):
            try:
                result=future.result()
                if result.get('proposal_ready'):ready.append((job,result))
                else:retry.append(job)
            except Exception as ex:
                retry.append(job);events.append(dict(stage='proposal_error',job=job,error=repr(ex)))
    def commit(current,items):
        nonlocal calls
        if not items:return current,[]
        calls+=1
        try:updated=validate(current,items)
        except Exception as ex:
            updated=None;events.append(dict(stage='validation_error',size=len(items),error=repr(ex)))
        events.append(dict(stage='batch_validation',size=len(items),accepted=updated is not None))
        if updated is not None:return updated,[j for j,p in items]
        if len(items)==1:retry.append(items[0][0]);return current,[]
        middle=len(items)//2
        current,left=commit(current,items[:middle]);current,right=commit(current,items[middle:])
        return current,left+right
    current,accepted=commit(base,ready)
    return current,accepted,retry,dict(validation_attempts=calls,proposal_count=len(jobs),ready_count=len(ready),events=events)
