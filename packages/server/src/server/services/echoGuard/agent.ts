// Kept dependency-light: FileSystem loads this very early.
import fs from "fs";
import path from "path";

/** The launchd label Echo Server runs under. */
export const ECHO_AGENT = "com.echo.server";

/**
 * True when launchd will restart us if we exit - so a relaunch should just
 * exit non-zero and let KeepAlive bring us back, rather than spawning a second
 * copy of the app (which races the dying one and flashes a window).
 *
 * launchd sets XPC_SERVICE_NAME to the job label, but not on every macOS; so
 * we also treat "our LaunchAgent plist is installed" as under-launchd.
 */
export const underLaunchd = (): boolean => {
    if (process.env.XPC_SERVICE_NAME === ECHO_AGENT) return true;
    try {
        const home = process.env.HOME ?? "";
        return !!home && fs.existsSync(path.join(home, "Library", "LaunchAgents", `${ECHO_AGENT}.plist`));
    } catch {
        return false;
    }
};
