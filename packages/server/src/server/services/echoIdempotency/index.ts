import { Server } from "@server";
import { Claim, COVER_MARGIN_MS, IdempotencyLedger, MacView, readMacView, RetryAuth, retryAuthProblem } from "./ledger";

/**
 * Durable send deduplication, behind the echo_idempotency setting (off by
 * default). Off, or if the ledger can't be used for any reason, sends behave
 * exactly as before: this never stands between a message and Messages.
 */
export class EchoIdempotency {
    private static ledger: IdempotencyLedger | null = null;

    private static ready: Promise<boolean> | null = null;

    private static timer: NodeJS.Timeout | null = null;

    static enabled(): boolean {
        return !!Server().repo?.getConfig("echo_idempotency");
    }

    private static open(): Promise<boolean> {
        if (!EchoIdempotency.ready) {
            EchoIdempotency.ready = (async () => {
                const ledger = new IdempotencyLedger(Server().repo.db);
                await ledger.ensureSchema();
                const cut = await ledger.reconcile();
                if (cut > 0) Server().log(`Echo idempotency: ${cut} send(s) were cut off by a restart; held as unknown`);
                EchoIdempotency.ledger = ledger;
                return true;
            })().catch((ex: any) => {
                Server().log(`Echo idempotency unavailable: ${ex?.message ?? ex}`, "warn");
                EchoIdempotency.ready = null;
                return false;
            });
        }
        return EchoIdempotency.ready;
    }

    /** At startup: only does anything when the setting is on. */
    static start() {
        if (!EchoIdempotency.enabled()) return;
        EchoIdempotency.open();
        if (EchoIdempotency.timer) return;
        EchoIdempotency.timer = setInterval(() => {
            EchoIdempotency.ledger?.sweep().catch(() => {});
        }, 60 * 60_000);
    }

    /** [readMacView] on this Mac's chat database; null if it couldn't be read. */
    private static async macView(chatGuid: string, sinceMs: number): Promise<MacView | null> {
        try {
            return await readMacView(Server().iMessageRepo.db, chatGuid, sinceMs);
        } catch {
            return null;
        }
    }

    /**
     * Null means "no ledger here - send as usual". [auth] is the phone's
     * history confirmation on a Try Again, checked against this Mac's own
     * chat database before it can release an outcome-unknown send early.
     */
    static async claim(key: string, chatGuid: string, auth?: RetryAuth | null): Promise<Claim | null> {
        if (!key || !EchoIdempotency.enabled()) return null;
        if (!(await EchoIdempotency.open())) return null;
        const verify = auth
            ? async (row: any) => {
                  const mac = await EchoIdempotency.macView(row.chat_guid, Number(row.created_at) - COVER_MARGIN_MS);
                  const problem = retryAuthProblem(row, auth, mac);
                  Server().log(`Echo idempotency: retry of ${key} ${problem ? `held (${problem})` : "released by history check"}`);
                  return problem == null;
              }
            : undefined;
        try {
            return await EchoIdempotency.ledger.claim(key, chatGuid, verify);
        } catch (ex: any) {
            Server().log(`Echo idempotency claim failed, sending without it: ${ex?.message ?? ex}`, "warn");
            return null;
        }
    }

    static async settle(key: string, claim: Claim | null, outcome: "done" | "failed" | "unknown", result?: any) {
        if (claim?.kind !== "new" || !EchoIdempotency.ledger) return;
        try {
            if (outcome === "done") await EchoIdempotency.ledger.complete(key, claim.token, result);
            else if (outcome === "failed") await EchoIdempotency.ledger.fail(key, claim.token);
            else await EchoIdempotency.ledger.unknown(key, claim.token);
        } catch (ex: any) {
            Server().log(`Echo idempotency couldn't record a send: ${ex?.message ?? ex}`, "warn");
        }
    }
}
