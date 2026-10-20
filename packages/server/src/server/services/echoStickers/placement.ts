/**
 * Where a sticker sits on the bubble it was dropped on.
 *
 * Messages keeps it in the attachment's `sticker_user_info`: a binary plist
 * with the sticker's centre as a fraction of the bubble (`sxs`, `sys`), its
 * scale (`ssa`), rotation in radians (`sro`) and the bubble's width in points
 * on the device that placed it (`spw`). Without it a phone can only guess,
 * which is how stickers ended up as tiny badges instead of where they were put.
 *
 * Kept free of the rest of the server so it can be tested on its own
 * (test/stickerPlacement.test.ts).
 */

export interface StickerPlacement {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    bubbleWidth: number;
}

/** The placement in [info], or null when there isn't one (or it can't be read). */
export function stickerPlacement(info: Buffer | Uint8Array | null | undefined): StickerPlacement | null {
    if (!info || info.length < 40) return null;
    let root: any;
    try {
        root = parseBplist(Buffer.from(info));
    } catch {
        return null;
    }
    root = unarchive(root);
    if (!root || typeof root !== "object") return null;
    const num = (k: string): number | null => {
        const v = root[k];
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        return Number.isFinite(n) ? n : null;
    };
    const x = num("sxs");
    const y = num("sys");
    if (x == null || y == null) return null;
    return {
        x,
        y,
        scale: num("ssa") ?? 1,
        rotation: num("sro") ?? 0,
        bubbleWidth: num("spw") ?? 0
    };
}

/**
 * The dictionary inside an NSKeyedArchiver archive, or [plist] itself when it
 * isn't one. Messages has stored sticker info both ways across macOS versions.
 */
export function unarchive(plist: any): any {
    if (!plist || !Array.isArray(plist.$objects) || !plist.$top) return plist;
    const objects: any[] = plist.$objects;
    const deref = (v: any): any => (v && typeof v === "object" && "$uid" in v ? objects[v.$uid] : v);
    const top = deref(plist.$top.root ?? Object.values(plist.$top)[0]);
    if (top && Array.isArray(top["NS.keys"]) && Array.isArray(top["NS.objects"])) {
        const out: Record<string, any> = {};
        top["NS.keys"].forEach((k: any, i: number) => {
            out[String(deref(k))] = deref(top["NS.objects"][i]);
        });
        return out;
    }
    return top;
}

/**
 * A minimal reader for Apple's binary plist (bplist00): dictionaries, arrays,
 * strings, numbers, booleans, dates and data - everything sticker info uses.
 */
export function parseBplist(buf: Buffer): any {
    if (buf.length < 40 || buf.toString("ascii", 0, 8) !== "bplist00") throw new Error("not a binary plist");
    const trailer = buf.length - 32;
    const offsetSize = buf.readUInt8(trailer + 6);
    const refSize = buf.readUInt8(trailer + 7);
    const numObjects = Number(buf.readBigUInt64BE(trailer + 8));
    const topObject = Number(buf.readBigUInt64BE(trailer + 16));
    const tableOffset = Number(buf.readBigUInt64BE(trailer + 24));
    if (numObjects > 100_000) throw new Error("too many objects");

    const readUInt = (at: number, size: number): number => {
        let v = 0;
        for (let i = 0; i < size; i++) v = v * 256 + buf.readUInt8(at + i);
        return v;
    };
    const offsetOf = (ref: number) => readUInt(tableOffset + ref * offsetSize, offsetSize);

    const seen = new Set<number>();
    const read = (ref: number): any => {
        if (ref >= numObjects) throw new Error("bad reference");
        if (seen.has(ref)) throw new Error("cycle");
        seen.add(ref);
        try {
            return readObject(offsetOf(ref));
        } finally {
            seen.delete(ref);
        }
    };

    // The length of a container or string: inline in the marker, or a following int.
    const lengthAt = (at: number, low: number): [number, number] => {
        if (low !== 0xf) return [low, at + 1];
        const marker = buf.readUInt8(at + 1);
        const size = 1 << (marker & 0xf);
        return [readUInt(at + 2, size), at + 2 + size];
    };

    const readObject = (at: number): any => {
        const marker = buf.readUInt8(at);
        const high = marker >> 4;
        const low = marker & 0xf;
        switch (high) {
            case 0x0:
                if (low === 0x8) return false;
                if (low === 0x9) return true;
                return null;
            case 0x1: {
                const size = 1 << low;
                if (size === 8) return Number(buf.readBigInt64BE(at + 1));
                return readUInt(at + 1, size);
            }
            case 0x2:
                return low === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
            case 0x3:
                return new Date(Date.UTC(2001, 0, 1) + buf.readDoubleBE(at + 1) * 1000);
            case 0x8:
                // A keyed archive's object reference.
                return { $uid: readUInt(at + 1, low + 1) };
            case 0x4: {
                const [len, start] = lengthAt(at, low);
                return buf.subarray(start, start + len);
            }
            case 0x5: {
                const [len, start] = lengthAt(at, low);
                return buf.toString("ascii", start, start + len);
            }
            case 0x6: {
                const [len, start] = lengthAt(at, low);
                const chars: string[] = [];
                for (let i = 0; i < len; i++) chars.push(String.fromCharCode(buf.readUInt16BE(start + i * 2)));
                return chars.join("");
            }
            case 0xa: {
                const [len, start] = lengthAt(at, low);
                const out: any[] = [];
                for (let i = 0; i < len; i++) out.push(read(readUInt(start + i * refSize, refSize)));
                return out;
            }
            case 0xd: {
                const [len, start] = lengthAt(at, low);
                const out: Record<string, any> = {};
                for (let i = 0; i < len; i++) {
                    const key = read(readUInt(start + i * refSize, refSize));
                    out[String(key)] = read(readUInt(start + (len + i) * refSize, refSize));
                }
                return out;
            }
            default:
                return null;
        }
    };

    return read(topObject);
}
