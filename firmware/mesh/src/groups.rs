//! Groups (design §7.7): a member's group ids, persisted on it. Names live in the app and the
//! hub config; members store ids only.

/// The groups a member is in (§7.7): up to 8 ids, 0 is "none".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Groups {
    pub(crate) ids: [u8; Groups::MAX],
    pub(crate) n: u8,
}

impl Groups {
    pub const MAX: usize = 8;

    pub const fn new() -> Groups {
        Groups { ids: [0; Groups::MAX], n: 0 }
    }

    /// Up to 8 distinct non-zero ids, in order; the rest are ignored.
    pub fn from_slice(ids: &[u8]) -> Groups {
        let mut g = Groups::new();
        for &id in ids {
            g.add(id);
        }
        g
    }

    pub fn add(&mut self, id: u8) -> bool {
        if id == 0 || self.contains(id) || self.n as usize >= Self::MAX {
            return false;
        }
        self.ids[self.n as usize] = id;
        self.n += 1;
        true
    }

    pub fn contains(&self, id: u8) -> bool {
        id != 0 && self.as_slice().contains(&id)
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.ids[..self.n as usize]
    }

    pub fn len(&self) -> usize {
        self.n as usize
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups() {
        let g = Groups::from_slice(&[3, 0, 3, 5, 1, 2, 4, 6, 7, 8, 9]);
        assert_eq!(g.as_slice(), &[3, 5, 1, 2, 4, 6, 7, 8]);
        assert!(g.contains(5) && !g.contains(0) && !g.contains(9));
    }
}
