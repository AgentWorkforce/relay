//! Validate the recipient supplied to desktop messaging methods.

use super::*;

pub(super) fn endpoint(raw: &str) -> Result<Endpoint, RpcError> {
    Endpoint::parse(raw).map_err(|error| RpcError::invalid_params(error.to_string()))
}

/// A `to` name or an exact `address`: exactly one.
pub(super) fn recipient_endpoint(
    to: Option<&str>,
    address: Option<&str>,
) -> Result<Endpoint, RpcError> {
    match (to, address) {
        (Some(to), None) => endpoint(to),
        (None, Some(address)) => match endpoint(address)? {
            Endpoint::Address(value) => Ok(Endpoint::Address(value)),
            _ => Err(RpcError::invalid_params(
                "An address must be of the form \"agent@machine\".",
            )),
        },
        _ => Err(RpcError::invalid_params(
            "Give exactly one of to and address.",
        )),
    }
}
