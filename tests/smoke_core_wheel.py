"""Check a core wheel in a clean environment, outside the source checkout."""

from importlib.util import find_spec
from pathlib import Path
import subprocess
import sys

import pycodex
from pycodex.portable import _decrypt_bundle, _encrypt_bundle
from pycodex.utils.crypto import aes_gcm_decrypt, aes_gcm_encrypt


def main():
    root = Path(__file__).resolve().parents[1]
    assert Path(pycodex.__file__).resolve().parent != root / "pycodex"
    for name in ("Cryptodome", "Crypto", "PIL", "workspace_server", "pycodex_ws"):
        assert find_spec(name) is None, name

    key, nonce = b"\0" * 32, b"\0" * 12
    ciphertext = bytes.fromhex("cea7403d4d606b6e074ec5d3baf39d18")
    tag = bytes.fromhex("d0d1c8a799996bf0265b98b5d48ab919")
    assert aes_gcm_encrypt(key, nonce, b"\0" * 16) == (ciphertext, tag)
    assert aes_gcm_decrypt(key, nonce, ciphertext, tag) == b"\0" * 16
    try:
        aes_gcm_decrypt(key, nonce, ciphertext, b"\0" * 16)
    except ValueError:
        pass
    else:
        raise AssertionError("AES-GCM accepted an invalid authentication tag")

    plaintext = bytes(range(256)) * 4096
    bundle = _encrypt_bundle(plaintext, "public wheel fixture")
    assert _decrypt_bundle(bundle, "public wheel fixture") == plaintext
    for module in ("pycodex", "pycodex.portable_server", "responses_server"):
        subprocess.run(
            [sys.executable, "-m", module, "--help"],
            check=True, stdout=subprocess.DEVNULL,
        )
    print("Core wheel: pure Python AES-GCM, portable round-trip and CLI smoke passed")


if __name__ == "__main__":
    main()
