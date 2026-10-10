"""Select physical pads without conflating repeated electrical terminal numbers."""


def resolve_pad(board, label, identity=None):
    candidates = [p for f in board.GetFootprints() for p in f.Pads()
                  if f.GetReference()+'.'+p.GetNumber() == label
                  and (identity is None or p.m_Uuid.AsString() == identity)]
    if len(candidates) != 1:
        raise ValueError('physical pad selection requires one match: '+label+
                         (' UUID '+identity if identity else ' (supply pad UUID for repeated numbers)'))
    return candidates[0]
