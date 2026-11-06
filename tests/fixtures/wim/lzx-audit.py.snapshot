#!/usr/bin/env python3
"""Authored WIM LZX grammar audit against pre-established native byte oracles.

This is research evidence, not a third independent native implementation.
Usage: python3 lzx-audit.py lzx-independent.json > lzx-tail-receipt.json
"""
import base64
import json
import pathlib
import struct
import sys


class Bits:
    def __init__(self, data):
        self.data = data
        self.position = 0
        self.count = 0
        self.value = 0

    def read(self, count):
        while self.count < count:
            assert self.position + 2 <= len(self.data), "Truncated LZX coding word"
            self.value = (self.value << 16) | int.from_bytes(self.data[self.position:self.position + 2], "little")
            self.position += 2
            self.count += 16
        self.count -= count
        value = self.value >> self.count
        self.value &= (1 << self.count) - 1
        return value

    def align_raw(self):
        # Even an already aligned raw header discards the next complete coding word.
        if not self.count:
            assert self.read(16) == 0
        else:
            assert self.value == 0, "Nonzero raw-header alignment"
        self.count = self.value = 0

    def raw(self, length):
        assert self.count == 0
        end = self.position + length
        assert end <= len(self.data), "Truncated raw data"
        result = self.data[self.position:end]
        self.position = end
        return result


def tree(lengths, maximum):
    result = {}
    code = 0
    for width in range(1, maximum + 1):
        for symbol, length in enumerate(lengths):
            if width == length:
                result[width, code] = symbol
                code += 1
        assert code <= 1 << width, "Oversubscribed canonical tree"
        code *= 2
    assert not code or code == 1 << (maximum + 1), "Incomplete nonempty tree"
    return result


def symbol(bits, codes, maximum):
    assert codes, "An empty tree cannot supply a symbol"
    code = 0
    for width in range(1, maximum + 1):
        code = (code << 1) | bits.read(1)
        if (width, code) in codes:
            return codes[width, code]
    raise AssertionError("Invalid canonical symbol")


def lengths(bits, target, start, stop):
    pretree = tree([bits.read(4) for _ in range(20)], 15)
    at = start
    while at < stop:
        value = symbol(bits, pretree, 15)
        if value < 17:
            target[at] = (target[at] - value) % 17
            at += 1
            continue
        if value == 17:
            run, length = 4 + bits.read(4), 0
        elif value == 18:
            run, length = 20 + bits.read(5), 0
        else:
            run = 4 + bits.read(1)
            delta = symbol(bits, pretree, 15)
            assert delta <= 16, "MS-PATCH nested pretree code must be in 0..16"
            length = (target[at] - delta) % 17
        assert run <= stop - at, "Pretree run crosses its declared alphabet"
        target[at:at + run] = [length] * run
        at += run


def audit(chunk):
    data, expected = base64.b64decode(chunk["packed"]), base64.b64decode(chunk["decoded"])
    bits = Bits(data)
    output = bytearray()
    recent = [1, 1, 1]
    main_lengths, length_lengths = [0] * 496, [0] * 249
    blocks, uses = [], {"repeated": 0, "explicit": 0, "aligned": 0}
    while len(output) < len(expected):
        assert len(blocks) < 1024
        block_type, default = bits.read(3), bits.read(1)
        size = 32768 if default else bits.read(16)
        assert 0 < size <= len(expected) - len(output), "Block size exceeds remaining chunk output"
        blocks.append({"type": block_type, "defaultSizeBit": default, "decoded": size})
        if block_type == 3:
            bits.align_raw()
            recent = list(struct.unpack("<III", bits.raw(12)))
            assert all(recent)
            output.extend(bits.raw(size))
            if size & 1:
                assert bits.raw(1) == b"\0", "Nonzero odd raw-block pad"
            continue
        assert block_type in [1, 2]
        aligned = tree([bits.read(3) for _ in range(8)], 7) if block_type == 2 else {}
        lengths(bits, main_lengths, 0, 256)
        lengths(bits, main_lengths, 256, 496)
        lengths(bits, length_lengths, 0, 249)
        main_tree, length_tree = tree(main_lengths, 16), tree(length_lengths, 16)
        end = len(output) + size
        while len(output) < end:
            value = symbol(bits, main_tree, 16)
            if value < 256:
                output.append(value)
                continue
            slot, length = (value - 256) // 8, value & 7
            if length == 7:
                length += symbol(bits, length_tree, 16)
            length += 2
            if slot < 3:
                uses["repeated"] += 1
                distance = recent[slot]
                recent[slot] = recent[0]
            else:
                uses["explicit"] += 1
                extra = 0 if slot < 4 else slot // 2 - 1
                base = slot - 2 if slot < 4 else ((2 + (slot & 1)) << extra) - 2
                if block_type == 2 and slot >= 8:
                    uses["aligned"] += 1
                    distance = (bits.read(extra - 3) << 3) + symbol(bits, aligned, 7) + base
                else:
                    distance = bits.read(extra) + base
                recent[2], recent[1] = recent[1], recent[0]
            recent[0] = distance
            assert 0 < distance <= len(output), "Match precedes this chunk"
            assert length <= end - len(output), "Match crosses its block"
            for _ in range(length):
                output.append(output[-distance])
    assert bits.position == len(data), "Trailing packed bytes"
    assert 0 <= bits.count <= 15 and bits.value == 0, "Nonzero final word alignment"
    transformed = base64.b64encode(output).decode()
    at, translated = 0, []
    while at < len(output) - 10:
        if output[at] != 0xe8:
            at += 1
            continue
        absolute = struct.unpack_from("<i", output, at + 1)[0]
        relative = absolute
        if 0 <= absolute < 12000000:
            relative = absolute - at
        elif -at <= absolute < 0:
            relative = absolute + 12000000
        if relative != absolute:
            struct.pack_into("<i", output, at + 1, relative)
            translated.append(at)
        at += 5
    assert output == expected, "Full bytes differ from independently established native resource oracle"
    return {"packed": len(data), "decoded": len(output), "blocks": blocks, "uses": uses,
            "remainingZeroBits": bits.count, "exactExtent": True,
            "e8TranslatedPositions": translated, "beforeE8": transformed}


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
