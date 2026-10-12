import hashlib
import sys

import pytest
from Cryptodome.Cipher import AES

from pycodex.portable.client import _decrypt_bundle
from pycodex.utils import crypto


@pytest.mark.parametrize(
    "size", [0, 1, 15, 16, 17, 31, 32, 63, 64, 65, 255, 4096, 65536, 1048576]
)
def test_aes_gcm_matches_pycryptodome(size):
    key = hashlib.sha256(("public fixture " + str(size)).encode("ascii")).digest()
    nonce = bytes(range(12))
    plaintext = b"0123456789abcdef" * (size // 16) + b"x" * (size % 16)
    ciphertext, tag = crypto.aes_gcm_encrypt(key, nonce, plaintext)
    reference = AES.new(key, AES.MODE_GCM, nonce=nonce)

    assert (ciphertext, tag) == reference.encrypt_and_digest(plaintext)
    assert crypto.aes_gcm_decrypt(key, nonce, ciphertext, tag) == plaintext


@pytest.mark.parametrize(
    "plaintext,ciphertext,tag",
    [
        ("", "", "530f8afbc74536b9a963b4f1c4cb738b"),
        (
            "00000000000000000000000000000000",
            "cea7403d4d606b6e074ec5d3baf39d18",
            "d0d1c8a799996bf0265b98b5d48ab919",
        ),
    ],
)
def test_aes256_gcm_nist_vectors(plaintext, ciphertext, tag):
    key, nonce = b"\0" * 32, b"\0" * 12
    plaintext = bytes.fromhex(plaintext)
    expected = bytes.fromhex(ciphertext), bytes.fromhex(tag)

    assert crypto.aes_gcm_encrypt(key, nonce, plaintext) == expected
    assert crypto.aes_gcm_decrypt(key, nonce, *expected) == plaintext


@pytest.mark.parametrize("field", ["key", "nonce", "ciphertext", "tag"])
def test_aes_gcm_rejects_modified_input(field):
    key, nonce = bytes(range(32)), bytes(range(12))
    ciphertext, tag = crypto.aes_gcm_encrypt(key, nonce, b"public tamper fixture")
    values = dict(key=key, nonce=nonce, ciphertext=ciphertext, tag=tag)
    data = values[field]
    values[field] = bytes([data[0] ^ 1]) + data[1:]

    with pytest.raises(ValueError, match="authentication failed"):
        crypto.aes_gcm_decrypt(**values)


@pytest.mark.parametrize(
    "field,size", [("key", 31), ("key", 33), ("nonce", 11), ("nonce", 13)]
)
def test_aes_gcm_validates_fixed_input_lengths(field, size):
    values = dict(key=b"\0" * 32, nonce=b"\0" * 12)
    values[field] = b"\0" * size

    with pytest.raises(ValueError, match="requires"):
        crypto.aes_gcm_encrypt(plaintext=b"", **values)
    with pytest.raises(ValueError, match="requires"):
        crypto.aes_gcm_decrypt(ciphertext=b"", tag=b"\0" * 16, **values)


@pytest.mark.parametrize("size", [0, 15, 17])
def test_aes_gcm_validates_tag_length(size):
    with pytest.raises(ValueError, match="16-byte authentication tag"):
        crypto.aes_gcm_decrypt(b"\0" * 32, b"\0" * 12, b"", b"\0" * size)


def test_pure_python_reads_existing_pcx1_bundle():
    payload = bytes.fromhex(
        "504358310102030405060708090a0b0c"
        "2004edae54e18f2c48447f711fdd00463e2d5c71a941e6aef0b7925d4b237e7359140c71a1ec816b"
    )

    assert _decrypt_bundle(payload, "legacy-test-secret") == b"legacy encrypted payload"


def test_aes_gcm_authenticates_before_decrypting(monkeypatch):
    def reject_decryption(self, nonce, data):
        raise AssertionError("unauthenticated ciphertext reached decryption")

    monkeypatch.setattr(crypto.AESGCM, "crypt", reject_decryption)
    with pytest.raises(ValueError, match="authentication failed"):
        crypto.aes_gcm_decrypt(b"\0" * 32, b"\0" * 12, b"untrusted", b"\0" * 16)


@pytest.mark.skipif(
    sys.maxsize < (1 << 36), reason="GCM limit exceeds this Python's maximum object size"
)
def test_aes_gcm_rejects_input_that_would_exhaust_the_counter():
    class OversizedInput:
        def __len__(self):
            return 1 << 36

    with pytest.raises(ValueError, match="maximum message length"):
        crypto.aes_gcm_encrypt(b"\0" * 32, b"\0" * 12, OversizedInput())
    with pytest.raises(ValueError, match="maximum message length"):
        crypto.aes_gcm_decrypt(b"\0" * 32, b"\0" * 12, OversizedInput(), b"\0" * 16)
