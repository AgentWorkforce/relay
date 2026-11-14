//! Telling extensions that a bridge connection ended.

use crate::relay::daemon::{CallContext, Core};
use std::sync::Arc;

/// Tells every extension, once, that a connection ended: when the client
/// hangs up mid-call, when the connection winds down, or, failing both, when
/// its task unwinds.
pub(super) struct Closed {
    core: Arc<Core>,
    context: CallContext,
    fired: bool,
}

impl Closed {
    pub(super) fn new(core: Arc<Core>, context: CallContext) -> Closed {
        Closed {
            core,
            context,
            fired: false,
        }
    }

    pub(super) fn fire(&mut self) {
        if std::mem::replace(&mut self.fired, true) {
            return;
        }
        for extension in &self.core.plugins.extensions {
            extension.connection_closed(&self.context);
        }
    }
}

impl Drop for Closed {
    fn drop(&mut self) {
        self.fire();
    }
}
