import { EchoAddress } from "@server/services/echoAddress";
import { RouterContext } from "koa-router";
import { Next } from "koa";
import { app } from "electron";
import axios from "axios";
import os from "os";
import crypto from "crypto";
import { Server } from "@server";
import { EchoGuard } from "@server/services/echoGuard";
import { EchoPush } from "@server/services/echoPush";
import { EchoPhone } from "@server/services/echoPhone";
import { EchoAI } from "@server/services/echoAI";
import { EchoMacApps } from "@server/services/echoMacApps";
import { EchoHandoff } from "@server/services/echoHandoff";
import { EchoTyping } from "@server/services/echoTyping";
import { EchoSearch } from "@server/services/echoSearch";
import { EchoBackup } from "@server/services/echoBackup";
import { EchoRemote } from "@server/services/echoRemote";
import { EchoAuth } from "@server/services/echoAuth";
import { wrapped } from "@server/services/echoWrapped";
import fs from "fs";
import { FileStream, Success } from "../responses/success";
import { BadRequest } from "../responses/errors";

type Preview = { url: string; title?: string; description?: string; image?: string; site?: string; icon?: string };

const previews = new Map<string, { at: number; value: Preview }>();
const PREVIEW_TTL = 6 * 3600_000;

/** Echo-only endpoints: health, Web Push and link previews. */
export class EchoRouter {
    /** A token for a browser being linked (Echo Web). Owner only; returned once. */
    static async mintBrowser(ctx: RouterContext, _: Next) {
        const name = String((ctx.request.body as any)?.name ?? "Browser");
        return new Success(ctx, { data: EchoAuth.browsers.mint(name) }).send();
    }

    /** Linked browsers: name, when linked, when last seen. Never the tokens. */
    static async browsers(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: EchoAuth.browsers.all() }).send();
    }

    /** Signs browsers out for real: their tokens stop working at once. {ids: [...]} or {all: true}. */
    static async revokeBrowsers(ctx: RouterContext, _: Next) {
        const body = (ctx.request.body as any) ?? {};
        const ids = body.all ? null : (Array.isArray(body.ids) ? body.ids.map(String) : []);
        return new Success(ctx, { data: { removed: EchoAuth.browsers.revoke(ids) } }).send();
    }

    /** A browser signing itself out (Echo Web's Sign Out): its key stops working. */
    static async leaveBrowser(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: { left: EchoAuth.leave(ctx.headers, ctx.request.query) } }).send();
    }

    /** A linked browser naming itself, so the phone and Mac list "Chrome on Windows". */
    static async nameBrowser(ctx: RouterContext, _: Next) {
        const name = String((ctx.request.body as any)?.name ?? "");
        return new Success(ctx, { data: { named: EchoAuth.rename(ctx.headers, ctx.request.query, name) } }).send();
    }

    static async status(ctx: RouterContext, _: Next) {
        const reading = EchoGuard.lastReading;
        return new Success(ctx, {
            data: {
                echo: true,
                version: app.getVersion(),
                // What this server's sign-in understands, so apps know they can stop putting the password in links.
                auth: { header: true, browsers: true },
                uptimeSec: Math.round(process.uptime()),
                memoryMb: reading
                    ? {
                          server: reading.server,
                          messages: reading.messages,
                          findMy: reading.findMy,
                          faceTime: reading.faceTime
                      }
                    : null,
                freeDiskGb: reading?.freeDiskGb == null ? null : Math.round(reading.freeDiskGb * 10) / 10,
                messagesGb: EchoGuard.messagesGb,
                limitsMb: {
                    server: Number(Server().repo.getConfig("echo_server_limit_mb")) || 900,
                    messages: Number(Server().repo.getConfig("echo_messages_limit_mb")) || 1400
                },
                privateApi: !!Server().privateApi?.helper,
                // FaceTime through the Mac: switched on, ringable/answerable, and whether the helper is inside FaceTime.
                faceTime: {
                    enabled: !!Server().repo.getConfig("enable_ft_private_api"),
                    calling: !!Server().repo.getConfig("facetime_calling"),
                    helper: Object.keys(Server().privateApi?.activeClients ?? {}).some(p => /facetime/i.test(p))
                },
                pushSubscribers: EchoPush.get().count,
                typing: EchoTyping.summary(),
                searchIndex: EchoSearch.get().status,
                // For Echo for Mac: what it needs to show and manage.
                permissions: {
                    fullDisk: Server().hasDiskAccess,
                    accessibility: Server().hasAccessibilityAccess
                },
                liveClients: (Server().httpService?.socketServer as any)?.engine?.clientsCount ?? 0,
                address: String(Server().repo.getConfig("server_address") ?? ""),
                proxy: String(Server().repo.getConfig("proxy_service") ?? ""),
                macos: os.release(),
                events: EchoGuard.events.slice(-15),
                // Every way in, so a phone can fall back when one dies, and how the public one is doing.
                routes: EchoAddress.get().routes(),
                addressCheck: EchoAddress.get().status
            }
        }).send();
    }

    /** Whether Catch me up is ready - never the key itself. */
    static async aiStatus(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: { configured: EchoAI.get().configured } }).send();
    }

    static async aiKey(ctx: RouterContext, _: Next) {
        const { key } = (ctx.request.body ?? {}) as any;
        try {
            await EchoAI.get().setKey(typeof key === "string" ? key : "");
        } catch (ex: any) {
            throw new BadRequest({ error: ex?.message ?? "Bad key" });
        }
        return new Success(ctx, { data: { configured: EchoAI.get().configured } }).send();
    }

    static async catchUp(ctx: RouterContext, _: Next) {
        const { chatGuid, names } = (ctx.request.body ?? {}) as any;
        if (typeof chatGuid !== "string" || !chatGuid) throw new BadRequest({ error: "chatGuid is required" });
        const nameMap: Record<string, string> = {};
        if (names && typeof names === "object") {
            for (const [k, v] of Object.entries(names)) if (typeof v === "string") nameMap[k] = v.slice(0, 60);
        }
        try {
            return new Success(ctx, { data: await EchoAI.get().catchUp(chatGuid, nameMap) }).send();
        } catch (ex: any) {
            const status = ex?.status ?? ex?.statusCode;
            const message =
                status === 401
                    ? "The Anthropic API key was rejected - check it in Your Mac on the phone"
                    : status === 429
                        ? "Too many requests to Claude right now - try again in a minute"
                        : ex?.message ?? "Couldn't catch up";
            throw new BadRequest({ error: message });
        }
    }

    // --- Reminders & Notes (the Mac's own apps) ----------------------------------

    /** Runs [work], turning a failure into a 400 whose message the phone can show as-is. */
    private static async mac<T>(ctx: RouterContext, work: () => Promise<T>) {
        try {
            return new Success(ctx, { data: await work() }).send();
        } catch (ex: any) {
            throw new BadRequest({ error: ex?.message ?? "The Mac didn't answer" });
        }
    }

    private static body(ctx: RouterContext): any {
        return ctx.request.body ?? {};
    }

    static reminders = (ctx: RouterContext, _: Next) =>
        EchoRouter.mac(ctx, () => EchoMacApps.get().reminders(ctx.request.query?.fresh === "1"));

    static addReminder = (ctx: RouterContext, _: Next) => {
        const { name, list, due, body } = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, () =>
            EchoMacApps.get().addReminder({
                name: String(name ?? ""),
                list: typeof list === "string" ? list : undefined,
                due: typeof due === "number" ? due : undefined,
                body: typeof body === "string" ? body : undefined
            })
        );
    };

    static updateReminder = (ctx: RouterContext, _: Next) => {
        const { id, completed, name, flagged, due } = EchoRouter.body(ctx);
        if (typeof id !== "string") throw new BadRequest({ error: "id is required" });
        const change: { completed?: boolean; name?: string; flagged?: boolean; due?: number | null } = {};
        if (typeof completed === "boolean") change.completed = completed;
        if (typeof name === "string") change.name = name.slice(0, 500);
        if (typeof flagged === "boolean") change.flagged = flagged;
        if (typeof due === "number" || due === null) change.due = due;
        return EchoRouter.mac(ctx, () => EchoMacApps.get().updateReminder(id, change).then(() => ({ ok: true })));
    };

    static deleteReminder = (ctx: RouterContext, _: Next) => {
        const { id } = EchoRouter.body(ctx);
        if (typeof id !== "string") throw new BadRequest({ error: "id is required" });
        return EchoRouter.mac(ctx, () => EchoMacApps.get().deleteReminder(id).then(() => ({ ok: true })));
    };

    static notes = (ctx: RouterContext, _: Next) =>
        EchoRouter.mac(ctx, () => EchoMacApps.get().notes(ctx.request.query?.fresh === "1"));

    static note = (ctx: RouterContext, _: Next) => {
        const id = String(ctx.request.query?.id ?? "");
        if (!id) throw new BadRequest({ error: "id is required" });
        return EchoRouter.mac(ctx, () => EchoMacApps.get().note(id));
    };

    static addNote = (ctx: RouterContext, _: Next) => {
        const { text } = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, () => EchoMacApps.get().addNote(String(text ?? "").slice(0, 200_000)));
    };

    static updateNote = (ctx: RouterContext, _: Next) => {
        const { id, text } = EchoRouter.body(ctx);
        if (typeof id !== "string") throw new BadRequest({ error: "id is required" });
        return EchoRouter.mac(ctx, () =>
            EchoMacApps.get().updateNote(id, String(text ?? "").slice(0, 200_000)).then(() => ({ ok: true }))
        );
    };

    /** Fix My Mac: { what: "address" | "messages" | "engine" | "all" }. */
    static repair = (ctx: RouterContext, _: Next) => {
        const { what } = EchoRouter.body(ctx);
        const w = ["address", "messages", "engine", "all"].includes(String(what)) ? String(what) : "all";
        return EchoRouter.mac(ctx, () => EchoAddress.get().repair(w));
    };

    static typingNow = (ctx: RouterContext, _: Next) => EchoRouter.mac(ctx, async () => EchoTyping.now());

    static typingTest = (ctx: RouterContext, _: Next) => EchoRouter.mac(ctx, () => EchoTyping.test());

    /** Full-history search: ?q=words&chat=guid&limit=&offset= */
    static async search(ctx: RouterContext, _: Next) {
        const q = ctx.request.query ?? {};
        const hits = EchoSearch.get().search(String(q.q ?? ""), {
            chat: q.chat ? String(q.chat) : undefined,
            fromMe: q.fromMe === "1" ? true : q.fromMe === "0" ? false : undefined,
            limit: Number(q.limit) || 50,
            offset: Number(q.offset) || 0
        });
        return new Success(ctx, { data: { hits, index: EchoSearch.get().status } }).send();
    }

    // --- Mac remote --------------------------------------------------------------

    static macState = (ctx: RouterContext, _: Next) => EchoRouter.mac(ctx, () => EchoRemote.get().state());

    static macAction = (ctx: RouterContext, _: Next) => {
        const b = EchoRouter.body(ctx);
        const r = EchoRemote.get();
        return EchoRouter.mac(ctx, async () => {
            switch (b.action) {
                case "lock": await r.lock(); break;
                case "volume": await r.setVolume(Number(b.value)); break;
                case "mute": await r.mute(b.value === true); break;
                case "playpause": case "next": case "previous": await r.media(b.action); break;
                case "open": await r.open(String(b.value ?? "")); break;
                case "say": await r.say(String(b.value ?? "")); break;
                default: throw new Error("Unknown action");
            }
            return r.state();
        });
    };

    static async macScreenshot(ctx: RouterContext, _: Next) {
        let file: string;
        try {
            file = await EchoRemote.get().screenshot();
        } catch (ex: any) {
            throw new BadRequest({ error: ex?.message ?? "Couldn't take a screenshot" });
        }
        const stream = fs.createReadStream(file);
        const cleanup = (): void => fs.unlink(file, (): void => undefined);
        stream.on("close", cleanup);
        ctx.status = 200;
        ctx.set("Content-Type", "image/jpeg");
        ctx.set("Cache-Control", "no-store");
        ctx.body = stream;
    }

    // --- Echo Wrapped ---------------------------------------------------------------

    static wrapped = (ctx: RouterContext, _: Next) =>
        EchoRouter.mac(ctx, async () => wrapped(Number(ctx.request.query?.days) || 365));

    // --- Backups to the PC --------------------------------------------------------

    static backupInfo = (ctx: RouterContext, _: Next) => EchoRouter.mac(ctx, () => EchoBackup.get().info());

    static async backupDb(ctx: RouterContext, _: Next) {
        let stream;
        try {
            stream = await EchoBackup.get().dbStream();
        } catch (ex: any) {
            throw new BadRequest({ error: `Couldn't read the Messages database: ${ex?.message ?? ex}` });
        }
        ctx.status = 200;
        ctx.set("Content-Type", "application/octet-stream");
        ctx.body = stream;
    }

    static async backupAttachments(ctx: RouterContext, _: Next) {
        const cursor = String(ctx.request.query?.since ?? "");
        const max = Math.min(Math.max(Number(ctx.request.query?.maxBytes) || 1024 ** 3, 50 * 1024 ** 2), 4 * 1024 ** 3);
        const part = await EchoBackup.get().attachmentsStream(cursor, max);
        if (!part) {
            await EchoBackup.get().markPulled();
            return new Success(ctx, { data: { done: true } }).send();
        }
        ctx.status = 200;
        ctx.set("Content-Type", "application/octet-stream");
        ctx.set("X-Echo-Next", encodeURIComponent(part.next));
        ctx.set("X-Echo-Count", String(part.count));
        ctx.body = part.stream;
    }

    // --- Settings, for Echo for Mac ---------------------------------------------

    /** Settings Echo for Mac can change, and the kind of value each takes. */
    private static SETTINGS: Record<string, "bool" | "string" | "port" | "mb" | "proxy"> = {
        proxy_service: "proxy",
        server_address: "string",
        socket_port: "port",
        ngrok_custom_domain: "string",
        zrok_reserve_tunnel: "bool",
        enable_private_api: "bool",
        enable_ft_private_api: "bool",
        facetime_calling: "bool",
        auto_caffeinate: "bool",
        echo_guard: "bool",
        echo_auto_codes: "bool",
        echo_phone_notifications_mac: "bool",
        echo_nightly_restart: "bool",
        echo_server_limit_mb: "mb",
        echo_messages_limit_mb: "mb"
    };

    /** Tokens are write-only: you see whether one is set, never the token. */
    private static SECRETS = ["ngrok_key", "zrok_token"];

    static async settings(ctx: RouterContext, _: Next) {
        const repo = Server().repo;
        const data: Record<string, unknown> = {};
        for (const k of Object.keys(EchoRouter.SETTINGS)) data[k] = repo.getConfig(k);
        for (const k of EchoRouter.SECRETS) data[`${k}_set`] = String(repo.getConfig(k) ?? "").length > 0;
        return new Success(ctx, { data }).send();
    }

    static setSettings = (ctx: RouterContext, _: Next) => {
        const body = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () => {
            const changes: [string, any][] = [];
            for (const [k, v] of Object.entries(body)) {
                const kind = EchoRouter.SETTINGS[k] ?? (EchoRouter.SECRETS.includes(k) ? "string" : null);
                if (!kind) throw new Error(`${k} can't be changed here`);
                if (kind === "bool") changes.push([k, v === true || v === 1 || v === "1" || v === "true"]);
                else if (kind === "port") {
                    const n = Number(v);
                    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("The port must be 1024-65535");
                    changes.push([k, n]);
                } else if (kind === "mb") {
                    const n = Number(v);
                    if (!Number.isFinite(n) || n < 300 || n > 8000) throw new Error("Memory limits must be 300-8000 MB");
                    changes.push([k, String(Math.round(n))]);
                } else if (kind === "proxy") {
                    if (!["cloudflare", "ngrok", "zrok", "dynamic-dns", "lan-url"].includes(String(v))) {
                        throw new Error("Unknown address method");
                    }
                    changes.push([k, String(v)]);
                } else changes.push([k, String(v ?? "").trim().slice(0, 500)]);
            }
            // One at a time: each change is applied by the engine as it lands.
            for (const [k, v] of changes) await Server().repo.setConfig(k, v);
            return { changed: changes.map(([k]) => k) };
        });
    };

    /** A new server password (random unless one is given). Every device must be paired again after. */
    static newPassword = (ctx: RouterContext, _: Next) => {
        const { password } = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () => {
            const next = typeof password === "string" && password.trim().length >= 8
                ? password.trim()
                : crypto.randomBytes(18).toString("base64url");
            await Server().repo.setConfig("password", next);
            return { password: next };
        });
    };

    // --- Clipboard and file drop ------------------------------------------------

    static async clipboard(ctx: RouterContext, _: Next) {
        const h = EchoHandoff.get();
        return new Success(ctx, { data: { enabled: h.clipboardOn, last: h.last } }).send();
    }

    // --- Your phone, on your computers -------------------------------------------

    static phone = (ctx: RouterContext, _: Next) =>
        EchoRouter.mac(ctx, async () => ({ state: EchoPhone.get().state, notifications: EchoPhone.get().notifications }));

    static phoneState = (ctx: RouterContext, _: Next) => {
        const b = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () => EchoPhone.get().report(b));
    };

    static phoneNotification = (ctx: RouterContext, _: Next) => {
        const b = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () => EchoPhone.get().notify(b));
    };

    static phoneNotificationRemoved = (ctx: RouterContext, _: Next) => {
        const { id, all } = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () => {
            if (all === true) EchoPhone.get().clearAll();
            else EchoPhone.get().remove(String(id ?? ""));
            return { ok: true };
        });
    };

    static phoneRing = (ctx: RouterContext, _: Next) => {
        const { stop, from } = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () => EchoPhone.get().ring(stop === true, typeof from === "string" ? from.slice(0, 40) : "computer"));
    };

    static setClipboard = (ctx: RouterContext, _: Next) => {
        const { text, from } = EchoRouter.body(ctx);
        if (typeof text !== "string") throw new BadRequest({ error: "text is required" });
        return EchoRouter.mac(ctx, async () => EchoHandoff.get().receiveClip(text, typeof from === "string" ? from : "phone"));
    };

    static clipboardSync = (ctx: RouterContext, _: Next) => {
        const { enabled } = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () => {
            await EchoHandoff.get().setClipboardOn(enabled === true);
            return { enabled: EchoHandoff.get().clipboardOn };
        });
    };

    /** Files from a device, as multipart "file" parts; saved to ~/Downloads/Echo. */
    static drop = (ctx: RouterContext, _: Next) => {
        const raw = (ctx.request as any).files?.file;
        const files: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
        if (!files.length) throw new BadRequest({ error: "No file came through" });
        const { from } = EchoRouter.body(ctx);
        return EchoRouter.mac(ctx, async () =>
            files.map(f =>
                EchoHandoff.get().receiveFile(
                    f.filepath ?? f.path,
                    f.originalFilename ?? f.name ?? "file",
                    typeof from === "string" ? from : "phone"
                )
            )
        );
    };

    static async drops(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: EchoHandoff.get().drops() }).send();
    }

    static async dropFile(ctx: RouterContext, _: Next) {
        const d = EchoHandoff.get().dropFile(String(ctx.request.query?.id ?? ""));
        if (!d) throw new BadRequest({ error: "That file isn't on offer any more" });
        ctx.response.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`);
        ctx.response.set("Content-Length", String(d.size));
        return new FileStream(ctx, d.file).send();
    }

    static dropDone = (ctx: RouterContext, _: Next) => {
        const { id } = EchoRouter.body(ctx);
        if (typeof id !== "string") throw new BadRequest({ error: "id is required" });
        return EchoRouter.mac(ctx, async () => {
            EchoHandoff.get().finish(id);
            return { ok: true };
        });
    };

    static async pushKey(ctx: RouterContext, _: Next) {
        return new Success(ctx, { data: { publicKey: EchoPush.get().publicKey() } }).send();
    }

    static async pushSubscribe(ctx: RouterContext, _: Next) {
        const { subscription, name, muted } = (ctx.request.body ?? {}) as any;
        try {
            EchoPush.get().subscribe(subscription, name, muted);
        } catch (ex: any) {
            throw new BadRequest({ error: ex?.message ?? "Bad subscription" });
        }
        return new Success(ctx, { message: "Subscribed" }).send();
    }

    static async pushUnsubscribe(ctx: RouterContext, _: Next) {
        const { endpoint } = (ctx.request.body ?? {}) as any;
        if (typeof endpoint !== "string") throw new BadRequest({ error: "endpoint is required" });
        EchoPush.get().unsubscribe(endpoint);
        return new Success(ctx, { message: "Unsubscribed" }).send();
    }

    static async pushTest(ctx: RouterContext, _: Next) {
        await EchoPush.get().send(JSON.stringify({ type: "test", at: Date.now() }));
        return new Success(ctx, { message: "Sent" }).send();
    }

    /** Title, description and image for a link, read from its page on the Mac. */
    static async preview(ctx: RouterContext, _: Next) {
        const raw = String(ctx.request.query?.url ?? "");
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            throw new BadRequest({ error: "A full http(s) URL is required" });
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequest({ error: "Only web links" });

        const hit = previews.get(url.href);
        if (hit && Date.now() - hit.at < PREVIEW_TTL) return new Success(ctx, { data: hit.value }).send();

        let value: Preview = { url: url.href };
        try {
            const res = await axios.get(url.href, {
                timeout: 8000,
                maxContentLength: 2_000_000,
                maxRedirects: 5,
                responseType: "text",
                headers: {
                    // Many sites only serve their preview tags to link-preview robots.
                    "User-Agent": "Mozilla/5.0 (compatible; facebookexternalhit/1.1; Echo link preview)",
                    Accept: "text/html,application/xhtml+xml"
                },
                validateStatus: s => s < 400
            });
            const finalUrl = res.request?.res?.responseUrl ?? url.href;
            if (String(res.headers["content-type"] ?? "").includes("html")) {
                value = EchoRouter.parse(String(res.data).slice(0, 600_000), finalUrl);
            }
        } catch {
            // Unreachable or not a page: the URL alone is still a preview.
        }
        previews.set(url.href, { at: Date.now(), value });
        if (previews.size > 300) previews.delete(previews.keys().next().value);
        return new Success(ctx, { data: value }).send();
    }

    static parse(html: string, base: string): Preview {
        const head = html.split(/<\/head>/i)[0];
        const meta = (key: string) => {
            const re = new RegExp(
                `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']|` +
                    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
                "i"
            );
            const m = head.match(re);
            return EchoRouter.decode((m?.[1] ?? m?.[2] ?? "").trim()) || undefined;
        };
        const abs = (u?: string) => {
            if (!u) return undefined;
            try {
                return new URL(u, base).href;
            } catch {
                return undefined;
            }
        };
        const pageTitle = EchoRouter.decode(head.match(/<title[^>]*>([^<]*)</i)?.[1]?.trim() ?? "");
        const title = meta("og:title") ?? meta("twitter:title") ?? pageTitle;
        const iconRe = /<link[^>]+rel=["'](?:apple-touch-icon|icon|shortcut icon)["'][^>]*href=["']([^"']+)["']/i;
        const icon = head.match(iconRe)?.[1];
        return {
            url: base,
            title: title || undefined,
            description: meta("og:description") ?? meta("twitter:description") ?? meta("description"),
            image: abs(meta("og:image") ?? meta("og:image:url") ?? meta("twitter:image")),
            site: meta("og:site_name") ?? new URL(base).hostname.replace(/^www\./, ""),
            icon: abs(icon ?? "/favicon.ico")
        };
    }

    private static decode(s: string) {
        return s
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#0?39;|&apos;/g, "'")
            .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
            .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
    }
}
