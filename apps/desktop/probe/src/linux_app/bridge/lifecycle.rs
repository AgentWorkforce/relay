//! Stopping the core, or leaving it running, when the app quits.

use super::*;
use crate::linux_app::host::{self, HOST_WAIT, SHUTDOWN_WAIT};
use std::sync::PoisonError;

impl Bridge {
    /// Asks the hosted core to stop and waits for it to exit. One that has
    /// not reached its socket yet is asked once it does, or killed.
    pub(super) async fn stop_hosted(&self) {
        let deadline = Instant::now() + HOST_WAIT;
        while self.hosting() && !self.ask_core_to_stop().await {
            if Instant::now() >= deadline {
                self.inner.hosted.kill();
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.inner.hosted.release().await;
    }

    /// [`Bridge::stop`] for the app quitting. With `keep_core` the core runs
    /// on, as the Mac's LaunchAgent does, and the next launch connects to it.
    /// Without, it stops: one this app hosts, and one an earlier run left
    /// running, but never the systemd unit's or one started by hand.
    pub async fn quit(&self, keep_core: bool) {
        if keep_core {
            self.close().await;
            self.inner.hosted.detach(&self.inner.options.socket);
            return;
        }
        self.stop().await;
        self.stop_left_behind().await;
    }

    pub(super) async fn close(&self) {
        self.inner.stopping.send_replace(true);
        let idle = std::mem::take(
            &mut self
                .inner
                .shared
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .idle,
        );
        drop(idle);
        let task = self
            .inner
            .events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(task) = task {
            let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
        }
        // The event task starts a child only while not stopping, and it has
        // ended, so no child appears after this.
    }

    /// Whether the core answering is the one an earlier run of the app left
    /// running: not this app's child, the systemd unit's or one started by
    /// hand, which [`Hosted::detach`] did not record.
    pub(super) async fn left_behind(&self) -> bool {
        let socket = &self.inner.options.socket;
        let Some(recorded) = host::left_running(socket) else {
            return false;
        };
        if self.hosting() {
            return false;
        }
        let answering = CoreStream::connect(socket)
            .await
            .ok()
            .and_then(|stream| stream.peer_credentials().ok()?.pid);
        if answering != Some(recorded) {
            host::forget_left_running(socket);
            return false;
        }
        true
    }

    /// Stops the core an earlier run left running, if it answers, and waits
    /// for it to free the socket.
    pub(super) async fn stop_left_behind(&self) {
        if !self.left_behind().await {
            return;
        }
        let socket = &self.inner.options.socket;
        self.inner.retiring.store(true, Ordering::SeqCst);
        self.ask_core_to_stop().await;
        let deadline = Instant::now() + SHUTDOWN_WAIT;
        while Instant::now() < deadline && CoreStream::connect(socket).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        host::forget_left_running(socket);
        self.inner.retiring.store(false, Ordering::SeqCst);
    }

    /// Whether the core that answered must not be used: one being stopped,
    /// whose greeting must not end [`Bridge::release_hosted`]'s hold on
    /// hosting, or one left running on another version, asked to stop here.
    pub(super) async fn unusable_core(&self) -> bool {
        if self.inner.retiring.load(Ordering::SeqCst) {
            return true;
        }
        if self.left_running_on_another_version().await {
            let _ = self.ask_core_to_stop().await;
            return true;
        }
        false
    }

    /// The core an earlier run left running, from before an update.
    async fn left_running_on_another_version(&self) -> bool {
        let Some(version) = self
            .inner
            .options
            .host
            .as_ref()
            .and_then(|host| host.version.clone())
        else {
            return false;
        };
        self.daemon_version()
            .is_some_and(|running| running != version)
            && self.left_behind().await
    }

    /// Sends `daemon.shutdown`, which needs no handshake. False when no
    /// core answers on the socket.
    pub(super) async fn ask_core_to_stop(&self) -> bool {
        let Ok(mut connection) = Connection::open(&self.inner.options.socket).await else {
            return false;
        };
        let _ = connection
            .request(method::DaemonShutdown::NAME, json!({}), CONNECT_TIMEOUT)
            .await;
        true
    }
}
