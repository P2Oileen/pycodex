"""AES-256-GCM using a bundled pure Python implementation."""

from hmac import compare_digest

from ._aes_gcm.gcm import AESGCM


def _validate(key, nonce, data):
    if len(key) != 32:
        raise ValueError("AES-256-GCM requires a 32-byte key")
    if len(nonce) != 12:
        raise ValueError("AES-GCM requires a 12-byte nonce")
    if len(data) > (1 << 36) - 32:
        raise ValueError("AES-GCM input exceeds the maximum message length")


def aes_gcm_encrypt(key: "bytes", nonce: "bytes", plaintext: "bytes"):
    """Return ciphertext and a 16-byte authentication tag."""
    _validate(key, nonce, plaintext)
    cipher = AESGCM(key)
    ciphertext = cipher.crypt(nonce, plaintext)
    return ciphertext, cipher.tag(nonce, ciphertext)


def aes_gcm_decrypt(
    key: "bytes", nonce: "bytes", ciphertext: "bytes", tag: "bytes"
) -> "bytes":
    """Verify the authentication tag before decrypting any ciphertext."""
    _validate(key, nonce, ciphertext)
    if len(tag) != 16:
        raise ValueError("AES-GCM requires a 16-byte authentication tag")
    cipher = AESGCM(key)
    if not compare_digest(tag, cipher.tag(nonce, ciphertext)):
        raise ValueError("AES-GCM authentication failed")
    return cipher.crypt(nonce, ciphertext)
