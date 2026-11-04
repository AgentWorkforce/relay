//! The keyed map merger the persisted store's merge and the activation
//! journal share: each key takes the side that changed it, and `ours`
//! when both did.

use super::*;

pub(super) fn merge_maps<V: Clone + PartialEq>(
    base: &BTreeMap<String, V>,
    ours: &BTreeMap<String, V>,
    theirs: &BTreeMap<String, V>,
) -> BTreeMap<String, V> {
    let keys: HashSet<&String> = base
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    keys.into_iter()
        .filter_map(|k| {
            pick(
                &base.get(k).cloned(),
                &ours.get(k).cloned(),
                &theirs.get(k).cloned(),
            )
            .map(|v| (k.clone(), v))
        })
        .collect()
}

/// `ours` if this process changed it (a removal included), else `theirs`.
fn pick<T: Clone + PartialEq>(base: &T, ours: &T, theirs: &T) -> T {
    if ours == base {
        theirs.clone()
    } else {
        ours.clone()
    }
}
