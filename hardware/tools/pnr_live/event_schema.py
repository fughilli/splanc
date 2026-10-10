"""Compatibility normalization for completed live-viewer phase events."""

def phase_frame(event):
    """Missing display labels must not discard completed board telemetry.

    Do not infer a routing phase from the candidate ID or invent native counts.
    Required acceptance/geometry fields still fail closed before lane mutation.
    """
    data = event["data"]
    label_source = next((key for key in ("name", "phase")
                         if isinstance(data.get(key), str) and data[key].strip()), None)
    name = data[label_source] if label_source else "Completed phase (label unavailable)"
    return dict(name=name, label_source=label_source or "unavailable",
                board_sha256=event["board_sha256"], event_id=event["id"],
                opens=data["opens"], violations=data["violations"])
