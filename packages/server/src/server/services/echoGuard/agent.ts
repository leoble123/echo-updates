// No imports on purpose: FileSystem loads this very early.

/** The launchd label Echo Server runs under. */
export const ECHO_AGENT = "com.echo.server";

/** True when launchd started this process (so exiting non-zero brings it straight back). */
export const underLaunchd = () => process.env.XPC_SERVICE_NAME === ECHO_AGENT;
