# Capabilities Rubric

Capability cases pass when missing SDK capabilities are surfaced explicitly and early. DeliveryRunner must throw `RelayCapabilityError` with capability `messaging.capabilities.serverDeliveryState` before delivery side effects when durable server state is unavailable. Agent-scoped messaging, channel, and event operations should report RelayCapabilityError when the mock client lacks an agent client. Unsupported durable-delivery stubs should return clear unsupported results without mutating state or claiming success.
