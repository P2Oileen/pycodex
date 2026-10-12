# Copyright (c) 2008, The Chromium Authors. All rights reserved.
# Adapted from tlslite-ng 0.8.2, tlslite/utils/aesgcm.py (author: Google).
# GCM derived there from Go's crypto/cipher implementation.
# See LICENSE for the BSD license and README.md for local changes.

"""GCM for 12-byte nonces, 16-byte tags and empty associated data."""

from .aes import AES256


class AESGCM:
    # Reduction by 1+x+x^2+x^7 for each four-bit polynomial.
    _reduction = (
        0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0,
        0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0,
    )

    def __init__(self, key):
        self._aes = AES256(key)
        h = int.from_bytes(self._aes.encrypt(b"\0" * 16), "big")
        self._product_table = [0] * 16
        self._product_table[8] = h
        for i in range(2, 16, 2):
            self._product_table[self._reverse_bits(i)] = self._shift(
                self._product_table[self._reverse_bits(i // 2)]
            )
            self._product_table[self._reverse_bits(i + 1)] = (
                self._product_table[self._reverse_bits(i)] ^ h
            )

    def crypt(self, nonce, data):
        """Apply GCM's counter stream to plaintext or authenticated ciphertext."""
        output = bytearray(len(data))
        for offset in range(0, len(data), 16):
            counter = nonce + (2 + offset // 16).to_bytes(4, "big")
            mask = self._aes.encrypt(counter)
            for i, value in enumerate(data[offset:offset + 16]):
                output[offset + i] = value ^ mask[i]
        return bytes(output)

    def tag(self, nonce, ciphertext):
        """Authenticate ciphertext with empty associated data."""
        y = 0
        for offset in range(0, len(ciphertext), 16):
            block = ciphertext[offset:offset + 16].ljust(16, b"\0")
            y = self._multiply(y ^ int.from_bytes(block, "big"))
        y = self._multiply(y ^ (len(ciphertext) << 3))
        mask = self._aes.encrypt(nonce + b"\0\0\0\1")
        return (y ^ int.from_bytes(mask, "big")).to_bytes(16, "big")

    def _multiply(self, y):
        """Multiply by the GCM key in GF(2^128), four bits at a time."""
        result = 0
        for _ in range(0, 128, 4):
            high = result & 0xf
            result >>= 4
            result ^= self._reduction[high] << 112
            result ^= self._product_table[y & 0xf]
            y >>= 4
        return result

    @staticmethod
    def _reverse_bits(value):
        value = ((value << 2) & 0xc) | ((value >> 2) & 0x3)
        return ((value << 1) & 0xa) | ((value >> 1) & 0x5)

    @staticmethod
    def _shift(value):
        high = value & 1
        value >>= 1
        if high:
            value ^= 0xe1 << 120
        return value
