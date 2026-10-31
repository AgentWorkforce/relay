//! What a channel injection says besides the posts: the channel's name, the
//! reply lines for what the session can use, and the host's note; and the
//! reply lines of a direct message.

use crate::relay::daemon::Core;
use crate::relay::delivery::channel_text::thread_target;
use crate::relay::delivery::policy::Delivery;
use crate::relay::hosted_mcp::{self, ChannelReply};
use crate::relay::outbound::channels::{channel_reply_command, channel_subscription_command};
use crate::relay::store::{Registration, SessionKind};
use crate::relay::workspace::Secret;

impl Core {
    /// The channel's name, as the reply instructions need it, from this
    /// agent's channel list; `None` while it cannot be read.
    pub(super) async fn channel_name(
        &self,
        registration: &Registration,
        token: &Secret,
        id: &str,
    ) -> Option<String> {
        if let Some(name) = self.delivery_state().channel_names.get(id) {
            return Some(name.clone());
        }
        let agent = crate::relay::client::agent_client(&registration.base_url, token).ok()?;
        let listed = agent.list_channels(false).await.ok()?;
        let mut state = self.delivery_state();
        for channel in listed {
            state.channel_names.insert(channel.id, channel.name);
        }
        state.channel_names.get(id).cloned()
    }

    /// The posts with their attachments saved and fetch hints added.
    pub(super) async fn with_files(
        &self,
        posts: Vec<Delivery>,
        registration: &Registration,
        token: &Secret,
    ) -> Vec<Delivery> {
        let mut saved = Vec::with_capacity(posts.len());
        for post in posts {
            let mut post = self
                .with_saved_attachments(&post, &registration.base_url, token)
                .await
                .unwrap_or(post);
            self.add_fetch_hints(&registration.target, &mut post.attachments)
                .await;
            saved.push(post);
        }
        saved
    }

    /// The lines after a channel injection's attribution: how to reply in
    /// the latest post's thread, then the host's note when the app the
    /// session runs in does not show relayed messages (as for a DM).
    pub(super) async fn channel_prompt_lines(
        &self,
        registration: &Registration,
        channel: &str,
        posts: &[Delivery],
    ) -> String {
        let thread = posts.last().map(thread_target).unwrap_or_default();
        let injector = self.plugins.injector.clone();
        let target = registration.target.clone();
        let (socket, note) = tokio::task::spawn_blocking(move || {
            (injector.relay_socket(&target), injector.host_note(&target))
        })
        .await
        .unwrap_or_default();
        let kind = registration.target.kind;
        let command = |subscribe: Option<bool>| {
            let (path, probe) = socket.as_ref()?;
            match subscribe {
                None => channel_reply_command(path, channel, thread, kind, *probe),
                Some(join) => channel_subscription_command(path, channel, join, kind, *probe),
            }
        };
        let (reply, unsubscribe) = (command(None), command(Some(false)));
        let web_address = (kind == SessionKind::ClaudeCloud && socket.is_none())
            .then(|| registration.current_address(&self.machine_prefix));
        let lines = ChannelReply {
            access: self.relay_mcp_access(&registration.target),
            channel,
            thread_id: thread,
            socket_reply: reply.as_deref(),
            socket_unsubscribe: unsubscribe.as_deref(),
            web_address: web_address.as_deref(),
        }
        .lines();
        match note {
            Some(note) => format!("{lines}\n{note}"),
            None => lines,
        }
    }

    /// The reply lines for a direct message, mention or thread reply, by
    /// what the session can use ([`hosted_mcp::dm_reply_hint`]).
    pub(in crate::relay::delivery) async fn dm_reply_lines(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> Option<String> {
        let injector = self.plugins.injector.clone();
        let target = registration.target.clone();
        let address = delivery.sender_address.clone();
        let to = address.is_none().then(|| delivery.sender.clone()).flatten();
        let parent = delivery.message_id.clone();
        let recipient = address.clone().or_else(|| to.clone())?;
        let socket = tokio::task::spawn_blocking(move || {
            injector.reply_hint(&target, to.as_deref(), address.as_deref(), &parent)
        })
        .await
        .ok()
        .flatten();
        // A headless spawned session answers through the socket only: that
        // sends as the session and claims its automatic answer, where a
        // hosted MCP reply would go unseen here and be answered twice.
        let spawned = registration
            .spawn
            .as_ref()
            .is_some_and(|spawn| spawn.taken_over_at.is_none());
        let access = if spawned {
            hosted_mcp::McpAccess::SocketOnly
        } else {
            self.relay_mcp_access(&registration.target)
        };
        let address = registration.current_address(&self.machine_prefix);
        if registration.target.kind == SessionKind::ClaudeCloud && socket.is_none() {
            return hosted_mcp::web_reply_hint(access, &recipient, &delivery.message_id, &address);
        }
        hosted_mcp::dm_reply_hint(
            access,
            &recipient,
            &delivery.message_id,
            socket.as_deref(),
            &address,
        )
    }
}
