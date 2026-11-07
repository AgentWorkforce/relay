//! The account's report: what `status.account` and the `sign_in` topic carry.

use crate::relay::state::AccountStatus;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// `account.status`, `account.sign_in` and the `sign_in` topic: the account
/// plus the link waiting for the person, if any.
#[derive(Clone, Debug, Default, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct SignInReport {
    #[serde(flatten)]
    pub account: AccountStatus,
    #[serde(flatten)]
    pub link: SignInLink,
}

/// The page a sign-in waits on; every field is null when none is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct SignInLink {
    pub verification_url: Option<String>,
    /// What the UI opens: the link with the code filled in.
    pub verification_url_complete: Option<String>,
    pub user_code: Option<String>,
    /// ISO-8601.
    pub expires_at: Option<String>,
    /// Seconds between device-approval polls.
    pub interval: Option<u64>,
}
