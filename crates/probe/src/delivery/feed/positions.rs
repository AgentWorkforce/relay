//! Access the immutable member snapshot used to prove one query page.
use super::*;

impl UploadPositions {
    /// Whether the job shares only its members.
    pub fn scoped(&self) -> bool {
        self.scoped
    }
    /// Whether this member followed a selected ancestor in the same snapshot.
    pub fn delegated(&self, session: &SessionIdentity) -> bool {
        self.members.get(session).is_some_and(|m| m.delegated)
    }
    /// Whether `session` was a member when the positions were read.
    pub fn member(&self, session: &SessionIdentity) -> bool {
        self.members.contains_key(session)
    }
}
