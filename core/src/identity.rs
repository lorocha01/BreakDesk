//! Device identity: a persistent Ed25519 key pair. The private key never leaves this module.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use std::path::Path;

const KEY_FILE: &str = "device.key";

pub struct Identity {
    key: SigningKey,
}

impl Identity {
    /// Loads `<dir>/device.key` (32-byte seed, base64) or creates it with restrictive permissions.
    pub fn load_or_create(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let path = dir.join(KEY_FILE);
        if path.exists() {
            let txt = std::fs::read_to_string(&path)?;
            let raw = B64
                .decode(txt.trim())
                .context("device.key is not valid base64")?;
            let seed: [u8; 32] = raw
                .try_into()
                .map_err(|_| anyhow!("device.key must hold 32 bytes"))?;
            return Ok(Self {
                key: SigningKey::from_bytes(&seed),
            });
        }
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        write_private(&path, B64.encode(key.to_bytes()).as_bytes())?;
        Ok(Self { key })
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    pub fn public_key_b64(&self) -> String {
        B64.encode(self.public_key_bytes())
    }

    pub fn fingerprint(&self) -> String {
        fingerprint(&self.public_key_bytes())
    }

    /// Signs the UTF-8 bytes of `message`; returns base64 signature.
    pub fn sign(&self, message: &str) -> String {
        B64.encode(self.key.sign(message.as_bytes()).to_bytes())
    }
}

fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(data)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // On Windows the per-user app data directory is already ACL-restricted to the user.
        std::fs::write(path, data)?;
        Ok(())
    }
}

/// `SHA-256(pub)` → uppercase hex → first 32 chars → groups of 4 joined by ':'.
pub fn fingerprint(public_key: &[u8]) -> String {
    let hex = hex::encode_upper(Sha256::digest(public_key));
    hex.as_bytes()[..32]
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join(":")
}

pub fn fingerprint_b64(public_key_b64: &str) -> Result<String> {
    Ok(fingerprint(&B64.decode(public_key_b64)?))
}

/// Verifies a base64 Ed25519 signature over UTF-8 `message` with a base64 public key.
pub fn verify(public_key_b64: &str, message: &str, signature_b64: &str) -> bool {
    let Ok(pk) = B64.decode(public_key_b64) else {
        return false;
    };
    let Ok(pk): Result<[u8; 32], _> = pk.try_into() else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    let Ok(sig) = B64.decode(signature_b64) else {
        return false;
    };
    let Ok(sig): Result<[u8; 64], _> = sig.try_into() else {
        return false;
    };
    vk.verify(message.as_bytes(), &Signature::from_bytes(&sig))
        .is_ok()
}

/// Message signed to obtain a device token (§2).
pub fn auth_message(nonce: &str, device_id: &str) -> String {
    format!("nexo-auth-v1:{nonce}:{device_id}")
}

/// Message signed over an SDP offer/answer (§4).
pub fn sdp_message(session_id: &str, kind: &str, sdp: &str) -> String {
    format!("nexo-sdp-v1:{session_id}:{kind}:{sdp}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_format_and_vector() {
        // SHA-256 of 32 zero bytes = 66687AADF862BD776C8FC18B8E9F8E20089714856EE233B3902A591D0D5F2925
        let fp = fingerprint(&[0u8; 32]);
        assert_eq!(fp, "6668:7AAD:F862:BD77:6C8F:C18B:8E9F:8E20");
        assert_eq!(fp.len(), 39);
    }

    #[test]
    fn sign_verify_roundtrip_and_tamper() {
        let id = Identity::from_seed([7u8; 32]);
        let msg = sdp_message("sess", "answer", "v=0\r\n");
        let sig = id.sign(&msg);
        assert!(verify(&id.public_key_b64(), &msg, &sig));
        assert!(!verify(&id.public_key_b64(), &format!("{msg}x"), &sig));
        let other = Identity::from_seed([8u8; 32]);
        assert!(!verify(&other.public_key_b64(), &msg, &sig));
        assert!(!verify("not-base64", &msg, &sig));
        assert_eq!(
            auth_message("bm9uY2U=", "123456789"),
            "nexo-auth-v1:bm9uY2U=:123456789"
        );
    }

    #[test]
    fn rfc8032_test_vector_1() {
        // RFC 8032 §7.1 TEST 1 (empty message)
        let seed: [u8; 32] =
            hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                .unwrap()
                .try_into()
                .unwrap();
        let id = Identity::from_seed(seed);
        assert_eq!(
            hex::encode(id.public_key_bytes()),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        let sig = B64.decode(id.sign("")).unwrap();
        assert_eq!(
            hex::encode(sig),
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        );
    }

    #[test]
    fn persists_key() {
        let dir = tempfile::tempdir().unwrap();
        let a = Identity::load_or_create(dir.path()).unwrap();
        let b = Identity::load_or_create(dir.path()).unwrap();
        assert_eq!(a.public_key_b64(), b.public_key_b64());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(KEY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
