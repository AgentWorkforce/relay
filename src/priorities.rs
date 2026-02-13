use crate::{
    queue::Prioritized,
    types::{InjectRequest, RelayPriority},
};

impl Prioritized for InjectRequest {
    fn priority(&self) -> RelayPriority {
        self.priority
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{InjectRequest, RelayPriority};

    #[test]
    fn inject_request_priority() {
        for p in [
            RelayPriority::P0,
            RelayPriority::P1,
            RelayPriority::P2,
            RelayPriority::P3,
            RelayPriority::P4,
        ] {
            let req = InjectRequest {
                id: "x".into(),
                from: "a".into(),
                target: "b".into(),
                body: "c".into(),
                priority: p,
                attempts: 0,
            };
            assert_eq!(req.priority(), p);
        }
    }
}
