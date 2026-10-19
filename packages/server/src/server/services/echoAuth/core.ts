/**
 * Echo's sign-in rules, kept free of the rest of the server so they can be
 * tested on their own (test/echoAuth.test.ts).
 *
 * Two ways in:
 *  - the server password, from the "Authorization: Bearer" header (the old
 *    ?password= query still works, for older apps and stock BlueBubbles clients);
 *  - a browser token: what Echo Web gets when it's linked with a code. Each
 *    one is separate, can be signed out here on the Mac, and can't change the
 *    password or hand out more tokens. A browser puts it in a header too,
 *    except in the links of pictures and downloads, where only a query can go.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export type Role = "owner" | "browser";

/** A browser token nobody has used yet stops working after this. */
export const UNUSED_TOKEN_MS = 30 * 60_000;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest();

/** Compares without leaking, through timing, how much of a guess was right. */
export function sameSecret(a: string, b: string): boolean {
    const x = sha256(String(a ?? "").trim());
    const y = sha256(String(b ?? "").trim());
    return crypto.timingSafeEqual(x, y);
}

/** The credential a request carries: the header first, then the old query names. */
export function credentialFrom(headers: Record<string, any>, query: Record<string, any>): string | null {
    const auth = String(headers?.authorization ?? "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    const q = query?.password ?? query?.guid ?? query?.token;
    if (Array.isArray(q)) return q[0] ?? null;
    return q ? String(q) : null;
}

/** Bytes -> url-safe base64 without padding. */
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Requests only the owner (the password) may make: a browser token can do
 * everything Echo Web needs, but can't lock you out or let itself in again.
 */
export function ownerOnly(method: string, urlPath: string): boolean {
    const p = urlPath.replace(/\/+$/, "");
    if (/\/api\/v1\/echo\/(password|browsers(\/revoke)?)$/.test(p)) return true;
    if (/\/api\/v1\/echo\/settings$/.test(p) && method !== "GET") return true;
    if (/\/api\/v1\/server\/(restart|update)/.test(p)) return true;
    return false;
}

export interface Browser {
    id: string;
    name: string;
    hash: string;
    createdAt: number;
    seenAt: number;
}

/** Linked browsers, on disk, with only a hash of each token. */
export class BrowserTokens {
    private list: Browser[] = [];

    private readonly file: string;

    constructor(file: string) {
        this.file = file;
        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            if (Array.isArray(raw)) this.list = raw.filter(b => b && b.id && b.hash);
        } catch {
            this.list = [];
        }
    }

    private save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.list), { mode: 0o600 });
        } catch {
            // Read-only disk: tokens still work until the server restarts.
        }
    }

    /** A new token for a browser called [name]. The token is only ever returned here. */
    mint(name: string, now = Date.now()): { id: string; token: string } {
        this.prune(now);
        const id = crypto.randomBytes(8).toString("hex");
        const token = "eb_" + b64url(crypto.randomBytes(32));
        this.list.push({ id, name: String(name || "Browser").slice(0, 60), hash: sha256(token).toString("hex"), createdAt: now, seenAt: 0 });
        this.save();
        return { id, token };
    }

    /** The browser [token] belongs to, marking it seen; null if it's unknown, revoked or never used in time. */
    check(token: string, now = Date.now()): Browser | null {
        if (!token || !token.startsWith("eb_")) return null;
        const hash = sha256(token).toString("hex");
        // Comparing hashes of 256-bit random tokens: timing reveals nothing usable.
        const b = this.list.find(x => x.hash === hash);
        if (!b) return null;
        if (!b.seenAt && now - b.createdAt > UNUSED_TOKEN_MS) return null;
        // Saved at most once a minute, not on every request.
        if (now - b.seenAt > 60_000) {
            b.seenAt = now;
            this.save();
        }
        return b;
    }

    all(now = Date.now()): Omit<Browser, "hash">[] {
        this.prune(now);
        return this.list.map(({ hash, ...rest }) => rest);
    }

    /** Signs out [ids], or every browser when [ids] is null. Returns how many went. */
    revoke(ids: string[] | null): number {
        const before = this.list.length;
        this.list = ids ? this.list.filter(b => !ids.includes(b.id)) : [];
        this.save();
        return before - this.list.length;
    }

    /** A browser naming itself ("Chrome on Windows") once it's linked. */
    rename(token: string, name: string, now = Date.now()): boolean {
        const b = this.check(token, now);
        if (!b) return false;
        b.name = String(name || b.name).slice(0, 60);
        this.save();
        return true;
    }

    /** A browser signing itself out: its own token stops working. */
    revokeToken(token: string, now = Date.now()): boolean {
        const b = this.check(token, now);
        return b ? this.revoke([b.id]) > 0 : false;
    }

    /** Codes that were never used are forgotten. */
    private prune(now: number) {
        const keep = this.list.filter(b => b.seenAt || now - b.createdAt <= UNUSED_TOKEN_MS);
        if (keep.length !== this.list.length) {
            this.list = keep;
            this.save();
        }
    }
}

/**
 * Who [cred] is: the owner, a linked browser, or nobody.
 */
export function roleFor(cred: string | null, password: string, browsers: BrowserTokens, now = Date.now()): Role | null {
    if (!cred) return null;
    if (password && sameSecret(cred, password)) return "owner";
    if (browsers.check(cred, now)) return "browser";
    return null;
}
