#!/usr/bin/env python3
"""Print the model name stored in a GGUF file's header (general.name, finetune, version), e.g. to check that an Ollama
tag holds the same model as the SGLang run. Reads only the header.
Usage: python3 gguf_name.py model.gguf
"""
import struct
import sys

SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}


def main(path):
    with open(path, 'rb') as h:
        if h.read(4) != b'GGUF':
            sys.exit('not a GGUF file')
        h.read(4)
        _, nkv = struct.unpack('<QQ', h.read(16))

        def s():
            n, = struct.unpack('<Q', h.read(8))
            return h.read(n).decode('utf-8', 'replace')

        def val(t):
            if t == 8:
                return s()
            if t == 9:
                et, = struct.unpack('<I', h.read(4)); n, = struct.unpack('<Q', h.read(8))
                for _ in range(n):
                    val(et)
                return None
            return h.read(SIZES[t])
        out = {}
        for _ in range(nkv):
            k = s(); t, = struct.unpack('<I', h.read(4)); v = val(t)
            if k in ('general.name', 'general.finetune', 'general.version'):
                out[k.split('.')[1]] = v
        print(' '.join(f'{k}={v}' for k, v in out.items()))


if __name__ == '__main__':
    main(sys.argv[1])
