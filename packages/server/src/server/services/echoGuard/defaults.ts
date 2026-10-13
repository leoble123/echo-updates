import { ServerRepository } from "@server/databases/server";
import { AutoStartMethods } from "@server/databases/server/constants";
import { getLogger } from "@server/lib/logging/Loggable";

export { ECHO_AGENT, underLaunchd } from "./agent";

/** Settings that are always held, whatever the database says. */
const ALWAYS: Record<string, string | number | boolean> = {
    // BlueBubbles' updater would replace Echo Server with BlueBubbles.
    check_for_updates: false,
    auto_install_updates: false,
    // The GPU is disabled in main.ts on every launch; keep the setting truthful.
    disable_gpu: true
};

/**
 * Applied once, the first time Echo Server starts on a Mac. After that they're the
 * user's to change. Everything here trades a feature the Echo apps don't use, or a
 * window nobody looks at, for memory on an 8 GB Mac.
 */
const ONCE: Record<string, string | number | boolean> = {
    headless: true,
    start_minimized: true,
    hide_dock_icon: true,
    dock_badge: false,
    enable_ft_private_api: false,
    facetime_calling: false,
    open_findmy_on_startup: false,
    auto_caffeinate: true,
    auto_start: true,
    auto_start_method: AutoStartMethods.LaunchAgent
};

export async function applyEchoDefaults(repo: ServerRepository): Promise<void> {
    const log = getLogger("EchoDefaults");
    try {
        for (const [key, value] of Object.entries(ALWAYS)) {
            if (repo.getConfig(key) !== value) await repo.setConfig(key, value);
        }
        if (!repo.getConfig("echo_lean_applied")) {
            log.info("First Echo Server start: applying lean settings");
            for (const [key, value] of Object.entries(ONCE)) await repo.setConfig(key, value);
            await repo.setConfig("echo_lean_applied", true);
        }
    } catch (ex: any) {
        log.error(`Couldn't apply Echo defaults: ${ex?.message ?? String(ex)}`);
    }
}
