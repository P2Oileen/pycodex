# Bundled pure Python AES-GCM

Portable encryption uses this subset through `pycodex.utils.crypto`. It needs
only Python's standard library, with no compiler, shared library, optional
crypto package or platform-specific build. Core ships a `py3-none-any` wheel.

The format remains AES-256-GCM with a 32-byte key, 12-byte nonce, 16-byte tag and
empty associated data. The existing `PCX1` layout and SHA-256 key derivation are
unchanged, so previously issued call tokens continue to work.

## Sources and licenses

- `aes.py`: the AES encryption primitive from
  [pyaes 1.6.1](https://pypi.org/project/pyaes/1.6.1/), by Richard Moore, under MIT.
  Upstream repository: https://github.com/ricmoo/pyaes.
  Source archive SHA-256:
  `02c1b1405c38d3c370b085fb952dd8bea3fadcee6411ad99f312cc129c536d8f`.
- `gcm.py`: adapted from the Google-authored `tlslite/utils/aesgcm.py` in
  [tlslite-ng 0.8.2](https://pypi.org/project/tlslite-ng/0.8.2/), under the BSD
  terms specified for Google's code in its LICENSE. That implementation derives
  GCM multiplication from Go's `crypto/cipher`.
  Upstream repository: https://github.com/tlsfuzzer/tlslite-ng.

`LICENSE` retains the applicable notices. `source-sha256.json` identifies the
original input files, before the local adaptations below.

## Local scope

- AES supports only the 256-bit key and 128-bit block used by portable.
  Decryption tables, the inverse AES primitive, other modes, padding and Python 2
  compatibility code are removed. GCM uses the AES encryption primitive in both
  directions.
- The AES S-box and T1 entries are unchanged. T2/T3/T4 are byte rotations of T1;
  their values were checked against all upstream entries. These tables are
  immutable class data. Key schedules and GCM product tables belong to each call.
- GCM retains the upstream four-bit multiplication and reduction tables. Its
  fixed nonce, tag and empty-associated-data contract removes generic TLS
  helpers. Counter processing is local and does not allocate a full keystream.
- `crypto.py` validates lengths and the GCM message-size bound. Decryption checks
  the tag with `hmac.compare_digest` before decrypting any ciphertext.

Pure Python execution is deliberately slower than native crypto, especially
for multi-megabyte bundles. These table-based Python primitives do not provide
constant-time AES/GHASH execution; constant-time tag comparison does not change
that property.

## Verification

```bash
uv sync --dev
uv run --dev pytest tests/test_crypto.py tests/test_portable.py
```

Tests cover NIST AES-256-GCM vectors, comparison with PyCryptodome, empty and
partial blocks, a 1 MiB payload, altered key/nonce/ciphertext/tag, input length
and counter bounds, authentication before decryption, and existing `PCX1`
bundles. PyCryptodome is a development-only reference dependency.

The publish workflow builds ordinary Python wheels and source distributions.
`tests/smoke_core_wheel.py` checks a clean core installation without Crypto or
Cryptodome, including portable round-trip and CLI entry points.
