import { RouterContext } from "koa-router";
import { Next } from "koa";
import { app } from "electron";
import axios from "axios";
import os from "os";
import { Server } from "@server";
import { EchoGuard } from "@server/services/echoGuard";
import { EchoPush } from "@server/services/echoPush";
import { EchoAI } from "@server/services/echoAI";
import { EchoMacApps } from "@server/services/echoMacApps";
import { EchoHandoff } from "@server/services/echoHandoff";
import { EchoTyping } from "@server/services/echoTyping";
import { FileStream, Success } from "../responses/success";
import { BadRequest } from "../responses/errors";

type Preview = { url: string; title?: string; description?: string; image?: string; site?: string; icon?: string };

const previews = new Map<string, { at: number; value: Preview }>();
const PREVIEW_TTL = 6 * 3600_000;

/** Echo-only endpoints: health, Web Push and link previews. */
export class EchoRouter {
    static async status(ctx: RouterContext, _: Next) {
        const reading = EchoGuard.lastReading;
        return new Success(ctx, {
            data: {
                echo: true,
                version: app.getVersion(),
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
                pushSubscribers: EchoPush.get().count,
                typing: EchoTyping.summary(),
                // For Echo for Mac: what it needs to show and manage.
                permissions: {
                    fullDisk: Server().hasDiskAccess,
                    accessibility: Server().hasAccessibilityAccess
                },
                liveClients: (Server().httpService?.socketServer as any)?.engine?.clientsCount ?? 0,
                address: String(Server().repo.getConfig("server_address") ?? ""),
                proxy: String(Server().repo.getConfig("proxy_service") ?? ""),
                macos: os.release(),
                events: EchoGuard.events.slice(-15)
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

    // --- Clipboard and file drop ------------------------------------------------

    static async clipboard(ctx: RouterContext, _: Next) {
        const h = EchoHandoff.get();
        return new Success(ctx, { data: { enabled: h.clipboardOn, last: h.last } }).send();
    }

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
