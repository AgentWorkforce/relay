//! A test signer standing in for Agent Relay Cloud's delegation key.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};

pub(crate) struct Signer {
    pair: Ed25519KeyPair,
}

impl Signer {
    pub(crate) fn new() -> Signer {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Signer {
            pair: Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap(),
        }
    }

    pub(crate) fn jwk(&self, kid: &str) -> Value {
        json!({"kty": "OKP", "crv": "Ed25519", "kid": kid, "use": "sig",
            "x": URL_SAFE_NO_PAD.encode(self.pair.public_key().as_ref())})
    }

    pub(crate) fn sign_with(&self, header: &Value, claims: &Value) -> String {
        let head = URL_SAFE_NO_PAD.encode(serde_json::to_vec(header).unwrap());
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signed = format!("{head}.{body}");
        let signature = URL_SAFE_NO_PAD.encode(self.pair.sign(signed.as_bytes()).as_ref());
        format!("{signed}.{signature}")
    }

    pub(crate) fn sign(&self, kid: &str, claims: &Value) -> String {
        self.sign_with(
            &json!({"alg": "EdDSA", "typ": "relay-delegation+jws", "kid": kid}),
            claims,
        )
    }
}
