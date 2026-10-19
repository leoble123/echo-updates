import { Context, Next } from "koa";
import { Server } from "@server";
import { EchoAuth, ownerOnly } from "@server/services/echoAuth";
import { Forbidden, ServerError, Unauthorized } from "../responses/errors";

/**
 * Lets a request through when it carries the server password (header or the
 * old ?password=) or a linked browser's token. Browsers can't change the
 * password or manage other browsers.
 */
export const AuthMiddleware = async (ctx: Context, next: Next) => {
    const password = String(Server().repo.getConfig("password") as string);
    if (!password) {
        throw new ServerError({ error: "Failed to retrieve password from the database" });
    }

    const role = EchoAuth.httpRole(password, ctx.headers, ctx.request.query);
    if (!role) {
        Server().log(`Client (IP: ${ctx.request.ip}) failed to authenticate.`, "debug");
        throw new Unauthorized({ error: "Missing or wrong server password!" });
    }
    if (role !== "owner" && ownerOnly(ctx.method, ctx.path)) {
        throw new Forbidden({ error: "Only the server password can do that." });
    }
    ctx.state.echoRole = role;

    await next();
};
