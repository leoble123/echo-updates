import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import zlib from "zlib";
import { spawn } from "child_process";
import { Transform, TransformCallback, Readable } from "stream";
import Database from "better-sqlite3";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";

/**
 * Echo backup format, "ECHOBK1": chunked AES-256-GCM, so files of any size
 * can be written and read without holding them in memory.
 *
 *   header:  "ECHOBK1\n" (8) | key id (8) | nonce prefix (7)
 *   chunks:  length u32 BE (ciphertext + 16-byte tag) | ciphertext | tag
 *
 * Each chunk's 12-byte nonce is prefix (7) | counter u32 BE (4) | last flag (1),
 * so chunks can't be reordered, and a file cut short fails to decrypt instead
 * of quietly losing its end.
 */
export const MAGIC = Buffer.from("ECHOBK1\n");
const CHUNK = 4 * 1024 * 1024;

export const keyId = (key: Buffer) => crypto.createHash("sha256").update(key).digest().subarray(0, 8);

export class EncryptStream extends Transform {
    private buf: Buffer[] = [];

    private size = 0;

    private counter = 0;

    private prefix = crypto.randomBytes(7);

    constructor(private key: Buffer) {
        super();
        this.push(Buffer.concat([MAGIC, keyId(key), this.prefix]));
    }

    private seal(plain: Buffer, last: boolean) {
        const nonce = Buffer.alloc(12);
        this.prefix.copy(nonce, 0);
        nonce.writeUInt32BE(this.counter++, 7);
        nonce[11] = last ? 1 : 0;
        const c = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
        const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(body.length, 0);
        this.push(len);
        this.push(body);
    }

    _transform(chunk: Buffer, _: BufferEncoding, done: TransformCallback) {
        this.buf.push(chunk);
        this.size += chunk.length;
        while (this.size > CHUNK) {
            const all = Buffer.concat(this.buf);
            this.seal(all.subarray(0, CHUNK), false);
            const rest = all.subarray(CHUNK);
            this.buf = [rest];
            this.size = rest.length;
        }
        done();
    }

    _flush(done: TransformCallback) {
        this.seal(Buffer.concat(this.buf), true);
        done();
    }
}

/** The inverse, for tests and for restoring on a Mac. */
export const decrypt = (data: Buffer, key: Buffer): Buffer => {
    if (!data.subarray(0, 8).equals(MAGIC)) throw new Error("Not an Echo backup");
    if (!data.subarray(8, 16).equals(keyId(key))) throw new Error("This backup was made with a different key");
    const prefix = data.subarray(16, 23);
    const out: Buffer[] = [];
    let at = 23;
    let counter = 0;
    let sawLast = false;
    while (at < data.length) {
        const len = data.readUInt32BE(at);
        const body = data.subarray(at + 4, at + 4 + len);
        at += 4 + len;
        const last = at >= data.length;
        const nonce = Buffer.alloc(12);
        prefix.copy(nonce, 0);
        nonce.writeUInt32BE(counter++, 7);
        nonce[11] = last ? 1 : 0;
        const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        d.setAuthTag(body.subarray(body.length - 16));
        out.push(d.update(body.subarray(0, body.length - 16)), d.final());
        sawLast = last;
    }
    if (!sawLast) throw new Error("The backup is incomplete");
    return Buffer.concat(out);
};

type FileEntry = { rel: string; size: number; mtime: number };

/**
 * Nightly backups to the PC. The Mac keeps nothing extra on its disk: each
 * piece is packed and encrypted as the PC asks for it. The key never leaves
 * the Mac (it's shown once in Echo for Mac to keep somewhere safe), so the PC
 * only ever holds ciphertext.
 */
export class EchoBackup extends Loggable {
    tag = "EchoBackup";

    private static instance: EchoBackup;

    static get() {
        EchoBackup.instance ??= new EchoBackup();
        return EchoBackup.instance;
    }

    static messages = path.join(os.homedir(), "Library", "Messages");

    private scan: { at: number; files: FileEntry[] } = null;

    /** The backup key, made on first use. */
    async key(): Promise<Buffer> {
        const repo = Server().repo;
        let b64 = String(repo.getConfig("echo_backup_key") ?? "");
        if (!b64) {
            b64 = crypto.randomBytes(32).toString("base64");
            await repo.setConfig("echo_backup_key", b64);
        }
        return Buffer.from(b64, "base64");
    }

    /**
     * Makes the key at start-up, so Echo for Mac can show it before the first
     * backup. Echo for Mac reads it from the settings database on disk - it is
     * never served over the network, where a tunnel could reach it.
     */
    start() {
        this.key().catch(ex => this.log.debug(`Couldn't make the backup key: ${ex?.message ?? ex}`));
    }

    /** Every attachment, oldest change first (cached for ten minutes - it's a big folder). */
    files(): FileEntry[] {
        if (this.scan && Date.now() - this.scan.at < 10 * 60_000) return this.scan.files;
        const root = path.join(EchoBackup.messages, "Attachments");
        const out: FileEntry[] = [];
        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.isFile()) {
                    try {
                        const st = fs.statSync(p);
                        out.push({ rel: path.relative(EchoBackup.messages, p), size: st.size, mtime: Math.floor(st.mtimeMs) });
                    } catch {
                        /* gone since the listing */
                    }
                }
            }
        };
        walk(root);
        out.sort((a, b) => a.mtime - b.mtime || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        this.scan = { at: Date.now(), files: out };
        return out;
    }

    static cursorOf = (f: FileEntry) => `${f.mtime}:${f.rel}`;

    static after = (f: FileEntry, cursor: string) => {
        if (!cursor) return true;
        const i = cursor.indexOf(":");
        const m = Number(cursor.slice(0, i));
        const rel = cursor.slice(i + 1);
        return f.mtime > m || (f.mtime === m && f.rel > rel);
    };

    async info() {
        const files = this.files();
        let dbBytes = 0;
        try {
            dbBytes = fs.statSync(path.join(EchoBackup.messages, "chat.db")).size;
        } catch {
            /* no access */
        }
        return {
            keyId: keyId(await this.key()).toString("hex"),
            dbBytes,
            attachmentsCount: files.length,
            attachmentsBytes: files.reduce((n, f) => n + f.size, 0),
            lastPulled: Number(Server().repo.getConfig("echo_backup_last") ?? 0) || null
        };
    }

    /** A consistent snapshot of the Messages database, gzipped and encrypted. */
    async dbStream(): Promise<Readable> {
        const tmp = path.join(os.tmpdir(), `echo-backup-${Date.now()}.db`);
        const src = new Database(path.join(EchoBackup.messages, "chat.db"), { readonly: true, fileMustExist: true });
        try {
            await src.backup(tmp);
        } finally {
            src.close();
        }
        const out = fs.createReadStream(tmp).pipe(zlib.createGzip({ level: 6 })).pipe(new EncryptStream(await this.key()));
        const cleanup = (): void => fs.unlink(tmp, (): void => undefined);
        out.on("end", cleanup);
        out.on("error", cleanup);
        out.on("close", cleanup);
        return out;
    }

    /**
     * Attachments changed after [cursor], up to [maxBytes], as an encrypted tar.
     * Returns the stream and the cursor to ask from next (null when nothing's left).
     */
    async attachmentsStream(cursor: string, maxBytes: number): Promise<{ stream: Readable; next: string; count: number } | null> {
        const pending = this.files().filter(f => EchoBackup.after(f, cursor));
        if (!pending.length) return null;
        const pick: FileEntry[] = [];
        let total = 0;
        for (const f of pending) {
            if (pick.length && total + f.size > maxBytes) break;
            pick.push(f);
            total += f.size;
        }
        // Paths relative to ~/Library/Messages, so a restore puts them back where Messages looks.
        const tar = spawn("/usr/bin/tar", ["-cf", "-", "-C", EchoBackup.messages, "-T", "-"], { stdio: ["pipe", "pipe", "ignore"] });
        tar.stdin.end(pick.map(f => f.rel).join("\n") + "\n");
        const stream = tar.stdout.pipe(new EncryptStream(await this.key()));
        return { stream, next: EchoBackup.cursorOf(pick[pick.length - 1]), count: pick.length };
    }

    async markPulled() {
        await Server().repo.setConfig("echo_backup_last", String(Date.now()));
    }
}
