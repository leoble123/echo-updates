import { RouterContext } from "koa-router";
import { Next } from "koa";
import { app } from "electron";
import axios from "axios";
import { Server } from "@server";
import { EchoGuard } from "@server/services/echoGuard";
import { EchoPush } from "@server/services/echoPush";
import { EchoAI } from "@server/services/echoAI";
import { Success } from "../responses/success";
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
