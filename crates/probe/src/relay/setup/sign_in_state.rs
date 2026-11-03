//! `sign_in` for `/setup/status`: attached is not enough when the core has
//! no Cloud session to act as the person (`account.needs_sign_in`).

use crate::relay::outbound::OutboundError;
use serde_json::Value;

/// Whether the account is attached but must sign in again for Cloud calls.
fn needs_sign_in(account: &Value) -> bool {
    account["state"] == "signed_in" && account["needs_sign_in"] == true
}

/// Signed in and able to call Cloud as the person; `attached` is whether
/// the account is signed in with a workspace known.
pub(super) fn ready(attached: bool, account: &Value) -> bool {
    attached && !needs_sign_in(account)
}

/// What `POST /setup/sign-in` answers without starting a sign-in, for an
/// attached account: another `workspace` is refused even while the account
/// must sign in again (renewing keeps the attached workspace), and a ready
/// one is signed in. `None` starts a sign-in.
pub(super) fn answer(
    attached: bool,
    account: &Value,
    workspace: Option<&str>,
) -> Option<Result<(), OutboundError>> {
    if !attached {
        return None;
    }
    let current = account["workspace_id"].as_str().map(str::to_lowercase);
    if workspace.is_some() && current.is_some() && workspace != current.as_deref() {
        return Some(Err(OutboundError::new(
            409,
            "workspace_mismatch",
            "This computer is signed in to another workspace. Disconnect it before switching workspaces.",
        )));
    }
    ready(attached, account).then_some(Ok(()))
}

/// `(signed_in, sign_in)` for `/setup/status`.
pub(super) fn reported(attached: bool, account: &Value) -> (bool, String) {
    let state = match (ready(attached, account), needs_sign_in(account)) {
        (true, _) => "signed_in",
        (false, true) => "needs_sign_in",
        (false, false) => account["state"].as_str().unwrap_or("signed_out"),
    };
    (ready(attached, account), state.to_string())
}

/// Copies the device sign-in link fields (URL, code, expiry, poll interval)
/// from the account status into a setup answer.
pub(super) fn copy_sign_in_link(account: &Value, result: &mut Value) {
    for key in [
        "verification_url",
        "verification_url_complete",
        "user_code",
        "expires_at",
        "interval",
    ] {
        result[key] = account[key].clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_account_without_a_usable_session_needs_to_sign_in_again() {
        let fine = json!({"state": "signed_in"});
        assert_eq!(reported(true, &fine), (true, "signed_in".into()));
        let stale = json!({"state": "signed_in", "needs_sign_in": true});
        assert_eq!(reported(true, &stale), (false, "needs_sign_in".into()));
        assert!(!ready(true, &stale));
        let pending = json!({"state": "pending_approval", "needs_sign_in": true});
        assert_eq!(
            reported(false, &pending),
            (false, "pending_approval".into())
        );
        assert_eq!(reported(false, &json!({})), (false, "signed_out".into()));
    }

    #[test]
    fn another_workspace_is_refused_even_while_signing_in_again() {
        let a = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
        let b = "7d1f3f0e-8a32-4c55-9a0e-5a7f3e6b2c10";
        let stale = json!({"state": "signed_in", "workspace_id": a, "needs_sign_in": true});
        let refused = answer(true, &stale, Some(b)).unwrap().unwrap_err();
        assert_eq!(refused.code, "workspace_mismatch");
        // The same workspace, or none named, renews the sign-in.
        assert!(answer(true, &stale, Some(a)).is_none());
        assert!(answer(true, &stale, None).is_none());
        let fine = json!({"state": "signed_in", "workspace_id": a});
        assert!(answer(true, &fine, Some(a)).unwrap().is_ok());
        assert!(answer(true, &fine, Some(b)).unwrap().is_err());
        assert!(answer(false, &fine, Some(b)).is_none());
    }
}
