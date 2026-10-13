import Anthropic from "@anthropic-ai/sdk";
import { Server } from "@server";
import { Loggable } from "@server/lib/logging/Loggable";

/** What "Catch me up" hands back. */
export type CatchUp = {
    /** Two or three sentences: what happened while you were away. */
    summary: string;
    /** The main threads, a line each. */
    points: string[];
    /** Anything asked of you or waiting on you, with who asked. */
    forYou: string[];
    /** How many messages it read. */
    count: number;
};

const MODEL = "claude-opus-5-5";

const SYSTEM = [
    "You catch someone up on a group chat or conversation they missed, the way a friend who read it would.",
    "You are given the messages since they last took part, oldest first, as `Name: text` lines.",
    "Lines from them are `You: ...`.",
    "Write plainly and briefly, in the chat's own tone. Use first names. No preamble, no 'In this conversation'.",
    "summary: two or three sentences on what happened and where things landed.",
    "points: up to five short lines, one per distinct topic, plan or decision (empty if the summary covers it).",
    "forYou: anything asked of them, waiting on their answer, or that clearly affects them - with who asked.",
    "Leave forYou empty if nothing is.",
    "If the messages are just chatter with nothing to act on, say so in the summary and leave the lists empty."
].join("\n");

const SCHEMA = {
    type: "object",
    properties: {
        summary: { type: "string" },
        points: { type: "array", items: { type: "string" } },
        forYou: { type: "array", items: { type: "string" } }
    },
    required: ["summary", "points", "forYou"],
    additionalProperties: false
};

/**
 * Echo's AI features, run on the Mac with the owner's Anthropic API key. The key
 * is set once from the phone, kept in the server's own settings, and never sent
 * back out.
 */
export class EchoAI extends Loggable {
    tag = "EchoAI";

    private static instance: EchoAI;

    static get() {
        EchoAI.instance ??= new EchoAI();
        return EchoAI.instance;
    }

    private client: Anthropic = null;

    private clientKey: string = null;

    private get key(): string {
        return String(Server().repo.getConfig("echo_anthropic_key") ?? "").trim();
    }

    get configured() {
        return this.key.length > 0;
    }

    async setKey(key: string) {
        const clean = String(key ?? "").trim();
        if (clean && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(clean)) {
            throw new Error("That doesn't look like an Anthropic API key");
        }
        await Server().repo.setConfig("echo_anthropic_key", clean);
        this.client = null;
    }

    private api(): Anthropic {
        const key = this.key;
        if (!key) throw new Error("Add an Anthropic API key first");
        if (!this.client || this.clientKey !== key) {
            this.client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 90_000 });
            this.clientKey = key;
        }
        return this.client;
    }

    /**
     * Catches you up on [chatGuid]: everything since you last said something,
     * at most [limit] messages (and at least the last 30, so a quiet chat still
     * gets context). [names] maps addresses to the names on the phone.
     */
    async catchUp(chatGuid: string, names: Record<string, string> = {}, limit = 300): Promise<CatchUp> {
        const [messages] = await Server().iMessageRepo.getMessages({
            chatGuid,
            limit,
            sort: "DESC",
            withAttachments: true
        });
        // Newest first from the database; find where you last spoke.
        const lastMine = messages.findIndex(m => m.isFromMe);
        // Your last message is kept as context; never fewer than 30 lines.
        const upTo = lastMine < 0 ? messages.length : Math.max(lastMine + 1, 30);
        const slice = messages.slice(0, upTo);
        const lines: string[] = [];
        for (const m of slice.reverse()) {
            // Tapbacks and group events aren't worth a line.
            const assoc = Number(m.associatedMessageType) || 0;
            if (assoc !== 0 || (m.itemType ?? 0) !== 0) continue;
            let text = (m.universalText(true) ?? "").trim();
            const att = m.attachments?.length ?? 0;
            if (!text && att) text = att > 1 ? `[${att} attachments]` : "[attachment]";
            if (!text) continue;
            const who = m.isFromMe ? "You" : names[m.handle?.id] ?? m.handle?.id ?? "Someone";
            lines.push(`${who}: ${text.slice(0, 1500)}`);
        }
        if (lines.length === 0) return { summary: "Nothing new to catch up on.", points: [], forYou: [], count: 0 };

        const response = await this.api().beta.messages.create({
            model: MODEL,
            max_tokens: 4000,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
            system: SYSTEM,
            messages: [{ role: "user", content: lines.join("\n") }]
        });
        if (response.stop_reason === "refusal") throw new Error("Claude declined to summarise this conversation");
        const text = response.content.find(b => b.type === "text");
        if (!text || text.type !== "text") throw new Error("No summary came back");
        const parsed = JSON.parse(text.text);
        const { input_tokens: tin, output_tokens: tout } = response.usage;
        this.log.debug(`Caught up on ${lines.length} messages (${tin} in, ${tout} out)`);
        return {
            summary: String(parsed.summary ?? ""),
            points: Array.isArray(parsed.points) ? parsed.points.map(String).slice(0, 5) : [],
            forYou: Array.isArray(parsed.forYou) ? parsed.forYou.map(String) : [],
            count: lines.length
        };
    }
}
