import path from "path";
import { FileSystem } from "@server/fileSystem";
import { BrowserTokens, Role, credentialFrom, roleFor } from "./core";

export { ownerOnly } from "./core";
export type { Role } from "./core";

/**
 * The server's side of Echo's sign-in rules (see core.ts): who a request is,
 * and the linked-browser list kept in ~/Library/Application Support/bluebubbles-server/echo.
 */
export class EchoAuth {
    private static store: BrowserTokens | null = null;

    static get browsers(): BrowserTokens {
        if (!EchoAuth.store) EchoAuth.store = new BrowserTokens(path.join(FileSystem.baseDir, "echo", "browsers.json"));
        return EchoAuth.store;
    }

    /** Who an HTTP request is, or null. */
    static httpRole(password: string, headers: Record<string, any>, query: Record<string, any>): Role | null {
        return roleFor(credentialFrom(headers, query), password, EchoAuth.browsers);
    }

    /** Signs out the browser whose token this request carries. */
    static leave(headers: Record<string, any>, query: Record<string, any>): boolean {
        const cred = credentialFrom(headers, query);
        return cred ? EchoAuth.browsers.revokeToken(cred) : false;
    }

    /** Lets the browser whose token this request carries say what it is. */
    static rename(headers: Record<string, any>, query: Record<string, any>, name: string): boolean {
        const cred = credentialFrom(headers, query);
        return cred ? EchoAuth.browsers.rename(cred, name) : false;
    }

    /** Who a live-socket connection is: the handshake's auth, header or query. */
    static socketRole(password: string, handshake: any): Role | null {
        const fromAuth = handshake?.auth?.token ?? handshake?.auth?.password;
        const cred = fromAuth ? String(fromAuth) : credentialFrom(handshake?.headers ?? {}, handshake?.query ?? {});
        let decoded = cred;
        try {
            decoded = cred ? decodeURIComponent(cred) : cred;
        } catch {
            decoded = cred;
        }
        return roleFor(decoded, password, EchoAuth.browsers) ?? roleFor(cred, password, EchoAuth.browsers);
    }
}
