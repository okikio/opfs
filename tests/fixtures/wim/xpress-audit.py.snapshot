#!/usr/bin/env python3
"""Authored MS-XCA framing audit, not a third independent native decoder.

The native fixture supplies complete decoded resource oracles before this audit.
This records the stricter end-symbol, zero-padding and exact-extent evidence.
Usage: python3 xpress-audit.py xpress-independent.json > xpress-tail-receipt.json
"""
import base64
import json
import pathlib
import sys


def audit(chunk):
    data = base64.b64decode(chunk["packed"])
    expected = base64.b64decode(chunk["decoded"])
    lengths = [(data[i // 2] >> (4 * (i % 2))) & 15 for i in range(512)]
    codes = {}
    code = 0
    for width in range(1, 16):
        for symbol, length in enumerate(lengths):
            if length == width:
                codes[width, code] = symbol
                code += 1
        code *= 2
    assert code == 65536, "The selected canonical tree must be complete"
    state = {"at": 256, "bits": 0, "value": 0}

    def ensure(count):
        while state["bits"] < count:
            at = state["at"]
            assert at + 2 <= len(data), "Truncated coding word"
            word = int.from_bytes(data[at:at + 2], "little")
            state["value"] = (state["value"] << 16) | word
            state["bits"] += 16
            state["at"] += 2

    def take(count):
        assert state["bits"] >= count
        state["bits"] -= count
        value = state["value"] >> state["bits"]
        state["value"] &= (1 << state["bits"]) - 1
        return value

    def symbol():
        ensure(16)
        code = 0
        for width in range(1, 16):
            code = (code << 1) | take(1)
            if (width, code) in codes:
                return codes[width, code]
        raise AssertionError("Invalid canonical symbol")

    def byte():
        at = state["at"]
        assert at < len(data), "Truncated interleaved length byte"
        state["at"] += 1
        return data[at]

    ensure(32)
    output = bytearray()
    extended = []
    while len(output) < len(expected):
        value = symbol()
        ensure(16)
        if value < 256:
            output.append(value)
            continue
        length, width = value & 15, (value >> 4) & 15
        # Extra lengths occupy the physical next-byte position, not the bit queue.
        if length == 15:
            extra = byte()
            length += extra
            if extra == 255:
                length = byte() | (byte() << 8)
                assert length >= 15
                extended.append(length)
        length += 3
        distance = (1 << width) + take(width)
        ensure(16)
        assert distance <= len(output)
        assert length <= len(expected) - len(output)
        for _ in range(length):
            output.append(output[-distance])
    assert output == expected, "Complete bytes differ from the native API oracle"
    end = symbol()
    ensure(16)
    assert end == 256
    assert state["at"] == len(data)
    assert state["value"] == 0
    assert 16 <= state["bits"] <= 31
    return {
        "packed": len(data), "decoded": len(output), "endSymbol": end,
        "remainingZeroBits": state["bits"], "exactExtent": True,
        "extendedU16Lengths": extended,
    }


def main():
    fixture = json.loads(pathlib.Path(sys.argv[1]).read_text())
    receipts = []
    for resource_index, resource in enumerate(fixture["nativeResources"]):
        for chunk_index, chunk in enumerate(resource["chunks"]):
            if chunk["compressed"]:
                receipts.append({"resource": resource_index, "chunk": chunk_index, **audit(chunk)})
    print(json.dumps(receipts, indent=2))


if __name__ == "__main__":
    main()
