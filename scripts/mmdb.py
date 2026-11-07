"""Minimal pure-Python reader for MaxMind DB (.mmdb) files, such as DB-IP's free City/ASN Lite
databases, so ./stats.sh needs no pip installs. Format spec: https://maxmind.github.io/MaxMind-DB/
Usage: Reader(path).get("8.8.8.8") -> dict or None
"""
import ipaddress
import mmap
import struct

_META = b"\xab\xcd\xefMaxMind.com"


class Reader:
    def __init__(self, path):
        with open(path, "rb") as f:
            self._buf = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        at = self._buf.rfind(_META)
        if at < 0:
            raise ValueError(f"{path}: not a MaxMind DB file")
        self._data_start = 0  # metadata pointers (if any) are relative to the metadata section
        self.metadata, _ = self._decode(at + len(_META), base=at + len(_META))
        self._nodes = self.metadata["node_count"]
        self._rsize = self.metadata["record_size"]
        tree_size = self._rsize * 2 // 8 * self._nodes
        self._data_start = tree_size + 16
        self._v4_start = None

    # ---- search tree ---------------------------------------------------------------------
    def _record(self, node, bit):
        b, rs = self._buf, self._rsize
        off = node * rs * 2 // 8
        if rs == 24:
            o = off + bit * 3
            return int.from_bytes(b[o:o + 3], "big")
        if rs == 28:
            mid = b[off + 3]
            if bit == 0:
                return ((mid & 0xF0) << 20) | int.from_bytes(b[off:off + 3], "big")
            return ((mid & 0x0F) << 24) | int.from_bytes(b[off + 4:off + 7], "big")
        if rs == 32:
            o = off + bit * 4
            return int.from_bytes(b[o:o + 4], "big")
        raise ValueError(f"unsupported record size {rs}")

    def _ipv4_start(self):
        if self._v4_start is None:
            node = 0
            if self.metadata.get("ip_version") == 6:
                for _ in range(96):
                    if node >= self._nodes:
                        break
                    node = self._record(node, 0)
            self._v4_start = node
        return self._v4_start

    def get(self, ip):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return None
        if addr.version == 6 and self.metadata.get("ip_version") == 4:
            return None
        packed = addr.packed
        node = self._ipv4_start() if addr.version == 4 else 0
        for i in range(len(packed) * 8):
            if node >= self._nodes:
                break
            node = self._record(node, (packed[i >> 3] >> (7 - (i & 7))) & 1)
        if node <= self._nodes:
            return None  # == node_count means "no data"; < means we ran out of bits inside the tree
        value, _ = self._decode(node - self._nodes - 16 + self._data_start, base=self._data_start)
        return value

    # ---- data section --------------------------------------------------------------------
    def _decode(self, off, base):
        b = self._buf
        ctrl = b[off]
        off += 1
        typ = ctrl >> 5
        if typ == 1:  # pointer: follow it, but continue after the pointer itself
            ss, vvv = (ctrl >> 3) & 3, ctrl & 7
            if ss == 0:
                p, off = (vvv << 8) | b[off], off + 1
            elif ss == 1:
                p, off = ((vvv << 16) | int.from_bytes(b[off:off + 2], "big")) + 2048, off + 2
            elif ss == 2:
                p, off = ((vvv << 24) | int.from_bytes(b[off:off + 3], "big")) + 526336, off + 3
            else:
                p, off = int.from_bytes(b[off:off + 4], "big"), off + 4
            value, _ = self._decode(base + p, base)
            return value, off
        if typ == 0:  # extended type
            typ, off = 7 + b[off], off + 1
        size = ctrl & 0x1F
        if size == 29:
            size, off = 29 + b[off], off + 1
        elif size == 30:
            size, off = 285 + int.from_bytes(b[off:off + 2], "big"), off + 2
        elif size == 31:
            size, off = 65821 + int.from_bytes(b[off:off + 3], "big"), off + 3

        if typ == 2:  # utf-8 string
            return b[off:off + size].decode("utf-8", "replace"), off + size
        if typ == 3:  # double
            return struct.unpack(">d", b[off:off + 8])[0], off + 8
        if typ == 4:  # bytes
            return bytes(b[off:off + size]), off + size
        if typ in (5, 6, 9, 10):  # unsigned ints
            return int.from_bytes(b[off:off + size], "big"), off + size
        if typ == 8:  # int32
            raw = int.from_bytes(b[off:off + size], "big")
            if size == 4 and raw >= 1 << 31:
                raw -= 1 << 32
            return raw, off + size
        if typ == 7:  # map
            out = {}
            for _ in range(size):
                k, off = self._decode(off, base)
                out[k], off = self._decode(off, base)
            return out, off
        if typ == 11:  # array
            out = []
            for _ in range(size):
                v, off = self._decode(off, base)
                out.append(v)
            return out, off
        if typ == 14:  # boolean, value is the size
            return bool(size), off
        if typ == 15:  # float
            return struct.unpack(">f", b[off:off + 4])[0], off + 4
        raise ValueError(f"unsupported mmdb data type {typ} at {off}")
