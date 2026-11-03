//! Contractor access: owner grants of scoped service access to seats.

use crate::relay::contractor_access::{ContractorAvailability, Role, Scope, Service};
use crate::relay::protocol::RpcError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// `contractors.status`: the cache of what Cloud last said. Owner-only
/// lists are empty for everyone else.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ContractorStatus {
    pub enabled: bool,
    pub availability: ContractorAvailability,
    /// Why the last refresh failed.
    pub failure: Option<RpcError>,
    pub role: Option<Role>,
    /// This person's own grant.
    pub grant: Option<AccessGrant>,
    /// Members without a grant, not dismissed here.
    pub pending_seats: Vec<PendingSeat>,
    pub services: Vec<Service>,
    pub grants: Vec<AccessGrant>,
    pub provisioning: Provisioning,
}

/// An approved grant: one seat's scoped access, only the scopes that grant
/// something.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct AccessGrant {
    pub id: String,
    pub user_id: String,
    pub display_name: Option<String>,
    pub description: String,
    pub scopes: Vec<Scope>,
    pub granted_by: Option<String>,
    pub created_at_ms: Option<i64>,
}

/// A workspace member who could be granted access.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct PendingSeat {
    pub user_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub identity_hash: String,
    /// Cloud's role, lowercased.
    pub role: String,
    pub joined_at_ms: Option<i64>,
}

/// What the seat-scoped token provider holds for this person's grant.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct Provisioning {
    pub grant_id: Option<String>,
    pub failed: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ProposeParams {
    pub user_id: String,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ApproveParams {
    pub user_id: String,
    pub description: String,
    pub scopes: Vec<Scope>,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct GrantResult {
    pub grant: AccessGrant,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct RevokeParams {
    pub grant_id: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct DismissParams {
    pub user_id: String,
}
