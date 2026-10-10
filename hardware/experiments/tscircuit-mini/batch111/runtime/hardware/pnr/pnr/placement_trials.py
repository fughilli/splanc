"""Bounded placement trial scheduling shared by paired routing controllers."""

def diverse_pair_poses(proposals,limit):
    """Cover distinct package orientations before nearby translations.

    Keep the geometric score order within each orientation and retain every
    candidate for larger budgets. No board refs or preferred angles are fixed.
    """
    first,later,seen=[],[],set()
    for pose in proposals:
        key=(pose['ref'],round(pose['rotation']%360,6))
        if key in seen:later.append(pose)
        else:first.append(pose);seen.add(key)
    return (first+later)[:max(0,limit)]

