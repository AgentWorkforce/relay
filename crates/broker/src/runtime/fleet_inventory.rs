//! Desired inventory and its last successful FIFO command enqueue. Failed
//! publication retains state; every mutation is compared with the actual last
//! enqueued snapshot, including changes that reverse before maintenance runs.
use super::*;
#[derive(Default, Debug)]
pub(super) struct FleetInventory {
    agents: HashMap<WorkerName, InventoryAgent>,
    published: std::sync::Mutex<Option<Value>>,
}
impl FleetInventory {
    pub(super) fn new() -> Self {
        Self::default()
    }
    #[cfg(test)]
    pub(super) fn from(agents: impl Into<HashMap<WorkerName, InventoryAgent>>) -> Self {
        Self {
            agents: agents.into(),
            published: Default::default(),
        }
    }
    pub(super) fn try_publish(
        &self,
        tx: &mpsc::Sender<FleetControlCommand>,
    ) -> Result<(), &'static str> {
        self.try_publish_snapshot(tx, self.agents.values().cloned().collect())
    }
    pub(super) fn try_publish_snapshot(
        &self,
        tx: &mpsc::Sender<FleetControlCommand>,
        snapshot: Vec<InventoryAgent>,
    ) -> Result<(), &'static str> {
        let fingerprint = serde_json::to_value(&snapshot).expect("inventory serializes");
        tx.try_send(FleetControlCommand::UpdateInventory(snapshot))
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => "fleet_control_backpressure",
                mpsc::error::TrySendError::Closed(_) => "fleet_control_unavailable",
            })?;
        *self.published.lock().unwrap() = Some(fingerprint);
        Ok(())
    }
    pub(super) fn needs_publication(&self) -> bool {
        let snapshot: Vec<_> = self.agents.values().collect();
        self.published.lock().unwrap().as_ref()
            != Some(&serde_json::to_value(snapshot).expect("inventory serializes"))
    }
}
impl std::ops::Deref for FleetInventory {
    type Target = HashMap<WorkerName, InventoryAgent>;
    fn deref(&self) -> &Self::Target {
        &self.agents
    }
}
impl std::ops::DerefMut for FleetInventory {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.agents
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn failed_reverse_change_retries_against_last_actual_publication() {
        let (tx, mut rx) = mpsc::channel(1);
        let mut inventory = FleetInventory::new();
        super::super::fleet::publish_fleet_inventory_snapshot(&tx, &inventory).await;
        rx.recv().await.unwrap();
        assert!(!inventory.needs_publication());
        inventory.insert(
            "worker".into(),
            InventoryAgent {
                agent_id: "identity".into(),
                name: "worker".into(),
                invocation_id: None,
                session_ref: None,
            },
        );
        super::super::fleet::publish_fleet_inventory_snapshot(&tx, &inventory).await;
        assert!(!inventory.needs_publication());
        inventory.clear(); // Back to the earlier empty A, after B was enqueued.
        super::super::fleet::publish_fleet_inventory_snapshot(&tx, &inventory).await;
        assert!(
            inventory.needs_publication(),
            "failed A must retry even though an older A once succeeded"
        );
        rx.recv().await.unwrap();
        super::super::fleet::publish_fleet_inventory_snapshot(&tx, &inventory).await;
        assert!(!inventory.needs_publication());
        assert!(
            matches!(rx.recv().await, Some(FleetControlCommand::UpdateInventory(rows)) if rows.is_empty())
        );
    }
}
